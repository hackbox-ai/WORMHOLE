import {randomUUID} from 'node:crypto';
import {mkdir,open,statfs,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import type {Pool} from 'pg';
import {EventArchiveWriter,readEventArchive,verifyEventArchive,ArchiveRowReader} from './event-archive.ts';
import {hasZstd,sha256} from './codec.ts';
import type {StoragePolicy} from './policy.ts';

export const coldRoot=(dataDir:string)=>path.join(dataDir,'storage','events');
export function coldPath(dataDir:string,id:string):string {
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('invalid cold archive ID');
  return path.join(coldRoot(dataDir),id);
}
export async function syncDirectory(directory:string):Promise<void>{
  // Linux rename/directory entries must be durable before a DB pointer commits.
  if(process.platform==='win32')return;
  const file=await open(directory,'r');try{await file.sync();}finally{await file.close();}
}
/** One bounded, ended-task batch. Ledger stubs preserve UID uniqueness, FK receipts
 * and replay cursors, including delayed DLQ retries. Never archives pending projection.
 */
export async function archiveColdEvents(pool:Pool,dataDir:string,policy:StoragePolicy,signal?:AbortSignal):Promise<{rows:number;rawBytes:number;storedBytes:number;id?:string}> {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL timezone='UTC'");await c.query("SET LOCAL lock_timeout='1s'");
    if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_events')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return {rows:0,rawBytes:0,storedBytes:0};}
    const streams=(await c.query(`SELECT business_kind,business_id FROM business_events WHERE event_type='message_update' AND cold_archive_id IS NULL AND NOT payload @> '{"workspace_cleaned":true}'::jsonb
      AND ts<now()-($1::integer*interval '1 day') GROUP BY business_kind,business_id ORDER BY min(seq) LIMIT 5000`,[policy.hotDays])).rows;
    for(const stream of streams){
      signal?.throwIfAborted();
      let taskId=/^task-([1-9]\d*)(?:-|$)/.exec(stream.business_id)?.[1];
      if(stream.business_kind==='task'&&/^[1-9]\d*$/.test(stream.business_id))taskId=stream.business_id;
      const conversation=/^conv-([1-9]\d*)$/.exec(stream.business_id)?.[1];
      if([taskId,conversation].some(value=>value&&(value.length>19||BigInt(value)>9223372036854775807n)))continue;
      if(conversation){const conv=(await c.query("SELECT task_id::text,updated_at<now()-($2::integer*interval '1 day') AS idle FROM conversations WHERE id=$1",[conversation,policy.hotDays])).rows[0];
        if(conv&&!conv.idle)continue;taskId=conv?.task_id??undefined;}
      if(!taskId&&!conversation)continue;
      if(taskId){
        const owner=(await c.query('SELECT status FROM tasks WHERE id=$1',[taskId])).rows[0];
        if(owner&&!['done','failed','timeout','cancelled','stopped'].includes(owner.status))continue;
        if(owner&&!(await c.query("SELECT id FROM tasks WHERE id=$1 AND status IN('done','failed','timeout','cancelled','stopped') FOR UPDATE",[taskId])).rowCount)continue;
      }
      const ids=(await c.query(`SELECT e.seq::text FROM business_events e WHERE e.business_kind=$1 AND e.business_id=$2
        AND e.event_type='message_update' AND e.cold_archive_id IS NULL AND NOT e.payload @> '{"workspace_cleaned":true}'::jsonb AND e.ts<now()-($3::integer*interval '1 day')
        AND (NOT e.payload ? '_activity' OR e.activity_projected) ORDER BY e.seq LIMIT $4`,[stream.business_kind,stream.business_id,policy.hotDays,policy.eventBatchRows])).rows.map(r=>r.seq as string);
      if(!ids.length)continue;
      await mkdir(coldRoot(dataDir),{recursive:true,mode:0o700});
      const disk=await statfs(coldRoot(dataDir));if(disk.bavail*disk.bsize<1024**3)throw new Error('insufficient space for cold archive');
      const id=randomUUID(),directory=coldPath(dataDir,id);
      const writer=await EventArchiveWriter.create(directory,hasZstd()?'zstd':'gzip',{taskId:taskId??null,...stream,representation:'exact-source-json',sample:false,lifecycle:true});
      await c.query(`DECLARE cold_source NO SCROLL CURSOR FOR SELECT (to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text AS line
        FROM business_events e WHERE e.seq=ANY($1::bigint[]) ORDER BY e.seq FOR UPDATE`,[ids]);
      try{while(true){signal?.throwIfAborted();const page=await c.query('FETCH FORWARD 16 FROM cold_source');if(!page.rows.length)break;for(const row of page.rows)await writer.append(row.line);}}
      finally{await c.query('CLOSE cold_source');}
      const manifest=await writer.finish();await verifyEventArchive(directory);
      if(manifest.rows!==ids.length)throw new Error('cold archive source count changed');
      await syncDirectory(directory);await syncDirectory(coldRoot(dataDir));signal?.throwIfAborted();
      const manifestHash=sha256(await readFile(path.join(directory,'manifest.json')));
      await c.query(`INSERT INTO storage_event_archives(id,task_id,first_seq,last_seq,rows,raw_bytes,stored_bytes,raw_hash,codec,manifest_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,taskId??null,ids[0],ids.at(-1),manifest.rows,manifest.rawBytes,manifest.storedBytes,manifest.rawHash,manifest.codec,manifestHash]);
      const changed=await c.query("UPDATE business_events SET payload='{}'::jsonb,cold_archive_id=$2 WHERE seq=ANY($1::bigint[]) AND cold_archive_id IS NULL",[ids,id]);
      if(changed.rowCount!==ids.length)throw new Error('cold archive pointer count mismatch');
      await c.query('COMMIT');return {rows:ids.length,rawBytes:manifest.rawBytes,storedBytes:manifest.storedBytes,id};
    }
    await c.query('ROLLBACK');return {rows:0,rawBytes:0,storedBytes:0};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

/** Hydrate only frames intersecting this bounded page. No global archive scan/cache. */
export async function validateColdManifest(dataDir:string,id:string,expected:string):Promise<void>{
  const file=path.join(coldPath(dataDir,id),'manifest.json'),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024**2)throw new Error('invalid cold manifest');
  if(sha256(await readFile(file))!==expected)throw new Error('cold manifest checksum mismatch');
}
export async function hydrateColdEvents<T extends {seq:string;cold_archive_id?:string|null;cold_manifest_hash?:string|null}>(rows:T[],dataDir:string,reader?:ArchiveRowReader):Promise<T[]> {
  const owned=!reader,cache=reader??new ArchiveRowReader(),out:T[]=[];
  try{for(const row of rows){
    if(!row.cold_archive_id){out.push(row);continue;}
    const line=await cache.read(coldPath(dataDir,row.cold_archive_id),row.cold_manifest_hash??'',row.seq);
    out.push({...row,...JSON.parse(line),cold_archive_id:row.cold_archive_id});
  }return out;}finally{if(owned)cache.clear();}
}

export async function eventPage(pool:Pool,kind:string,id:string,cursor:string,dataDir?:string,limit=200,reader?:ArchiveRowReader){
  const rows=(await pool.query(`SELECT e.seq,e.event_type,e.payload,e.cold_archive_id,a.manifest_hash AS cold_manifest_hash FROM business_events e
    LEFT JOIN storage_event_archives a ON a.id=e.cold_archive_id WHERE e.business_kind=$1 AND e.business_id=$2 AND e.seq>$3 ORDER BY e.seq LIMIT $4`,[kind,id,cursor,limit])).rows;
  if(rows.some(row=>row.cold_archive_id)&&!dataDir)throw new Error('cold event storage is not configured');
  return dataDir?hydrateColdEvents(rows,dataDir,reader):rows;
}

/** Explicit rollback of a cold segment; all restored JSON numbers stay in SQL.
 * The immutable archive remains retained after restoration.
 */
export async function restoreColdArchive(pool:Pool,dataDir:string,id:string,signal?:AbortSignal):Promise<{restored:number}>{
  const directory=coldPath(dataDir,id),c=await pool.connect();let restored=0;
  try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");
    if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_events')) AS acquired")).rows[0].acquired)throw new Error('cold maintenance is busy');
    const catalog=(await c.query('SELECT task_id,manifest_hash FROM storage_event_archives WHERE id=$1',[id])).rows[0];if(!catalog)throw new Error('cold archive not found');
    const task=catalog.task_id?(await c.query('SELECT status FROM tasks WHERE id=$1 FOR UPDATE',[catalog.task_id])).rows[0]:undefined;if(task&&['running','queued','created','paused'].includes(task.status))throw new Error('restore requires an ended task');
    await validateColdManifest(dataDir,id,catalog.manifest_hash);
    const pending=Number((await c.query('SELECT count(*)::text AS n FROM business_events WHERE cold_archive_id=$1',[id])).rows[0].n);
    let lines:string[]=[],bytes=0;
    const flush=async()=>{
      if(!lines.length)return;signal?.throwIfAborted();
      const result=await c.query(`UPDATE business_events e SET payload=v->'payload',cold_archive_id=NULL
        FROM jsonb_array_elements($2::jsonb) v WHERE e.cold_archive_id=$1 AND e.seq=(v->>'seq')::bigint
        AND e.event_uid IS NOT DISTINCT FROM v->>'event_uid' AND e.business_kind=v->>'business_kind'
        AND e.business_id=v->>'business_id' AND e.event_type=v->>'event_type'`,[id,'['+lines.join(',')+']']);
      restored+=result.rowCount??0;lines=[];bytes=0;
    };
    for await(const line of readEventArchive(directory)){signal?.throwIfAborted();lines.push(line);bytes+=Buffer.byteLength(line);if(lines.length>=128||bytes>=4*1024**2)await flush();}await flush();
    if(restored!==pending)throw new Error('cold restoration identity/count mismatch');
    await c.query('COMMIT');return {restored};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
