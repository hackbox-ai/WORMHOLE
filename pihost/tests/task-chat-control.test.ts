import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {TaskChatService} from '../src/domains/tasks/chat.ts';
import {applyTaskExecutionControl} from '../src/domains/tasks/runtime-control.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {registerPlatformTools,chatToolsFor} from '../src/domains/tools/platform.ts';
import {runTool} from '../src/domains/tools/gate.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import {projectActivity} from '../src/domains/activity/projector.ts';
import {appendEvent} from '../src/events/ledger.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+60000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail('timeout '+label);}
test('Main agent stops/pauses a real worker, reads findings and finishes its summary without cancelling itself',async()=>{
 const base=loadConfig(),tag=process.pid+'_'+Date.now(),schema='wormhole_main_control_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-main-control-'));
 const admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
 await mkdir(path.join(dir,'agent'));await mkdir(path.join(dir,'skills'));await writeFile(path.join(dir,'agent/models.json'),'{"providers":{}}');
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}},dlq=path.join(dir,'dlq');
 let requests=0,closed=0,direct=false;
 const marker=path.join(dir,"background-heartbeat");
 const endpoint=createServer((_req,res)=>{requests++;res.on('close',()=>closed++);});await new Promise<void>(r=>endpoint.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+(endpoint.address() as {port:number}).port;
 const mock=await startMockAnthropic(0,{tool:body=>{
  const names=((body.tools??[]) as {name:string}[]).map(t=>t.name),messages=body.messages as any[];
  if(names.includes('stop_current_task')){
   const user=messages.filter(m=>m.role==='user').flatMap(m=>m.content??[]).filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
   const action=user.includes('暂停任务')?'pause_current_task':'stop_current_task';
   const calls=messages.flatMap(m=>m.content??[]).filter(c=>c.type==='tool_use').map(c=>c.name);
   if(!calls.includes(action))return {name:action,input:{}};
   if(!calls.includes('list_findings'))return {name:'list_findings',input:{}};
   return;
  }
  if(names.includes('set_goals')&&!names.includes('add_intent')&&!messages.some(m=>(m.content??[]).some((c:any)=>c.type==='tool_use')))return {name:'set_goals',input:{text:'controlled goal'}};
  const used=messages.flatMap(m=>m.content??[]).filter(c=>c.type==='tool_use').map(c=>c.name);
  if(direct&&names.includes('http_request')&&names.includes('Bash')&&!used.includes('Bash'))return {
    name:'Bash',input:{command:"while true; do printf x >> '"+marker+"'; sleep 0.05; done",run_in_background:true},
  };
  if(names.includes('http_request')&&!used.includes('http_request'))return {name:'http_request',input:{url}};
 },text:body=>{
  const names=((body.tools??[]) as {name:string}[]).map(t=>t.name);
  if(!names.includes('stop_current_task'))return 'controlled fixture';
  const used=(body.messages as any[]).flatMap(m=>m.content??[]).filter(c=>c.type==='tool_use');
  if(used.length<2)return 'controlled main tool phase';
  const all=JSON.stringify(body.messages);
  return all.includes('fixture finding')&&all.includes('execution_stopped')?'已停止执行。现有记录：fixture finding，待核实。':'FIXTURE_MISSING_CONTROL_OR_FINDINGS';
 }});
 const agents=new AgentsService(pool,dlq),assets=new AssetsService(pool,dlq),findings=new FindingsService(pool,dlq),intercept=new InterceptService(pool,dlq),skills=new SkillsService(pool,dlq,path.join(dir,'skills')),mcp=new McpService(pool,dlq);
 const engine=new TaskEngine(pool,config,{agents,assets,findings,intercept,settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:false,taskConcurrencyLimit:2,trafficCapture:false}),getRebuildCount:()=>0},mcp,skills});
 const tasks=new TaskService(pool,dlq,id=>void engine.bootstrap(id),(id,action)=>applyTaskExecutionControl(engine,id,action));
 const deps={pool,dlqPath:dlq,tasks,assets,findings,intercept,skills,mcp,graph:engine.graph,taskOperation:(id:number)=>engine.beginTaskOperation(id)};
 registerPlatformTools(deps);
 const chat=new TaskChatService(pool,config,agents);
 chat.wire(engine,(taskId,signal,businessId)=>chatToolsFor('mainagent',{businessKind:'task',businessId,agentKey:'mainagent',taskId,signal,canExecute:async()=>!signal.aborted&&!engine.isDeleting(taskId)},deps));
 try{
  await pool.query("INSERT INTO llm_profiles(name,model,format,base_url,api_key,is_default,max_tokens,context_window_k) VALUES('main control','mock-1','anthropic',$1,'fixture',TRUE,1024,16)",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port]);
  for(const action of ['stop','pause'] as const){
   const beforeRequests=requests,beforeClosed=closed;
   const made=await tasks.create({name:'controlled '+action,goal:'controlled worker only',seed_first_intent:true});assert.ok(made.ok);
   const id=Number(made.task!.id);
   await findings.record({task_id:id,name:'fixture finding',vulnclass:'fixture',severity:'medium',summary:'fixture finding',evidence:'controlled fixture evidence',worker:'fixture'});
   await until(()=>requests>beforeRequests,'worker performs a controlled local HTTP request');
   const tools=await chatToolsFor('mainagent',{businessKind:'task',businessId:'binding-check',agentKey:'mainagent',taskId:id},deps);
   assert.ok(tools.some(t=>t.name==='stop_current_task'));assert.ok(tools.some(t=>t.name==='pause_current_task'));
   const sent=await chat.send(id,action==='pause'?'暂停任务，总结当前发现':'停止任务，总结当前发现');assert.equal(sent.status,202);
   await until(()=>!chat.isBusy(id),'main summary finishes after task control');
   await until(()=>closed>beforeClosed,'worker HTTP request is cancelled');
   const row=(await pool.query('SELECT status,paused,stopped_reason FROM tasks WHERE id=$1',[id])).rows[0];
   if(action==='pause'){assert.equal(row.paused,true);assert.equal(row.status,'running');}
   else{assert.equal(row.status,'failed');assert.equal(row.stopped_reason,'manual');}
   await until(async()=>{await projectActivity(pool);return !!(await pool.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND worker='mainagent' AND kind='result'",[made.task!.exploration_id])).rowCount;},'durable summary projects into the UI read model');
   const results=(await pool.query("SELECT detail,is_error FROM activity WHERE exploration_id=$1 AND worker='mainagent' AND kind='result' ORDER BY id",[made.task!.exploration_id])).rows;
   assert.equal(results.length,1);assert.equal(results[0].is_error,false);assert.match(results[0].detail,/fixture finding/);
   const audit=(await pool.query("SELECT tool_key,is_error,native_tool_call_id FROM tool_calls WHERE business_kind='task' AND business_id=$1 ORDER BY id",['task-'+id+'-main'])).rows;
   assert.deepEqual(audit.map(r=>r.tool_key),[action+'_current_task','list_findings']);assert.ok(audit.every(r=>!r.is_error&&r.native_tool_call_id));
   const scoped={businessKind:'task',businessId:'scope-check',agentKey:'mainagent',taskId:id};
   assert.equal((await runTool(pool,'stop_current_task',{task_id:'9999'},scoped)).status,'invalid-params','model cannot select another task');
   assert.equal((await runTool(pool,'stop_current_task',{}, {...scoped,agentKey:'worker'})).status,'not-visible','worker cannot use main controls');
   if(action==='pause')await tasks.control(id,'stop');
   const total=requests;await new Promise(r=>setTimeout(r,120));assert.equal(requests,total,'stopped execution does not emit another request');
  }

  direct=true;
  const made=await tasks.create({name:'HTTP stop with background worker',goal:'controlled worker only',seed_first_intent:true});
  assert.ok(made.ok);
  const id=Number(made.task.id);
  const baselineRequests=requests,baselineClosed=closed;
  await until(async()=>requests>baselineRequests&&(await readFile(marker,'utf8').catch(()=>'' )).length>0,'live Worker Bash and HTTP started');
  const ctx={pool,config,tasks,taskEngine:engine,auth:{verifyToken:async()=>true}} as unknown as AppContext;
  const api=createServer((req,res)=>void routeRequest(req,res,ctx));
  await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
  try{
   const response=await fetch('http://127.0.0.1:'+(api.address() as {port:number}).port+'/api/tasks/'+id+'/stop',{
     method:'POST',headers:{Authorization:'Bearer fixture'},signal:AbortSignal.timeout(10000),
   });
   assert.equal(response.status,200);
   assert.ok(closed>baselineClosed,'HTTP stream closed before stop returned');
   assert.equal((await engine.platformState(id)).started,false,'task run released before stop returned');
   const after=await readFile(marker,'utf8');
   await new Promise(r=>setTimeout(r,250));
   assert.equal(await readFile(marker,'utf8'),after,'background subprocess stopped writing');
   const nodes=(await pool.query("SELECT state,claimed_by FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows;
   assert.ok(nodes.length&&nodes.every(node=>node.state==='stopped'&&node.claimed_by===null));
   assert.ok((await pool.query("SELECT markdown FROM task_reports WHERE task_id=$1 AND phase='final'",[id])).rows[0]?.markdown.trim());
  }finally{
   api.closeAllConnections();
   await new Promise<void>(r=>api.close(()=>r()));
  }
 }finally{
  await chat.shutdown();await engine.shutdown();resetPiRuntime();
  endpoint.closeAllConnections();await new Promise<void>(r=>endpoint.close(()=>r()));mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
test('Activity projection skips a held lock, scopes replay to one run and bounds backlog without losing receipts',async()=>{
 const cfg=loadConfig(),schema='wormhole_projection_control_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:cfg.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:cfg.database.dsn,options:'-c search_path='+schema}),locker=await pool.connect();await runMigrations(pool);
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-projection-control-'));
 try{
  await locker.query('BEGIN');await locker.query("SELECT pg_advisory_xact_lock(hashtext('pi_activity_projection'))");
  const start=Date.now();assert.equal(await projectActivity(pool),0);assert.ok(Date.now()-start<1500,'contention returns promptly');await locker.query('ROLLBACK');
  await pool.query("INSERT INTO explorations(id,goal) VALUES(1,'fixture');INSERT INTO tasks(id,exploration_id,name,goal) VALUES(1,1,'fixture','fixture')");
  for(const runId of ['first','second'])for(let ordinal=0;ordinal<5;ordinal++)await appendEvent(pool,path.join(dir,'dlq'),{business_kind:'mainagent',business_id:runId,event_type:'agent_start',payload:{type:'agent_start',_activity:{taskId:1,worker:'mainagent',runId,ordinal,mainSeg:0}}});
  assert.equal(await projectActivity(pool,{runId:'second',maxEvents:2}),2);
  assert.equal(Number((await pool.query("SELECT next_ordinal FROM pi_activity_capture WHERE run_id='second'")).rows[0].next_ordinal),2);
  assert.equal((await pool.query("SELECT 1 FROM pi_activity_capture WHERE run_id='first'")).rowCount,0,'other runs are not replayed on the tool path');
  assert.equal(await projectActivity(pool,{runId:'second',maxEvents:20}),3);
  assert.equal(await projectActivity(pool,{maxEvents:2}),2);assert.equal(await projectActivity(pool,{maxEvents:20}),3);assert.equal(await projectActivity(pool),0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM pi_activity_projected')).rows[0].count),10,'all event receipts persist exactly once');
 }finally{await locker.query('ROLLBACK');locker.release();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
