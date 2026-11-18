/** Real Pi + isolated PostgreSQL schema. Only model responses are canned. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { AgentsService } from '../src/domains/agents/service.ts';
import { AssetsService } from '../src/domains/assets/service.ts';
import { FindingsService } from '../src/domains/findings/service.ts';
import { InterceptService } from '../src/domains/intercept/service.ts';
import { LlmService } from '../src/domains/llm/service.ts';
import { ConversationsService } from '../src/domains/conversations/service.ts';
import { TaskService, TaskEngine } from '../src/domains/tasks/index.ts';
import { TaskChatService } from '../src/domains/tasks/chat.ts';
import { createHostedSession, resetPiRuntime } from '../src/pi/session-host.ts';
import {ActivityService} from '../src/domains/activity/service.ts';
import { startMockAnthropic, type ToolCallSpec } from './fixtures/mock-anthropic.ts';
import {runTool} from '../src/domains/tools/gate.ts';

const base=loadConfig();
const schema=`codex_lifecycle_${process.pid}_${Date.now()}`;
assert.match(schema,/^codex_lifecycle_\d+_\d+$/);
const admin=new Pool({connectionString:base.database.dsn});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-codex-lifecycle-'));
const config={...base,dataDir:dir,pi:{...base.pi,modelsPath:path.join(dir,'models.json'),agentDir:path.join(dir,'agent')}};
await mkdir(config.pi.agentDir);
try { await runMigrations(pool); }
catch (err) {
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw err;
}
const dlq=path.join(dir,'events-dlq.jsonl');
await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['http_request'])]);
const agents=new AgentsService(pool,dlq);
const intercept=new InterceptService(pool,dlq);
const consumers={get:()=>({workers:3,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0};
const engine=new TaskEngine(pool,config,{agents,intercept,assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),settingsConsumers:consumers});
const tasks=new TaskService(pool,dlq,id=>void engine.launch(id),(id,action)=>{
  if(action==='pause') engine.pause(id);
  if(action==='resume') engine.resume(id);
  if(action==='stop') engine.abort(id);
});
const servers:Server[]=[];
after(async()=>{
  await engine.shutdown();
  for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function until(cond:()=>Promise<boolean>|boolean,label:string,ms=15000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await cond())return;await new Promise(r=>setTimeout(r,25));}
  const snapshot=await pool.query('SELECT id,status,paused,queued,stopped_reason FROM tasks ORDER BY id');
  assert.fail(`${label}: ${JSON.stringify(snapshot.rows)}`);
}
async function mock(opts:{delayMs?:number;responseBarrier?:Promise<void>;toolCalls?:ToolCallSpec[];text?:(b:Record<string,unknown>,n:number)=>string}={}){
  const {server,state}=await startMockAnthropic(0,{marker:'LIFECYCLE',...opts});servers.push(server);
  const port=(server.address() as {port:number}).port;
  const llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const c=await llm.createProfile({name:`mock-${port}`,model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${port}`,api_key:'fixture'});
  await llm.activate(Number(c.profile!.id));
  const result=await llm.compileToPiRuntime();if('error' in result)throw new Error(result.error);
  config.pi.provider=result.provider;config.pi.modelId=result.modelId;resetPiRuntime();return state;
}
async function seed(titles:string[],timeout_seconds=0){
  const c=await tasks.create({name:'lifecycle',goal:'fixture',queued:true,timeout_seconds});assert.ok(c.ok);
  const id=Number(c.task.id);
  for(const title of titles)await pool.query("INSERT INTO exploration_nodes(task_id,kind,title) VALUES($1,'intent',$2)",[id,title]);
  return id;
}
async function status(id:number){return String((await tasks.get(id))?.status);}

test('G03: three Pi workers overlap and each intent completes once',async()=>{
  const state=await mock({delayMs:400});const id=await seed(['a','b','c']);await engine.launch(id);
  await until(()=>state.calls.length>=3,'three concurrent model requests');
  const owners=await pool.query("SELECT id,claimed_by,state FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id]);
  assert.equal(owners.rows.filter(r=>r.state==='running').length,3);assert.equal(new Set(owners.rows.map(r=>r.claimed_by)).size,3);
  await until(async()=>await status(id)==='done','goalless completion');await engine.drain(id);
  assert.equal(state.calls.length,3,'seeded goalless tasks do not invoke planner');
  const ev=await pool.query("SELECT payload->>'intentId' AS intent FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type='intent_done'",[String(id)]);
  assert.equal(ev.rowCount,3);assert.equal(new Set(ev.rows.map(r=>r.intent)).size,3);
});
test('G07/G13: native Pi records tool results and exposes them to its next trace tool',async()=>{
 const target=createServer((_q,r)=>r.end('NATIVE_TRACE_BODY'));servers.push(target);await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(target.address() as {port:number}).port}/trace`;
 const id=await seed(['native trace']);const intent=Number((await pool.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows[0].id);
 const state=await mock({toolCalls:[{name:'http_request',input:{url}},{name:'get_worker_trace',input:{intent_id:intent}}]});await engine.launch(id);await until(async()=>await status(id)==='done','trace worker done');await engine.drain(id);
 assert.equal(state.calls.length,3);const last=JSON.stringify(state.calls.at(-1)!.body);assert.match(last,/tool_result/);assert.match(last,/NATIVE_TRACE_BODY/);
 const rows=(await pool.query('SELECT * FROM activity WHERE node_id=$1 ORDER BY id',[intent])).rows;assert.equal(rows.filter(r=>r.kind==='tool_use').length,2);assert.equal(rows.filter(r=>r.kind==='tool_result').length,2);assert.equal(rows.filter(r=>r.kind==='result').length,1);assert.equal(rows.find(r=>r.tool==='http_request'&&r.kind==='tool_use').tool_use_id,'toolu_1');
 assert.deepEqual([rows.at(-1).input_tokens,rows.at(-1).output_tokens],[33,21],'all three model calls are accounted, not just final assistant');
 const service=new ActivityService(pool);const trace=await service.trace(id,intent);assert.ok(trace.every(a=>!['thinking','usage'].includes(a.kind)));assert.equal((await service.outputRows(id,intent)).filter(a=>a.kind==='result').at(-1).detail,'LIFECYCLE_3');
});
test('G01: kill_work stops one native Pi worker while its sibling completes',async()=>{
 const state=await mock({delayMs:900});const id=await seed(['kill one','keep sibling']);await engine.launch(id);await until(()=>state.calls.length===2,'both worker models started');
 const nodes=(await pool.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND kind='intent' ORDER BY id",[id])).rows.map(r=>Number(r.id));
 const foreign=await runTool(pool,'kill_work',{intent_id:nodes[0]},{businessKind:'planner',businessId:'other',taskId:id+10000,agentKey:'planner'});assert.match(foreign.error??'',/本任务的意图/);
 const killed=await runTool(pool,'kill_work',{intent_id:nodes[0]},{businessKind:'planner',businessId:'kill fixture',taskId:id,agentKey:'planner'});assert.equal(killed.status,'executed',JSON.stringify(killed));
 await until(async()=>await status(id)==='done','sibling completes after kill');await engine.drain(id);
 const final=(await pool.query('SELECT state,attempts FROM exploration_nodes WHERE id=ANY($1::bigint[]) ORDER BY id',[nodes])).rows;assert.deepEqual(final.map(r=>r.state),['stopped','done']);assert.deepEqual(final.map(r=>r.attempts),[1,1],'killed work is never retried');
});
test('G01: steer_work retains Pi context and prevents its already planned HTTP action',async()=>{
 let hits=0;const target=createServer((_q,r)=>{hits++;r.end('should not execute');});servers.push(target);await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(target.address() as {port:number}).port}/steer`;
 const state=await mock({delayMs:500,toolCalls:[{name:'http_request',input:{url}}]});const id=await seed(['steer']);await engine.launch(id);await until(()=>state.calls.length===1,'worker model started');const intent=Number((await pool.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows[0].id);
 const steered=await runTool(pool,'steer_work',{intent_id:intent,message:'STEER_FIXTURE: cancel the old HTTP request and summarize existing work.'},{businessKind:'planner',businessId:'steer fixture',taskId:id,agentKey:'planner'});assert.equal(steered.status,'executed',JSON.stringify(steered));
 await until(async()=>await status(id)==='done','steered work completes');await engine.drain(id);assert.equal(hits,0,'pending HTTP action is blocked before its side effect');assert.ok(state.calls.length>=2);assert.match(JSON.stringify(state.calls.at(-1)!.body),/STEER_FIXTURE/,'correction enters the same native Pi context');
 assert.equal((await pool.query('SELECT state FROM exploration_nodes WHERE id=$1',[intent])).rows[0].state,'done');
});
test('G03: pause cancels model, releases lease, resume executes again',async()=>{
  const state=await mock({delayMs:700});const id=await seed(['pause']);await engine.launch(id);
  await until(()=>state.calls.length===1,'model started');assert.ok((await tasks.control(id,'pause')).ok);
  await until(async()=>!(await pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND state='running'",[id])).rowCount,'paused lease released');
  await new Promise(r=>setTimeout(r,800));assert.equal(state.calls.length,1);assert.equal(await status(id),'paused');
  assert.ok((await tasks.control(id,'resume')).ok);await until(async()=>await status(id)==='done','resume');await engine.drain(id);assert.equal(state.calls.length,2);
});
test('G03: stop during approval cancels waiter and prevents HTTP side effect',async()=>{
  let hits=0;const receiver=createServer((_req,res)=>{hits++;res.end('ok');});await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));servers.push(receiver);
  const url=`http://127.0.0.1:${(receiver.address() as {port:number}).port}/cancelled`;
  await mock({toolCalls:[{name:'http_request',input:{url}}]});
  const rule=await intercept.createRule({name:'ask',match_target:'tool_name',match_type:'string',pattern:'http_request',action:'ask',enabled:true});
  const id=await seed(['approval']);await engine.launch(id);await until(async()=>!!(await intercept.pending()).length,'approval pending');
  const pending=await intercept.pending();await tasks.control(id,'stop');await engine.drain(id);
  assert.equal(hits,0);assert.equal(await status(id),'failed');assert.equal((await intercept.pending()).length,0);
  assert.equal((await intercept.decide(Number(pending[0].id),'approved')).status,409);
  await pool.query('DELETE FROM intercept_rules WHERE id=$1',[rule.rule!.id]);
});
test('G03: queued second task starts after slot release',async()=>{
  await mock({delayMs:300});const first=await seed(['queue1']);const second=await seed(['queue2']);
  await Promise.all([engine.launch(first),engine.launch(second)]);
  assert.equal(engine.isRunning(first),true);assert.equal(engine.isRunning(second),false);assert.equal((await tasks.get(second))?.queued,true);
  await until(async()=>await status(second)==='done','queue advancement',20000);await engine.drain(second);assert.equal(await status(first),'done');
});
test('G03: boot restores fresh crashed lease but preserves paused task',async()=>{
  await mock();const id=await seed(['recover']);await pool.query("UPDATE tasks SET status='running',queued=FALSE WHERE id=$1",[id]);
  await pool.query("UPDATE exploration_nodes SET state='running',claimed_by='crashed',claimed_at=now(),heartbeat_at=now() WHERE task_id=$1 AND kind='intent'",[id]);
  const paused=await seed(['paused']);await pool.query("UPDATE tasks SET status='paused',paused=TRUE,queued=FALSE WHERE id=$1",[paused]);
  await engine.recover();await until(async()=>await status(id)==='done','fresh lease recovered');await engine.drain(id);
  assert.equal(engine.isRunning(paused),false);assert.equal(await status(paused),'paused');
});
test('G03 source engine_timeout.go: expired deadline dispatches only terminal planner, no ordinary worker',async()=>{
  const state=await mock();const id=await seed(['expired']);await pool.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[id]);
  await engine.launch(id);await engine.drain(id);assert.equal(await status(id),'timeout');assert.equal(state.calls.length,1);
  const prompt=JSON.stringify(state.calls[0]!.body?.messages);assert.ok(prompt.includes('任务终局收尾'));
  const finals=await pool.query("SELECT event_type FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type IN ('final_planner_start','final_planner_done','task_timeout') ORDER BY seq",[String(id)]);
  assert.deepEqual(finals.rows.map(r=>r.event_type),['final_planner_start','final_planner_done','task_timeout']);
  assert.equal(Number((await pool.query("SELECT count(*) FROM business_events WHERE business_id LIKE $1 AND business_kind='worker'",['task-'+id+'-intent-%'])).rows[0].count),0);

});
test('G03: empty frontier with open goal stays running; goal is never claimed',async()=>{
  await mock({text:()=> '[]'});const id=await seed(['one']);await pool.query("INSERT INTO exploration_nodes(task_id,kind,title,state) VALUES($1,'goal','unfinished','open')",[id]);
  await engine.launch(id);
  await until(async()=>!!(await pool.query("SELECT 1 FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type='planner_done'",[String(id)])).rowCount,'planner after worker');
  assert.equal(await status(id),'running');assert.equal(engine.isRunning(id),true);
  assert.equal((await pool.query("SELECT state FROM exploration_nodes WHERE task_id=$1 AND kind='goal'",[id])).rows[0].state,'open');
  await tasks.control(id,'stop');await engine.drain(id);
});
test('G13: stop accepted turn before session creation prevents late assistant',async()=>{
  const state=await mock({delayMs:700});const convs=new ConversationsService(pool,config,agents,dlq);const c=await convs.create('auto','cancel',null);assert.ok(c.ok);
  const id=Number(c.conv.id);assert.equal((await convs.send(id,'cancel me')).status,202);assert.equal(await convs.stop(id),'cancelled');
  assert.equal(await convs.stop(id),'not-running');assert.equal(convs.isRunning(id),false);assert.equal(state.calls.length,0);
  assert.equal((await pool.query("SELECT 1 FROM conversation_activities WHERE conversation_id=$1 AND kind='assistant'",[id])).rowCount,0);
});
test('G13: complete Pi history exceeds 16 messages and survives fresh hosted instance',async()=>{
  const state=await mock({text:()=> 'remembered'});
  for(let turn=0;turn<10;turn++){const h=await createHostedSession(pool,config,{kind:'chat',businessId:'history',systemPrompt:'fixture'});await h.session.prompt(turn===0?'secret: HISTORY_SEED':`turn ${turn}`);await h.dispose();}
  const messages=state.calls.at(-1)!.body!.messages as unknown[];assert.ok(messages.length>=19,`history length ${messages.length}`);assert.match(JSON.stringify(messages),/HISTORY_SEED/);
  const h=await createHostedSession(pool,config,{kind:'chat',businessId:'other-segment',systemPrompt:'fixture'});assert.equal(h.session.messages.length,0);await h.dispose();
});

test('G13: main segment zero/current selection persist native Pi user/results without sharing context',async()=>{
 const state=await mock();const id=await seed([]),chat=new TaskChatService(pool,config,agents);chat.wire(engine,async()=>[]);const activity=new ActivityService(pool);
 assert.equal((await chat.send(id,'ORIGINAL_SEGMENT')).status,202);assert.equal((await chat.send(id,'busy other segment',9)).status,409);await until(()=>!chat.isBusy(id),'original main done');
 assert.deepEqual((await activity.history(id,'main:0')).items instanceof Array,true);
 const fresh=await activity.newMain(id);assert.equal(fresh.seq,1);assert.equal((await chat.send(id,'NEW_SEGMENT')).status,202);await until(()=>!chat.isBusy(id),'new main done');
 assert.ok(!JSON.stringify(state.calls.at(-1)!.body).includes('ORIGINAL_SEGMENT'));
 assert.equal((await chat.send(id,'FOLLOWUP')).status,202);await until(()=>!chat.isBusy(id),'main followup done');assert.match(JSON.stringify(state.calls.at(-1)!.body),/NEW_SEGMENT/);
 const items=(await activity.history(id,'main')).items as any[];assert.deepEqual(items.filter(a=>a.kind==='user').map(a=>a.summary),['NEW_SEGMENT','FOLLOWUP']);assert.equal(items.filter(a=>a.kind==='result').length,2);assert.ok(items.every(a=>a.main_seg===1));
 const tokens=await activity.tokens(id);const sessions=tokens.sessions as any[];assert.equal(sessions.find(s=>s.session==='main:1').input_tokens,22);assert.equal(sessions.find(s=>s.session==='main:0').input_tokens,11);
 // This history-only fixture intentionally leaves an empty queued execution.
 // Release it before the following tests share the global FIFO scheduler.
 await tasks.control(id,'stop');await engine.drain(id);
});
test('G03: deadline interrupts in-flight model and releases the runtime',async()=>{
  const state=await mock({delayMs:2000});const id=await seed(['deadline'],1);
  await engine.launch(id);await until(()=>state.calls.length===1,'deadline model started');
  await until(async()=>await status(id)==='timeout','deadline terminal state');await engine.drain(id);
  assert.equal(engine.isRunning(id),false);
  // Original worker can finish its bounded writeback; task outcome remains timeout
  // unless the final planner actually proves the goal. Do not demand worker failure.
  const n=await pool.query("SELECT state FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id]);assert.ok(n.rows.every(r=>['done','stopped'].includes(r.state)));
  const events=(await pool.query("SELECT event_type FROM business_events WHERE business_kind='task' AND business_id=$1 ORDER BY seq",[String(id)])).rows.map(r=>r.event_type);
  assert.equal(events.filter(e=>e==='final_planner_start').length,1);
  assert.ok(events.indexOf('final_planner_done')<events.indexOf('task_timeout'));
  assert.ok(state.calls.some(c=>JSON.stringify(c.body?.messages).includes('任务终局收尾')));

});
test('G03/G13: delete barrier drains worker and segmented main-agent before removal',async()=>{
  let release!:()=>void;const responseBarrier=new Promise<void>(r=>{release=r;});
  const state=await mock({responseBarrier});const id=await seed(['delete']);
  const chat=new TaskChatService(pool,config,agents);chat.wire(engine,async()=>[]);
  await engine.launch(id);assert.equal((await chat.send(id,'slow main',99)).status,202);
  await until(()=>state.calls.length>=2,'worker and main started');assert.equal(chat.isBusy(id),true);
  await engine.beginDelete(id);
  assert.equal((await chat.send(id,'late')).status,409);
  await chat.stopTask(id);assert.equal(chat.isBusy(id),false);
  assert.ok((await tasks.remove(id)).ok);engine.endDelete(id);
  assert.equal(await tasks.get(id),null);
  release();
});
test('G13: stop while provider is streaming suppresses cancelled assistant',async()=>{
  const state=await mock({delayMs:800});const convs=new ConversationsService(pool,config,agents,dlq);const c=await convs.create('auto','live cancel',null);assert.ok(c.ok);
  const id=Number(c.conv.id);await convs.send(id,'slow reply');await until(()=>state.calls.length===1,'chat request started');
  assert.equal(await convs.stop(id),'cancelled');assert.equal(convs.isRunning(id),false);
  assert.equal((await pool.query("SELECT 1 FROM conversation_activities WHERE conversation_id=$1 AND kind='assistant'",[id])).rowCount,0);
});
