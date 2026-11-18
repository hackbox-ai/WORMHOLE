/** Streaming, lossless cold storage for inactive native JSONL checkpoints.
 * No SDK file is rewritten; a verified gzip copy replaces an inactive file,
 * and the most recent small checkpoint is materialized before native resume.
 */
import {createReadStream,createWriteStream} from 'node:fs';
import {readdir,lstat,readFile,open,rename,unlink,link,utimes} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform,Writable} from 'node:stream';
import {createGzip,createGunzip} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Pool} from 'pg';
import {syncDirectory} from './cold-events.ts';

interface CheckpointMeta {version:1;file:string;rawBytes:number;rawHash:string;storedHash:string;mtimeMs:number}
async function digestStream(file:string,gunzip=false):Promise<{hash:string;bytes:number}>{
  const digest=createHash('sha256');let bytes=0;
  const sink=new Writable({write(chunk,_encoding,done){digest.update(chunk);bytes+=chunk.length;done();}});
  if(gunzip)await pipeline(createReadStream(file),createGunzip(),sink);else await pipeline(createReadStream(file),sink);
  return {hash:digest.digest('hex'),bytes};
}
async function syncFile(file:string){const h=await open(file,process.platform==='win32'?'r+':'r');try{await h.sync();}finally{await h.close();}}
async function metadata(directory:string,name:string):Promise<CheckpointMeta>{
  if(!/\.jsonl\.[a-f0-9]{64}\.gtygz\.json$/.test(name)||path.basename(name)!==name)throw new Error('invalid checkpoint metadata name');
  const file=path.join(directory,name),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new Error('invalid checkpoint metadata');
  const meta=JSON.parse(await readFile(file,'utf8')) as CheckpointMeta;
  if(meta.version!==1||path.basename(meta.file)!==meta.file||!meta.file.endsWith('.jsonl')||!Number.isSafeInteger(meta.rawBytes)||meta.rawBytes<0||!Number.isFinite(meta.mtimeMs)||!/^[a-f0-9]{64}$/.test(meta.rawHash)||!/^[a-f0-9]{64}$/.test(meta.storedHash)||name!==`${meta.file}.${meta.rawHash}.gtygz.json`)throw new Error('invalid checkpoint metadata');
  return meta;
}
export async function compressCheckpoint(directory:string,name:string):Promise<boolean>{
  if(path.basename(name)!==name||!name.endsWith('.jsonl'))throw new Error('invalid native checkpoint name');
  const source=path.join(directory,name),before=await lstat(source);if(!before.isFile()||before.isSymbolicLink()||before.size<4096)return false;
  const temporary=path.join(directory,`.storage-${randomUUID()}.tmp`);let tempMeta:string|undefined;
  try{
    const rawHash=createHash('sha256');let rawBytes=0;
    await pipeline(createReadStream(source),new Transform({transform(chunk,_encoding,done){rawHash.update(chunk);rawBytes+=chunk.length;done(null,chunk);}}),createGzip({level:6}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
    const hash=rawHash.digest('hex'),restored=await digestStream(temporary,true);
    if(restored.hash!==hash||restored.bytes!==rawBytes)throw new Error('native checkpoint round trip mismatch');
    const after=await lstat(source);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||rawBytes!==before.size)throw new Error('native checkpoint changed during compression');
    const packed=source+'.'+hash+'.gtygz',stored=await digestStream(temporary);if(stored.bytes>=rawBytes)return false;
    await syncFile(temporary);await rename(temporary,packed);
    const meta:CheckpointMeta={version:1,file:name,rawBytes,rawHash:hash,storedHash:stored.hash,mtimeMs:before.mtimeMs};
    tempMeta=path.join(directory,`.storage-${randomUUID()}.tmp`);const handle=await open(tempMeta,'wx',0o600);try{await handle.writeFile(JSON.stringify(meta));await handle.sync();}finally{await handle.close();}
    await rename(tempMeta,packed+'.json');tempMeta=undefined;await syncDirectory(directory);
    await unlink(source);await syncDirectory(directory);return true;
  }finally{await unlink(temporary).catch(()=>{});if(tempMeta)await unlink(tempMeta).catch(()=>{});}
}
/** Returns true when a large archived checkpoint should use a fresh handoff. */
export async function prepareNativeCheckpoint(directory:string,maximum:number):Promise<boolean>{
  const names=await readdir(directory);let hotMtime=-1,latest:{name:string;meta:CheckpointMeta}|undefined;
  for(const name of names){
    if(name.endsWith('.jsonl')){const info=await lstat(path.join(directory,name));if(info.isFile()&&!info.isSymbolicLink())hotMtime=Math.max(hotMtime,info.mtimeMs);}
    else if(/\.jsonl\.[a-f0-9]{64}\.gtygz\.json$/.test(name)){const meta=await metadata(directory,name);if(!latest||meta.mtimeMs>latest.meta.mtimeMs)latest={name,meta};}
  }
  if(!latest||latest.meta.mtimeMs<=hotMtime)return false;
  if(latest.meta.rawBytes>maximum)return true;
  const packed=path.join(directory,latest.name.slice(0,-5)),info=await lstat(packed);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('invalid packed checkpoint');
  const stored=await digestStream(packed);if(stored.hash!==latest.meta.storedHash)throw new Error('checkpoint stored checksum mismatch');
  const temp=path.join(directory,`.storage-${randomUUID()}.tmp`);
  try{
    let restoredBytes=0;
    await pipeline(createReadStream(packed),createGunzip(),new Transform({transform(chunk,_encoding,done){restoredBytes+=chunk.length;if(restoredBytes>latest!.meta.rawBytes){done(new Error('checkpoint decoded length exceeded'));return;}done(null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
    const raw=await digestStream(temp);if(raw.hash!==latest.meta.rawHash||raw.bytes!==latest.meta.rawBytes)throw new Error('checkpoint raw checksum mismatch');
    await syncFile(temp);
    const native=path.join(directory,latest.meta.file);
    try{await link(temp,native);await utimes(native,new Date(latest.meta.mtimeMs),new Date(latest.meta.mtimeMs));await syncDirectory(directory);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    return false;
  }finally{await unlink(temp).catch(()=>{});}
}
export async function archiveNativeCheckpoints(pool:Pool,dataDir:string,hotDays:number,maximum=2,signal?:AbortSignal,orphanGraceDays=7):Promise<{files:number}>{
  const root=path.join(dataDir,'pi-sessions'),names=await readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});let files=0;
  for(const name of names){
    signal?.throwIfAborted();const taskId=/^(?:worker|planner)-task-([1-9]\d*)(?:-|$)/.exec(name)?.[1];if(!taskId)continue;
    const directory=path.join(root,name),info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())continue;
    const c=await pool.connect();
    try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");
      const task=(await c.query("SELECT status FROM tasks WHERE id=$1 AND status IN('done','failed','timeout','cancelled','stopped') FOR UPDATE",[taskId])).rows[0];
      if(task)for(const file of await readdir(directory)){
        if(/^\.storage-[a-f0-9-]{36}\.tmp$/.test(file)){
          const candidate=path.resolve(directory,file),info=await lstat(candidate);
          if(path.dirname(candidate)!==path.resolve(directory))throw new Error('checkpoint cleanup escaped root');
          if(info.isFile()&&!info.isSymbolicLink()&&Date.now()-info.mtimeMs>orphanGraceDays*86400000)await unlink(candidate);
          continue;
        }
        signal?.throwIfAborted();if(!file.endsWith('.jsonl'))continue;
        const stat=await lstat(path.join(directory,file));if(Date.now()-stat.mtimeMs<hotDays*86400000)continue;
        if(await compressCheckpoint(directory,file))files++;
        if(files>=maximum)break;
      }
      await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    if(files>=maximum)break;
  }
  return {files};
}
