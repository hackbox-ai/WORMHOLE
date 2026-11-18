import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {Type} from 'typebox';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createHostedSession,resetPiRuntime,setCallRecorder,type HostedSession} from '../src/pi/session-host.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {registerTool} from '../src/domains/tools/gate.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
function requestPhase(body:Record<string,unknown>){const messages=body.messages as {role:string;content:any[]}[];let index=-1,text='';for(let i=0;i<messages.length;i++){const m=messages[i]!;if(m.role!=='user')continue;const s=m.content?.filter(c=>c.type==='text').map(c=>c.text).join('')??'';if(s){index=i;text=s;}}
 const mode=messages.flatMap(m=>m.role==='user'?m.content.filter(c=>c.type==='text').map(c=>c.text??''):[]).filter(s=>s.includes('MODE:')).at(-1)?.match(/MODE:([a-z-]+)/)?.[1]??'infinite';return {mode,settling:text.includes('SETTLEMENT_PHASE'),tail:JSON.stringify(messages.slice(index+1))};}
test('F12 native Pi run budgets: exact turn cap, settlement writeback/cap/Bash suppression, live next-run update, duration and owner cancel',async(t)=>{
 const base=loadConfig(),tag=process.pid+'_'+Date.now(),schema='codex_budget_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-native-budget-')),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema}),agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}},effects=new Map<string,{ticks:number;saves:number;slowStarted:boolean;slowCompleted:number}>();let host:HostedSession|undefined;
 const mock=await startMockAnthropic(0,{marker:'FINISHED',tool:body=>{const p=requestPhase(body);if(p.settling){
  if(p.mode==='wrapcancel')return {name:'budget_probe',input:{operation:'slow'}};
  if(p.mode==='fact'){const all=JSON.stringify(body);const intent=Number(all.match(/INTENT:(\d+)/)?.[1]);return p.tail.includes('fact recorded')?undefined:{name:'record_fact',input:{summary:'BUDGET_WRITEBACK_FACT',evidence:'controlled tool actual completion',intent_id:intent}};}
  if(p.mode==='bash'){return p.tail.includes('tool_result')?undefined:{name:'Bash',input:{command:'echo SHOULD_NEVER_RUN'}};}
  return p.mode==='wraplimit'||!p.tail.includes('SAVED_RESULT')?{name:'budget_probe',input:{operation:'save'}}:undefined;
 }
 if(p.mode==='natural')return undefined;return {name:'budget_probe',input:{operation:p.mode==='wrapfail'?'fault':['timeout','cancel'].includes(p.mode)?'slow':p.mode==='planner-time'?'delay':'tick'}};
 }});
 const effect=(key:string)=>{if(!effects.has(key))effects.set(key,{ticks:0,saves:0,slowStarted:false,slowCompleted:0});return effects.get(key)!;};
 registerTool({key:'budget_probe',description:'bounded native fixture effect',schema:Type.Object({operation:Type.String()}),params:{operation:'string'},required:['operation'],execute:async(p,ctx)=>{
  const e=effect(ctx.businessId);if(p.operation==='slow'){e.slowStarted=true;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,10000),cancel=()=>{clearTimeout(timer);reject(new Error('fixture slow tool cancelled'));};if(ctx.signal?.aborted)cancel();else ctx.signal?.addEventListener('abort',cancel,{once:true});});e.slowCompleted++;return 'SLOW_FINISHED';}
  if(p.operation==='fault')mock.state.failuresLeft=100;
  if(p.operation==='delay')await new Promise(r=>setTimeout(r,400));if(p.operation==='save'){e.saves++;return 'SAVED_RESULT';}e.ticks++;return 'TICK_RESULT';
 }});
 try{
  await runMigrations(pool);const writer=new LlmRecords(pool);setCallRecorder((entry,on)=>writer.recordCall(entry,on,entry.businessKind));const supplier='http://127.0.0.1:'+(mock.server.address() as {port:number}).port,profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('budget fixture','anthropic','mock-1',$1,'fixture-key',true) RETURNING id",[supplier])).rows[0].id);
  await pool.query("INSERT INTO agents(key,name,role,builtin,enabled,max_turns,run_seconds,wrapup_prompt,wrapup_max_turns) VALUES('budget_custom','custom','assistant',false,true,1,0,'SETTLEMENT_PHASE',2)");
  async function create(key:string,businessId:string,taskId?:number,intentId?:number){const tools=await assembleTools(pool,taskId?['budget_probe','record_fact']:['budget_probe'],{agentKey:key,businessKind:'worker',businessId,taskId,intentId},{rules:[]});host=await createHostedSession(pool,config,{kind:key==='goals'?'planner':'worker',businessId,systemPrompt:'Execute the provided local fixture.',customTools:tools,provider:'profile-'+profile,profileBinding:true,freshContext:true,...(taskId?{activity:{taskId,nodeId:intentId,worker:key}}:{})});return host;}
  async function configure(key:string,max:number,seconds=0,wrap=2){await pool.query("UPDATE agents SET max_turns=$2,run_seconds=$3,wrapup_prompt='SETTLEMENT_PHASE',wrapup_max_turns=$4 WHERE key=$1",[key,max,seconds,wrap]);}
  async function finished(){await host!.flushEvents();await host!.dispose();host=undefined;}
  await t.test('worker exact main cap and settlement writes with original hooks retained',async()=>{
   await configure('worker',2);const h=await create('worker','worker-budget');let previousCalls=0;const previous=()=>{previousCalls++;return undefined;};h.session.agent.finishTurn=previous;
   const starts=mock.state.calls.length;await h.session.prompt('MODE:infinite');assert.equal(mock.state.calls.length-starts,4);assert.deepEqual(effect('worker-budget'),{ticks:2,saves:1,slowStarted:false,slowCompleted:0});assert.deepEqual(h.budgetExit,{reason:'max_turns',mainTurns:2,settlementTurns:2,settled:true});assert.equal(h.session.agent.finishTurn,previous);assert.ok(previousCalls>=2);assert.equal(h.modelFailure,undefined);assert.ok(h.session.getActiveToolNames().includes('Bash'),'restored after settlement');
   const audits=(await pool.query("SELECT native_tool_call_id,is_error FROM tool_calls WHERE business_id='worker-budget' ORDER BY id")).rows;assert.equal(audits.length,3);assert.ok(audits.every(r=>r.native_tool_call_id&&!r.is_error));await finished();
  });
  await t.test('natural completion on cap turn does not start settlement',async()=>{await configure('worker',1);const h=await create('worker','natural-budget'),start=mock.state.calls.length;await h.session.prompt('MODE:natural');assert.equal(mock.state.calls.length-start,1);assert.equal(h.budgetExit,undefined);assert.equal(effect('natural-budget').saves,0);await finished();});
  await t.test('a long user-defined time allowance does not overflow into an immediate timeout',async()=>{
   await configure('worker',0,30*24*3600);const h=await create('worker','long-user-budget');
   await h.session.prompt('MODE:natural');assert.equal(h.budgetExit,undefined);assert.equal(h.modelFailure,undefined);await finished();
  });
  await t.test('system planner limits apply independently and can be disabled without overriding Agent limits',async()=>{
   await configure('planner',4,0);await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.task_efficiency',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify({enabled:false,plannerMaxTurns:2})]);
   const h=await create('planner','system-planner-budget');await h.session.prompt('MODE:infinite');assert.equal(h.budgetExit?.mainTurns,2);
   await pool.query("UPDATE app_settings SET value=$1 WHERE key='settings.task_efficiency'",[JSON.stringify({plannerMaxTurns:0})]);
   await h.session.prompt('MODE:infinite');assert.equal(h.budgetExit?.mainTurns,4);await finished();
   await pool.query("DELETE FROM app_settings WHERE key='settings.task_efficiency'");
  });
  await t.test('settlement cap ends repeated writeback exactly',async()=>{await configure('worker',1,0,2);const h=await create('worker','wrap-limit'),start=mock.state.calls.length;await h.session.prompt('MODE:wraplimit');assert.equal(mock.state.calls.length-start,3);assert.equal(effect('wrap-limit').saves,2);assert.equal(h.budgetExit?.settlementTurns,2);await finished();});
  await t.test('worker settlement hides Bash and hallucinated invocation has no executor/audit side effect',async()=>{await configure('worker',1);const h=await create('worker','hidden-bash'),start=mock.state.calls.length;await h.session.prompt('MODE:bash');const calls=mock.state.calls.slice(start);assert.equal(calls.length,3);assert.ok(!((calls[1]!.body!.tools??[]) as any[]).some(tool=>tool.name==='Bash'));assert.ok(JSON.stringify(calls[2]).includes('not found'));assert.equal(Number((await pool.query("SELECT count(*) FROM tool_calls WHERE business_id='hidden-bash' AND tool_key='Bash'")).rows[0].count),0);await finished();});
  await t.test('existing host loads changed budget at next explicit prompt',async()=>{await configure('budget_custom',1);const h=await create('budget_custom','hot-budget');await h.session.prompt('MODE:infinite');assert.equal(h.budgetExit?.mainTurns,1);await configure('budget_custom',3);await h.session.prompt('MODE:infinite');assert.equal(h.budgetExit?.mainTurns,3);assert.equal(effect('hot-budget').ticks,4);assert.equal(effect('hot-budget').saves,2);await configure('budget_custom',0,0);await h.session.prompt('MODE:natural');assert.equal(h.budgetExit,undefined,'unlimited run cannot keep stale budget reason');await finished();});
  await t.test('goals hard 8 turns and no settlement despite editable table limits',async()=>{await configure('goals',1,1);const h=await create('goals','goals-budget'),start=mock.state.calls.length;await h.session.prompt('MODE:infinite');assert.equal(mock.state.calls.length-start,8);assert.equal(effect('goals-budget').ticks,8);assert.equal(effect('goals-budget').saves,0);assert.equal(h.budgetExit?.settled,false);await finished();});
  await t.test('planner respects its own wall budget and enters bounded settlement',async()=>{await configure('planner',4,1);const h=await create('planner','planner-budget'),start=Date.now();await h.session.prompt('MODE:planner-time');assert.ok(Date.now()-start<4000);assert.equal(h.budgetExit?.reason,'timeout');assert.ok(effect('planner-budget').ticks<4);assert.equal(h.budgetExit?.settled,true);await finished();});
  await t.test('wall-clock expiry aborts in-flight tool and uses alive writeback context',async()=>{await configure('worker',0,1);const h=await create('worker','duration-budget'),start=Date.now();await h.session.prompt('MODE:timeout');assert.ok(Date.now()-start<5000,'does not wait for 10s tool');assert.equal(h.budgetExit?.reason,'timeout');assert.equal(h.budgetExit?.settled,true);assert.equal(effect('duration-budget').slowCompleted,0);assert.equal(effect('duration-budget').saves,1);assert.equal(h.modelFailure,undefined);await finished();});
  await t.test('settlement source record_fact persists one real task graph fact and returns receipt to model',async()=>{
   await configure('worker',1);const task=await new TaskService(pool,path.join(dir,'task-dlq'),()=>{}).create({goal:'budget writeback',queued:true});assert.ok(task.ok);if(!task.ok)return;
   const taskId=Number(task.task.id),graph=new ExplorationService(pool);await graph.ensure(taskId);const intent=await graph.addIntent(taskId,{summary:'writeback fixture'});registerGraphTools(pool,graph,()=>{});
   const h=await create('worker','actual-fact-budget',taskId,intent),start=mock.state.calls.length;await h.session.prompt('MODE:fact INTENT:'+intent);await h.flushEvents();
   const facts=(await pool.query("SELECT payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND state='confirmed'",[taskId])).rows;assert.equal(facts.length,1);assert.equal(facts[0].payload.summary,'BUDGET_WRITEBACK_FACT');assert.ok(JSON.stringify(mock.state.calls.slice(start)).includes('fact recorded'));
   const calls=(await pool.query("SELECT native_tool_call_id,is_error FROM tool_calls WHERE business_id='actual-fact-budget' AND tool_key='record_fact'")).rows;assert.equal(calls.length,1);assert.ok(calls[0].native_tool_call_id);assert.equal(calls[0].is_error,false);
   const activities=(await pool.query("SELECT kind,input_tokens,output_tokens FROM activity WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1) AND worker='worker'",[taskId])).rows;
   const results=activities.filter(r=>r.kind==='result');assert.equal(results.length,1,'one product result across native main+settlement phases');
   const usage=(await pool.query("SELECT sum(input_tokens)::integer AS input,sum(output_tokens)::integer AS output FROM llm_usage WHERE task_id=$1",[taskId])).rows[0];
   assert.equal(results[0].input_tokens,usage.input);assert.equal(results[0].output_tokens,usage.output);
   const raw=(await pool.query("SELECT event_type FROM business_events WHERE business_id='actual-fact-budget' AND event_type IN ('agent_end','agent_run_end')")).rows;
   assert.equal(raw.filter(r=>r.event_type==='agent_end').length,2,'raw native completions preserved');
   assert.equal(raw.filter(r=>r.event_type==='agent_run_end').length,1);await finished();
  });
  await t.test('task deadline binding picks timeout words only for timeout, preserves per-run words for max turns',async()=>{
   for(const [name,own,turns,offset,expected]of [['clamped-timeout',20,0,1,'TASK_TIMEOUT_PHASE'],['clamped-max-turn',0,1,30,'PER_RUN_PHASE'],['own-timeout',1,0,30,'PER_RUN_PHASE']] as const){
    const task=await new TaskService(pool,path.join(dir,'clock-dlq'),()=>{}).create({queued:true});assert.ok(task.ok);const taskId=Number(task.task.id);await pool.query("UPDATE tasks SET deadline_at=now()+$2*interval '1 second' WHERE id=$1",[taskId,offset]);
    await configure('worker',turns,own,3);await pool.query("UPDATE agents SET wrapup_prompt='SETTLEMENT_PHASE PER_RUN_PHASE',task_timeout_wrapup_prompt='SETTLEMENT_PHASE TASK_TIMEOUT_PHASE',task_timeout_wrapup_max_turns=2 WHERE key='worker'");
    const h=await create('worker',name,taskId),start=mock.state.calls.length;await h.session.prompt('MODE:'+(turns?'infinite':'timeout'));assert.equal(h.budgetExit?.reason,turns?'max_turns':'timeout');
    const phase=mock.state.calls.slice(start).find(c=>JSON.stringify(c.body?.messages).includes('SETTLEMENT_PHASE'));assert.ok(phase);assert.ok(JSON.stringify(phase.body?.messages).includes(expected));assert.equal(effect(name).saves,1);await finished();
   }
  });
  await t.test('worker/planner/mainagent native sessions keep independent concurrent budgets',async()=>{
   await configure('worker',2);await configure('planner',3);await configure('mainagent',4,1);const list:HostedSession[]=[];
   try{for(const key of ['worker','planner','mainagent']){const h=await create(key,'concurrent-'+key);list.push(h);host=undefined;}await Promise.all(list.map(h=>h.session.prompt('MODE:infinite')));
    for(const [i,h]of list.entries()){assert.equal(h.budgetExit?.mainTurns,i+2);assert.equal(effect('concurrent-'+['worker','planner','mainagent'][i]).ticks,i+2);assert.equal(h.budgetExit?.settled,true);await h.flushEvents();}
   }finally{await Promise.all(list.map(h=>h.dispose()));}
  });
  await t.test('owner cancellation does not restart a settlement/model request',async()=>{await configure('worker',0,0);const h=await create('worker','owner-cancel'),start=mock.state.calls.length,work=h.session.prompt('MODE:cancel');const end=Date.now()+5000;while(!effect('owner-cancel').slowStarted){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}await h.session.abort();await work;assert.equal(mock.state.calls.length-start,1);assert.equal(effect('owner-cancel').slowCompleted,0);assert.equal(effect('owner-cancel').saves,0);assert.equal(h.budgetExit,undefined);await finished();});
  await t.test('settlement provider failure is not reported as settled',async()=>{
   await configure('worker',1);try{const h=await create('worker','failed-settlement');await h.session.prompt('MODE:wrapfail');assert.ok(h.modelFailure);assert.equal(h.budgetExit?.reason,'max_turns');assert.equal(h.budgetExit?.settled,false);assert.equal(effect('failed-settlement').ticks,1);assert.equal(effect('failed-settlement').saves,0);await finished();}finally{mock.state.failuresLeft=0;}
  });
  await t.test('owner abort during settlement stops its tool and leaves settled false',async()=>{
   await configure('worker',1);const h=await create('worker','cancel-settlement'),start=mock.state.calls.length,work=h.session.prompt('MODE:wrapcancel'),end=Date.now()+5000;
   while(!effect('cancel-settlement').slowStarted){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}
   await h.session.abort();await work;assert.equal(mock.state.calls.length-start,2);assert.equal(h.budgetExit?.settled,false);assert.equal(effect('cancel-settlement').slowCompleted,0);assert.equal(effect('cancel-settlement').saves,0);await finished();
  });
  await t.test('provider hard failure stays model failure and never fabricates budget settlement',async()=>{
   await configure('worker',1);mock.state.failuresLeft=100;try{const h=await create('worker','provider-budget-error'),start=mock.state.calls.length;await h.session.prompt('MODE:infinite');assert.ok(h.modelFailure);assert.equal(h.budgetExit,undefined);assert.equal(effect('provider-budget-error').saves,0);assert.ok(mock.state.calls.length>start);await finished();}finally{mock.state.failuresLeft=0;}
  });
 }finally{await host?.dispose();setCallRecorder(null);resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
