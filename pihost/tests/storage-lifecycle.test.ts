import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm,readFile,writeFile,mkdir,utimes,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {storagePolicy} from '../src/storage/policy.ts';
import {archiveColdEvents,coldPath,eventPage,restoreColdArchive} from '../src/storage/cold-events.ts';
import {collectStorageOrphans,storageStatus} from '../src/storage/lifecycle.ts';
import {ArtifactStore,objectFile} from '../src/storage/artifacts.ts';
import {migrateRecordings} from '../src/storage/migrate-recordings.ts';
import {expandRecordBodies,legacyBodyFields} from '../src/storage/record-body.ts';
import {WorkerHandoffs} from '../src/domains/tasks/handoff.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {getTool,runTool} from '../src/domains/tools/gate.ts';
import {workerSessionTooLarge} from '../src/pi/session-size.ts';
import {appendEvent,backfillDeadLetters} from '../src/events/ledger.ts';
import {compressCheckpoint,prepareNativeCheckpoint} from '../src/storage/checkpoints.ts';
import {taskEventScope,taskEventLines} from '../src/storage/task-events.ts';
import {TaskArchives} from '../src/domains/tasks/archives.ts';
import {ArchiveRowReader} from '../src/storage/event-archive.ts';

const config=loadConfig(),admin=new Pool({connectionString:config.database.dsn}),schema=`wormhole_lifecycle_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
const root=await mkdtemp(path.join(tmpdir(),'wormhole-lifecycle-')),policy=storagePolicy({hotDays:0,eventBatchRows:100});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});});
const task=async(status='failed')=>Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('fixture','verify bounded recovery',$1) RETURNING id",[status])).rows[0].id);

test('cold payload publication is lossless, replay merges hot/cold, UID dedup and projection receipts survive',async()=>{
  const id=await task(),uid=randomUUID(),business=`task-${id}-intent-1`;
  await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload,event_uid,ts)
    SELECT 'worker',$1,CASE WHEN i=3 THEN 'message_end' ELSE 'message_update' END,jsonb_build_object('delta',repeat('🧪',200)||i),CASE WHEN i=1 THEN $2 ELSE NULL END,now()-interval '2 days' FROM generate_series(1,5) i`,[business,uid]);
  const original=(await eventPage(pool,'worker',business,'0')).map(row=>({seq:row.seq,event_type:row.event_type,payload:row.payload}));
  const seq=original[0]!.seq;await pool.query('INSERT INTO pi_activity_projected(event_seq) VALUES($1)',[seq]);
  const result=await archiveColdEvents(pool,root,policy);assert.equal(result.rows,4);assert.ok(result.storedBytes<result.rawBytes);
  const replay=await eventPage(pool,'worker',business,'0',root);assert.deepEqual(replay.map(row=>({seq:row.seq,event_type:row.event_type,payload:row.payload})),original);
  const cache=new ArchiveRowReader(),page1=await eventPage(pool,'worker',business,'0',root,2,cache),page2=await eventPage(pool,'worker',business,page1.at(-1).seq,root,3,cache);
  assert.equal(page1.length+page2.length,5);assert.equal(cache.stats.framesRead,1,'SSE-sized pages reuse the same verified frame');cache.clear();
  const c=await pool.connect();try{await c.query('BEGIN READ ONLY');const scope=await taskEventScope(c,String(id)),lines=[];for await(const line of taskEventLines(c,scope,{dataDir:root}))lines.push(JSON.parse(line));assert.deepEqual(lines.map(row=>row.payload),original.map(row=>row.payload));await c.query('ROLLBACK');}finally{c.release();}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pi_activity_projected WHERE event_seq=$1',[seq])).rows[0].n,1);
  assert.equal((await pool.query('SELECT payload FROM business_events WHERE seq=$1',[seq])).rows[0].payload.delta,undefined);
  const dlq=path.join(root,'duplicate.jsonl');await writeFile(dlq,JSON.stringify({event_uid:uid,ts:new Date().toISOString(),business_kind:'worker',business_id:business,event_type:'message_update',payload:{changed:true}})+'\n');
  assert.equal(await backfillDeadLetters(pool,dlq),0,'cold stubs retain event_uid uniqueness');
  assert.equal((await archiveColdEvents(pool,root,policy)).rows,0);
  await assert.rejects(eventPage(pool,'worker',business,'0'),/not configured/);
  const directory=coldPath(root,result.id!),frame=path.join(directory,(await readdir(directory)).find(name=>name.endsWith('.frame'))!),bytes=await readFile(frame);
  await writeFile(frame,Buffer.alloc(bytes.length));await assert.rejects(eventPage(pool,'worker',business,'0',root),/checksum/);await writeFile(frame,bytes);
  const manifest=path.join(directory,'manifest.json'),manifestBytes=await readFile(manifest);await writeFile(manifest,Buffer.concat([manifestBytes,Buffer.from(' ')]));await assert.rejects(eventPage(pool,'worker',business,'0',root),/manifest checksum/);await writeFile(manifest,manifestBytes);
});

test('active tasks, unprojected events and age window are excluded; aborted migration leaves source intact',async()=>{
  const active=await task('running'),ended=await task();
  await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload,ts) VALUES
    ('worker',$1,'message_update','{"delta":"active"}',now()-interval '2 days'),
    ('worker',$2,'message_update','{"_activity":{"runId":"pending","ordinal":0}}',now()-interval '2 days'),
    ('worker',$2,'message_update','{"delta":"recent"}',now())`,[`task-${active}-intent-1`,`task-${ended}-intent-1`]);
  assert.equal((await archiveColdEvents(pool,root,storagePolicy({hotDays:1}))).rows,0);
  const signal=AbortSignal.abort();await assert.rejects(archiveColdEvents(pool,root,policy,signal));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND cold_archive_id IS NOT NULL',[`task-${active}-intent-1`])).rows[0].n,0);
});

test('legacy migration preserves all six unequal/null/empty fields, is idempotent and aborts atomically',async()=>{
  const bodies={request_text:'alias A',response_text:'alias B',request_body:'canonical '+('x'.repeat(10000)),response_body:'',raw_request:null,raw_response:'data: 🧪\r\n\\u0000'};
  const id=(await pool.query(`INSERT INTO llm_records(${legacyBodyFields.join(',')}) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,legacyBodyFields.map(key=>bodies[key]))).rows[0].id;
  await assert.rejects(migrateRecordings(pool,8,AbortSignal.abort()));
  assert.equal((await pool.query('SELECT body_storage FROM llm_records WHERE id=$1',[id])).rows[0].body_storage,null);
  assert.equal((await migrateRecordings(pool)).rows,1);
  const row=(await pool.query('SELECT * FROM llm_records WHERE id=$1',[id])).rows[0],expanded=await expandRecordBodies(row);
  for(const key of legacyBodyFields)assert.equal(expanded[key],bodies[key]);
  assert.equal(row.request_text,'');assert.ok(row.body_storage.length<row.body_raw_bytes/5);assert.equal((await migrateRecordings(pool)).rows,0);
});

test('large tool results share one compressed object, paginate exactly and enforce task ownership',async()=>{
  const id=await task(),other=await task(),store=new ArtifactStore(pool,root),value={content:[{type:'text',text:'中文 🧪\r\n'.repeat(10000)}],details:{toolCallId:42,large:'x'.repeat(50000)}};
  const small=await store.externalize(id,1,value,32768);assert.ok(JSON.stringify(small).length<4000);assert.ok(small.details.artifact.storedBytes<1000);
  const second=await store.externalize(id,2,{...value,details:{...value.details,toolCallId:43}},32768),again=second.details.artifact;assert.equal(again.hash,small.details.artifact.hash);assert.equal(second.details.toolCallId,43);assert.equal(small.details.toolCallId,42);
  const files=(await readdir(path.dirname(objectFile(root,again.hash,again.codec)))).filter(name=>!name.startsWith('.'));assert.equal(files.length,1);
  let offset=0,text='';do{const page=await store.read(id,again.hash,offset,777);assert.ok(page.nextOffset>offset);text+=page.text;offset=page.nextOffset;if(page.done)break;}while(true);
  const restored=JSON.parse(text);restored.details.toolCallId=small.details.toolCallId;assert.deepEqual(restored,value);await assert.rejects(store.read(other,again.hash),/belong/);
  await assert.rejects(store.read(id,'../secret'),/belong/);await assert.rejects(store.read(id,again.hash,0,17000),/range/);
});

test('worker handoff retains explicit next step through runtime observation and refuses foreign intent/evidence',async()=>{
  const id=await task('running'),other=await task(),graph=new ExplorationService(pool);await graph.ensure(id);await graph.ensure(other);
  const intent=await graph.addIntent(id,{summary:'resume this direction',stop_condition:'verified outcome'}),foreign=await graph.addIntent(other,{summary:'other direction'});
  const handoffs=new WorkerHandoffs(pool,root);handoffs.register();
  await handoffs.save(id,intent,{progress:'observed negative control',next_step:'inspect saved response without rerunning mutation'});
  await handoffs.observe(id,intent,{outcome:'interrupted',summary:'last visible output'});
  const packet=await handoffs.packet(id,intent);assert.equal(packet.checkpoint.checkpoint.next_step,'inspect saved response without rerunning mutation');assert.equal(packet.checkpoint.revision,'2');
  assert.ok(Buffer.byteLength(JSON.stringify(packet))<32768);await assert.rejects(handoffs.save(other,intent,{}),/belong/);await assert.rejects(handoffs.packet(id,foreign),/unavailable/);
  await assert.rejects(handoffs.save(id,intent,{progress:'x'.repeat(10000)}),/8192/);
  await assert.rejects(getTool('save_worker_checkpoint')!.execute({progress:'a',next_step:'b',evidence_ids:[foreign]},{taskId:id,intentId:intent,businessKind:'worker',businessId:`task-${id}-intent-${intent}`,agentKey:'worker'}),/evidence IDs/);
  const denied=await runTool(pool,'save_worker_checkpoint',{progress:'a',next_step:'b'},{taskId:id,intentId:intent,businessKind:'worker',businessId:'fixture',agentKey:'worker',canExecute:async()=>false});assert.equal(denied.status,'blocked');
});

test('orphan retention only removes aged unreferenced managed paths; latest native checkpoint size chooses rotation',async()=>{
  const abandoned=path.join(root,'storage','events',randomUUID());await mkdir(abandoned);await writeFile(path.join(abandoned,'partial'),'pending');
  await utimes(abandoned,new Date(0),new Date(0));const unknown=path.join(root,'storage','events','user-file');await writeFile(unknown,'keep');await utimes(unknown,new Date(0),new Date(0));
  assert.equal(await collectStorageOrphans(pool,root,policy),1);assert.equal(await readFile(unknown,'utf8'),'keep');
  const status=await storageStatus(pool);assert.equal(status.archives.segments,'1');
  const sessions=path.join(root,'native');await mkdir(sessions);await writeFile(path.join(sessions,'older.jsonl'),'x'.repeat(100000));await utimes(path.join(sessions,'older.jsonl'),new Date(0),new Date(0));await writeFile(path.join(sessions,'newer.jsonl'),'small');
  assert.equal(await workerSessionTooLarge(sessions,1000),false);await writeFile(path.join(sessions,'newer.jsonl'),'x'.repeat(100001));assert.equal(await workerSessionTooLarge(sessions,1000),true);
});

test('policy rejects invalid budgets and keeps explicit zero hot-days',()=>{assert.equal(storagePolicy({hotDays:0}).hotDays,0);assert.throws(()=>storagePolicy({toolInlineBytes:-1}));assert.throws(()=>storagePolicy({enabled:'yes' as any}));});

test('inactive native checkpoint compresses losslessly and resumes by restoring the latest; corruption fails closed',async()=>{
  const directory=path.join(root,'checkpoint-roundtrip');await mkdir(directory);
  const filename='2026-10-15_session.jsonl',source=Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\n'+JSON.stringify({type:'message',content:'完整 🧪\r\n'.repeat(20000)})+'\n');
  await writeFile(path.join(directory,filename),source);assert.equal(await compressCheckpoint(directory,filename),true);
  assert.ok(!(await readdir(directory)).includes(filename));assert.equal(await prepareNativeCheckpoint(directory,1024),true,'oversized native state uses the structured handoff without loading JSONL');
  assert.equal(await prepareNativeCheckpoint(directory,source.length+1),false);assert.deepEqual(await readFile(path.join(directory,filename)),source);
  assert.equal(await compressCheckpoint(directory,filename),true);const packed=(await readdir(directory)).find(name=>name.endsWith('.gtygz'))!;
  await writeFile(path.join(directory,packed),'corrupt');await assert.rejects(prepareNativeCheckpoint(directory,source.length+1),/checksum/);
  assert.ok(!(await readdir(directory)).includes(filename),'damaged archives never become native checkpoints');
});

test('explicit cold restoration is atomic on cancellation and restores exact JSON numbers without duplicating identities',async()=>{
  const id=await task(),business=`task-${id}-intent-1`;
  await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload,event_uid,ts)
    VALUES('worker',$1,'message_update','{"exact":9007199254740993123,"delta":"restore"}',$2,now()-interval '1 hour')`,[business,randomUUID()]);
  const before=(await pool.query('SELECT payload::text AS value FROM business_events WHERE business_id=$1',[business])).rows[0].value;
  // A five-day age window selects only this fixture's ten-day-old event.
  await pool.query("UPDATE business_events SET ts=now()-interval '10 days' WHERE business_id=$1",[business]);
  const result=await archiveColdEvents(pool,root,storagePolicy({hotDays:5}));assert.equal(result.rows,1);
  await assert.rejects(restoreColdArchive(pool,root,result.id!,AbortSignal.abort()));
  assert.equal((await pool.query('SELECT cold_archive_id FROM business_events WHERE business_id=$1',[business])).rows[0].cold_archive_id,result.id);
  assert.equal((await restoreColdArchive(pool,root,result.id!)).restored,1);assert.equal((await restoreColdArchive(pool,root,result.id!)).restored,0);
  assert.equal((await pool.query('SELECT payload::text AS value FROM business_events WHERE business_id=$1',[business])).rows[0].value,before);
});

test('inactive unbound conversations and old orphan task streams archive without recreating business objects',async()=>{
  const conv=(await pool.query("INSERT INTO conversations(agent_key,title,updated_at) VALUES('auto','cold fixture',now()-interval '40 days') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload,ts) VALUES
    ('chat',$1,'message_update','{"delta":"old chat"}',now()-interval '40 days'),
    ('worker','task-987654321-intent-1','message_update','{"delta":"orphan"}',now()-interval '40 days')`,['conv-'+conv]);
  const coldPolicy=storagePolicy({hotDays:30});assert.equal((await archiveColdEvents(pool,root,coldPolicy)).rows,1);assert.equal((await archiveColdEvents(pool,root,coldPolicy)).rows,1);
  assert.equal((await eventPage(pool,'chat','conv-'+conv,'0',root))[0].payload.delta,'old chat');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE id=987654321')).rows[0].n,0);
});

test('manual task archive and restore preserves structured worker checkpoint and artifact references',async()=>{
  const id=await task(),graph=new ExplorationService(pool);await graph.ensure(id);const intent=await graph.addIntent(id,{summary:'archive handoff fixture'}),handoffs=new WorkerHandoffs(pool,root);
  await handoffs.save(id,intent,{progress:'saved evidence',next_step:'inspect existing artifact'});
  const artifact=await new ArtifactStore(pool,root).put(id,intent,{content:'retained task evidence'}),archives=new TaskArchives(pool,root);
  const job=await archives.queue(id);await archives.runOne();assert.equal((await pool.query('SELECT count(*)::int AS n FROM worker_handoffs WHERE intent_id=$1',[intent])).rows[0].n,0);
  await archives.queueRestore(Number(job.id));await archives.runOne();
  assert.equal((await handoffs.packet(id,intent)).checkpoint.checkpoint.next_step,'inspect existing artifact');
  assert.ok((await new ArtifactStore(pool,root).read(id,artifact.hash)).text.includes('retained task evidence'));
});
