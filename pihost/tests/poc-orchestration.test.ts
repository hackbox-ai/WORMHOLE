import {bindExtension} from '../src/domains/extensions/availability.ts';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {PocService} from '../src/domains/pocs/service.ts';
import {seedPocTools,registerPocTools} from '../src/domains/pocs/tools.ts';
import {pocNeedsReview,pocMayComplete,pocReviewed,pocDelivery} from '../src/domains/pocs/lifecycle.ts';
import {FingerprintService} from '../src/domains/fingerprints/service.ts';
import {seedFingerprintTools,registerFingerprintTools} from '../src/domains/fingerprints/tools.ts';
import {acknowledgeFingerprintReview} from '../src/domains/fingerprints/lifecycle.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {AssetContextService} from '../src/domains/assets/context.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {completeAchievedTask} from '../src/domains/tasks/completion.ts';
import {TaskArchives} from '../src/domains/tasks/archives.ts';
import {WorkerHandoffs} from '../src/domains/tasks/handoff.ts';
import {runTool,registerTool} from '../src/domains/tools/gate.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import type {PihostConfig} from '../src/config.ts';

const dsn=process.env.WORMHOLE_POC_TEST_DSN;
if(!dsn){test('PoC orchestration needs an isolated database',{skip:true},()=>{});}else{
if(!new URL(dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('dedicated wormhole_poc_test database required');
const admin=new Pool({connectionString:dsn}),schema='poc_'+process.pid+'_'+Date.now();let pool:Pool,pocs:PocService,fp:FingerprintService,dir:string,graph:ExplorationService,assets:AssetsService,findings:FindingsService;
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.statusCode=req.url==='/missing'?404:200;res.end('poc-controlled-marker');});let url:string;
const raw=(id:string,product='WORMHOLE PoCLab')=>`id: ${id}\ninfo:\n  name: Controlled read only technology ${id}\n  severity: info\n  tags: tech\n  metadata:\n    product: ${product}\n  description: Read the public /proof route and record the actual response.\nhttp:\n  - method: GET\n    path: ["{{BaseURL}}/proof"]\n`;
const document=()=>({format:'wormhole-poc-source-v1',key:'fixture',title:'Controlled knowledge fixture',type:'nuclei',provenance:{fixture:true},entries:[{native_id:'poc-fixture.yaml',raw:raw('poc-fixture')},{native_id:'other.yaml',raw:raw('unrelated','other-product')}]});
before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:dsn,options:'-c search_path='+schema});await runMigrations(pool);dir=await mkdtemp(path.join(tmpdir(),'wormhole-poc-'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/';
 pocs=new PocService(pool);await pocs.import(document());await seedPocTools(pocs);registerPocTools(pocs);bindExtension('pocs',async()=>({key:'pocs',state:await pocs.enabled()?'available':'disabled',detail:'fixture',settings:'/system/pocs'}));fp=new FingerprintService(pool);await fp.import('ehole',{fingerprint:[{cms:'WORMHOLE PoCLab',method:'keyword',location:'body',keyword:['poc-controlled-marker']}]});await seedFingerprintTools(fp);registerFingerprintTools(fp);bindExtension('fingerprints',async()=>({key:'fingerprints',state:await fp.enabled()?'available':'disabled',detail:'fixture',settings:'/system/fingerprints'}));
 assets=new AssetsService(pool,path.join(dir,'dlq'));findings=new FindingsService(pool,path.join(dir,'dlq'));graph=new ExplorationService(pool);registerBusinessTools({assets,findings,fingerprints:fp});
});
after(async()=>{await fp?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
async function task(){const result=await new TaskService(pool,path.join(dir,'dlq'),()=>{}).create({goal:'Controlled PoC knowledge checks',queued:true});assert.ok(result.ok);const id=Number(result.task.id);await pool.query("UPDATE tasks SET status='running',paused=false,queued=false WHERE id=$1",[id]);await graph.ensure(id);await new AssetContextService(pool).addScope(id,'ip','127.0.0.1','controlled fixture');await pocs.pin(id);return id;}
async function observed(id:number,version=''){await fp.observeHTTP({taskId:id,businessId:'fixture-entry'},{url,method:'GET',status:200,headers:{},body:'poc-controlled-marker'});await fp.drain();if(version)await pool.query('UPDATE fingerprint_observations SET version=$2 WHERE job_id IN(SELECT j.id FROM fingerprint_jobs j JOIN fingerprint_materials m ON m.id=j.material_id WHERE m.task_id=$1)',[id,version]);await pocs.refresh(id);return (await pocs.candidates(id)).items[0]!;}
test('import is static and idempotent, malformed entries are accounted for and snapshots are immutable',async()=>{
 const first=await pocs.import(document()),again=await pocs.import(document());assert.equal(first.revision,again.revision);assert.equal(first.accepted,2);
 const id=await task(),pinned=await pocs.pin(id);await pocs.updateSource('fixture',{enabled:false});assert.equal(await pocs.pin(id),pinned);assert.notEqual(await pocs.snapshot(),pinned);await pocs.updateSource('fixture',{enabled:true});
 const partial=await pocs.import({...document(),key:'broken',entries:[{native_id:'good',raw:raw('good')},{native_id:'bad',raw:'id: a\nid: b'}]});assert.equal(partial.accepted,1);assert.equal(partial.failed,1);await pocs.updateSource('broken',{enabled:false});
});
test('product evidence produces task-owned candidates, unknown version remains unknown, repeated refresh does not duplicate',async()=>{
 const id=await task(),candidate=await observed(id);assert.equal(candidate.applicability,'unknown');assert.equal(candidate.product,'WORMHOLE PoCLab');assert.ok(candidate.observation_ids.length);const revision=(await pocs.summary(id)).revision;await pocs.refresh(id);assert.equal((await pocs.summary(id)).revision,revision);assert.equal((await pocs.candidates(id)).total,1);assert.ok(await pocNeedsReview(pool,id));
 const foreign=await task();await assert.rejects(graph.addIntent(foreign,{summary:'foreign',poc_candidate_ids:[Number(candidate.id)]}),/当前任务/);await assert.rejects(pocs.detail(candidate.entry_id,{taskId:foreign,candidateId:Number(candidate.id)}),/当前任务/);
});
test('explicit version overrides affect subsequent snapshots, exact boundaries exclude and retired candidates cannot spawn work',async()=>{
 const old=await task(),entry=(await observed(old)).entry_id;await pocs.override(entry,{enabled:true,version_range:'<2.0',notes:'controlled test boundary'});const current=await task(),candidate=await observed(current,'2.0');assert.equal(candidate.applicability,'excluded');assert.equal((await pocs.detail(entry,{taskId:old})).override,undefined);await assert.rejects(graph.addIntent(current,{summary:'excluded',poc_candidate_ids:[Number(candidate.id)]}),/适用/);await pocs.override(entry,{enabled:true,version_range:'',notes:''});
});
test('product aliases are pinned per task, support canonical chains and reject cyclic mappings',async()=>{
 const old=await task();await observed(old);await pocs.alias('other-product','WORMHOLE PoCLab');const current=await task();await observed(current);assert.equal((await pocs.candidates(old)).total,1);assert.equal((await pocs.candidates(current)).total,2);await assert.rejects(pocs.alias('WORMHOLE PoCLab','other-product'),/循环/);await pocs.removeAlias('other-product');
});
test('Worker packets and tools filter unrelated work, explicit references and factual use are traceable',async()=>{
 const id=await task(),candidate=await observed(id);const own=await graph.addIntent(id,{summary:'Read '+url,poc_candidate_ids:[Number(candidate.id)],fingerprint_observation_ids:candidate.observation_ids.map(Number),test_key:'controlled',hypothesis:'Read public response',stop_condition:'one GET'}),other=await graph.addIntent(id,{summary:'Unrelated work https://unrelated.invalid/'});
 assert.equal((await pocs.summary(id,other)).candidates.length,0);const packet=await new WorkerHandoffs(pool,dir,fp,pocs).packet(id,own);assert.equal(packet.poc_knowledge?.candidates.length,1);assert.ok(Buffer.byteLength(JSON.stringify(packet))<=32768);
 const detail=await runTool(pool,'read_poc',{entry_id:candidate.entry_id,candidate_id:Number(candidate.id)},{businessKind:'worker',businessId:'task-'+id+'-intent-'+own,taskId:id,intentId:own,agentKey:'worker'});assert.equal(detail.status,'executed');
 const fact=await graph.recordFact(id,{summary:'Actual fixture response inspected',evidence:'controlled test observation',poc_candidate_ids:[Number(candidate.id)]},'worker',own);assert.ok(fact);assert.equal((await pocs.candidates(id)).items[0]!.linked_facts,1);assert.equal(await graph.addIntent(id,{summary:'same controlled direction',test_key:'controlled',poc_candidate_ids:[Number(candidate.id)]}),own);
 const events=(await pool.query("SELECT event_type FROM business_events WHERE business_id=$1 AND event_type LIKE 'poc_%'",[String(id)])).rows.map(r=>r.event_type);assert.ok(events.includes('poc_intent_linked'));assert.ok(events.includes('poc_detail_read'));assert.ok(events.includes('poc_evidence_linked'));
});
test('successful review is separate from delivery and all completion paths respect the bounded PoC fence',async()=>{
 const id=await task();await observed(id);const f=await fp.summary(id);await acknowledgeFingerprintReview(pool,id,f.revision);const s=await pocs.summary(id);await pocDelivery(pool,id,'planner',s.revision,s.candidates.map(c=>Number(c.id)));assert.equal(await completeAchievedTask(pool,id),false);assert.ok((await pool.query('SELECT completion_requested FROM task_poc_state WHERE task_id=$1',[id])).rows[0].completion_requested);await pocReviewed(pool,id,s.revision);assert.equal(await completeAchievedTask(pool,id),true);
 const timeout=await task();await observed(timeout);await pool.query("UPDATE task_poc_state SET settlement_deadline_at=now()-interval '1 second' WHERE task_id=$1",[timeout]);assert.equal(await pocMayComplete(pool,timeout),true);assert.equal((await pool.query('SELECT settlement_outcome FROM task_poc_state WHERE task_id=$1',[timeout])).rows[0].settlement_outcome,'timed_out');await pocs.configure(false);assert.equal((await pocs.summary(timeout)).enabled,false);await pocs.configure(true);
});
test('new negative material retires old recommendations and paused or terminal tasks reject late publication',async()=>{
 const id=await task(),candidate=await observed(id);const intent=await graph.addIntent(id,{summary:'Inspect '+url,poc_candidate_ids:[Number(candidate.id)]});
 await fp.observeHTTP({taskId:id,businessId:'fixture-entry'},{url,method:'GET',status:200,headers:{},body:'controlled negative response without marker'});await fp.drain();await pocs.refresh(id);
 assert.equal((await pocs.candidates(id)).total,0);assert.equal((await pocs.summary(id,intent)).candidates[0]!.active,false);await assert.rejects(graph.addIntent(id,{summary:'new work on retired candidate',poc_candidate_ids:[Number(candidate.id)]}),/适用/);
 for(const status of ['paused','done']){const before=(await pool.query('SELECT fingerprint_revision FROM task_poc_state WHERE task_id=$1',[id])).rows[0].fingerprint_revision;await pool.query('UPDATE task_fingerprint_state SET revision=revision+1 WHERE task_id=$1',[id]);await pool.query('UPDATE tasks SET status=$2,paused=$3 WHERE id=$1',[id,status,status==='paused']);await pocs.refresh(id);assert.equal((await pool.query('SELECT fingerprint_revision FROM task_poc_state WHERE task_id=$1',[id])).rows[0].fingerprint_revision,before);}
});
test('archive restores fixed library content, candidates and delivery receipts without overwriting global activation',async()=>{
 const id=await task();await observed(id);const before=await pocs.summary(id);await pocs.deliver(id,'planner');await pool.query("UPDATE tasks SET status='done' WHERE id=$1",[id]);const archives=new TaskArchives(pool,dir,{isTaskRunning:()=>false,abortTask:()=>{},drainSide:async()=>{}}),job=await archives.queue(id);await archives.runOne();assert.equal((await archives.get(Number(job.id)))?.state,'ready');assert.equal((await pocs.candidates(id)).total,0);await pocs.updateSource('fixture',{enabled:false});await archives.queueRestore(Number(job.id));await archives.runOne();assert.equal(await pocs.available(),false);assert.equal(await pocs.available(id),true);assert.deepEqual(await pocs.summary(id),before);assert.equal((await pocs.sources()).sources.find(s=>s.key==='fixture').enabled,false);assert.ok((await pool.query('SELECT 1 FROM poc_deliveries WHERE task_id=$1',[id])).rowCount);await pocs.updateSource('fixture',{enabled:true});
});
test('real Pi orchestration dispatches from candidates, reads original PoC, makes an actual HTTP call and links a fact',async()=>{
 const mock=await startMockAnthropic(0,{delayMs:100,tool:body=>{
  const names=(body.tools as {name:string}[]??[]).map(t=>t.name),messages=body.messages as {role:string;content:{type:string;name?:string;text?:string}[]}[];const used=(name:string)=>messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_use'&&c.name===name));const prompt=messages.find(m=>m.role==='user'&&Array.isArray(m.content))?.content.filter(c=>c.type==='text').map(c=>c.text).join('')??'';
  if(names.includes('set_goals')&&!names.includes('add_intent'))return used('set_goals')?undefined:{name:'set_goals',input:{text:'Verify controlled response using PoC knowledge',objective_type:'coverage'}};
  if(names.includes('add_intent')){const overview=JSON.parse(prompt.split('任务探索图概览：\n')[1]!.split('\n操作约束：')[0]!);const fact=overview.recent_facts.find((f:{state:string})=>f.state==='confirmed');if(fact&&!used('resolve_goal'))return {name:'resolve_goal',input:{goal_id:overview.goals[0].id,evidence_id:fact.id,outcome:'tested_negative',reason:'actual controlled public response observed'}};const c=overview.poc_knowledge?.candidates.find((c:{active:boolean})=>c.active);if(c&&!used('add_intent')&&!overview.done_intents_total&&!overview.open_intents.length&&!overview.running_intents.length)return {name:'add_intent',input:{summary:'Read '+new URL('/proof',c.url).href,poc_candidate_ids:[Number(c.id)],fingerprint_observation_ids:c.observation_ids.map(Number),test_key:'poc-native-public-proof',hypothesis:'Read source-guided public route',stop_condition:'one GET and record response'}};return undefined;}
  if(names.includes('http_request')){const packet=JSON.parse(prompt.split('当前结构化交接包：\n')[1]!);const c=packet.poc_knowledge.candidates[0];if(!used('read_poc'))return {name:'read_poc',input:{entry_id:c.entry_id,candidate_id:Number(c.id)}};if(!used('http_request'))return {name:'http_request',input:{url:new URL('/proof',c.url).href,method:'GET'}};if(!used('record_fact'))return {name:'record_fact',input:{summary:'Actual source-guided public response observed',evidence:'GET /proof actual fixture response',poc_candidate_ids:[Number(c.id)]}};return undefined;}return undefined;
 }});
 const config:PihostConfig={listen:{host:'127.0.0.1',port:0},database:{dsn},dataDir:dir,pi:{agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json'),provider:'fixture',modelId:'mock-1'}};await mkdir(config.pi.agentDir,{recursive:true});await writeFile(config.pi.modelsPath,JSON.stringify({providers:{}}));const profile=await new LlmService(pool,path.join(dir,'dlq'),config.pi.modelsPath).createProfile({name:'poc-native-fixture',model:'mock-1',format:'anthropic',base_url:'http://127.0.0.1:'+(mock.server.address() as {port:number}).port,api_key:'synthetic-fixture-key',is_default:true});assert.ok(profile.ok);resetPiRuntime();
 const engine=new TaskEngine(pool,config,{pocs,fingerprints:fp,assets,findings,agents:new AgentsService(pool,path.join(dir,'dlq')),intercept:new InterceptService(pool,path.join(dir,'dlq')),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});fp.bindNotify((id,change)=>engine.notifyFingerprints(id,change));const id=await task();await assets.upsertSource({type:'service',url,service_type:'http',task_id:id});await pool.query('UPDATE tasks SET llm_profile_id=$2,active_llm_profile_id=$2 WHERE id=$1',[id,profile.profile.id]);
 try{await engine.launch(id);const end=Date.now()+50000;while(Date.now()<end&&(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status!=='done')await new Promise(r=>setTimeout(r,100));assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'done');await engine.drain(id);const calls=(await pool.query("SELECT tool_key,params,is_error FROM tool_calls WHERE business_id LIKE $1 ORDER BY id",['task-'+id+'%'])).rows;assert.ok(calls.some(c=>c.tool_key==='read_poc'&&!c.is_error));assert.ok(calls.some(c=>c.tool_key==='http_request'&&JSON.stringify(c.params).includes('/proof')&&!c.is_error));assert.ok((await pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload ? 'poc_candidate_ids'",[id])).rowCount);assert.ok((await pool.query("SELECT 1 FROM poc_deliveries WHERE task_id=$1 AND recipient='worker' AND cardinality(candidate_ids)>0",[id])).rowCount);}
 finally{await engine.shutdown();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));}
});
}
