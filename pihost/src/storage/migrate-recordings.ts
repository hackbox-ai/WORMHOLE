import type {Pool} from 'pg';
import {legacyBodyFields,packLegacyBodies,expandRecordBodies,type LegacyBodies} from './record-body.ts';

/** Row locks + round-trip proof before replacing text. Each small batch commits
 * independently; a crash cannot leave a half-written envelope or erase a body.
 */
export async function migrateRecordings(pool:Pool,limit=8,signal?:AbortSignal):Promise<{rows:number;storedBytes:number;lastId:string;skipped:number}> {
  const c=await pool.connect();let rows=0,storedBytes=0,lastId='0',skipped=0;
  try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");
    if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':wormhole_storage_recordings')) AS acquired")).rows[0].acquired){await c.query('ROLLBACK');return {rows,storedBytes,lastId,skipped};}
    const selected=(await c.query(`SELECT id,${legacyBodyFields.join(',')} FROM llm_records WHERE body_storage IS NULL AND workspace_cleaned_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM storage_recording_failures f WHERE f.record_id=llm_records.id)
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,[Math.max(1,Math.min(100,limit))])).rows;
    for(const row of selected){
      signal?.throwIfAborted();const bodies=Object.fromEntries(legacyBodyFields.map(key=>[key,row[key]])) as LegacyBodies;
      let packed:Awaited<ReturnType<typeof packLegacyBodies>>;
      try{packed=await packLegacyBodies(bodies);}catch(error){
        if((error as Error).message!=='storage body exceeds maximum size')throw error;
        await c.query("INSERT INTO storage_recording_failures(record_id,reason) VALUES($1,'body exceeds codec bound; original retained') ON CONFLICT DO NOTHING",[row.id]);skipped++;continue;
      }
      const expanded=await expandRecordBodies({body_storage:packed.bytes,body_codec:packed.codec,body_raw_bytes:packed.rawBytes,body_sha256:packed.hash});
      for(const key of legacyBodyFields)if(expanded[key]!==bodies[key])throw new Error('historical recording round trip mismatch');
      await c.query(`UPDATE llm_records SET request_text='',response_text='',request_body=NULL,response_body=NULL,raw_request=NULL,raw_response=NULL,
        body_storage=$2,body_codec=$3,body_raw_bytes=$4,body_sha256=$5 WHERE id=$1 AND body_storage IS NULL`,[row.id,packed.bytes,packed.codec,packed.rawBytes,packed.hash]);
      rows++;storedBytes+=packed.bytes.length;lastId=String(row.id);
    }
    await c.query('COMMIT');return {rows,storedBytes,lastId,skipped};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
