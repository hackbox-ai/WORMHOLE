import type {PoolClient} from 'pg';
import path from 'node:path';
import {ArchiveRowReader} from './event-archive.ts';

/** Exact task-N boundary; include bound pentest conversations without touching payloads.
 * scope is based on explicit stored business identities, not fuzzy substring matches.
 */
export async function taskEventScope(client: PoolClient, taskId: string): Promise<{sql: string; values: unknown[]}> {
  if (!/^[1-9]\d*$/.test(taskId)) throw new Error('invalid task ID');
  const conversations = (await client.query('SELECT id::text FROM conversations WHERE task_id=$1', [taskId])).rows.map(r => `conv-${r.id}`);
  return {sql: "((e.business_kind='task' AND e.business_id=$1) OR e.business_id=$2 OR e.business_id LIKE $3 OR e.business_id=ANY($4::text[]))",
    values: [taskId, `task-${taskId}`, `task-${taskId}-%`, conversations]};
}

export async function* taskEventLines(client: PoolClient, scope: {sql: string; values: unknown[]}, options: {sampleSeqs?: string[]; maxSeq?: string;dataDir?:string} = {}): AsyncGenerator<string> {
  const values = [...scope.values];
  const filters = [scope.sql];
  if (options.sampleSeqs) { values.push(options.sampleSeqs); filters.push(`e.seq=ANY($${values.length}::bigint[])`); }
  if (options.maxSeq) { values.push(options.maxSeq); filters.push(`e.seq<=$${values.length}::bigint`); }
  const cold=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='business_events'::regclass AND attname='cold_archive_id' AND NOT attisdropped) AND to_regclass('storage_event_archives') IS NOT NULL AS available")).rows[0].available;
  // Return JSON text, not JS-decoded payloads: preserve JSON numbers and all columns.
  await client.query(`DECLARE storage_events NO SCROLL CURSOR FOR
    SELECT e.seq::text,${cold?'e.cold_archive_id,a.manifest_hash':'NULL::text AS cold_archive_id,NULL::text AS manifest_hash'},
      ${cold?"CASE WHEN e.cold_archive_id IS NULL THEN (to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text END":"(to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text"} AS line
    FROM business_events e ${cold?'LEFT JOIN storage_event_archives a ON a.id=e.cold_archive_id':''} WHERE ${filters.join(' AND ')} ORDER BY e.seq`, values);
  const archive=new ArchiveRowReader();
  try {
    while (true) {
      const result = await client.query('FETCH FORWARD 32 FROM storage_events');
      if (!result.rows.length) break;
      for (const row of result.rows){
        if(!row.cold_archive_id){yield row.line as string;continue;}
        if(!options.dataDir)throw new Error('cold event export requires dataDir; original payload was not exported');
        if(!/^[0-9a-f-]{36}$/.test(row.cold_archive_id))throw new Error('invalid cold archive ID');
        yield await archive.read(path.join(options.dataDir,'storage','events',row.cold_archive_id),row.manifest_hash,row.seq);
      }
    }
  } finally { archive.clear();await client.query('CLOSE storage_events').catch(() => {}); }
}

export async function sampleTaskEventSeqs(client: PoolClient, scope: {sql: string; values: unknown[]}, updates = 16000, windows = 8): Promise<string[]> {
  if (!Number.isSafeInteger(updates) || updates < 0 || updates > 200000 || !Number.isSafeInteger(windows) || windows < 1 || windows > 64) throw new Error('invalid sample size');
  const semantic = await client.query(`SELECT e.seq::text FROM business_events e WHERE ${scope.sql} AND e.event_type<>'message_update' ORDER BY e.seq`, scope.values);
  const ids = new Set<string>(semantic.rows.map(r => r.seq));
  const bounds = (await client.query(`SELECT min(e.seq)::text AS lo,max(e.seq)::text AS hi FROM business_events e WHERE ${scope.sql}`, scope.values)).rows[0];
  if (bounds.lo === null) return [];
  const lo = BigInt(bounds.lo), hi = BigInt(bounds.hi), width = hi - lo + 1n;
  for (let i = 0; i < windows; i++) {
    const start = lo + width * BigInt(i) / BigInt(windows), end = lo + width * BigInt(i + 1) / BigInt(windows);
    const count = Math.floor(updates / windows) + (i < updates % windows ? 1 : 0);
    if (!count) continue;
    const rows = await client.query(`SELECT e.seq::text FROM business_events e WHERE ${scope.sql}
      AND e.seq >= $5 AND e.seq < $6 AND e.event_type='message_update' ORDER BY e.seq LIMIT $7`, [...scope.values, String(start), String(end), count]);
    for (const row of rows.rows) ids.add(row.seq);
  }
  return [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}
