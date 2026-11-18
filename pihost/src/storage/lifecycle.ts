import {Pool} from 'pg';
import {readdir,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import type {PihostConfig} from '../config.ts';
import {storagePolicy,type StoragePolicy} from './policy.ts';
import {archiveColdEvents,coldRoot} from './cold-events.ts';
import {objectRoot,objectFile,ArtifactStore} from './artifacts.ts';
import {migrateRecordings} from './migrate-recordings.ts';
import {archiveNativeCheckpoints} from './checkpoints.ts';

/** Collect only abandoned files in our two managed namespaces. Committed cold
 * archives are retained indefinitely: the last evidence copy never expires.
 */
export async function collectStorageOrphans(pool:Pool,dataDir:string,policy:StoragePolicy):Promise<number>{
  const c=await pool.connect();let removed=0;
  try{
    await c.query('BEGIN');
    if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_events')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return 0;}
    if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_objects')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return 0;}
    const archives=new Set((await c.query('SELECT id FROM storage_event_archives')).rows.map(r=>String(r.id)));
    const objects=new Set((await c.query('SELECT DISTINCT hash,codec,layout FROM storage_artifacts')).rows.map(r=>path.basename(objectFile(dataDir,r.hash,r.codec,r.layout))));
    for(const [root,keep,isName]of [
      [coldRoot(dataDir),archives,(name:string)=>/^[0-9a-f-]{36}$/.test(name)],
      [objectRoot(dataDir),objects,(name:string)=>/^[a-f0-9]{64}\.(identity|gzip|zstd)(\.frames)?\.blob$/.test(name)||/^\.tmp-[0-9a-f-]{36}$/.test(name)]
    ] as const){
      const names=await readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
      for(const name of names){
        if(removed>=100)break;if(keep.has(name)||!isName(name))continue;
        const candidate=path.resolve(root,name);if(path.dirname(candidate)!==path.resolve(root))throw new Error('managed cleanup escaped root');
        const info=await lstat(candidate);if(info.isSymbolicLink()||Date.now()-info.mtimeMs<policy.orphanGraceDays*86400000)continue;
        await rm(candidate,{recursive:info.isDirectory(),force:false});removed++;
      }
    }
    await c.query('COMMIT');return removed;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function storageStatus(pool:Pool){
  return {
    tables:(await pool.query("SELECT c.relname,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN('business_events','llm_records','storage_artifacts','storage_event_archives','worker_handoffs') ORDER BY c.relname")).rows,
    events:(await pool.query("SELECT count(*)::text AS rows,count(*) FILTER(WHERE cold_archive_id IS NOT NULL)::text AS cold_rows FROM business_events")).rows[0],
    archives:(await pool.query('SELECT count(*)::text AS segments,COALESCE(sum(rows),0)::text AS rows,COALESCE(sum(raw_bytes),0)::text AS raw_bytes,COALESCE(sum(stored_bytes),0)::text AS stored_bytes FROM storage_event_archives')).rows[0],
    recordings:(await pool.query('SELECT count(*)::text AS rows,count(*) FILTER(WHERE body_storage IS NULL)::text AS legacy_rows,COALESCE(sum(octet_length(body_storage)),0)::text AS packed_bytes FROM llm_records')).rows[0],
    recordingFailures:(await pool.query('SELECT record_id,reason,created_at FROM storage_recording_failures ORDER BY record_id LIMIT 100')).rows,
    artifacts:(await pool.query("SELECT count(*)::text AS refs,count(DISTINCT hash)::text AS objects,COALESCE(sum(raw_bytes),0)::text AS referenced_raw_bytes,count(*) FILTER(WHERE layout='frames-v2')::text AS framed_refs,count(*) FILTER(WHERE layout='body-v1' AND raw_bytes>=1048576)::text AS legacy_large_refs,count(*) FILTER(WHERE layout='body-v1' AND raw_bytes>16777216)::text AS legacy_oversized_refs FROM storage_artifacts")).rows[0],
    maintenance:(await pool.query('SELECT job,last_success_at,last_error,counters FROM storage_maintenance_state ORDER BY job')).rows
  };
}
export class StorageLifecycle {
  readonly policy:StoragePolicy;
  constructor(readonly pool:Pool,readonly config:PihostConfig){this.policy=storagePolicy(config.storage);}
  async runOnce(signal?:AbortSignal){
    const result:Record<string,unknown>={};
    for(const [name,run]of [
      ['recordings',()=>migrateRecordings(this.pool,this.policy.recordingBatchRows,signal)],
      ['events',()=>archiveColdEvents(this.pool,this.config.dataDir,this.policy,signal)],
      ['artifacts',()=>new ArtifactStore(this.pool,this.config.dataDir).reframeLegacy(1,16*1024*1024,signal)],
      ['checkpoints',()=>archiveNativeCheckpoints(this.pool,this.config.dataDir,this.policy.hotDays,2,signal,this.policy.orphanGraceDays)],
      ['orphans',async()=>({removed:await collectStorageOrphans(this.pool,this.config.dataDir,this.policy)})]
    ] as const){signal?.throwIfAborted();try{result[name]=await this.job<unknown>(name,run);}catch(error){if(signal?.aborted)throw error;result[name]={error:(error as Error).name};}}
    return result;
  }
  private async job<T>(name:string,run:()=>Promise<T>):Promise<T>{
    try{const result=await run();await this.pool.query(`INSERT INTO storage_maintenance_state(job,last_success_at,counters) VALUES($1,now(),$2)
      ON CONFLICT(job) DO UPDATE SET last_success_at=now(),last_error=NULL,counters=EXCLUDED.counters`,[name,JSON.stringify(result)]);return result;}
    catch(error){await this.pool.query(`INSERT INTO storage_maintenance_state(job,last_error) VALUES($1,$2)
      ON CONFLICT(job) DO UPDATE SET last_error=EXCLUDED.last_error`,[name,(error as Error).name+': '+((error as {code?:string}).code??'failed')]).catch(()=>{});throw error;}
  }
}
export function startStorageLifecycle(config:PihostConfig):()=>Promise<void>{
  const policy=storagePolicy(config.storage);if(!policy.enabled)return async()=>{};
  // Separate pool: cold compression cannot consume execution/projection slots.
  const pool=new Pool({connectionString:config.database.dsn,max:1,application_name:'wormhole-storage',statement_timeout:30000,connectionTimeoutMillis:5000});
  const service=new StorageLifecycle(pool,config),controller=new AbortController();let pending:Promise<unknown>|undefined;
  const tick=()=>{if(controller.signal.aborted||pending)return;pending=service.runOnce(controller.signal).catch(error=>{if(!controller.signal.aborted)console.warn('[storage] maintenance deferred',String((error as Error).name));}).finally(()=>{pending=undefined;});};
  const initial=setTimeout(tick,5000),timer=setInterval(tick,policy.intervalMs);initial.unref();timer.unref();
  return async()=>{clearTimeout(initial);clearInterval(timer);controller.abort();await pending;await pool.end();};
}
