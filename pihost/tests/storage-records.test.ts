import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {LlmRecords,type LlmCallEntry} from '../src/domains/observability/records.ts';
import {ObservabilityService} from '../src/domains/observability/service.ts';
import {taskEventScope,taskEventLines,sampleTaskEventSeqs} from '../src/storage/task-events.ts';
import {EventArchiveWriter,readEventArchive} from '../src/storage/event-archive.ts';
import {compactTaskEvents} from '../src/storage/compact-events.ts';
import {durableSessionEvent} from '../src/pi/event-payload.ts';

const config=loadConfig(),schema=`wormhole_storage_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:config.database.dsn});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
const records=new LlmRecords(pool);
test('new compressed recordings retain wire bytes, legacy/API views and usage; lists do not read bodies',async()=>{
  const request=JSON.stringify({system:'稳定规则'.repeat(400),messages:[{role:'user',content:'🧪'.repeat(5000)}]});
  const entry:LlmCallEntry={model:'fixture',profileId:null,profileName:'local',sessionId:'storage-call',taskId:'44',worker:'worker',explorationId:null,
    input:12,output:4,cacheRead:8,cacheWrite:2,latencyMs:3,status:'ok',error:'',stopReason:'end_turn',text:'结果',thinking:'思考',
    rawRequest:request,rawResponse:'data: {"delta":"结果"}\r\n\r\n',requestBody:request};
  await records.recordCall(entry,true);
  const row=(await pool.query("SELECT * FROM llm_records WHERE session_id='storage-call'")).rows[0];
  assert.equal(row.request_text,'');assert.equal(row.response_text,'');assert.equal(row.request_body,null);assert.equal(row.raw_request,null);
  assert.ok(row.body_storage.length<row.body_raw_bytes/5);
  const detail=await records.detail(row.id);assert.equal(detail!.raw_request,request);assert.equal(detail!.request_body,request);assert.equal(detail!.raw_response,entry.rawResponse);
  assert.deepEqual(JSON.parse(String(detail!.response_body)),{text:'结果',stop_reason:'end_turn',usage:{input_tokens:12,output_tokens:4,cache_read_tokens:8,cache_write_tokens:2},thinking:'思考'});
  const legacy=await new ObservabilityService(pool).llmRecordDetail(Number(row.id));assert.equal(legacy!.request_text,request);assert.ok(!('body_storage'in legacy!));
  const list=await records.list({task:'44'});assert.equal(list.records.length,1);assert.ok(!('raw_request'in list.records[0]!));
  const usage=(await pool.query("SELECT count(*)::int AS n FROM llm_usage WHERE business_id='storage-call'")).rows[0];assert.equal(usage.n,1);
  await records.recordCall({...entry,sessionId:'storage-off'},false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM llm_records WHERE session_id='storage-off'")).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM llm_usage WHERE business_id='storage-off'")).rows[0].n,1);
  const old=(await pool.query("INSERT INTO llm_records(request_body,raw_response) VALUES('old body','old wire') RETURNING id")).rows[0].id;
  assert.equal((await records.detail(old))!.raw_response,'old wire');
  await pool.query('UPDATE llm_records SET body_sha256=$2 WHERE id=$1',[row.id,'0'.repeat(64)]);
  await assert.rejects(records.detail(row.id),/checksum/);
  assert.equal((await records.list({task:'44'})).records.length,1,'corrupt detail does not block summary listing');
});
test('task ownership excludes similar IDs; read-only cursor export and independent archive restore preserve all fields',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-db-')),client=await pool.connect();
  try{
    const task=(await pool.query("INSERT INTO tasks(name,goal,status) VALUES('storage','fixture','failed') RETURNING id")).rows[0].id as string;
    const other=task+'0',conv=(await pool.query("INSERT INTO conversations(agent_key,title,task_id) VALUES('pentest','storage',$1) RETURNING id",[task])).rows[0].id;
    for(const [kind,id,event]of [['task',task,'task_created'],['planner',`task-${task}`,'message_end'],['worker',`task-${task}-intent-1`,'message_update'],['chat',`conv-${conv}`,'tool_execution_end'],['worker',`task-${other}-intent-1`,'message_update'],['task',other,'task_created']]){
      await pool.query('INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES($1,$2,$3,$4)',[kind,id,event,JSON.stringify({type:event,value:'🧪',integer:'9007199254740993123'})]);
    }
    const before=(await pool.query('SELECT count(*)::int AS n FROM business_events')).rows[0].n;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone='UTC'");
    const scope=await taskEventScope(client,String(task)),seqs=await sampleTaskEventSeqs(client,scope,8,4);
    assert.equal(seqs.length,4);
    const writer=await EventArchiveWriter.create(path.join(root,'events'),'gzip',{taskId:String(task)},1024),original:string[]=[];
    for await(const line of taskEventLines(client,scope)){original.push(line);await writer.append(line);}
    await writer.finish();await client.query('ROLLBACK');
    assert.equal(original.length,4);assert.equal((await pool.query('SELECT count(*)::int AS n FROM business_events')).rows[0].n,before);
    await client.query('BEGIN');await client.query("SET LOCAL timezone='UTC'");
    await client.query('CREATE TEMP TABLE restored_events (LIKE business_events INCLUDING ALL) ON COMMIT DROP');
    for await(const line of readEventArchive(writer.directory))await client.query('INSERT INTO restored_events SELECT r.* FROM jsonb_populate_record(NULL::restored_events,$1::jsonb) r',[line]);
    const restored=(await client.query("SELECT (to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text AS line FROM restored_events e ORDER BY seq")).rows.map(r=>r.line);
    assert.deepEqual(restored,original);await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await rm(root,{recursive:true,force:true});}
});

test('historical compaction requires full matching archive and an ended task; only snapshots change atomically',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-compact-')),client=await pool.connect();
  try{
    const task=String((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('compact','fixture','failed') RETURNING id")).rows[0].id);
    const originalPayloads=[
      {type:'message_update',storage_version:2,assistantMessageEvent:{type:'text_delta',delta:'已有增量一'}},
      {type:'message_update',storage_version:2,assistantMessageEvent:{type:'text_delta',delta:'已有增量二'}},
      {type:'message_update',message:{content:'累计快照'.repeat(100)},assistantMessageEvent:{type:'text_delta',delta:'片段',partial:{content:'另一份累计快照'.repeat(100)}},_activity:{runId:'original',ordinal:0}},
      {type:'message_update',assistantMessageEvent:{type:'toolcall_delta',delta:'{"n":1}',partial:{huge:'x'.repeat(1000)}},index:0},
      {type:'message_update',message:{content:'没有 assistantMessageEvent'}},
      {type:'message_update',assistantMessageEvent:null,message:{content:'null assistantMessageEvent'}},
      {type:'message_end',message:{role:'assistant',content:[{type:'text',text:'完整消息'}]}},
      {type:'tool_execution_end',result:{content:[{type:'text',text:'完整工具结果'}]},isError:false}
    ];
    for(const payload of originalPayloads)await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('worker',$1,$2,$3)",[`task-${task}-intent-1`,payload.type,JSON.stringify(payload)]);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");
    const scope=await taskEventScope(client,task),writer=await EventArchiveWriter.create(path.join(root,'original'),'zstd',{taskId:task,sample:false,representation:'exact-source-json'},1024);
    const originals:string[]=[];for await(const line of taskEventLines(client,scope)){originals.push(line);await writer.append(line);}
    await writer.finish();await client.query('ROLLBACK');
    const plan=await compactTaskEvents(client,writer.directory);assert.equal(plan.applied,false);assert.equal(plan.changed,0);
    const seq=JSON.parse(originals[0]!).seq;
    await pool.query("UPDATE business_events SET payload=payload||'{\"changed\":true}' WHERE seq=$1",[seq]);
    await assert.rejects(compactTaskEvents(client,writer.directory,true),/source changed/);
    await pool.query('UPDATE business_events SET payload=$2 WHERE seq=$1',[seq,JSON.stringify(originalPayloads[0])]);
    const progress:number[]=[];
    const result=await compactTaskEvents(client,writer.directory,true,(n,phase)=>{if(phase==='compact')progress.push(n);},2);
    assert.equal(result.changed,4);assert.equal(result.eligibleUpdates,4);assert.equal(progress[0],0,'v2-only first page does not stop scanning');
    const actual=(await pool.query('SELECT * FROM business_events e WHERE '+scope.sql+' ORDER BY seq',scope.values)).rows;
    assert.equal(actual.length,originals.length);
    for(let i=0;i<actual.length;i++){
      const original=JSON.parse(originals[i]!);
      assert.equal(actual[i]!.seq,original.seq);assert.equal(actual[i]!.event_uid,original.event_uid);assert.equal(actual[i]!.source,original.source);
      assert.equal(actual[i]!.ts.toISOString(),new Date(original.ts).toISOString());
      assert.deepEqual(actual[i]!.payload,durableSessionEvent(originalPayloads[i]!));
    }
    const backup=[];for await(const line of readEventArchive(writer.directory))backup.push(line);assert.deepEqual(backup,originals);
    await assert.rejects(compactTaskEvents(client,writer.directory,true),/source changed/);
    await pool.query("UPDATE tasks SET status='running' WHERE id=$1",[task]);
    await assert.rejects(compactTaskEvents(client,writer.directory),/ended task/);
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await rm(root,{recursive:true,force:true});}
});

test('a malformed later page rolls back earlier converted pages',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-rollback-')),client=await pool.connect();
  try{
    const task=String((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('rollback','fixture','failed') RETURNING id")).rows[0].id);
    for(const payload of [{type:'message_update',message:{text:'retain'},assistantMessageEvent:{delta:'x',partial:{text:'retain'}}},{type:'message_update',assistantMessageEvent:['unsupported']}]){
      await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('worker',$1,'message_update',$2)",[`task-${task}-intent-1`,JSON.stringify(payload)]);
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");
    const scope=await taskEventScope(client,task),writer=await EventArchiveWriter.create(path.join(root,'original'),'zstd',{taskId:task,sample:false,representation:'exact-source-json'},1024);
    const original:string[]=[];for await(const line of taskEventLines(client,scope)){original.push(line);await writer.append(line);}
    await writer.finish();await client.query('ROLLBACK');
    const progress:number[]=[];await assert.rejects(compactTaskEvents(client,writer.directory,true,(n)=>progress.push(n),1),/unsupported legacy/);
    assert.ok(progress.includes(1),'one earlier batch actually wrote before the later failure');
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL timezone='UTC'");
    const after:string[]=[];for await(const line of taskEventLines(client,scope))after.push(line);await client.query('ROLLBACK');
    assert.deepEqual(after,original,'earlier writes were rolled back as well');
    await assert.rejects(compactTaskEvents(client,writer.directory,true,undefined,512,{before:async()=>{}}),/unsupported legacy/);
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL timezone='UTC'");
    const afterRewrite:string[]=[];for await(const line of taskEventLines(client,scope))afterRewrite.push(line);await client.query('ROLLBACK');
    assert.deepEqual(afterRewrite,original,'a failed table rewrite is atomic too');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await rm(root,{recursive:true,force:true});}
});

test('offline rewrite preserves table identity, foreign-key receipts, exact large numbers and unrelated events',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-rewrite-')),client=await pool.connect();
  try{
    const task=String((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('rewrite','fixture','failed') RETURNING id")).rows[0].id);
    const old=(await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload)
      VALUES('worker',$1,'message_update','{"type":"message_update","large":9007199254740993123,"message":{"text":"old"},"assistantMessageEvent":{"delta":"🧪","partial":{"text":"old"}}}') RETURNING seq`,[`task-${task}-intent-1`])).rows[0].seq;
    const end=(await pool.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload)
      VALUES('worker',$1,'message_end','{"type":"message_end","message":{"text":"keep exactly"}}') RETURNING seq`,[`task-${task}-intent-1`])).rows[0].seq;
    await pool.query('INSERT INTO pi_activity_projected(event_seq) VALUES($1),($2)',[old,end]);
    const oid=(await pool.query("SELECT 'business_events'::regclass::oid::text AS oid")).rows[0].oid;
    const othersBefore=(await pool.query('SELECT seq::text,payload FROM business_events e WHERE NOT '+(await taskEventScope(client,task)).sql+' ORDER BY e.seq',(await taskEventScope(client,task)).values)).rows;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");
    const scope=await taskEventScope(client,task),writer=await EventArchiveWriter.create(path.join(root,'original'),'zstd',{taskId:task,sample:false,representation:'exact-source-json'},1024);
    for await(const line of taskEventLines(client,scope))await writer.append(line);await writer.finish();await client.query('ROLLBACK');
    let stopped=false;const result=await compactTaskEvents(client,writer.directory,true,undefined,512,{before:async()=>{stopped=true;}});
    assert.equal(stopped,true);assert.equal(result.strategy,'offline-rewrite');assert.equal(result.changed,1);
    assert.equal((await pool.query("SELECT 'business_events'::regclass::oid::text AS oid")).rows[0].oid,oid);
    const row=(await pool.query("SELECT payload,payload->>'large' AS large FROM business_events WHERE seq=$1",[old])).rows[0];
    assert.equal(row.large,'9007199254740993123');assert.equal(row.payload.storage_version,2);assert.equal(row.payload.message,undefined);assert.equal(row.payload.assistantMessageEvent.partial,undefined);assert.equal(row.payload.assistantMessageEvent.delta,'🧪');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pi_activity_projected WHERE event_seq=ANY($1::bigint[])',[[old,end]])).rows[0].n,2);
    const othersAfter=(await pool.query('SELECT seq::text,payload FROM business_events e WHERE NOT '+scope.sql+' ORDER BY e.seq',scope.values)).rows;
    assert.deepEqual(othersAfter,othersBefore);
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await rm(root,{recursive:true,force:true});}
});
