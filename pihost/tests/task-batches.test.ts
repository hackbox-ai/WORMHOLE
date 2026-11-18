import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskBatches} from '../src/domains/tasks/batches.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {completeAchievedTask} from '../src/domains/tasks/completion.ts';
import {requestDiscoveryFinish,finishDiscoveryIfReady} from '../src/domains/tasks/continuous.ts';
import {EfficiencySupervisor} from '../src/domains/tasks/efficiency.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {FingerprintService} from '../src/domains/fingerprints/service.ts';
import {PocService} from '../src/domains/pocs/service.ts';
import {pocReviewed} from '../src/domains/pocs/lifecycle.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import type {PihostConfig} from '../src/config.ts';
import {routeTaskBatches} from '../src/api/task-batches.ts';
import {ModelingService} from '../src/domains/modeling/service.ts';
import {SettingsService} from '../src/domains/settings/service.ts';
import {SettingsConsumers} from '../src/domains/settings/consumers.ts';
const dsn=process.env.WORMHOLE_POC_TEST_DSN;
if(!dsn){test('batch integration requires isolated database',{skip:true},()=>{});}else{
 if(!new URL(dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('isolated fixture required');
 const admin=new Pool({connectionString:dsn}),schema='batch_'+process.pid+'_'+Date.now();
 let pool:Pool,dir:string,tasks:TaskService,batches:TaskBatches,graph:ExplorationService,fp:FingerprintService,pocs:PocService;
 before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:dsn,options:'-c search_path='+schema});await runMigrations(pool);dir=await mkdtemp(path.join(tmpdir(),'wormhole-batch-'));tasks=new TaskService(pool,path.join(dir,'dlq'),()=>{throw new Error('queued tasks cannot launch sessions');});graph=new ExplorationService(pool);fp=new FingerprintService(pool);pocs=new PocService(pool);batches=new TaskBatches(pool,tasks,async()=>({fingerprint:await fp.snapshot(),poc:await pocs.snapshot()}));});
 after(async()=>{await fp?.close();await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
 const body=(targets='example.com\n192.0.2.1\nhttps://example.net/app')=>({targets,idempotency_key:randomUUID(),timeout_seconds:1800,requirements:'保留可复现证据'});
 async function children(id:string){return (await pool.query('SELECT * FROM tasks WHERE batch_id=$1 ORDER BY batch_position',[id])).rows;}
 async function active(id:number){await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[id]);await graph.ensure(id);}
 test('batch creation is atomic, queued, idempotent and pins one pair of knowledge snapshots',async()=>{
  const input=body(),batch=await batches.create(input),again=await batches.create(input);assert.equal(again.duplicate,true);
  const rows=await children(batch.id);assert.equal(rows.length,3);assert.deepEqual(rows.map(t=>t.batch_position),[1,2,3]);
  for(const t of rows){assert.equal(t.queued,true);assert.equal(t.deadline_at,null);assert.equal(t.first_run_at,null);assert.equal(t.worker_limit,null);assert.equal(t.execution_mode,'continuous');assert.match(t.goal,/不设最低或最高漏洞数量/);assert.equal((await pool.query('SELECT count(*)::int n FROM task_scope WHERE task_id=$1',[t.id])).rows[0].n,1);}
  assert.equal((await pool.query('SELECT count(DISTINCT snapshot_id)::int n FROM task_poc_state WHERE task_id=ANY($1::bigint[])',[rows.map(t=>t.id)])).rows[0].n,1);
  await assert.rejects(batches.create({...input,targets:'different.example'}),/提交编号/);
  const invalid=body();await assert.rejects(batches.create({...invalid,llm_profile_ids:[99999999]}));assert.equal((await pool.query('SELECT 1 FROM task_batches WHERE id=$1',[invalid.idempotency_key])).rowCount,0);
 });
 test('batch worker options follow global settings and upgrade clears the old fixed override',async()=>{
  assert.equal((await batches.options()).workers,3);
  await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.workers','2') ON CONFLICT(key) DO UPDATE SET value='2'");
  assert.equal((await batches.options()).workers,2);
  const batch=await batches.create(body('inherit-workers.example'));
  const row=(await children(batch.id))[0];assert.equal(row.worker_limit,null);
  await pool.query('UPDATE tasks SET worker_limit=1 WHERE id=$1',[row.id]);
  const {readFile}=await import('node:fs/promises');
  await pool.query(await readFile('migrations/0075_batch_worker_inheritance.sql','utf8'));
  assert.equal((await children(batch.id))[0].worker_limit,null);
  await pool.query("DELETE FROM app_settings WHERE key='settings.workers'");
 });
 test('batch API pauses, resumes and cancels persisted children including exclusive model prerequisites',async()=>{
  const controlTasks=new TaskService(pool,path.join(dir,'dlq'),()=>{},async(id,action)=>{if(action==='resume')await pool.query('UPDATE tasks SET queued=true,queued_at=COALESCE(queued_at,now()) WHERE id=$1',[id]);});
  const ctx={pool,tasks:controlTasks,fingerprints:fp,pocs,taskEngine:{pumpQueue:async()=>{}}} as any;
  const api=createServer((req,res)=>{void routeTaskBatches(req,res,new URL(req.url!,'http://localhost'),ctx,(r,s,v)=>{r.writeHead(s,{'content-type':'application/json'});r.end(JSON.stringify(v));});});
  await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(api.address() as {port:number}).port;
  const call=async(p:string,b:unknown)=>{const r=await fetch(origin+'/api/task-batches'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;};
  try{const batch=await call('',body('https://batch-control.example/a\nhttps://batch-control.example/b')),rows=await children(batch.id);
   const model=await new ModelingService(pool).request({target:'https://batch-control.example',task_id:Number(rows[0].id),trigger:'initial',reason:'controlled prerequisite'});
   await call('/'+batch.id+'/control',{action:'pause_all'});assert.ok((await children(batch.id)).every(t=>t.paused));assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[model.task_id])).rows[0].paused,true);
   await call('/'+batch.id+'/control',{action:'resume'});assert.ok((await children(batch.id)).every(t=>!t.paused&&t.queued));
   await call('/'+batch.id+'/control',{action:'pause_queue'});assert.ok((await children(batch.id)).every(t=>t.paused));
   await call('/'+batch.id+'/control',{action:'cancel_waiting'});assert.ok((await children(batch.id)).every(t=>t.status==='failed'&&!t.queued&&!t.paused));assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[model.task_id])).rows[0].status,'failed');
  }finally{api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
 });
 test('proving every goal cannot terminate continuous discovery; completion needs current owned evidence',async()=>{
  const batch=await batches.create(body('continuous.example')),id=Number((await children(batch.id))[0].id);await active(id);
  const goal=await graph.addGoal(id,{text:'阶段目标'}),fact=await graph.recordFact(id,{summary:'实际响应为公开静态页面',evidence:'controlled fixture response'});
  const proof=await graph.proveGoal(id,goal,fact);assert.equal(proof.allMet,true);assert.equal(proof.completed,false);assert.equal(await completeAchievedTask(pool,id),false);assert.equal(await new EfficiencySupervisor(pool).finishCovered(id),false);
  await pocs.refresh(id);
  const reason='已复查公开入口与已有响应，没有可执行的新方向，保留现有证据与受限检查。',coverage=[{area:'公开入口与应用响应',outcome:'tested',reason:'实际响应已记录'}];
  await assert.rejects(requestDiscoveryFinish(pool,id,reason,[99999999],coverage),/依据/);
  await requestDiscoveryFinish(pool,id,reason,[fact],coverage);await graph.recordFact(id,{summary:'新增待分析响应'});assert.equal(await finishDiscoveryIfReady(pool,id),false,'new evidence invalidates an earlier review');
  await requestDiscoveryFinish(pool,id,reason,[fact],coverage);assert.equal(await finishDiscoveryIfReady(pool,id),false,'unread PoC revision holds completion');await pocReviewed(pool,id,Number((await pocs.summary(id)).revision));assert.equal(await finishDiscoveryIfReady(pool,id),true);assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'done');
 });
 test('UI workers=3 starts three native Workers claiming distinct intents concurrently',async()=>{
  await pool.query("UPDATE tasks SET status='failed',queued=false,paused=false WHERE status NOT IN('done','failed','timeout')");
  const pending:import('node:http').ServerResponse[]=[],target=createServer((req,res)=>{if(req.url!=='/proof'){res.end('controlled entrance');return;}pending.push(res);});
  await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+(target.address() as {port:number}).port+'/';
  const mock=await startMockAnthropic(0,{tool:body=>{
   const names=(body.tools as {name:string}[]??[]).map(t=>t.name);
   if(names.includes('api_model_submit')||!names.includes('http_request'))return undefined;
   const used=JSON.stringify(body.messages).includes('"name":"http_request"');
   return used?undefined:{name:'http_request',input:{url:url+'proof',method:'GET'}};
  }});
  const config:PihostConfig={listen:{host:'127.0.0.1',port:0},database:{dsn},dataDir:dir,pi:{agentDir:path.join(dir,'parallel-agent'),modelsPath:path.join(dir,'parallel-agent/models.json'),provider:'fixture',modelId:'mock-1'}};
  await mkdir(config.pi.agentDir,{recursive:true});await writeFile(config.pi.modelsPath,'{"providers":{}}');
  const dlq=path.join(dir,'parallel-dlq'),settings=new SettingsService(pool,dlq),consumers=new SettingsConsumers(pool,settings,dlq);
  await settings.apply({workers:3});assert.equal((await consumers.load()).workers,3);
  const profile=await new LlmService(pool,dlq,config.pi.modelsPath).createProfile({name:'three-native-workers',model:'mock-1',format:'anthropic',base_url:'http://127.0.0.1:'+(mock.server.address() as {port:number}).port,api_key:'fixture',is_default:true});assert.ok(profile.ok);resetPiRuntime();
  const engine=new TaskEngine(pool,config,{assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),agents:new AgentsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:consumers});
  try{
   const batch=await batches.create({...body(url),llm_profile_ids:[Number(profile.profile.id)]}),taskId=Number((await children(batch.id))[0].id);
   await graph.addGoal(taskId,{text:'Three independent response checks'});
   for(let n=1;n<=3;n++)await graph.addIntent(taskId,{summary:'Independent response check '+n,test_key:'parallel-'+n,hypothesis:'controlled response '+n,stop_condition:'one GET response'});
   await engine.pumpQueue();
   const deadline=Date.now()+20000;
   while(pending.length<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
   const claims=(await pool.query("SELECT id,claimed_by FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state='running'",[taskId])).rows;
   assert.equal(pending.length,3,'three actual HTTP requests are simultaneously awaiting responses');
   assert.equal(claims.length,3);assert.equal(new Set(claims.map(c=>c.claimed_by)).size,3,'distinct Worker owners claim distinct intents');
   for(let n=1;n<=3;n++)assert.ok(claims.some(c=>c.claimed_by==='worker-task'+taskId+'-'+n));
   assert.ok(engine.slots.ids.includes(taskId),'Workers execute under their owning task slot');
   for(const res of pending)res.end('parallel proof');
   await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=$1",[taskId]);engine.abort(taskId);await engine.drain(taskId);
  }finally{
   for(const res of pending)if(!res.writableEnded)res.end('cleanup');
   await engine.shutdown();
   await pool.query("UPDATE llm_profiles SET is_default=false WHERE name='three-native-workers'");
   for(const server of [target,mock.server]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }
 });
 test('real Pi + five HTTP targets roll forward at three, continue after goal proof and stop at admission-based deadlines',async()=>{
  await pool.query("UPDATE tasks SET status='failed',queued=false,paused=false WHERE status NOT IN('done','failed','timeout')");
  const hits:string[]=[],servers=Array.from({length:5},()=>createServer((req,res)=>{hits.push(req.headers.host+req.url!);res.setHeader('content-type','text/plain');res.end('controlled batch response');}));
  for(const server of servers)await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const urls=servers.map(s=>'http://127.0.0.1:'+(s.address() as {port:number}).port+'/');
  const mock=await startMockAnthropic(0,{delayMs:50,tool:body=>{
   const names=(body.tools as {name:string}[]??[]).map(t=>t.name),messages=body.messages as {role:string;content:{type:string;name?:string;text?:string}[]}[];
   const used=(name:string)=>messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_use'&&c.name===name)),prompt=messages.find(m=>m.role==='user'&&Array.isArray(m.content))?.content.filter(c=>c.type==='text').map(c=>c.text).join('')??'';
   if(names.includes('set_goals')&&!names.includes('add_intent'))return used('set_goals')?undefined:{name:'set_goals',input:{text:'核对本地公开响应',objective_type:'coverage'}};
   if(names.includes('add_intent')){const overview=JSON.parse(prompt.split('任务探索图概览：\n')[1]!.split('\n操作约束：')[0]!);const fact=overview.recent_facts.find((f:{state:string})=>f.state==='confirmed');if(fact&&overview.goals[0].state!=='met'&&!used('prove_goal'))return {name:'prove_goal',input:{goal_id:Number(overview.goals[0].id),evidence_id:Number(fact.id)}};if(fact&&overview.goals[0].state==='met'&&JSON.stringify(overview).includes(urls[4])&&!used('finish_discovery'))return {name:'finish_discovery',input:{reason:'已复查受控公开入口和实际响应，仅当前合成检查范围内无可执行新方向，保留真实结果。',evidence_ids:[Number(fact.id)],coverage:[{area:'受控公开 HTTP 响应',outcome:'tested',reason:'已发送 GET 并记录实际结果，无其他授权入口'}]}};if(!fact&&!overview.open_intents.length&&!overview.running_intents.length&&!overview.done_intents_total&&!used('add_intent'))return {name:'add_intent',input:{summary:'GET actual controlled response',test_key:'batch-fixture-read',hypothesis:'public endpoint responds',stop_condition:'record one actual HTTP response'}};return undefined;}
   if(names.includes('http_request')){const text=JSON.stringify(body);const target=urls.find(u=>text.includes(u));if(target&&!used('http_request'))return {name:'http_request',input:{url:target+'proof',method:'GET'}};if(!used('record_fact'))return {name:'record_fact',input:{summary:'公开入口核验完成，继续其他覆盖方向',evidence:'actual GET controlled batch response'}};}
   return undefined;
  }});
  const config:PihostConfig={listen:{host:'127.0.0.1',port:0},database:{dsn},dataDir:dir,pi:{agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json'),provider:'fixture',modelId:'mock-1'}};
  await mkdir(config.pi.agentDir,{recursive:true});await writeFile(config.pi.modelsPath,'{"providers":{}}');
  const profile=await new LlmService(pool,path.join(dir,'dlq'),config.pi.modelsPath).createProfile({name:'batch-native',model:'mock-1',format:'anthropic',base_url:'http://127.0.0.1:'+(mock.server.address() as {port:number}).port,api_key:'synthetic-fixture-key',is_default:true});assert.ok(profile.ok);resetPiRuntime();
  const makeEngine=()=>new TaskEngine(pool,config,{pocs,fingerprints:fp,assets:new AssetsService(pool,path.join(dir,'dlq')),findings:new FindingsService(pool,path.join(dir,'dlq')),agents:new AgentsService(pool,path.join(dir,'dlq')),intercept:new InterceptService(pool,path.join(dir,'dlq')),settingsConsumers:{get:()=>({workers:4,taskConcurrencyEnabled:false,taskConcurrencyLimit:9,trafficCapture:false}),getRebuildCount:()=>0}});let engine=makeEngine();
  let max=0;const sample=setInterval(()=>{max=Math.max(max,engine.slots.size);},5);
  async function until(fn:()=>Promise<boolean>|boolean,label:string,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('timeout '+label+' '+JSON.stringify({tasks:(await pool.query('SELECT id,status,queued,paused,first_run_at,stopped_reason FROM tasks ORDER BY id')).rows,nodes:(await pool.query('SELECT task_id,kind,title,state,last_error FROM exploration_nodes ORDER BY id')).rows,errors:(await pool.query('SELECT tool_key,params,error_text FROM tool_calls WHERE is_error ORDER BY id')).rows,hits,requests:mock.state.calls.length}));}
  try{
   const batch=await batches.create({...body(urls.join('\n')),llm_profile_ids:[Number(profile.profile.id)]}),rows=await children(batch.id),ids=rows.map(t=>Number(t.id));
   await engine.pumpQueue();await until(()=>engine.slots.size===3,'first three admitted');
   await until(async()=>Number((await pool.query("SELECT count(*)::int n FROM exploration_nodes WHERE task_id=ANY($1::bigint[]) AND kind='goal' AND state='met'",[ids.slice(0,3)])).rows[0].n)===3,'first three real responses and goal proofs');
   const before=await children(batch.id);assert.ok(before.slice(0,3).every(t=>t.status==='running'),JSON.stringify(before));assert.ok(before.slice(3).every(t=>t.first_run_at===null&&t.deadline_at===null&&t.queued),JSON.stringify(before));assert.equal(max,3);
   const chatTask=await tasks.create({queued:true,goal:'controlled queued chat'});assert.ok(chatTask.ok);const chatId=Number(chatTask.task.id);await pool.query("UPDATE tasks SET queue_mode='pentest_chat',status='running' WHERE id=$1",[chatId]);let chatRelease:(()=>void)|undefined;const pendingChat=engine.acquireConversationTask(chatId,new AbortController().signal).then(r=>{chatRelease=r;});
   await pool.query("UPDATE tasks SET status='done',completed_at=now() WHERE id=$1",[ids[1]]);engine.abort(ids[1]!);await engine.drain(ids[1]!);await pendingChat;assert.ok(engine.slots.ids.includes(chatId));assert.equal((await pool.query('SELECT first_run_at FROM tasks WHERE id=$1',[ids[3]])).rows[0].first_run_at,null,'chat and task execution share all three slots');chatRelease!();await pool.query("UPDATE tasks SET status='done' WHERE id=$1",[chatId]);await engine.pumpQueue();
   await until(async()=>!!(await pool.query('SELECT first_run_at FROM tasks WHERE id=$1',[ids[3]])).rows[0].first_run_at,'fourth starts without waiting for task one');assert.ok(engine.slots.ids.includes(ids[0]!));assert.ok(!engine.slots.ids.includes(ids[4]!));
   const abortChat=new AbortController();let chatStarted=false;const chat=engine.acquireConversationTask(999999,abortChat.signal).then(r=>{chatStarted=true;r();}).catch(()=>{});await new Promise(r=>setTimeout(r,100));assert.equal(chatStarted,false);abortChat.abort();await chat;
   await pool.query('UPDATE tasks SET deadline_at=now()-interval \'1 second\' WHERE id=$1',[ids[0]]);await (engine as any).settleTask(ids[0]);
   assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[ids[0]])).rows[0].status,'timeout');await engine.pumpQueue();await until(async()=>!!(await pool.query('SELECT first_run_at FROM tasks WHERE id=$1',[ids[4]])).rows[0].first_run_at,'fifth after deadline cleanup');
   const count=hits.filter(h=>h.includes(String((servers[0]!.address() as {port:number}).port))).length;await new Promise(r=>setTimeout(r,300));assert.equal(hits.filter(h=>h.includes(String((servers[0]!.address() as {port:number}).port))).length,count,'no new target requests after cutoff');assert.equal(max,3);assert.ok(hits.some(h=>h.endsWith('/proof')));
   await until(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[ids[4]])).rows[0].status==='done','host accepts actual planner coverage review');assert.ok((await pool.query("SELECT 1 FROM tool_calls WHERE tool_key='finish_discovery' AND NOT is_error AND business_id=$1",['task-'+ids[4]])).rowCount);
   await pool.query('UPDATE tasks SET paused=true WHERE id=$1',[ids[3]]);engine.pause(ids[3]!);await engine.shutdown();engine=makeEngine();await engine.recover();assert.ok(engine.slots.size<=3);assert.equal(engine.isRunning(ids[3]!),false,'recovery preserves a human pause');assert.ok(engine.isRunning(ids[2]!)&&!engine.isRunning(ids[4]!),'recover only nonterminal admitted tasks');
  }finally{clearInterval(sample);await engine.shutdown();for(const s of [mock.server,...servers]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}}
 });
}
