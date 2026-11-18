import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {loadConfig} from '../src/config.ts';import {runMigrations} from '../src/db/migrate.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';

test('native Pi planner → worker negative evidence → goal resolution → covered finish; busy projector cannot block tools',async()=>{
 const base=loadConfig(),schema='wormhole_eff_native_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-eff-native-'));await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),'{"providers":{}}');
 const config={...base,efficiency:{maxActiveSeconds:21600},dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}};
 const dlq=path.join(dir,'events.jsonl');let plannerRequests=0;
 const mock=await startMockAnthropic(0,{delayMs:5,tool:body=>{
  const names=(body.tools as {name:string}[]).map(t=>t.name),messages=body.messages as any[];
  const last=messages.at(-1);if(last?.content?.some((c:any)=>c.type==='tool_result'))return undefined;
  if(names.includes('prove_goal')){
   plannerRequests++;
   const input=last.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('');
   const overview=JSON.parse(input.split('任务探索图概览：\n')[1].split('\n操作约束：')[0]);
   const fact=overview.recent_facts.find((f:any)=>f.state==='confirmed');
   if(fact)return {name:'resolve_goal',input:{goal_id:overview.goals[0].id,evidence_id:fact.id,outcome:'tested_negative',reason:'Controlled local fixture has no exposed endpoint'}};
   return {name:'add_intent',input:{summary:'Check controlled fixture',test_key:'local fixture read-only coverage',hypothesis:'endpoint is exposed',stop_condition:'record negative or verified exposure'}};
  }
  if(names.includes('record_fact'))return {name:'record_fact',input:{summary:'Controlled local fixture is not exposed',evidence:'Negative control: fixed local response',confidence:'observed'}};
  return undefined;
 }});
 const profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('eff fixture','anthropic','mock-1',$1,'fixture',TRUE) RETURNING id",['http://127.0.0.1:'+(mock.server.address() as any).port])).rows[0].id);
 const engine=new TaskEngine(pool,config,{agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:false,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});
 const held=await pool.connect();
 try{
  const id=Number((await pool.query("INSERT INTO tasks(name,goal,status,llm_profile_id,active_llm_profile_id) VALUES('local efficiency','Check fixture','running',$1,$1) RETURNING id",[profile])).rows[0].id);
  await engine.graph.ensure(id);await engine.graph.addGoal(id,{text:'Complete endpoint checks',objective_type:'coverage'});
  await held.query('BEGIN');await held.query("SELECT pg_advisory_xact_lock(hashtext('pi_activity_projection'))");
  const started=Date.now();await engine.launch(id);
  while(Date.now()-started<20000){const row=(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0];if(row.status==='done')break;await new Promise(r=>setTimeout(r,50));}
  const row=(await pool.query('SELECT status,stopped_reason FROM tasks WHERE id=$1',[id])).rows[0];
  assert.equal(row.status,'done');assert.equal(row.stopped_reason,'coverage_complete');assert.ok(plannerRequests<=3);
  const calls=(await pool.query("SELECT tool_key,is_error,preflight_ms,execution_ms,native_tool_call_id FROM tool_calls ORDER BY id")).rows;
  assert.deepEqual(calls.map(c=>c.tool_key),['add_intent','record_fact','resolve_goal']);assert.ok(calls.every(c=>!c.is_error&&c.native_tool_call_id));
  assert.ok(calls.every(c=>c.execution_ms!==null&&c.preflight_ms!==null));
  assert.ok(Date.now()-started<20000,'projection lock must not stall real Pi tool execution');
  assert.equal((await pool.query("SELECT count(*)::int n FROM findings WHERE task_id=$1",[id])).rows[0].n,0,'negative results never become fabricated findings');
  const eventTypes=(await pool.query("SELECT DISTINCT event_type FROM business_events WHERE business_id=$1",[String(id)])).rows.map(r=>r.event_type);
  assert.ok(eventTypes.includes('goal_resolved')&&eventTypes.includes('task_done'));
  const deltas=(await pool.query("SELECT payload FROM business_events WHERE event_type='message_update' AND business_kind IN('planner','worker')")).rows;
  assert.ok(deltas.length>0);assert.ok(deltas.every(r=>r.payload.storage_version===2&&!r.payload.message&&!r.payload.assistantMessageEvent?.partial));
  assert.ok((await pool.query("SELECT 1 FROM business_events WHERE event_type='message_end' AND payload->'message'->>'role'='assistant' LIMIT 1")).rowCount,'complete assistant messages remain durable');
  // A second engine-owned task has an exhausted persistent allowance. The
  // independent supervisor must suspend it before any fresh model/tool call.
  const guarded=Number((await pool.query("INSERT INTO tasks(name,goal,status,llm_profile_id,active_llm_profile_id) VALUES('budget fixture','Keep existing evidence','running',$1,$1) RETURNING id",[profile])).rows[0].id);
  await engine.graph.ensure(guarded);await engine.graph.addGoal(guarded,{text:'Check guarded fixture'});
  await pool.query('INSERT INTO task_efficiency_state(task_id,active_seconds) VALUES($1,21601)',[guarded]);
  const before=mock.state.calls.length;await engine.launch(guarded);
  const end=Date.now()+5000;while(Date.now()<end&&!(await pool.query('SELECT paused FROM tasks WHERE id=$1',[guarded])).rows[0].paused)await new Promise(r=>setTimeout(r,20));
  assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[guarded])).rows[0].paused,true);
  assert.equal(mock.state.calls.length,before,'budget suspension happens before fresh model execution');
  await pool.query('UPDATE tasks SET paused=FALSE WHERE id=$1',[guarded]);engine.resume(guarded);
  const resumed=Date.now()+5000;while(Date.now()<resumed&&(await pool.query('SELECT paused_reason FROM task_efficiency_state WHERE task_id=$1',[guarded])).rows[0].paused_reason)await new Promise(r=>setTimeout(r,20));
  assert.equal((await pool.query('SELECT active_seconds FROM task_efficiency_state WHERE task_id=$1',[guarded])).rows[0].active_seconds,0,'explicit resume grants a new finite allowance');
 }finally{
  await held.query('ROLLBACK');held.release();await engine.shutdown();await resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
