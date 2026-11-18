/** Explicit historical v1 -> v2 migration. Full original archive is a mandatory
 * precondition, and its bytes must still match the source snapshot before writes.
 */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {readArchiveManifest,verifyEventArchive} from './event-archive.ts';
import {taskEventScope,taskEventLines} from './task-events.ts';
import {rewriteTaskEvents} from './rewrite-events.ts';

export async function compactTaskEvents(client:PoolClient,directory:string,apply=false,onProgress?:(rows:number,phase:'verify-source'|'compact')=>void,batchSize=512,rewrite?:{before:()=>Promise<void>}):Promise<Record<string,unknown>>{
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>2000)throw new Error('invalid compaction batch size');
  const manifest=await readArchiveManifest(directory),taskId=String(manifest.source.taskId??'');
  if(manifest.source.sample!==false||manifest.source.representation!=='exact-source-json'||!/^[1-9]\d*$/.test(taskId))throw new Error('compaction requires a complete original task archive');
  const {rows:archiveRows}=await verifyEventArchive(directory);
  if(archiveRows!==manifest.rows)throw new Error('archive count mismatch');
  await client.query(apply?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL timezone='UTC'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const task=(await client.query(`SELECT status,paused,deleted_at FROM tasks WHERE id=$1 ${apply?'FOR UPDATE':''}`,[taskId])).rows[0];
    if(!task||task.deleted_at||['running','queued'].includes(task.status))throw new Error('compaction requires an existing ended task');
    const scope=await taskEventScope(client,taskId),hash=createHash('sha256');let sourceRows=0;
    for await(const line of taskEventLines(client,scope)){hash.update(line+'\n');sourceRows++;if(sourceRows%2048===0)onProgress?.(sourceRows,'verify-source');}
    if(sourceRows!==manifest.rows||hash.digest('hex')!==manifest.rawHash)throw new Error('source changed since archive; export again before migration');
    const before=(await client.query(`SELECT count(*)::text AS rows,sum(pg_column_size(payload))::text AS live_stored_payload_bytes FROM business_events e WHERE ${scope.sql}`,scope.values)).rows[0];
    let changed=0,eligibleUpdates=0,cursor='0';
    if(rewrite){
      if(!apply)throw new Error('offline rewrite requires explicit apply');
      await rewrite.before();
      changed=await rewriteTaskEvents(client,taskId,scope.values[3] as string[]);eligibleUpdates=changed;
    }else while(true){
      // LIMIT applies before inspecting large payloads. A full-table JSON
      // validation can exceed the normal SQL timeout on million-event ledgers.
      const batch=(await client.query(`WITH batch AS MATERIALIZED (
        SELECT e.seq,e.payload->>'type' AS native_type,COALESCE(e.payload->>'storage_version','') AS version,
          jsonb_typeof(e.payload->'assistantMessageEvent') AS update_type
        FROM business_events e WHERE ${scope.sql} AND e.seq>$5::bigint AND event_type='message_update'
        ORDER BY e.seq LIMIT $6
      ) SELECT seq::text,native_type='message_update' AND version<>'2' AS eligible,
        native_type='message_update' AND version<>'2' AND update_type NOT IN ('object','null') AS invalid
        FROM batch ORDER BY batch.seq`,[...scope.values,cursor,batchSize])).rows;
      if(!batch.length)break;
      if(batch.some(row=>row.invalid))throw new Error('unsupported legacy update payload; transaction rolled back');
      const ids=batch.filter(row=>row.eligible).map(row=>row.seq);eligibleUpdates+=ids.length;
      if(apply&&ids.length){
        const result=await client.query(`WITH normalized AS MATERIALIZED (
          SELECT seq,(payload-'message') #- '{assistantMessageEvent,partial}' AS payload
          FROM business_events WHERE seq=ANY($1::bigint[])
        ) UPDATE business_events e SET payload=jsonb_set(n.payload,'{assistantMessageEvent}',
          COALESCE(NULLIF(n.payload->'assistantMessageEvent','null'::jsonb),'{}'::jsonb),true)
          ||'{"storage_version":2}'::jsonb FROM normalized n WHERE e.seq=n.seq`,[ids]);
        if(result.rowCount!==ids.length)throw new Error('compaction batch count mismatch');
        changed+=result.rowCount;
      }
      // Advance across already-v2 pages too, rather than stopping before later v1 rows.
      cursor=String(batch.at(-1)!.seq);onProgress?.(changed,'compact');
    }
    const after=(await client.query(`SELECT count(*)::text AS rows,sum(pg_column_size(payload))::text AS live_stored_payload_bytes FROM business_events e WHERE ${scope.sql}`,scope.values)).rows[0];
    if(before.rows!==after.rows)throw new Error('compaction changed event count');
    await client.query('COMMIT');
    return {taskId,applied:apply,strategy:rewrite?'offline-rewrite':'paged-update',originalArchiveVerified:true,sourceSnapshotMatched:true,archiveRows,eligibleUpdates,changed,before,after,
      note:'only cumulative snapshots in native message_update are removed; seq/uid/time and every other event are unchanged; '+(rewrite?'offline rewrite also replaces physical storage':'physical file reclamation is separate')};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
