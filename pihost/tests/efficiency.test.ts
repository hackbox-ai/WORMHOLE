import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {EfficiencySupervisor,efficiencyDecision,efficiencyOptions,type EfficiencyState} from '../src/domains/tasks/efficiency.ts';
import {EventBatchWriter} from '../src/events/batch-writer.ts';
import {backfillDeadLetters} from '../src/events/ledger.ts';
import {createPool,backgroundPool} from '../src/db/pool.ts';

const base=loadConfig(),schema='wormhole_efficiency_'+process.pid+'_'+Date.now();
const admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
const graph=new ExplorationService(pool),supervisor=new EfficiencySupervisor(pool,{maxActiveSeconds:21600,maxModelCalls:1000,maxOutputTokens:1500000});
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-efficiency-'));
after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
async function task(){const id=Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('efficiency fixture','Check evidence','running') RETURNING id")).rows[0].id);await graph.ensure(id);return id;}

test('concurrent duplicate intents share one identity; changed hypothesis and fresh evidence remain possible',async()=>{
 const id=await task(),input={summary:'Check fixture endpoint',test_key:'endpoint GET auth'};
 const results=await Promise.all(Array.from({length:6},()=>graph.addIntent(id,input,{viaAgent:true})));
 assert.equal(new Set(results).size,1);
 const first=results[0]!;await pool.query("UPDATE exploration_nodes SET state='done',updated_at=now() WHERE id=$1",[first]);
 assert.equal(await graph.addIntent(id,input,{viaAgent:true}),first,'completed directions cannot churn without fresh evidence');
 const oldFact=await graph.recordFact(id,{summary:'old evidence'});
 await pool.query('UPDATE exploration_nodes SET created_at=now()-interval \'1 day\' WHERE id=$1',[oldFact]);
 await assert.rejects(graph.addIntent(id,{...input,new_evidence_ids:[oldFact]},{viaAgent:true}),/新增/);
 const fresh=await graph.recordFact(id,{summary:'new prerequisite observed'});
 const next=await graph.addIntent(id,{...input,new_evidence_ids:[fresh]},{viaAgent:true});assert.notEqual(next,first);
 assert.equal(await graph.addIntent(id,{...input,new_evidence_ids:[fresh]},{viaAgent:true}),next,'same evidence cannot create concurrent duplicates');
 assert.notEqual(await graph.addIntent(id,{summary:'POST variant',test_key:'endpoint POST auth'},{viaAgent:true}),first);
});
test('duplicate facts do not inflate progress and preserve both causal links',async()=>{
 const id=await task(),a=await graph.addIntent(id,{summary:'path A'}),b=await graph.addIntent(id,{summary:'path B'});
 const x=await graph.recordFact(id,{summary:'Same observed fact',evidence:'same response'},'worker',a);
 const y=await graph.recordFact(id,{summary:' Same   observed fact ',evidence:'same response'},'worker',b);
 assert.equal(x,y);assert.equal((await pool.query("SELECT count(*)::int n FROM exploration_edges WHERE dst_id=$1 AND rel='yields'",[x])).rows[0].n,2);
 assert.notEqual(await graph.recordFact(id,{summary:'Same observed fact',evidence:'same  response'},'worker',b),x,'meaningful evidence whitespace is preserved');
});
test('negative/blocked goals finish with distinct reason, not achieved; active work prevents premature completion',async()=>{
 for(const outcome of ['tested_negative','blocked']){
  const id=await task(),g=await graph.addGoal(id,{text:'Check fixture',objective_type:'coverage'}),i=await graph.addIntent(id,{summary:'fixture check'});
  const fact=await graph.recordFact(id,{summary:'Negative controls complete; no exposure',evidence:'local fixture response'},'worker',i);
  await graph.resolveGoal(id,g,fact,outcome,'actual fixture evidence');assert.equal(await supervisor.finishCovered(id),false);
  await pool.query("UPDATE exploration_nodes SET state='done' WHERE id=$1",[i]);assert.equal(await supervisor.finishCovered(id),true);
  const t=(await pool.query('SELECT t.status,t.stopped_reason,e.status exploration_status FROM tasks t JOIN explorations e ON e.id=t.exploration_id WHERE t.id=$1',[id])).rows[0];
  assert.equal(t.status,'done');assert.equal(t.stopped_reason,outcome==='blocked'?'conditions_missing':'coverage_complete');assert.equal(t.exploration_status,'exhausted');
  assert.equal((await graph.node(id,g))!.state,'open','never claim a verified vulnerability');
  assert.equal(await supervisor.finishCovered(id),false,'terminal completion is idempotent');
 }
});
test('goal resolution rejects cross-task/non-fact evidence and paused tasks',async()=>{
 const id=await task(),foreign=await task(),g=await graph.addGoal(id,{text:'coverage'}),f=await graph.recordFact(foreign,{summary:'foreign'}),i=await graph.addIntent(id,{summary:'not evidence'});
 await assert.rejects(graph.resolveGoal(id,g,f,'tested_negative','reason'),/真实记录/);
 await assert.rejects(graph.resolveGoal(id,g,i,'blocked','reason'),/真实记录/);
 const fact=await graph.recordFact(id,{summary:'prerequisite missing'});await pool.query('UPDATE tasks SET paused=TRUE WHERE id=$1',[id]);
 await assert.rejects(graph.resolveGoal(id,g,fact,'blocked','reason'),/不在执行中/);
});
test('a new fact arriving between stagnation detection and the pause transaction prevents a stale suspension',async()=>{
 const id=await task(),sample=await supervisor.sample(id);await supervisor.observe(id,sample);
 await pool.query("UPDATE task_efficiency_state SET empty_rounds=3,last_progress_at=now()-interval '1 hour' WHERE task_id=$1",[id]);
 await graph.recordFact(id,{summary:'new evidence just arrived',evidence:'controlled fixture'});
 assert.equal(await supervisor.pause(id,'no_new_evidence',sample),false);
 assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[id])).rows[0].paused,false);
});
test('planning acknowledges only its input revision, so concurrent evidence still wakes a fresh round',async()=>{
 const id=await task(),before=await supervisor.sample(id);await supervisor.observe(id,before);
 await graph.recordFact(id,{summary:'worker result during planner model call',evidence:'fixture'});
 const after=await supervisor.sample(id);await supervisor.recordRound(id,after,before.revision);
 const state=(await pool.query('SELECT plan_signature FROM task_efficiency_state WHERE task_id=$1',[id])).rows[0];
 assert.equal(state.plan_signature,before.revision);assert.notEqual(state.plan_signature,after.revision);
});
test('constraint/scope edits and directly related evidence invalidate the planning signature',async()=>{
 const id=await task(),source=await task();let before=await supervisor.sample(id);
 await pool.query("INSERT INTO task_constraints(task_id,kind,text) VALUES($1,'deny','Keep fixture read only')",[id]);
 let next=await supervisor.sample(id);assert.notEqual(next.revision,before.revision);before=next;
 await pool.query("INSERT INTO task_scope(task_id,kind,domain,source) VALUES($1,'root_domain','fixture.example','manual')",[id]);
 next=await supervisor.sample(id);assert.notEqual(next.revision,before.revision);before=next;
 await pool.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[id,source]);
 await graph.recordFact(source,{summary:'Direct source has a new observed prerequisite',evidence:'fixture'});
 next=await supervisor.sample(id);assert.notEqual(next.revision,before.revision);assert.notEqual(next.progress,before.progress);
});
test('stagnation excludes in-flight work/approvals; budgets suspend with durable audit and resume resets allowance',async()=>{
 const id=await task(),sample=await supervisor.sample(id);await supervisor.observe(id,sample);
 await pool.query("UPDATE task_efficiency_state SET empty_rounds=3,last_progress_at=now()-interval '1 hour' WHERE task_id=$1",[id]);
 let s=(await pool.query('SELECT * FROM task_efficiency_state WHERE task_id=$1',[id])).rows[0] as EfficiencyState;
 assert.equal(efficiencyDecision(s,sample,supervisor.options,Date.now()),'no_new_evidence');
 assert.equal(efficiencyDecision(s,{...sample,active:1},supervisor.options,Date.now()),null);
 assert.equal(efficiencyDecision(s,{...sample,approvals:1},supervisor.options,Date.now()),null);
 assert.equal(efficiencyDecision({...s,active_seconds:21600},{...sample,active:1},supervisor.options,Date.now()),'active_time_budget');
 assert.equal(efficiencyDecision(s,{...sample,calls:1000},supervisor.options,Date.now()),'model_call_budget');
 assert.equal(efficiencyDecision(s,{...sample,output:1500000},supervisor.options,Date.now()),'output_token_budget');
 assert.ok(await supervisor.pause(id,'no_new_evidence',sample));assert.equal(await supervisor.pause(id,'no_new_evidence',sample),false);
 assert.equal((await pool.query('SELECT status,paused FROM tasks WHERE id=$1',[id])).rows[0].paused,true);
 assert.equal((await pool.query("SELECT count(*)::int n FROM business_events WHERE business_id=$1 AND event_type='task_efficiency_paused'",[String(id)])).rows[0].n,1);
 await pool.query('UPDATE tasks SET paused=FALSE WHERE id=$1',[id]);s=await supervisor.observe(id,{...sample,calls:1000,output:1500000});
 assert.equal(s.empty_rounds,0);assert.equal(Number(s.base_calls),1000);assert.equal(s.paused_reason,null);
 assert.equal(efficiencyDecision(s,{...sample,calls:1000,output:1500000},supervisor.options,Date.now()),null);
 assert.equal(efficiencyOptions({maxModelCalls:NaN}).maxModelCalls,0);
});
test('ordered event bursts reduce database round trips without losing SSE frames; DLQ batch replay is idempotent',async()=>{
 let inserts=0;const counted={query:async(...args:any[])=>{inserts++;return (pool.query as any)(...args);}} as Pool;
 const writer=new EventBatchWriter(counted,path.join(dir,'burst.jsonl'));
 for(let n=0;n<256;n++)writer.append({business_kind:'perf',business_id:'burst',event_type:'message_update',payload:{n}});
 assert.equal(await writer.flush(),0);assert.equal(inserts,4,'256 events require four inserts');
 const rows=(await pool.query("SELECT payload->>'n' n FROM business_events WHERE business_kind='perf' ORDER BY seq")).rows;
 assert.deepEqual(rows.map(r=>Number(r.n)),Array.from({length:256},(_,i)=>i));
 const fail={query:async()=>{throw new Error('injected DB disconnect');}} as unknown as Pool,dlq=path.join(dir,'failed.jsonl'),failed=new EventBatchWriter(fail,dlq);
 failed.append({business_kind:'perf',business_id:'dlq',event_type:'a',payload:{n:1}});failed.append({business_kind:'perf',business_id:'dlq',event_type:'b',payload:{n:2}});
 assert.equal(await failed.flush(),2);assert.equal((await readFile(dlq,'utf8')).trim().split('\n').length,2);
 assert.equal(await backfillDeadLetters(pool,dlq),2);assert.equal(await backfillDeadLetters(pool,dlq),0);
});
test('projection has separate connections and execution statements have bounded lock waits',async()=>{
 const core=createPool(base.database.dsn),background=backgroundPool(core);
 try{
  assert.notEqual(core,background);assert.equal(core.options.connectionTimeoutMillis,5000);assert.equal(background.options.max,2);
  const settings=(await core.query("SELECT current_setting('statement_timeout') stmt,current_setting('lock_timeout') lock")).rows[0];
  assert.equal(settings.stmt,'30s');assert.equal(settings.lock,'5s');
  const held=await background.connect();
  try{await held.query('BEGIN');await held.query("SELECT pg_advisory_xact_lock(hashtext('pi_activity_projection'))");
   const start=Date.now();assert.equal((await core.query('SELECT 1 n')).rows[0].n,1);assert.ok(Date.now()-start<2000);
  }finally{await held.query('ROLLBACK');held.release();}
 }finally{await core.end();}
});
