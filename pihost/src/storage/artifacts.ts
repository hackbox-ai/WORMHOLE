import {mkdir,open,rename,readFile,lstat,unlink,utimes} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Pool} from 'pg';
import {packBody,unpackBody,sha256,hasZstd,MAX_BODY_BYTES,type PackedBody} from './codec.ts';
import {syncDirectory} from './cold-events.ts';
import {ArtifactFrameReader,writeArtifactFrames,ARTIFACT_FRAMING_THRESHOLD} from './artifact-frames.ts';

export const objectRoot=(dataDir:string)=>path.join(dataDir,'storage','objects');
export function objectFile(dataDir:string,hash:string,codec:string,layout='body-v1'):string {
  if(!/^[a-f0-9]{64}$/.test(hash)||!['identity','gzip','zstd'].includes(codec)||!['body-v1','frames-v2'].includes(layout))throw new Error('invalid artifact reference');
  return path.join(objectRoot(dataDir),`${hash}.${codec}${layout==='frames-v2'?'.frames':''}.blob`);
}
export class ArtifactStore {
  constructor(readonly pool:Pool,readonly dataDir:string){}
  /** Explicit rollback to the old object format. Pause lifecycle maintenance
   * before running this, otherwise eligible bodies will be framed again. */
  async restoreLegacy(limit=1,maxRawBytes=16*1024*1024,signal?:AbortSignal){
    if(!Number.isSafeInteger(limit)||limit<1||limit>10||!Number.isSafeInteger(maxRawBytes)||maxRawBytes<1||maxRawBytes>MAX_BODY_BYTES)throw new Error('invalid artifact restoration budget');
    let objects=0,refs=0;
    for(let n=0;n<limit;n++){
      signal?.throwIfAborted();const c=await this.pool.connect();let temporary:string|undefined;
      try{
        await c.query('BEGIN');
        if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_objects')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return {objects,refs,deferred:true};}
        const row=(await c.query("SELECT hash,codec,raw_bytes,manifest_sha256 FROM storage_artifacts WHERE layout='frames-v2' AND raw_bytes<=$1 ORDER BY raw_bytes,created_at LIMIT 1",[maxRawBytes])).rows[0];
        if(!row){await c.query('COMMIT');break;}
        const source=objectFile(this.dataDir,row.hash,row.codec,'frames-v2'),reader=await ArtifactFrameReader.open(source,{hash:row.hash,codec:row.codec,rawBytes:Number(row.raw_bytes),manifestHash:row.manifest_sha256});
        let text:string;try{text=await reader.restoreText();}finally{await reader.close();}
        const packed=await packBody(JSON.parse(text),row.codec);if(packed.hash!==row.hash)throw new Error('artifact restoration checksum mismatch');
        temporary=path.join(objectRoot(this.dataDir),'.tmp-'+randomUUID());const handle=await open(temporary,'wx',0o600);
        try{await handle.writeFile(packed.bytes);await handle.sync();}finally{await handle.close();}
        await unpackBody({...packed,bytes:await readFile(temporary)});signal?.throwIfAborted();
        await rename(temporary,objectFile(this.dataDir,row.hash,packed.codec));temporary=undefined;await syncDirectory(objectRoot(this.dataDir));
        const now=new Date();await utimes(source,now,now);
        const updated=await c.query(`UPDATE storage_artifacts SET layout='body-v1',manifest_sha256=NULL,codec=$3,stored_bytes=$4
          WHERE hash=$1 AND codec=$2 AND layout='frames-v2'`,[row.hash,row.codec,packed.codec,packed.bytes.length]);
        signal?.throwIfAborted();await c.query('COMMIT');objects++;refs+=updated.rowCount??0;
      }catch(error){await c.query('ROLLBACK');throw error;}
      finally{if(temporary)await unlink(temporary).catch(()=>{});c.release();}
    }
    return {objects,refs,deferred:false};
  }
  /** Bounded background conversion. Old files get a fresh orphan grace period,
   * so readers which already fetched the old pointer can finish safely. */
  async reframeLegacy(limit=1,maxRawBytes=16*1024*1024,signal?:AbortSignal){
    if(!Number.isSafeInteger(limit)||limit<1||limit>10||!Number.isSafeInteger(maxRawBytes)||maxRawBytes<ARTIFACT_FRAMING_THRESHOLD||maxRawBytes>MAX_BODY_BYTES)throw new Error('invalid artifact migration budget');
    let objects=0,refs=0;
    for(let n=0;n<limit;n++){
      signal?.throwIfAborted();const c=await this.pool.connect();let temporary:string|undefined;
      try{
        await c.query('BEGIN');
        if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_objects')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return {objects,refs,deferred:true};}
        const row=(await c.query(`SELECT hash,codec,raw_bytes FROM storage_artifacts WHERE layout='body-v1' AND raw_bytes>=$1 AND raw_bytes<=$2 ORDER BY raw_bytes,created_at LIMIT 1`,[ARTIFACT_FRAMING_THRESHOLD,maxRawBytes])).rows[0];
        if(!row){await c.query('COMMIT');break;}
        const value=await this.load(row.hash,row.codec,Number(row.raw_bytes)),text=JSON.stringify(value);
        if(sha256(Buffer.from(text))!==row.hash)throw new Error('legacy artifact canonical checksum mismatch');
        temporary=path.join(objectRoot(this.dataDir),'.tmp-'+randomUUID());
        const framed=await writeArtifactFrames(temporary,text,row.codec),reader=await ArtifactFrameReader.open(temporary,framed);
        try{await reader.verify();}finally{await reader.close();}
        signal?.throwIfAborted();
        await rename(temporary,objectFile(this.dataDir,row.hash,row.codec,'frames-v2'));temporary=undefined;await syncDirectory(objectRoot(this.dataDir));
        // Touch only managed original metadata; the raw body is unchanged.
        const now=new Date();await utimes(objectFile(this.dataDir,row.hash,row.codec),now,now);
        const updated=await c.query(`UPDATE storage_artifacts SET layout='frames-v2',manifest_sha256=$3,stored_bytes=$4
          WHERE hash=$1 AND codec=$2 AND layout='body-v1'`,[row.hash,row.codec,framed.manifestHash,framed.storedBytes]);
        signal?.throwIfAborted();await c.query('COMMIT');objects++;refs+=updated.rowCount??0;
      }catch(error){await c.query('ROLLBACK');throw error;}
      finally{if(temporary)await unlink(temporary).catch(()=>{});c.release();}
    }
    return {objects,refs,deferred:false};
  }
  async put(taskId:number,intentId:number,value:unknown){
    const text=JSON.stringify(value);if(typeof text!=='string')throw new Error('artifact must be JSON serializable');
    const rawBytes=Buffer.byteLength(text);if(rawBytes>MAX_BODY_BYTES)throw new Error('storage body exceeds maximum size');
    const hash=sha256(Buffer.from(text)),root=objectRoot(this.dataDir),c=await this.pool.connect();
    let temporary:string|undefined;
    try{
      await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock_shared(hashtext(current_schema()||':wormhole_storage_objects'))");
      const existing=(await c.query('SELECT codec,layout,manifest_sha256,stored_bytes FROM storage_artifacts WHERE hash=$1 ORDER BY created_at LIMIT 1',[hash])).rows[0];
      const layout=existing?.layout??(rawBytes>=ARTIFACT_FRAMING_THRESHOLD?'frames-v2':'body-v1');
      const packed=layout==='body-v1'?await packBody(value,existing?.codec):undefined;
      const codec:PackedBody['codec']=existing?.codec??packed?.codec??(hasZstd()?'zstd':'gzip'),file=objectFile(this.dataDir,hash,codec,layout);
      let manifestHash:string|null=existing?.manifest_sha256??null,storedBytes=Number(existing?.stored_bytes??packed?.bytes.length??0);
      await mkdir(root,{recursive:true,mode:0o700});
      try{
        if(layout==='frames-v2'){
          if(!manifestHash)throw Object.assign(new Error('unpublished artifact'),{code:'ENOENT'});
          const reader=await ArtifactFrameReader.open(file,{hash,codec,rawBytes,manifestHash});try{await reader.verify();}finally{await reader.close();}
        }else{const restored=await this.load(hash,codec,rawBytes);if(JSON.stringify(restored)!==text)throw new Error('artifact collision');}
      }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        temporary=path.join(root,'.tmp-'+randomUUID());
        if(layout==='frames-v2'){
          const framed=await writeArtifactFrames(temporary,text,codec);manifestHash=framed.manifestHash;storedBytes=framed.storedBytes;
          const reader=await ArtifactFrameReader.open(temporary,{hash,codec,rawBytes,manifestHash});try{await reader.verify();}finally{await reader.close();}
        }else{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(packed!.bytes);await handle.sync();}finally{await handle.close();}}
        await rename(temporary,file);temporary=undefined;await syncDirectory(root);
      }
      await c.query(`INSERT INTO storage_artifacts(task_id,intent_id,hash,raw_bytes,stored_bytes,codec,layout,manifest_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(task_id,intent_id,hash) DO NOTHING`,[taskId,intentId,hash,rawBytes,storedBytes,codec,layout,manifestHash]);
      await c.query('COMMIT');return {hash,codec,rawBytes,storedBytes,layout};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{if(temporary)await unlink(temporary).catch(()=>{});c.release();}
  }
  private async load(hash:string,codec:PackedBody['codec'],rawBytes:number){
    const file=objectFile(this.dataDir,hash,codec),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024**2+1024**2)throw new Error('invalid artifact file');
    return unpackBody({hash,codec,rawBytes,bytes:await readFile(file)});
  }
  async read(taskId:number,hash:string,offset=0,limit=8000){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>16000)throw new Error('invalid artifact range');
    const row=(await this.pool.query('SELECT codec,raw_bytes,layout,manifest_sha256 FROM storage_artifacts WHERE task_id=$1 AND hash=$2 LIMIT 1',[taskId,hash])).rows[0];
    if(!row)throw new Error('artifact does not belong to this task');
    if(row.layout==='frames-v2'){
      const reader=await ArtifactFrameReader.open(objectFile(this.dataDir,hash,row.codec,row.layout),{hash,codec:row.codec,rawBytes:Number(row.raw_bytes),manifestHash:row.manifest_sha256});
      try{return await reader.read(offset,limit);}finally{await reader.close();}
    }
    const value=await this.load(hash,row.codec,Number(row.raw_bytes)),text=JSON.stringify(value);
    // UTF-16 offsets match JS strings; avoid breaking a surrogate pair at a boundary.
    let start=Math.min(offset,text.length),end=Math.min(start+limit,text.length);
    if(start>0&&/[\uDC00-\uDFFF]/.test(text[start]??''))start--;
    if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]??''))end=end-start===1?end+1:end-1;
    return {hash,offset:start,nextOffset:end,totalCharacters:text.length,done:end>=text.length,text:text.slice(start,end)};
  }
  async externalize(taskId:number,intentId:number,result:any,threshold:number){
    // Images/audio remain visible to the model; externalize text-only results.
    if((result.content??[]).some((block:any)=>block.type!=='text'))return result;
    const raw=JSON.stringify(result);
    if(Buffer.byteLength(raw)<=threshold)return result;
    // Invocation IDs belong to the reference envelope, otherwise identical tool
    // bodies get a new object hash on every audited call and cannot deduplicate.
    const {toolCallId,...bodyDetails}=result.details??{};
    const stored=result.details===undefined?result:{...result,details:bodyDetails};
    const artifact=await this.put(taskId,intentId,stored);
    const preview=(result.content??[]).filter((block:any)=>block.type==='text').map((block:any)=>block.text??'').join('\n').slice(0,2000);
    return {...result,content:[{type:'text',text:`${preview}

[The complete result text has been saved without loss,${artifact.rawBytes} Bytes. The call ID is retained in the reference details. Use read_worker_artifact to read on demand, hash=${artifact.hash}, offset=0; do not repopulate all fragments into the context. ]`}],
      details:{toolCallId,artifact}};
  }
}
