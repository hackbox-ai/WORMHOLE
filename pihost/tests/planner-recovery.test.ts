import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {TaskService,TaskEngine} from '../src/domains/tasks/index.ts';
import {resetPiRuntime,setCallRecorder} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import {runPlannerRound,compactPlannerContext,plannerRecoveryContext,plannerRetryDelay,type PlannerPlan} from '../src/domains/tasks/planner-recovery.ts';
import {progressSQL} from '../src/domains/tasks/progress.ts';

async function until(check:()=>Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail(label);}
async function fixture(){
 const base=loadConfig();assert.match(new URL(base.database.dsn).pathname,/test/i);
 const schema='planner_cont_'+process.pid+'_'+Date.now(),dir=await mkdtemp(path.join(tmpdir(),'wormhole-planner-cont-'));
 const admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
 await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),'{"providers":{}}');
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}};
 return {pool,config,dir,close:async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}};
}
test('native Planner keeps scheduling after repeated length, wakes without graph change and preserves user controls',async()=>{
 const {pool,config,dir,close}=await fixture(),dlq=path.join(dir,'dlq');
 let mode:'truncate'|'recover'|'idle'='truncate';
 const planner=(b:any)=>b.tools?.some((t:any)=>t.name==='add_intent');
 const mock=await startMockAnthropic(0,{
  truncate:b=>planner(b)&&mode==='truncate',
  tool:body=>{const b=body as any;if(!planner(b)||mode!=='recover')return;const used=b.messages.some((m:any)=>m.content?.some((c:any)=>c.type==='tool_use'&&c.name==='add_intent'));const known=JSON.stringify(b.messages).includes('one persisted recovery direction');if(!used&&!known)return {name:'add_intent',input:{summary:'one persisted recovery direction',test_key:'fixture-independent-check',hypothesis:'local fixture can be checked',stop_condition:'fixed fixture response'}};},
 });
 const entries:any[]=[];setCallRecorder(async entry=>{entries.push(entry);});
 const deps={agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:false,taskConcurrencyLimit:2,trafficCapture:false}),getRebuildCount:()=>0},mcp:null};
 const makeEngine=()=>new TaskEngine(pool,config,deps);
 let engine=makeEngine(),taskId=0;
 const tasks=new TaskService(pool,dlq,id=>void engine.launch(id),(id,action)=>{if(action==='pause')engine.pause(id);else if(action==='resume')engine.resume(id);});
 const rec=async()=> (await pool.query('SELECT * FROM task_planner_recovery WHERE task_id=$1',[taskId])).rows[0];
 try{
  const profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default,max_tokens,thinking_type,reasoning_effort) VALUES('fixture','anthropic','mock-1',$1,'fixture',true,0,'enabled','max') RETURNING id",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port])).rows[0].id);
  const made=await tasks.create({name:'persistent planning fixture',goal:'fixture goal',queued:true});assert.ok(made.ok);taskId=Number(made.task.id);
  await engine.graph.addGoal(taskId,{text:'open fixture goal'},'system');
  const constraint='Only use controlled local fixtures. '.repeat(80);
  await pool.query("INSERT INTO task_constraints(task_id,kind,text) VALUES($1,'allow',$2)",[taskId,constraint]);
  await pool.query("UPDATE tasks SET status='running',queued=FALSE WHERE id=$1",[taskId]);await engine.launch(taskId);
  await until(async()=>Number((await rec())?.failures)===2,'initial + compact both truncate');
  assert.equal((await rec()).blocked,false);assert.equal(mock.state.calls.filter(c=>planner(c.body)).length,2);
  const calls=mock.state.calls.filter(c=>planner(c.body)).map(c=>c.body as any);
  assert.equal(calls[0].thinking.type,'enabled');assert.equal(calls[1].thinking.type,'disabled');assert.equal(calls[1].output_config,undefined);
  assert.ok(JSON.stringify(calls[1].messages).includes(constraint),'operation constraints are never shortened');
  const truncated=entries.filter(e=>['length','max_tokens'].includes(e.stopReason));assert.equal(truncated.length,2);assert.ok(truncated.every(e=>e.status==='error'));
  const progress=(await pool.query(`SELECT ${progressSQL()} AS progress FROM tasks t WHERE id=$1`,[taskId])).rows[0].progress;
  assert.equal(progress.phase,'planning_retry_wait');assert.ok(progress.next_attempt_at);
  await engine.shutdown();engine=makeEngine();await engine.launch(taskId);
  await new Promise(r=>setTimeout(r,4300));assert.equal(mock.state.calls.filter(c=>planner(c.body)).length,2,'restart must retain delay');
  // No notify and no graph revision change: the persisted schedule itself wakes planning.
  await pool.query("UPDATE task_planner_recovery SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[taskId]);
  await until(async()=>Number((await rec())?.failures)===3,'scheduled single-gap attempt must run');
  assert.equal((await rec()).strategy,'single_gap');assert.equal(mock.state.calls.filter(c=>planner(c.body)).length,3);
  mode='recover';await pool.query("UPDATE task_planner_recovery SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[taskId]);
  await until(async()=>Number((await pool.query("SELECT count(*) FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[taskId])).rows[0].count)===1,'alternate strategy must execute real add_intent');
  await until(async()=>mock.state.calls.some(c=>(c.body as any)?.tools?.some((t:any)=>t.name==='http_request')),'worker continues independently');
  assert.ok(mock.state.calls.filter(c=>(c.body as any)?.tools?.some((t:any)=>t.name==='http_request')).every(c=>(c.body as any).thinking?.type==='enabled'),'Planner recovery control must not leak into Worker calls');
  await engine.shutdown();
  assert.equal(Number((await pool.query("SELECT count(*) FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[taskId])).rows[0].count),1,'persisted tool action is not replayed');
  assert.deepEqual((await pool.query('SELECT max_tokens,thinking_type,reasoning_effort FROM llm_profiles WHERE id=$1',[profile])).rows[0],{max_tokens:0,thinking_type:'enabled',reasoning_effort:'max'});
  // Normal text-only replies are not effective progress and remain scheduled.
  mode='idle';engine=makeEngine();const second=await tasks.create({name:'text only fixture',goal:'still open',queued:true});assert.ok(second.ok);taskId=Number(second.task.id);
  await engine.graph.addGoal(taskId,{text:'unresolved goal'},'system');await pool.query("UPDATE tasks SET status='running',queued=FALSE WHERE id=$1",[taskId]);await engine.launch(taskId);
  await until(async()=>(await rec())?.last_outcome==='idle','text alone must not count as progress');
  assert.equal((await rec()).failures,1);
  await pool.query("UPDATE task_planner_recovery SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[taskId]);
  await until(async()=>Number((await rec())?.failures)===2,'no-action planning must change strategy and continue');
  assert.equal((await rec()).strategy,'compact');
  await pool.query('UPDATE llm_profiles SET updated_at=now() WHERE id=$1',[profile]);
  await until(async()=>{const state=await rec();return state?.strategy==='normal'&&state.last_outcome==='idle'&&state.failures===1;},'model setting changes wake a delayed planner without changing the graph');
  // Idle efficiency must not suspend a planner that has a scheduled next strategy.
  await engine.shutdown();
  await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.task_efficiency','{\"enabled\":true,\"idleSeconds\":1,\"emptyRounds\":1}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  await pool.query("UPDATE task_efficiency_state SET empty_rounds=10,last_progress_at=now()-interval '1 hour',paused_reason=NULL WHERE task_id=$1",[taskId]);
  engine=makeEngine();await engine.launch(taskId);await new Promise(r=>setTimeout(r,4300));
  assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[taskId])).rows[0].paused,false,'evidence drought schedules reviews instead of suspending');
  assert.ok((await tasks.control(taskId,'pause')).ok);const before=mock.state.calls.length;
  await pool.query("UPDATE task_planner_recovery SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[taskId]);
  await new Promise(r=>setTimeout(r,4300));assert.equal(mock.state.calls.length,before,'explicit pause always wins over planning schedule');
 }finally{await engine.shutdown();setCallRecorder(null);resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await close();}
});

test('persistent backoff rotates strategies, wakes on new evidence and preserves successful effects',async()=>{
 const {pool,close}=await fixture();let now=Date.now()+1000,allowed=true;const seen:PlannerPlan[]=[];
 try{
  const id=Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('scheduler','open','running') RETURNING id")).rows[0].id);
  const call=()=>runPlannerRound(pool,id,async p=>{seen.push(p);const view=(await pool.query(`SELECT ${progressSQL()} AS progress FROM tasks t WHERE id=$1`,[id])).rows[0].progress;assert.equal(view.phase,p.strategy==='normal'?'planning':'planning_recovery');return 'length';},async()=>allowed,()=>now);
  await call();assert.deepEqual(seen.map(p=>p.strategy),['normal','compact']);const before=seen.length;
  await call();assert.equal(seen.length,before,'same failed input must obey backoff');
  for(let i=0;i<3;i++){now+=300001;await call();}
  assert.deepEqual(seen.slice(2).map(p=>p.strategy),['single_gap','alternate','evidence']);
  await pool.query("INSERT INTO exploration_nodes(task_id,kind,state,payload) VALUES($1,'fact','confirmed','{\"summary\":\"new worker evidence\"}')",[id]);
  await call();assert.equal(seen.length,6,'real new evidence wakes before next scheduled time');
  const count=seen.length;await pool.query('UPDATE exploration_nodes SET updated_at=now(),heartbeat_at=now() WHERE task_id=$1',[id]);
  await call();assert.equal(seen.length,count,'heartbeat updates are not fresh evidence');
  for(let i=0;i<20;i++){now+=300001;await call();}
  const state=(await pool.query('SELECT * FROM task_planner_recovery WHERE task_id=$1',[id])).rows[0];assert.equal(state.blocked,false);assert.equal(state.history.length,8);assert.ok(new Date(state.next_attempt_at).getTime()<=now+300000);
  assert.equal(plannerRetryDelay(999),300000);
  // Successful earlier writes remain visible; the second attempt reads fresh state.
  await pool.query('DELETE FROM task_planner_recovery WHERE task_id=$1',[id]);let writes=0;
  await runPlannerRound(pool,id,async p=>{if(p.strategy==='normal'){writes++;await pool.query("INSERT INTO exploration_nodes(task_id,kind,state,payload) VALUES($1,'fact','confirmed','{\"summary\":\"partial effect\"}')",[id]);return 'length';}assert.ok((await pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND payload->>'summary'='partial effect'",[id])).rowCount);return 'progress';},async()=>true,()=>now);
  assert.equal(writes,1);assert.equal((await pool.query('SELECT 1 FROM task_planner_recovery WHERE task_id=$1',[id])).rowCount,0);
  await runPlannerRound(pool,id,async()=>{allowed=false;return 'length';},async()=>allowed,()=>now);
  const reserved=(await pool.query('SELECT next_attempt_at FROM task_planner_recovery WHERE task_id=$1',[id])).rows[0];assert.ok(new Date(reserved.next_attempt_at).getTime()>now);
  allowed=true;let afterCrash=0;await runPlannerRound(pool,id,async()=>{afterCrash++;return 'progress';},async()=>true,()=>now);assert.equal(afterCrash,0,'in-flight reservation survives process loss');
 }finally{await close();}
});

test('small-gap summaries rotate goals, preserve IDs and bound wide nested input',()=>{
 const overview={goals:[{id:1,state:'open',text:'a'},{id:2,state:'open',text:'b'}],recent_facts:Array.from({length:100},(_,id)=>({id,summary:'x'.repeat(5000)}))};
 const first=plannerRecoveryContext(overview,{strategy:'single_gap',failures:2,history:[]}) as any;
 const second=plannerRecoveryContext(overview,{strategy:'alternate',failures:3,history:[]}) as any;
 assert.equal(first.goals[0].id,1);assert.equal(second.goals[0].id,2);assert.equal(first.recent_facts[0].id,0);assert.ok(first.recent_facts.at(-1).omitted);
 const wide=Object.fromEntries(Array.from({length:1000},(_,i)=>['field'+i,{nested:'x'.repeat(5000)}]));assert.ok(JSON.stringify(compactPlannerContext(wide)).length<22000);
});
