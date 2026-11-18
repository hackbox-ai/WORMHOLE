import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {runMigrations} from '../src/db/migrate.ts';
import {ModelingService} from '../src/domains/modeling/service.ts';
import {mergeDocument,normalizeTarget,targetsInText,validateDocument,skeleton} from '../src/domains/modeling/document.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {claimNextIntent,releaseModelingIntent,recoverModelingIntents} from '../src/domains/tasks/host.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {registerModelingTools} from '../src/domains/modeling/tools.ts';
import {runTool} from '../src/domains/tools/gate.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import {routeModeling} from '../src/api/modeling.ts';
import {ConversationsService} from '../src/domains/conversations/service.ts';
import {TaskChatService} from '../src/domains/tasks/chat.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {chatToolsFor,registerPlatformTools} from '../src/domains/tools/platform.ts';
import {probeModelingEntrance,modelingRunBudget} from '../src/domains/modeling/execution.ts';
import type {AppContext} from '../src/api/server.ts';
import type {PihostConfig} from '../src/config.ts';

// Deliberately separate from existing suites that clear baseline databases.
const dsn=process.env.WORMHOLE_MODELING_TEST_DSN;
if(!dsn||!new URL(dsn).pathname.startsWith('/modeling_test'))throw new Error('WORMHOLE_MODELING_TEST_DSN must point to an isolated modeling_test database');
const pool=new Pool({connectionString:dsn});
await runMigrations(pool);
const tmp=await mkdtemp(path.join(tmpdir(),'wormhole-modeling-'));
const dlq=path.join(tmp,'events.jsonl');
const config:PihostConfig={listen:{host:'127.0.0.1',port:0},database:{dsn},dataDir:tmp,pi:{modelsPath:path.join(tmp,'models.json'),agentDir:path.join(tmp,'agent'),provider:'fixture',modelId:'mock-1'}};
await mkdir(config.pi.agentDir,{recursive:true});await writeFile(config.pi.modelsPath,JSON.stringify({providers:{}}));
const service=new ModelingService(pool);
const tasks=new TaskService(pool,dlq,()=>{});
const graph=new ExplorationService(pool);
const engines:TaskEngine[]=[];
const syntheticEntrance=async()=>({status:200,body:'Synthetic entrance fixture. No real target was contacted.'});
after(async()=>{for(const e of engines)await e.shutdown();await pool.end();});
async function parent(goal='modeling fixture'){
  const r=await tasks.create({name:goal,goal,queued:true});assert.ok(r.ok);return Number(r.task.id);
}
async function running(id:number){await pool.query("UPDATE tasks SET status='running',paused=FALSE,queued=FALSE WHERE id=$1",[id]);}
const operation={summary:'读取订单',responses:{'200':{description:'成功'}}};
async function finish(id:number){await running(id);await service.submit(id,{paths:{'/orders':{get:operation}},entities:[{name:'订单',fields:[{name:'id',type:'integer'}]}]});await service.requestFinish(id,'已覆盖订单读取；支付与后台未覆盖。合成测试数据，无真实目标验证。');await service.publish(id);}

test('target identities preserve application path, environment and auth boundaries',async()=>{
  assert.equal(normalizeTarget('HTTPS://EXAMPLE.COM:443/admin/?token=discard#route'),'https://example.com/admin');
  assert.notEqual(normalizeTarget('https://example.com'),normalizeTarget('https://example.com/admin'));
  assert.throws(()=>normalizeTarget('https://user:secret@example.com'));
  assert.deepEqual(targetsInText('测试 https://example.test/admin，完成建模。'),['https://example.test/admin']);
  const a=await service.request({target:'https://identity.test',queued:true});
  const b=await service.request({target:'https://identity.test',environment:'staging',queued:true});
  const c=await service.request({target:'https://identity.test',auth_context:'admin',queued:true});
  assert.notEqual(a.system_id,b.system_id);assert.notEqual(a.system_id,c.system_id);
});
test('incremental submissions retain GET when POST for the same path arrives',()=>{
  const doc=mergeDocument({...skeleton('商城','https://shop.test'),paths:{'/orders':{get:operation}}},{paths:{'/orders':{post:operation}}});
  assert.deepEqual(Object.keys((doc.paths as Record<string,object>)['/orders']!).sort(),['get','post']);
  assert.equal(validateDocument(doc,true).length,0);
  assert.ok(validateDocument({...doc,paths:{'/bad':{get:{responses:{'200':{$ref:'#/components/responses/Missing'}}}}}},true).some(e=>e.includes('未解析引用')));
});
test('concurrent triggers share one running job and attach both parent tasks',async()=>{
  const p=await parent('concurrent'),q=await parent('concurrent');
  const result=await Promise.all(Array.from({length:6},(_,i)=>service.request({target:'https://shared.test/admin',task_id:i%2?p:q,queued:true,trigger:'initial'})));
  assert.equal(new Set(result.map(r=>r.task_id)).size,1);assert.equal(result.filter(r=>r.created).length,1);
  assert.equal((await pool.query('SELECT * FROM task_business_models WHERE modeling_task_id=$1',[result[0]!.task_id])).rowCount,2);
});
test('initial modeling does not block intent claims or task execution',async()=>{
  const p=await parent('initial supplement');await running(p);await graph.ensure(p);
  const intent=await graph.addIntent(p,{summary:'测试订单权限'});
  const job=await service.request({target:'https://initial.test',task_id:p,trigger:'initial',queued:true});
  assert.equal((await claimNextIntent(pool,p,'before-model')).intentId,intent);
  assert.equal((await pool.query('SELECT initial_gate FROM task_business_models WHERE task_id=$1',[p])).rows[0].initial_gate,false);
  await finish(job.task_id);const model=await service.readForTask(p,job.system_id,'/orders');assert.ok(model.document);
});
test('discovery modeling leaves current and unrelated intents runnable',async()=>{
  const p=await parent('discovery supplement');await running(p);await graph.ensure(p);
  const intent=await graph.addIntent(p,{summary:'后台方向',priority:9}),unrelated=await graph.addIntent(p,{summary:'其他已知系统',priority:1});
  const a=await service.request({target:'https://discovery.test/a',task_id:p,intent_id:intent,trigger:'discovery',queued:true});
  const b=await service.request({target:'https://discovery.test/b',task_id:p,intent_id:intent,trigger:'discovery',queued:true});
  assert.equal((await claimNextIntent(pool,p,'current')).intentId,intent);assert.equal((await claimNextIntent(pool,p,'other')).intentId,unrelated);
  await finish(a.task_id);await finish(b.task_id);assert.equal((await pool.query('SELECT state FROM exploration_nodes WHERE id=$1',[intent])).rows[0].state,'running');
});
test('publishing a background model never duplicates an active worker',async()=>{
  const p=await parent('worker drain');await running(p);await graph.ensure(p);const intent=await graph.addIntent(p,{summary:'发现后台'});await claimNextIntent(pool,p,'old-worker');
  const job=await service.request({target:'https://worker-drain.test',task_id:p,intent_id:intent,trigger:'discovery',queued:true});await finish(job.task_id);
  assert.equal((await claimNextIntent(pool,p,'new-worker')).claimed,false);assert.equal(await releaseModelingIntent(pool,p,intent,'old-worker'),false);
  assert.equal((await pool.query('SELECT state,claimed_by FROM exploration_nodes WHERE id=$1',[intent])).rows[0].claimed_by,'old-worker');
});
test('boot recovery releases legacy model-blocked intents even without a model version',async()=>{
  const p=await parent('legacy dependency recovery');await running(p);await graph.ensure(p);const intent=await graph.addIntent(p,{summary:'发现独立系统'});
  await service.request({target:'https://dependency-recovery.test',task_id:p,intent_id:intent,trigger:'discovery',queued:true});
  await pool.query("UPDATE exploration_nodes SET state='blocked',blocked_reason='business_modeling',claimed_by='crashed-worker' WHERE id=$1",[intent]);
  await recoverModelingIntents(pool);assert.equal((await claimNextIntent(pool,p,'recovered-worker')).intentId,intent);
});
test('invalid submission is atomic, terminal writes fail, and drafts survive cancellation',async()=>{
  const job=await service.request({target:'https://validation.test',queued:true});await running(job.task_id);
  await service.submit(job.task_id,{paths:{'/orders':{get:operation}}});
  const before=await service.get(job.task_id);
  await assert.rejects(service.submit(job.task_id,{paths:{bad:{get:operation}},entities:[{name:'should not persist'}]}));
  const after=await service.get(job.task_id);assert.deepEqual(after.document,before.document);assert.deepEqual(after.entities,before.entities);assert.equal(after.submissions,1);
  await pool.query("UPDATE tasks SET status='paused',paused=TRUE WHERE id=$1",[job.task_id]);
  await assert.rejects(service.submit(job.task_id,{entities:[]}));
  await assert.rejects(service.requestFinish(job.task_id,'paused completion'));
  await pool.query("UPDATE tasks SET status='failed',paused=FALSE WHERE id=$1",[job.task_id]);
  await assert.rejects(service.publish(job.task_id));assert.deepEqual((await service.get(job.task_id)).document,before.document);
  const retried=await service.retry(job.task_id);assert.deepEqual((await service.get(retried.task_id)).document,before.document);
});
test('scope constraints separate shared jobs and original user instructions reach modeling',async()=>{
  const p=await parent('只读取公开接口，不访问管理后台'),q=await parent('允许核验管理接口');
  await pool.query("INSERT INTO task_constraints(task_id,text,kind) VALUES($1,'不访问管理后台','deny')",[p]);
  const a=await service.request({target:'https://scope.test',task_id:p,trigger:'initial',queued:true});
  const b=await service.request({target:'https://scope.test',task_id:q,trigger:'initial',queued:true});
  assert.equal(a.system_id,b.system_id);assert.notEqual(a.task_id,b.task_id);
  assert.match((await pool.query('SELECT description FROM tasks WHERE id=$1',[a.task_id])).rows[0].description,/只读取公开接口/);
  assert.equal((await pool.query('SELECT text FROM task_constraints WHERE task_id=$1',[a.task_id])).rows[0].text,'不访问管理后台');
});
test('initialization is idempotent across concurrent admission attempts',async()=>{
  const r=await tasks.create({goal:'初始化',queued:true,modeling_targets:['https://initialize.test']});assert.ok(r.ok);
  const id=Number(r.task.id);await Promise.all([service.initializeTask(id),service.initializeTask(id)]);
  assert.equal((await service.list(id)).length,1);assert.equal((await pool.query('SELECT modeling_initialized FROM tasks WHERE id=$1',[id])).rows[0].modeling_initialized,true);
});
test('retry a failed shared job rebinds every waiting consumer without discarding drafts',async()=>{
  const p=await parent('shared retry'),q=await parent('shared retry');
  const a=await service.request({target:'https://shared-retry.test',task_id:p,queued:true});
  await service.request({target:'https://shared-retry.test',task_id:q,queued:true});
  await running(a.task_id);await service.submit(a.task_id,{paths:{'/partial':{get:operation}}});
  await pool.query("UPDATE tasks SET status='failed',stopped_reason='fixture interruption' WHERE id=$1",[a.task_id]);
  const retry=await service.retry(a.task_id);
  assert.equal((await pool.query('SELECT 1 FROM task_business_models WHERE modeling_task_id=$1',[retry.task_id])).rowCount,2);
  assert.ok((await service.get(retry.task_id)).document.paths['/partial']);
  await finish(retry.task_id);assert.equal(await service.pending(p),false);assert.equal(await service.pending(q),false);
});
test('incremental runs retain historical versions and pin prior consumers',async()=>{
  const p=await parent('version consumer');
  const job=await service.request({target:'https://versions.test',task_id:p,queued:true});await finish(job.task_id);
  const first=(await service.catalog(p))[0]!.version_id;
  const q=await parent('另一个任务：针对订单访问控制');
  const newer=await service.request({target:'https://versions.test',task_id:q,queued:true});
  assert.notEqual(newer.task_id,job.task_id);assert.equal((await service.get(newer.task_id)).base_version_id,first);
  await finish(newer.task_id);
  assert.equal((await service.catalog(p))[0]!.version_id,first);
  const repeated=await service.request({target:'https://versions.test',task_id:p,trigger:'discovery',queued:true});assert.equal(repeated.ready,true);
  assert.equal((await service.get(newer.task_id)).versions.length,2);
});
test('publication and a concurrent attachment cannot leave a consumer waiting on a completed job',async()=>{
  const p=await parent('publication race'),q=await parent('publication race');
  const job=await service.request({target:'https://publication-race.test',task_id:p,queued:true});
  await running(job.task_id);await service.submit(job.task_id,{paths:{'/orders':{get:operation}}});await service.requestFinish(job.task_id,'合成接口，未覆盖其他模块');
  await Promise.all([service.publish(job.task_id),service.request({target:'https://publication-race.test',task_id:q,queued:true,trigger:'initial'})]);
  const rows=(await pool.query(`SELECT m.version_id,t.status FROM task_business_models m JOIN tasks t ON t.id=m.modeling_task_id WHERE m.task_id=ANY($1::bigint[])`,[[p,q]])).rows;
  assert.ok(rows.every(r=>r.version_id!==null||r.status!=='done'));
});
test('model read and mutation tools respect host ownership and agent role',async()=>{
  registerModelingTools(service);
  const p=await parent('owner'),q=await parent('foreign');
  const job=await service.request({target:'https://ownership.test',task_id:p,queued:true});await finish(job.task_id);
  const read=await runTool(pool,'api_model_read',{system_id:job.system_id},{businessKind:'worker',businessId:'foreign',agentKey:'worker',taskId:q});assert.notEqual(read.status,'executed');
  const write=await runTool(pool,'api_model_submit',{entities:[]},{businessKind:'worker',businessId:'foreign',agentKey:'worker',taskId:job.task_id});assert.notEqual(write.status,'executed');
  const foreignIntent=await graph.addIntent(q,{summary:'foreign'});
  await assert.rejects(service.request({target:'https://ownership.test/foreign',task_id:p,intent_id:foreignIntent,queued:true}));
});
test('HTTP create/list/detail/export validate IDs and expose persisted versions',async()=>{
  const server=createServer((req,res)=>{void routeModeling(req,res,new URL(req.url!,'http://fixture'),{taskEngine:{modeling:service},tasks} as unknown as AppContext,(r,s,v)=>{r.writeHead(s,{'Content-Type':'application/json'});r.end(JSON.stringify(v));});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const bad=await fetch(base+'/api/business-models',{method:'POST',body:JSON.stringify({target:'file:///tmp'})});assert.equal(bad.status,400);
    assert.equal((await fetch(base+'/api/business-models?task_id=NaN')).status,400);
    const created=await fetch(base+'/api/business-models',{method:'POST',body:JSON.stringify({target:'https://http-fixture.test'})});assert.equal(created.status,201);
    const job=await created.json() as {task_id:number};await finish(job.task_id);
    const detail=await (await fetch(base+`/api/business-models/${job.task_id}`)).json() as {versions:unknown[]};assert.equal(detail.versions.length,1);
    assert.match(await (await fetch(base+`/api/business-models/${job.task_id}/export?format=yaml`)).text(),/openapi: 3.0.3/);
    assert.equal((await fetch(base+`/api/business-models/${job.task_id}/stop`,{method:'POST'})).status,409);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
async function waitFor(check:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('fixture deadline exceeded');}
test('real Pi loop: single-slot testing finishes without waiting for optional background models',async()=>{
  const mock=await startMockAnthropic(0,{graphWorkflow:true,tool:body=>{
    const names=(body.tools as {name:string}[]??[]).map(t=>t.name);
    const messages=body.messages as {content:{type:string;name?:string;text?:string}[]}[];
    if(names.includes('insert_assets')&&!messages.some(m=>m.content.some(c=>c.type==='tool_use'&&c.name==='insert_assets'))){
      return {name:'insert_assets',input:{assets:[{type:'service',url:'https://independent.e2e-fixture.test/admin',page_title:'独立系统管理后台'}]}};
    }
    return undefined;
  }});
  const port=(mock.server.address() as {port:number}).port;
  const llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'modeling-e2e',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${port}`,api_key:'synthetic-fixture-key',is_default:true});assert.ok(profile.ok);
  resetPiRuntime();
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});engines.push(engine);
  const serviceTasks=new TaskService(pool,dlq,id=>void engine.launch(id));
  // Domain tests deliberately leave jobs queued. Keep this E2E's queue isolated.
  await pool.query("UPDATE tasks SET status='failed',queued=FALSE WHERE status IN ('created','running','paused')");
  const created=await serviceTasks.create({name:'e2e source',goal:'验证本地协议夹具工作流',timeout_seconds:120,modeling_targets:['https://e2e-fixture.test'],llm_profile_ids:[Number(profile.profile.id)]});assert.ok(created.ok);const id=Number(created.task.id);
  const tick=setInterval(()=>void engine.pumpQueue(),200);
  try{
    await waitFor(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status==='done',45000);
    const models=await engine.modeling.list(id);assert.equal(models.length,2,JSON.stringify(models));assert.ok(models.every(m=>['created','running','failed','done'].includes(m.status)));
    assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'done');
    const executed=(await pool.query('SELECT first_run_at,deadline_at FROM tasks WHERE id=$1',[id])).rows[0];
    assert.equal(new Date(executed.deadline_at).getTime()-new Date(executed.first_run_at).getTime(),120000,'initial modeling must not disable the test execution deadline');
    assert.ok((await pool.query('SELECT 1 FROM intent_business_models WHERE task_id=$1',[id])).rowCount);
    const calls=mock.state.calls.map(c=>(c.body?.tools as {name:string}[]??[]).map(t=>t.name));
    assert.ok(!calls[0]!.includes('api_model_submit'),'testing is admitted before optional modeling');
    assert.ok((await pool.query("SELECT 1 FROM tool_calls WHERE run_id=$1 AND is_error=FALSE",['task-'+id])).rowCount);
  }finally{clearInterval(tick);await engine.shutdown();await new Promise<void>(r=>mock.server.close(()=>r()));}
});
test('pause/resume cancels the old modeling turn and only publishes after the resumed turn',async()=>{
  let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  const mock=await startMockAnthropic(0,{responseBarrier:barrier});
  const llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'modeling-pause',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile.id));resetPiRuntime();
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  const controls=new TaskService(pool,dlq,id=>void engine.launch(id),(id,action)=>{if(action==='pause')engine.pause(id);else if(action==='resume')engine.resume(id);else engine.abort(id);});
  const job=await engine.modeling.request({target:'https://pause-fixture.test'});
  try{
    await waitFor(async()=>mock.state.calls.length>0);
    assert.equal((await controls.control(job.task_id,'pause')).ok,true);
    assert.equal((await engine.modeling.get(job.task_id)).status,'paused');
    assert.equal((await engine.modeling.get(job.task_id)).versions.length,0);
    release();await controls.control(job.task_id,'resume');
    await waitFor(async()=>(await engine.modeling.get(job.task_id)).status==='done');
    assert.equal((await engine.modeling.get(job.task_id)).versions.length,1);
  }finally{release();await engine.shutdown();await new Promise<void>(r=>mock.server.close(()=>r()));}
});
test('boot recovery runs an interrupted modeling job from its durable draft',async()=>{
  const mock=await startMockAnthropic(0);
  const llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'modeling-recovery',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile.id));resetPiRuntime();
  const job=await service.request({target:'https://recovery-fixture.test',queued:true});await running(job.task_id);await service.submit(job.task_id,{paths:{'/checkpoint':{get:operation}}});
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  try{
    await engine.recover();await waitFor(async()=>(await engine.modeling.get(job.task_id)).status==='done');
    const recovered=await engine.modeling.get(job.task_id);assert.ok(recovered.document.paths['/checkpoint']);assert.ok(recovered.document.paths['/fixture']);assert.equal(recovered.versions.length,1);
  }finally{await engine.shutdown();await new Promise<void>(r=>mock.server.close(()=>r()));}
});

test('standalone Auto can query its own models or explicitly link a test task without overriding task ownership',async()=>{
  registerModelingTools(service);
  const conversation=Number((await pool.query("INSERT INTO conversations(agent_key,title) VALUES('auto','model scope') RETURNING id")).rows[0].id);
  const other=Number((await pool.query("INSERT INTO conversations(agent_key,title) VALUES('auto','other scope') RETURNING id")).rows[0].id);
  const ctx={businessKind:'chat',businessId:`conv-${conversation}`,agentKey:'auto',conversationId:conversation};
  const launch=await runTool(pool,'request_business_model',{target:'https://auto-scope.test',reason:'合成测试'},ctx);
  assert.equal(launch.status,'executed');const job=launch.output as {task_id:number;system_id:number};await finish(job.task_id);
  const list=await runTool(pool,'list_business_models',{},ctx);assert.equal((list.output as any[])[0].modeling_task_id,String(job.task_id));
  const read=await runTool(pool,'api_model_read',{system_id:job.system_id,path:'/orders'},ctx);assert.equal(read.status,'executed');assert.ok((read.output as any).document.paths['/orders']);
  const foreign=await runTool(pool,'api_model_read',{system_id:job.system_id},{...ctx,businessId:`conv-${other}`,conversationId:other});assert.notEqual(foreign.status,'executed');
  const p=await parent('explicit task binding'),q=await parent('foreign task binding');
  const linked=await runTool(pool,'request_business_model',{target:'https://auto-linked.test',reason:'用户指定任务',task_id:p},ctx);assert.equal(linked.status,'executed');
  assert.equal((await service.catalog(p)).length,1);
  const override=await runTool(pool,'request_business_model',{target:'https://cannot-override.test',reason:'invalid override',task_id:q},{businessKind:'task',businessId:`task-${p}-main`,agentKey:'mainagent',taskId:p});assert.notEqual(override.status,'executed');
});

test('entrance checks retry transport failures twice, accept HTTP errors as reachable, and respect cancellation and policy denial',async()=>{
  let attempts=0;
  await assert.rejects(probeModelingEntrance('https://unreachable.test',async()=>{attempts++;return {status:'blocked',executionFailed:true,error:'AbortError'};}),/两次请求/);assert.equal(attempts,2);
  assert.equal((await probeModelingEntrance('https://reachable.test',async()=>({status:'executed',output:{status:403,body:'login required'}}))).status,403);
  attempts=0;await assert.rejects(probeModelingEntrance('https://blocked.test',async()=>{attempts++;return {status:'blocked',error:'scope denied'};}),/策略阻止/);assert.equal(attempts,1);
  const abort=new AbortController();attempts=0;
  await assert.rejects(probeModelingEntrance('https://cancel.test',async()=>{attempts++;abort.abort();return {status:'error',error:'aborted'};},abort.signal));assert.equal(attempts,1);
});

test('queued modeling keeps its full execution budget and reserves time for a bounded final submission',async()=>{
  const job=await service.request({target:'https://queued-budget.test',queued:true});
  const queued=(await pool.query('SELECT first_run_at,deadline_at,timeout_seconds FROM tasks WHERE id=$1',[job.task_id])).rows[0];
  assert.equal(queued.first_run_at,null);assert.equal(queued.deadline_at,null);assert.equal(queued.timeout_seconds,900);
  const budget=modelingRunBudget(900000,900,0);assert.ok(budget.seconds+budget.settlementSeconds<900);assert.equal(budget.settlementSeconds,60);
  const short=modelingRunBudget(30000,900,0);assert.ok(short.seconds+short.settlementSeconds<=30);
});

test('an unreachable entrance fails before any model call, records the cause and preserves a retry draft',async()=>{
  await pool.query("UPDATE tasks SET status='failed',queued=FALSE WHERE status IN ('created','running','paused')");
  let calls=0;
  const engine=new TaskEngine(pool,config,{modelingProbe:(target,signal)=>probeModelingEntrance(target,async()=>{calls++;return {status:'error',error:'test route timeout'};},signal),agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  const original=await service.request({target:'https://unreachable-draft.test',queued:true});await running(original.task_id);await service.submit(original.task_id,{paths:{'/retained':{get:operation}}});
  await pool.query("UPDATE tasks SET status='timeout',queued=FALSE WHERE id=$1",[original.task_id]);
  const retry=await engine.modeling.retry(original.task_id);
  try{
    await waitFor(async()=>(await engine.modeling.get(retry.task_id)).status==='failed');
    const detail=await engine.modeling.get(retry.task_id);assert.match(detail.stopped_reason,/目标入口不可达/);assert.ok(detail.document.paths['/retained']);assert.ok(detail.events.some(e=>e.event_type==='modeling_failed'));assert.equal(calls,2);
    assert.equal((await pool.query('SELECT 1 FROM llm_usage WHERE task_id=$1',[String(retry.task_id)])).rowCount,0);
    const clock=(await pool.query('SELECT first_run_at,deadline_at FROM tasks WHERE id=$1',[retry.task_id])).rows[0];assert.ok(clock.first_run_at);assert.ok(clock.deadline_at);
  }finally{await engine.shutdown();}
});

test('real Auto conversation and task main-agent chat launch modeler jobs and read their published results',async()=>{
  await pool.query("UPDATE tasks SET status='failed',queued=FALSE WHERE status IN ('created','running','paused')");
  let system=0;
  const mock=await startMockAnthropic(0,{tool:body=>{
    const names=(body.tools as {name:string}[]??[]).map(t=>t.name);
    if(!names.includes('request_business_model')||names.includes('api_model_submit'))return undefined;
    const messages=body.messages as {content:{type:string;name?:string;text?:string}[]}[];
    const used=messages.flatMap(m=>m.content).filter(c=>c.type==='tool_use').map(c=>c.name);
    const main=names.includes('pause_current_task');
    if(!used.includes('request_business_model'))return {name:'request_business_model',input:{target:main?'https://main-chat-fixture.test':'https://auto-chat-fixture.test',reason:'仅使用合成协议夹具'}};
    if(!used.includes('list_business_models'))return {name:'list_business_models',input:{}};
    if(JSON.stringify(messages).includes('MODE:read')&&!used.includes('api_model_read'))return {name:'api_model_read',input:{system_id:system,path:'/fixture'}};
    return undefined;
  }});
  const llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'modeling-chat-native',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile.id));resetPiRuntime();
  const agents=new AgentsService(pool,dlq),assets=new AssetsService(pool,dlq),findings=new FindingsService(pool,dlq),intercept=new InterceptService(pool,dlq);
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents,assets,findings,intercept,settingsConsumers:null});engines.push(engine);
  const deps={pool,dlqPath:dlq,tasks,assets,findings,intercept,modeling:engine.modeling,graph:engine.graph,skills:new SkillsService(pool,dlq,path.join(tmp,'chat-skills')),mcp:new McpService(pool,dlq)};
  registerPlatformTools(deps);
  const auto=new ConversationsService(pool,config,agents,dlq,(key,ctx)=>chatToolsFor(key,ctx,deps));
  const main=new TaskChatService(pool,config,agents);
  main.wire(engine,(taskId,signal,businessId)=>chatToolsFor('mainagent',{taskId,signal,businessId,businessKind:'task',agentKey:'mainagent'},deps));
  try{
    const conv=await auto.create('auto','独立业务建模',Number(profile.profile.id));assert.ok(conv.ok);const cid=Number(conv.conv.id);
    assert.equal((await auto.send(cid,'请对指定系统进行业务建模')).status,202);
    await waitFor(async()=>!auto.isRunning(cid));
    const own=(await engine.modeling.conversationCatalog(cid))[0];assert.ok(own);system=Number(own.system_id);
    await waitFor(async()=>(await engine.modeling.get(Number(own.modeling_task_id))).status==='done');
    assert.equal((await auto.send(cid,'MODE:read 请读取建模接口')).status,202);await waitFor(async()=>!auto.isRunning(cid));
    const reads=(await pool.query("SELECT result,is_error,native_tool_call_id FROM tool_calls WHERE business_kind='chat' AND business_id=$1 AND tool_key='api_model_read'",[`conv-${cid}`])).rows;
    assert.equal(reads.length,1);assert.equal(reads[0].is_error,false);assert.ok(reads[0].native_tool_call_id);assert.ok(reads[0].result.document.paths['/fixture']);
    const p=await parent('main agent modeling');await pool.query("UPDATE tasks SET status='done',queued=FALSE WHERE id=$1",[p]);
    assert.equal((await main.send(p,'请给当前任务补充业务建模')).status,202);await waitFor(async()=>!main.isBusy(p));
    const linked=(await engine.modeling.catalog(p))[0];assert.ok(linked);await waitFor(async()=>(await engine.modeling.get(Number(linked.modeling_task_id))).status==='done');
    assert.equal((await pool.query('SELECT source_task_id FROM business_model_runs WHERE task_id=$1',[linked.modeling_task_id])).rows[0].source_task_id,String(p));
    system=Number(linked.system_id);
    assert.equal((await main.send(p,'MODE:read 请读取当前任务的建模接口')).status,202);await waitFor(async()=>!main.isBusy(p));
    const mainRead=(await pool.query("SELECT result,is_error,native_tool_call_id FROM tool_calls WHERE business_kind='task' AND business_id=$1 AND tool_key='api_model_read'",[`task-${p}-main`])).rows;
    assert.equal(mainRead.length,1);assert.equal(mainRead[0].is_error,false);assert.ok(mainRead[0].native_tool_call_id);assert.ok(mainRead[0].result.document.paths['/fixture']);
    assert.ok(mock.state.calls.some(c=>JSON.stringify(c.body?.system).includes('用户明确要求业务建模')));
  }finally{await auto.shutdown();await main.shutdown();await engine.shutdown();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));}
});

test('modeler turn budget enters a network-free settlement and publishes the saved model',async()=>{
  const mock=await startMockAnthropic(0),llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'modeling-settlement',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile.id));resetPiRuntime();
  await pool.query("UPDATE agents SET max_turns=1 WHERE key='modeler'");
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  try{
    const job=await engine.modeling.request({target:'https://settlement-fixture.test'});await waitFor(async()=>(await engine.modeling.get(job.task_id)).status==='done');
    const settled=mock.state.calls.filter(call=>JSON.stringify(call.body?.messages).includes('现在停止扩展建模范围'));
    assert.ok(settled.length);const names=(settled[0].body?.tools as {name:string}[]).map(t=>t.name);assert.ok(names.includes('api_model_done'));assert.ok(!names.includes('http_request'));assert.ok(!names.includes('Bash'));
    assert.equal((await engine.modeling.get(job.task_id)).versions.length,1);
  }finally{await pool.query("UPDATE agents SET max_turns=0 WHERE key='modeler'");await engine.shutdown();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));}
});

test('queue expiration retains an actionable modeling reason and exposes the timeout event',async()=>{
  const engine=new TaskEngine(pool,config,{modelingProbe:syntheticEntrance,agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  const job=await engine.modeling.request({target:'https://expired-model.test',queued:true});
  await pool.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[job.task_id]);
  try{await engine.pumpQueue();const detail=await engine.modeling.get(job.task_id);assert.equal(detail.status,'timeout');assert.match(detail.stopped_reason,/草稿.*保留/);assert.ok(detail.events.some(e=>e.event_type==='modeling_timeout'));}
  finally{await engine.shutdown();}
});

test('real HTTP gate execution errors are retried as transport failures rather than policy denials',async()=>{
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const engine=new TaskEngine(pool,config,{agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});engines.push(engine);
  try{
    const job=await engine.modeling.request({target:`http://127.0.0.1:${port}`});await waitFor(async()=>(await engine.modeling.get(job.task_id)).status==='failed');
    const detail=await engine.modeling.get(job.task_id);assert.match(detail.stopped_reason,/目标入口不可达/);assert.match(detail.stopped_reason,/两次请求/);assert.ok(!detail.stopped_reason.includes('工具策略阻止'));
    const calls=(await pool.query("SELECT execution_ms,is_error FROM tool_calls WHERE business_id=$1 AND tool_key='http_request'",[`task-${job.task_id}-modeling`])).rows;assert.equal(calls.length,2);assert.ok(calls.every(c=>c.is_error&&c.execution_ms!==null));
    assert.equal((await pool.query('SELECT 1 FROM llm_usage WHERE task_id=$1',[String(job.task_id)])).rowCount,0);
  }finally{await engine.shutdown();}
});
