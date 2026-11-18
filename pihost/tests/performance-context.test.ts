import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm,readdir,utimes,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {WorkerHandoffs} from '../src/domains/tasks/handoff.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {ArtifactStore,objectRoot,objectFile} from '../src/storage/artifacts.ts';
import {ArtifactFrameReader} from '../src/storage/artifact-frames.ts';
import {collectStorageOrphans} from '../src/storage/lifecycle.ts';
import {storagePolicy} from '../src/storage/policy.ts';
import {CallPerformance} from '../src/domains/observability/call-performance.ts';
import {TaskPerformance} from '../src/domains/observability/task-performance.ts';
import {LlmRecords,type LlmCallEntry} from '../src/domains/observability/records.ts';
import {createServer} from 'node:http';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';
import {packBody} from '../src/storage/codec.ts';

const config=loadConfig();if(!/test(?:\?|$)/.test(new URL(config.database.dsn).pathname))throw new Error('requires an isolated test database');
const admin=new Pool({connectionString:config.database.dsn}),schema=`wormhole_performance_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
const root=await mkdtemp(path.join(tmpdir(),'wormhole-performance-'));
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});});
const task=async()=>Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('fixture','fixed quality baseline','running') RETURNING id")).rows[0].id);

test('handoff recovers older explicit, dependency and negative evidence despite newer unrelated facts',async()=>{
  const id=await task(),other=await task(),graph=new ExplorationService(pool);await graph.ensure(id);await graph.ensure(other);
  const parent=await graph.recordFact(id,{summary:'original prerequisite',detail:'local precondition'});
  const intent=await graph.addIntent(id,{summary:'resume a bounded check',parent_ids:[parent],hypothesis:'check saved outcome',stop_condition:'verified'});
  const negative=await graph.recordFact(id,{summary:'negative control already completed',detail:'fixed control returned no capability',intent_id:intent});
  const required=await graph.recordFact(id,{summary:'critical checkpoint reference',detail:'required next-step input'});
  const foreign=await graph.recordFact(other,{summary:'foreign task secret'});
  for(let n=0;n<40;n++)await graph.recordFact(id,{summary:`unrelated newer fact ${n}`});
  const handoffs=new WorkerHandoffs(pool,root);await handoffs.save(id,intent,{progress:'completed control',next_step:'inspect existing evidence',evidence_ids:[required]});
  const packet=await handoffs.packet(id,intent),ids=packet.recentEvidence.map(row=>String(row.id));
  assert.ok(ids.includes(String(required)));assert.ok(ids.includes(String(parent)));assert.ok(ids.includes(String(negative)));assert.ok(!ids.includes(String(foreign)));
  assert.equal(ids[0],String(required));assert.ok(packet.recentEvidence.find(row=>String(row.id)===String(negative)).selection_reasons.includes('intent_output'));
  assert.equal(packet.checkpoint.checkpoint.next_step,'inspect existing evidence');assert.ok(Buffer.byteLength(JSON.stringify(packet))<=32768);
  assert.equal(packet.anchors[0].id,String(parent));
  await pool.query('INSERT INTO task_constraints(task_id,kind,text) VALUES($1,\'deny\',$2)',[id,'FULL_AUTHORITY_'.repeat(4000)]);
  const oversized=await handoffs.packet(id,intent);assert.equal(oversized.constraints[0].text,'FULL_AUTHORITY_'.repeat(4000));assert.equal(oversized.authorityOverBudget,true);
});

test('large artifacts use one seekable object across calls; ownership and orphan retention still hold',async()=>{
  const id=await task(),other=await task(),store=new ArtifactStore(pool,root),value={content:[{type:'text',text:'Unicode 🧪 / '.repeat(100000)}],details:{toolCallId:10}};
  const first=await store.externalize(id,1,value,32768),second=await store.externalize(id,2,{...value,details:{toolCallId:11}},32768);
  assert.equal(first.details.artifact.layout,'frames-v2');assert.equal(first.details.artifact.hash,second.details.artifact.hash);
  assert.equal(first.details.toolCallId,10);assert.equal(second.details.toolCallId,11);
  const hash=first.details.artifact.hash,row=(await pool.query('SELECT * FROM storage_artifacts WHERE task_id=$1 AND hash=$2 LIMIT 1',[id,hash])).rows[0];
  const file=objectFile(root,hash,row.codec,row.layout),reader=await ArtifactFrameReader.open(file,{hash,codec:row.codec,rawBytes:Number(row.raw_bytes),manifestHash:row.manifest_sha256});
  try{const page=await reader.read(900000,8000);assert.equal(page.text,JSON.stringify({...value,details:{}}).slice(page.offset,page.nextOffset));assert.ok(reader.stats.decompressedBytes<300000);}finally{await reader.close();}
  await assert.rejects(store.read(other,hash),/belong/);
  await utimes(file,new Date(0),new Date(0));assert.equal(await collectStorageOrphans(pool,root,storagePolicy()),0);assert.ok((await readdir(objectRoot(root))).includes(path.basename(file)));
  const page=await store.read(id,hash,0,16000);assert.ok(page.text.includes('Unicode'));
  const fresh={content:[{type:'text',text:value.content[0]!.text+'CONCURRENT_PUBLICATION'}],details:{toolCallId:20}};
  const concurrent=await Promise.all([20,21,22].map(toolCallId=>store.externalize(id,toolCallId,{...fresh,details:{toolCallId}},32768)));
  assert.ok(concurrent.every(result=>result.details.artifact.hash===concurrent[0].details.artifact.hash));
  const published=(await pool.query('SELECT count(*)::text AS n,count(DISTINCT manifest_sha256)::text AS manifests FROM storage_artifacts WHERE hash=$1',[concurrent[0].details.artifact.hash])).rows[0];
  assert.equal(published.n,'3');assert.equal(published.manifests,'1');assert.ok((await store.read(id,concurrent[0].details.artifact.hash,0,100)).text.includes('Unicode'));
});

test('call metrics distinguish no-content, rate waiting, response headers and first real content',()=>{
  let now=0;const metrics=new CallPerformance(()=>now);metrics.context(8,2,50);now=5;metrics.addRateWait(5);
  const done=metrics.httpStart();now=15;done();done();metrics.observe({type:'start'});metrics.observe({type:'text_delta',delta:''});assert.equal(metrics.snapshot().firstContentMs,null);
  now=30;metrics.observe({type:'thinking_delta',delta:'reasoning'});now=50;metrics.observe({type:'text_delta',delta:'answer'});metrics.response(100);metrics.request(200);metrics.finish();now=100;
  assert.deepEqual({...metrics.snapshot(),startedAt:''},{version:1,startedAt:'',totalMs:50,firstContentMs:30,afterFirstContentMs:20,rateWaitMs:5,retryWaitMs:0,httpWaitMs:10,httpAttempts:1,requestBytes:200,responseBytes:100,contextMessages:8,tools:2,systemBytes:50});
});

test('legacy large objects migrate atomically, update every reference and retain the original through the grace period',async()=>{
  const id=await task(),other=await task(),value={content:[{type:'text',text:'older original 🧪 '.repeat(80000)}],details:{legacy:true}},packed=await packBody(value),store=new ArtifactStore(pool,root);
  await mkdir(objectRoot(root),{recursive:true});const original=objectFile(root,packed.hash,packed.codec);await writeFile(original,packed.bytes);await utimes(original,new Date(0),new Date(0));
  for(const taskId of [id,other])await pool.query('INSERT INTO storage_artifacts(task_id,intent_id,hash,raw_bytes,stored_bytes,codec) VALUES($1,1,$2,$3,$4,$5)',[taskId,packed.hash,packed.rawBytes,packed.bytes.length,packed.codec]);
  assert.ok((await store.read(id,packed.hash,1000000,100)).text.length>0,'legacy format works before migration');
  await assert.rejects(store.reframeLegacy(1,16*1024*1024,AbortSignal.abort()));assert.equal((await pool.query('SELECT layout FROM storage_artifacts WHERE hash=$1',[packed.hash])).rows[0].layout,'body-v1');
  await pool.query(`CREATE FUNCTION reject_fixture_reframe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture interrupted after publication'; END $$;
    CREATE TRIGGER reject_fixture_reframe BEFORE UPDATE ON storage_artifacts FOR EACH ROW EXECUTE FUNCTION reject_fixture_reframe()`);
  try{await assert.rejects(store.reframeLegacy(),/fixture interrupted/);}finally{await pool.query('DROP TRIGGER reject_fixture_reframe ON storage_artifacts; DROP FUNCTION reject_fixture_reframe()');}
  assert.equal((await pool.query('SELECT layout FROM storage_artifacts WHERE hash=$1',[packed.hash])).rows[0].layout,'body-v1');assert.deepEqual(await readFile(original),packed.bytes);
  assert.deepEqual(await store.reframeLegacy(),{objects:1,refs:2,deferred:false});
  const rows=(await pool.query('SELECT layout FROM storage_artifacts WHERE hash=$1',[packed.hash])).rows;assert.ok(rows.every(row=>row.layout==='frames-v2'));
  assert.deepEqual(await readFile(original),packed.bytes);assert.equal(await collectStorageOrphans(pool,root,storagePolicy()),0,'fresh grace period protects readers with old pointers');
  for(const taskId of [id,other]){const page=await store.read(taskId,packed.hash,1000000,100);assert.equal(page.text,JSON.stringify(value).slice(page.offset,page.nextOffset));}
  assert.equal((await store.reframeLegacy()).objects,0);
  await assert.rejects(store.restoreLegacy(1,16*1024*1024,AbortSignal.abort()));
  const restored=await store.restoreLegacy(10);assert.ok(restored.refs>=2);
  assert.equal((await pool.query('SELECT layout FROM storage_artifacts WHERE hash=$1',[packed.hash])).rows[0].layout,'body-v1');
  const page=await store.read(id,packed.hash,1000000,100);assert.equal(page.text,JSON.stringify(value).slice(page.offset,page.nextOffset));
});

test('task baseline keeps telemetry with recording disabled, reports missing history honestly and requires API authentication',async()=>{
  const id=await task(),writer=new LlmRecords(pool),metrics=new CallPerformance();metrics.request(200);metrics.observe({type:'text_delta',delta:'fixture'});metrics.finish();
  const entry:LlmCallEntry={model:'local-fixture',profileId:null,profileName:'fixture',sessionId:`task-${id}-intent-1`,taskId:String(id),worker:'worker',explorationId:null,input:100,output:10,cacheRead:50,cacheWrite:0,latencyMs:20,status:'ok',error:'',stopReason:'stop',text:'private answer',thinking:'',rawRequest:'private request',rawResponse:'private response',performance:metrics.snapshot()};
  await writer.recordCall(entry,false,'worker');await writer.recordCall({...entry,performance:undefined},false,'worker');
  await pool.query("INSERT INTO tool_calls(business_kind,business_id,tool_key,params,preflight_ms,execution_ms,finished_at) VALUES('worker',$1,'fixture','{\"private\":\"TOOL_SECRET\"}',5,10,now()),('worker',$1,'fixture','{\"private\":\"TOOL_SECRET\"}',6,12,now()),('worker',$2,'other','{}',999,999,now())",[`task-${id}-intent-1`,`task-${id}0-intent-1`]);
  const report=(await new TaskPerformance(pool).report(String(id)))!;assert.equal(report.model.calls,'2');assert.equal(report.model.measured_calls,'1');assert.equal(report.phases.firstContentMs.samples,'1');assert.equal(report.tools.calls,'2');assert.equal(report.tools.cumulative_execution_ms,22);assert.equal(report.repeatSignals[0].additional_calls,'1');
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM llm_records WHERE task_id=$1',[String(id)])).rows[0].n,'0');
  assert.ok(!JSON.stringify(report).includes('TOOL_SECRET'));assert.ok(!JSON.stringify(report).includes('private request'));assert.equal(report.interpretation.durationsOverlap,true);
  const auth=new AuthService(pool,path.join(root,'jwt.key')),token=(await auth.init('performance-fixture-123')).token!,ctx={pool,config,auth} as any;
  const server=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/tasks/`;
    assert.equal((await fetch(`${base}${id}/performance`)).status,401);
    const response=await fetch(`${base}${id}/performance`,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);assert.equal((await response.json() as any).model.measured_calls,'1');
    assert.equal((await fetch(`${base}999999999/performance`,{headers:{authorization:`Bearer ${token}`}})).status,404);
    assert.equal((await fetch(`${base}${2n**63n}/performance`,{headers:{authorization:`Bearer ${token}`}})).status,400);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
