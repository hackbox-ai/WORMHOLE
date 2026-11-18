/** Read-only source inventory/export/benchmark. Restore is allowed only into a
 * different database and a newly created private schema. Never prunes source data.
 */
import {readFile, mkdir, writeFile, stat, open} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {EventArchiveWriter, readEventArchive, readArchiveManifest,verifyEventArchive} from '../src/storage/event-archive.ts';
import {hasZstd, type StorageCodec} from '../src/storage/codec.ts';
import {taskEventScope, taskEventLines, sampleTaskEventSeqs} from '../src/storage/task-events.ts';
import {durableSessionEvent} from '../src/pi/event-payload.ts';
import {compactTaskEvents} from '../src/storage/compact-events.ts';
import {packRecordBodies,expandRecordBodies,type RecordBodies} from '../src/storage/record-body.ts';

const args = process.argv.slice(2), mode = args.shift();
function option(name: string, fallback?: string): string {
  const at = args.indexOf('--' + name);
  if (at === -1) { if (fallback !== undefined) return fallback; throw new Error(`missing --${name}`); }
  const value = args[at + 1]; if (!value || value.startsWith('--')) throw new Error(`missing --${name} value`); return value;
}
const codecs: StorageCodec[] = hasZstd() ? ['gzip', 'zstd'] : ['gzip'];
async function configPool(filename: string): Promise<Pool> {
  const config = JSON.parse(await readFile(filename, 'utf8'));
  if (!config.database?.dsn) throw new Error('configuration has no database');
  return new Pool({connectionString: config.database.dsn, max: 1, application_name: 'wormhole-storage-' + mode,
    statement_timeout: 30000, connectionTimeoutMillis: 5000});
}
async function verify(directory: string) {
  const m = await readArchiveManifest(directory), started = performance.now();
  const {rows} = await verifyEventArchive(directory);
  if (rows !== m.rows) throw new Error('archive verification count mismatch');
  const middle = m.blocks[Math.floor(m.blocks.length / 2)], rangeStarted = performance.now();
  let rangeRows = 0;
  if (middle) for await (const _line of readEventArchive(directory, {fromSeq: middle.firstSeq, toSeq: middle.lastSeq})) rangeRows++;
  return {rows, rawHash: m.rawHash, verified: true, verifyMs: rangeStarted - started,
    rangeReadMs: performance.now() - rangeStarted, rangeRows, blocks: m.blocks.length,
    rawBytes: m.rawBytes, frameBytes: m.storedBytes, manifestBytes: (await stat(path.join(directory, 'manifest.json'))).size};
}

if (mode === 'compact') {
  // Reserve the audit file before any mutation; an existing output cannot make
  // a successful migration appear to fail after commit.
  const audit=await open(option('output'),'wx',0o600);
  const pool=await configPool(option('config')),client=await pool.connect();let lastProgress=performance.now();
  try{
    const result=await compactTaskEvents(client,option('archive'),args.includes('--apply'),(rows,phase)=>{
      if(performance.now()-lastProgress>15000){console.error(JSON.stringify({progress:phase,rows}));lastProgress=performance.now();}
    });
    await audit.writeFile(JSON.stringify(result,null,2)+'\n');await audit.sync();console.log(JSON.stringify(result));
  }catch(error){await audit.writeFile(JSON.stringify({applied:null,error:String((error as Error).message),note:'inspect source state before retrying'})+'\n');throw error;}
  finally{await audit.close();client.release();await pool.end();}
} else if (mode === 'benchmark-recordings') {
  const pool=await configPool(option('config')),client=await pool.connect(),taskId=option('task');
  if(!/^[1-9]\d*$/.test(taskId))throw new Error('invalid task ID');
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`DECLARE recordings NO SCROLL CURSOR FOR SELECT request_text,response_text,request_body,response_body,raw_request,raw_response
      FROM llm_records WHERE task_id=$1 ORDER BY id`,[taskId]);
    const results=codecs.map(codec=>({codec,rows:0,storedBytes:0,envelopeBytes:0,compressionMs:0,roundTripVerified:true}));
    let rows=0,legacyTextBytes=0;
    while(true){const batch=(await client.query('FETCH FORWARD 4 FROM recordings')).rows;if(!batch.length)break;
      for(const row of batch){
        legacyTextBytes+=Object.values(row).reduce<number>((sum,value)=>sum+(typeof value==='string'?Buffer.byteLength(value):0),0);
        const bodies:RecordBodies={request_body:row.request_body,response_body:row.response_body,raw_request:row.raw_request,raw_response:row.raw_response};
        for(const result of results){
          const start=performance.now(),body=await packRecordBodies(bodies,result.codec);result.compressionMs+=performance.now()-start;
          result.rows++;result.storedBytes+=body.bytes.length;result.envelopeBytes+=body.rawBytes;
          const restored=await expandRecordBodies({body_storage:body.bytes,body_codec:body.codec,body_raw_bytes:body.rawBytes,body_sha256:body.hash});
          for(const key of Object.keys(bodies) as (keyof RecordBodies)[])if(restored[key]!==bodies[key])throw new Error('recording round-trip mismatch');
        }
        rows++;
      }
    }
    const report={taskId,rows,legacyTextBytes,results,sourceWrites:0,note:'legacyTextBytes is six text fields in UTF-8, not PostgreSQL physical table size; four canonical fields are retained exactly'};
    await writeFile(option('output'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
    await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end();}
} else if (mode === 'verify') {
  console.log(JSON.stringify(await verify(option('archive'))));
} else if (mode === 'restore') {
  const source = await configPool(option('source-config')), target = await configPool(option('target-config'));
  const schema = option('schema');
  if (!/^storage_restore_[a-z0-9_]+$/.test(schema)) throw new Error('restore requires a storage_restore_* schema');
  const client = await target.connect();
  try {
    const identitySql = 'SELECT current_database() AS database,inet_server_addr()::text AS host,inet_server_port() AS port';
    const a = (await source.query(identitySql)).rows[0], b = (await client.query(identitySql)).rows[0];
    if (a.database === b.database) throw new Error('restore target must have a different database name');
    const directory = option('archive'), manifest = await readArchiveManifest(directory);
    const owner = String(manifest.source.taskId ?? '');
    if (!/^[1-9]\d*$/.test(owner)) throw new Error('archive has no task identity');
    await client.query('BEGIN');
    await client.query("SET LOCAL timezone='UTC'");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.events (
      seq bigint PRIMARY KEY,ts timestamptz NOT NULL,business_kind text NOT NULL,business_id text NOT NULL,
      event_type text NOT NULL,payload jsonb NOT NULL,event_uid text UNIQUE,source text NOT NULL,activity_projected boolean NOT NULL)`);
    let batch: string[] = [], restored = 0;
    const flush = async () => {
      if (!batch.length) return;
      await client.query(`INSERT INTO ${schema}.events SELECT r.* FROM jsonb_array_elements($1::jsonb) j,
        LATERAL jsonb_populate_record(NULL::${schema}.events,j) r`, ['[' + batch.join(',') + ']']);
      restored += batch.length; batch = [];
    };
    for await (const line of readEventArchive(directory)) { batch.push(line); if (batch.length >= 32) await flush(); }
    await flush();
    await client.query(`DECLARE restored_events NO SCROLL CURSOR FOR SELECT (to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text AS line FROM ${schema}.events e ORDER BY seq`);
    const hash = createHash('sha256'); let checked = 0;
    while (true) { const result = await client.query('FETCH FORWARD 32 FROM restored_events'); if (!result.rows.length) break;
      for (const row of result.rows) { hash.update(row.line + '\n'); checked++; }
    }
    const restoredHash = hash.digest('hex');
    if (restored !== manifest.rows || checked !== restored || restoredHash !== manifest.rawHash) throw new Error('restored database hash mismatch');
    await client.query('COMMIT');
    console.log(JSON.stringify({schema, rows: restored, rawHash: restoredHash, databaseRoundTripVerified: true, sourceWrites: 0}));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); await target.end(); await source.end(); }
} else if (['inventory', 'benchmark', 'export'].includes(mode ?? '')) {
  const pool = await configPool(option('config')), client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone='UTC'");
    const taskId = option('task'), scope = await taskEventScope(client, taskId);
    const task = (await client.query('SELECT id::text,status,paused,deleted_at,updated_at FROM tasks WHERE id=$1', [taskId])).rows[0];
    if (!task) throw new Error('task not found');
    const stats = (await client.query(`SELECT event_type,count(*)::text AS rows,
      sum(pg_column_size(payload))::text AS live_stored_payload_bytes,min(seq)::text AS first_seq,max(seq)::text AS last_seq
      FROM business_events e WHERE ${scope.sql} GROUP BY event_type ORDER BY sum(pg_column_size(payload)) DESC`, scope.values)).rows;
    const tables = (await client.query(`SELECT c.relname,c.reltuples::bigint::text AS estimated_rows,
      pg_relation_size(c.oid)::text AS heap_bytes,pg_indexes_size(c.oid)::text AS index_bytes,pg_total_relation_size(c.oid)::text AS total_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`)).rows;
    const source = {taskId, task, sourceWrites: 0, ownership: 'task identity + task-N boundary + bound conversations', stats, tables,
      note: 'live_stored_payload_bytes excludes tuple/index/TOAST overhead and dead versions; it is not exact per-task physical disk usage'};
    if (mode === 'inventory') {
      const output = option('output'); await writeFile(output, JSON.stringify(source, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      console.log(JSON.stringify({output, sourceWrites: 0, stats, tables}));
    } else {
      if (['running', 'queued'].includes(task.status)) throw new Error('export/benchmark requires an ended task');
      const output = path.resolve(option('output')); await mkdir(output, {mode: 0o700});
      const isSample = mode === 'benchmark', sampleSeqs = isSample ? await sampleTaskEventSeqs(client, scope, Number(option('updates', '16000')), Number(option('windows', '8'))) : undefined;
      const selectedCodecs = mode === 'export' ? [option('codec', hasZstd() ? 'zstd' : 'gzip') as StorageCodec] : codecs;
      if (selectedCodecs.some(c => !['gzip','zstd'].includes(c))) throw new Error('unsupported export codec');
      const variants: {name: string; writer: EventArchiveWriter; compact: boolean}[] = [];
      for (const codec of selectedCodecs) for (const compact of isSample ? [false, true] : [false]) {
        const name = `${compact ? 'delta' : 'original'}-${codec}`;
        variants.push({name, compact, writer: await EventArchiveWriter.create(path.join(output, name), codec,
          {taskId, sample: isSample, representation: compact ? 'current-durableSessionEvent-v2' : 'exact-source-json',
            sampling: isSample ? 'all semantic events + streaming updates from distributed sequence windows' : 'complete task event scope'})});
      }
      let rows = 0, lastProgress = performance.now(), semanticPreserved = 0;
      const typeCounts: Record<string, number> = {}, started = performance.now();
      for await (const line of taskEventLines(client, scope, {sampleSeqs,dataDir:config.dataDir})) {
        let compactLine: string | undefined;
        if (isSample) {
          const row = JSON.parse(line);
          typeCounts[row.event_type] = (typeCounts[row.event_type] ?? 0) + 1;
          // Only v1 native message updates carry cumulative snapshots. All other
          // events are preserved byte-for-byte in the comparison representation.
          if (row.event_type === 'message_update' && row.payload?.type === 'message_update' && row.payload?.storage_version !== 2) {
            compactLine = JSON.stringify({...row, payload: durableSessionEvent(row.payload)});
          } else { compactLine = line; semanticPreserved++; }
        }
        for (const variant of variants) await variant.writer.append(variant.compact ? compactLine! : line);
        rows++;
        if (performance.now() - lastProgress > 15000) { console.error(JSON.stringify({progress: 'export', rows, rawBytes: variants[0]!.writer.manifest.rawBytes})); lastProgress = performance.now(); }
      }
      const summaries = [];
      for (const variant of variants) {
        const manifest = await variant.writer.finish();
        summaries.push({variant: variant.name, compressionMs: manifest.compressionMs, ...await verify(variant.writer.directory)});
      }
      const originalHashes = new Set(summaries.filter(v => v.variant.startsWith('original')).map(v => v.rawHash));
      const deltaHashes = new Set(summaries.filter(v => v.variant.startsWith('delta')).map(v => v.rawHash));
      if (originalHashes.size !== 1 || deltaHashes.size > 1) throw new Error('codec-independent restoration mismatch');
      const report = {...source, mode, sample: isSample, rows, typeCounts, semanticPreservedByteForByte: semanticPreserved,
        deltaRepresentationIsNotOriginalSnapshotBackup: true, elapsedMs: performance.now() - started,
        peakRssBytes: process.resourceUsage().maxRSS * 1024, variants: summaries};
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      console.log(JSON.stringify({output, rows, sample: isSample, sourceWrites: 0, variants: summaries, elapsedMs: report.elapsedMs, peakRssBytes: report.peakRssBytes}));
    }
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); await pool.end(); }
} else {
  throw new Error('usage: task-storage.ts inventory|benchmark|export --config FILE --task ID --output NEW_PATH; verify --archive DIR; compact --config FILE --archive DIR --output FILE [--apply]; restore --source-config FILE --target-config FILE --archive DIR --schema storage_restore_NAME');
}
