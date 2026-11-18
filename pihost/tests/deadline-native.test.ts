import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {resetPiRuntime,setCallRecorder} from '../src/pi/session-host.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
test('F03 native deadline: worker final writeback -> final planner goal judgment -> guarded terminal state',async(t)=>{
 const base=loadConfig(),schema='codex_deadline_native_'+process.pid+'_'+Date.now(),dir=await mkdtemp(path.join(tmpdir(),'wormhole-deadline-native-')),admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}},dlq=path.join(dir,'dlq');let prove=false;
 const mock=await startMockAnthropic(0,{marker:'DEADLINE_FINISHED',tool:body=>{
  const messages=body.messages as any[],latest=messages.filter(m=>m.role==='user').map(m=>m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('')).filter(Boolean).at(-1)??'';
  const names=(body.tools as any[]??[]).map(t=>t.name),all=JSON.stringify(body);
  if(names.includes('insert_assets')&&!names.includes('add_intent')){
   if(latest.includes('WORKER_TIMEOUT_SAVES'))return all.includes('DEADLINE_FACT')?undefined:{name:'record_fact',input:{summary:'DEADLINE_FACT',evidence:'observed before deadline',confidence:'observed'}};
   return {name:'Bash',input:{command:'sleep 10; echo NEVER_REACH_THIS'}};
  }
  if(names.includes('prove_goal')&&latest.includes('FINAL_JUDGMENT')&&prove&&!JSON.stringify(messages).includes('"name":"prove_goal"')){
   const text=latest.split('任务探索图概览：\n')[1]?.split('\n【任务终局')[0];const overview=JSON.parse(text??'{}');
   if(overview.goals?.[0]&&overview.recent_facts?.[0])return {name:'prove_goal',input:{goal_id:Number(overview.goals[0].id),evidence_id:Number(overview.recent_facts[0].id),reason:'deadline fact proves goal'}};
  }
  return undefined;
 }});
 const port=(mock.server.address() as {port:number}).port;await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('deadline native','anthropic','mock-1',$1,'fixture',true)",['http://127.0.0.1:'+port]);
 await pool.query("UPDATE agents SET max_turns=0,run_seconds=0,wrapup_prompt='PER_RUN_SETTLEMENT',task_timeout_wrapup_prompt=CASE WHEN key='worker' THEN 'WORKER_TIMEOUT_SAVES' ELSE 'FINAL_JUDGMENT' END,task_timeout_wrapup_max_turns=3 WHERE key IN ('worker','planner')");
 const writer=new LlmRecords(pool);setCallRecorder((e,on)=>writer.recordCall(e,on,e.businessKind));
 const settings={get:()=>({workers:1,taskConcurrencyEnabled:false,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0};
 const engine=new TaskEngine(pool,config,{agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:settings});
 const tasks=new TaskService(pool,dlq,()=>{},(id,action)=>{if(action==='stop')engine.abort(id);if(action==='pause')engine.pause(id);});
 async function until(fn:()=>Promise<boolean>,message:string,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail(message);}
 async function fixture(){const r=await tasks.create({goal:'verify controlled local evidence',queued:true});assert.ok(r.ok);const id=Number(r.task.id);await engine.graph.ensure(id);await engine.graph.addGoal(id,{text:'controlled goal'},'system');const first=await engine.graph.addIntent(id,{summary:'long controlled tool'}),second=await engine.graph.addIntent(id,{summary:'MUST_NOT_START',priority:-1});await pool.query("UPDATE tasks SET queued=FALSE,deadline_at=now()+interval '2 seconds',timeout_seconds=2 WHERE id=$1",[id]);return {id,first,second};}
 try{
  for(const met of [false,true])await t.test('deadline writes before terminal; final goal met='+met,async()=>{
   prove=met;const {id,first,second}=await fixture(),start=Date.now(),offset=mock.state.calls.length;await engine.launch(id);
   await until(async()=>['done','timeout'].includes(String((await tasks.get(id))?.status)),'deadline terminal did not commit');await engine.drain(id);assert.ok(Date.now()-start<9000,'native timer interrupts ten-second Bash');
   assert.equal((await tasks.get(id))?.status,met?'done':'timeout');
   const facts=(await pool.query("SELECT id,created_at FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'summary'='DEADLINE_FACT'",[id])).rows;assert.equal(facts.length,1,JSON.stringify(mock.state.calls.slice(offset).map(call=>({tools:call.body.tools?.map((tool:any)=>tool.name),messages:call.body.messages?.slice(-2)}))));
   const terminal=(await pool.query('SELECT completed_at FROM tasks WHERE id=$1',[id])).rows[0];assert.ok(facts[0].created_at<=terminal.completed_at,'writeback precedes task terminal');
   const pending=(await pool.query('SELECT state FROM exploration_nodes WHERE id=$1',[second])).rows[0];assert.equal(pending.state,'stopped');
   const audit=(await pool.query("SELECT tool_key,is_error,native_tool_call_id FROM tool_calls WHERE business_id LIKE $1 ORDER BY id",['task-'+id+'-%'])).rows;assert.equal(audit.filter(r=>r.tool_key==='Bash').length,1,'no new worker admission or settlement probes');assert.equal(audit.filter(r=>r.tool_key==='record_fact').length,1);assert.ok(audit.every(r=>r.native_tool_call_id));
   const calls=mock.state.calls.slice(offset);assert.ok(JSON.stringify(calls).includes('WORKER_TIMEOUT_SAVES'));assert.ok(JSON.stringify(calls).includes('FINAL_JUDGMENT'));assert.ok(!JSON.stringify(calls).includes('PER_RUN_SETTLEMENT'),'deadline chooses task words');
   const events=(await pool.query("SELECT seq,event_type,payload FROM business_events WHERE business_kind='task' AND business_id=$1 ORDER BY seq",[String(id)])).rows;
   const finalStarts=events.filter(e=>e.event_type==='final_planner_start');assert.equal(finalStarts.length,1,'coordinator/supervisor timers share one final round');assert.ok(finalStarts[0].seq<events.find(e=>e.event_type===(met?'task_done':'task_timeout')).seq);
   assert.equal(Number((await pool.query("SELECT count(*) FROM llm_usage WHERE task_id=$1",[id])).rows[0].count),calls.length,'all actual calls attributed to task');
  });
  await t.test('owner stop during final Pi request cancels model and guarded timeout cannot overwrite failed',async()=>{
   let release!:()=>void;const responseBarrier=new Promise<void>(r=>release=r),slow=await startMockAnthropic(0,{responseBarrier,marker:'MUST_NOT_FINISH'});
   try{
    const supplier='http://127.0.0.1:'+(slow.server.address() as {port:number}).port;await pool.query('UPDATE llm_profiles SET base_url=$1 WHERE is_default=TRUE',[supplier]);
    const r=await tasks.create({queued:true});assert.ok(r.ok);const id=Number(r.task.id);await pool.query("UPDATE tasks SET queued=FALSE,deadline_at=now()-interval '1 second' WHERE id=$1",[id]);await engine.launch(id);
    await until(async()=>slow.state.calls.length===1,'final model request was not entered');assert.equal((await tasks.control(id,'stop')).status,200);
    await engine.drain(id);assert.equal((await tasks.get(id))?.status,'failed');assert.equal(slow.state.calls.length,1,'cancel cannot trigger a fresh settlement request');
    assert.equal(Number((await pool.query("SELECT count(*) FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type IN ('task_timeout','task_done')",[String(id)])).rows[0].count),0,'terminal guard preserves explicit stop');
   }finally{release();slow.server.closeAllConnections();await new Promise<void>(r=>slow.server.close(()=>r()));await pool.query('UPDATE llm_profiles SET base_url=$1 WHERE is_default=TRUE',['http://127.0.0.1:'+port]);}
  });
  await t.test('missing model waits for readiness; shutdown cancels wait with no fabricated terminal',async()=>{
   await pool.query('UPDATE llm_profiles SET is_default=FALSE');const r=await tasks.create({queued:true});assert.ok(r.ok);const id=Number(r.task.id);await pool.query("UPDATE tasks SET status='paused',paused=TRUE,queued=FALSE,deadline_at=now()-interval '1 second' WHERE id=$1",[id]);engine.startDeadlineCoordinator(id);
   await until(async()=>!!(await pool.query("SELECT 1 FROM business_events WHERE business_id=$1 AND event_type='task_settling'",[String(id)])).rowCount,'did not enter settle');await new Promise(r=>setTimeout(r,100));assert.equal((await tasks.get(id))?.status,'paused');
   await engine.shutdown();assert.equal((await tasks.get(id))?.status,'paused','no goal judgment fabricated when model unavailable');
  });
 }finally{await engine.shutdown();setCallRecorder(null);resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
