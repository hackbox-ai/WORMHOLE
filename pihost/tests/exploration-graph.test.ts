/** Source-shaped graph fixtures + real Pi tool driven goals/planner/worker path.
 * References: db/exploration.go, agent/tools.go:1030,1157,1326,1474;
 * server/server.go:2370,2493,2538; server/dto.go:179,264. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer,type Server} from 'node:http';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskService,TaskEngine} from '../src/domains/tasks/index.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {ToolsService} from '../src/domains/tools/service.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {getTool,runTool,validateParams} from '../src/domains/tools/gate.ts';
import {startMockAnthropic,type ToolCallSpec} from './fixtures/mock-anthropic.ts';

const base=loadConfig(),schema=`codex_graph_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:base.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
try{await runMigrations(pool);}catch(e){await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw e;}
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-graph-')),config={...base,dataDir:dir,pi:{...base.pi,modelsPath:path.join(dir,'models.json'),agentDir:path.join(dir,'agent')}};await mkdir(config.pi.agentDir);
const dlq=path.join(dir,'dlq.jsonl'),agents=new AgentsService(pool,dlq),intercept=new InterceptService(pool,dlq);
const engine=new TaskEngine(pool,config,{agents,intercept,assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),settingsConsumers:null});
const tasks=new TaskService(pool,dlq,()=>{}),graph=engine.graph,tools=new ToolsService(pool,dlq),servers:Server[]=[];
const auth=new AuthService(pool,authKeyPath(dir)),token=(await auth.init('graph-fixture-123456')).token!;
let resumed=0;
const ctx={pool,config,auth,tools,tasks,taskEngine:{notify:()=>{},resume:()=>{resumed++;},isDeleting:()=>false}} as unknown as AppContext;
const api=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));servers.push(api);
const url=`http://127.0.0.1:${(api.address() as {port:number}).port}`;
async function call(route:string,method='GET',body?:unknown){const r=await fetch(url+route,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
async function task(){const r=await tasks.create({name:'graph',goal:'verify fixture',queued:false,description:'source-shaped'});assert.ok(r.ok);const id=Number(r.task.id);await graph.ensure(id);return id;}
after(async()=>{await engine.shutdown();for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('G07: origin → intent → fact → goal proof, asset anchors and idempotent proves',async()=>{
  const id=await task();const asset=(await pool.query("INSERT INTO assets(type,value,domain) VALUES('domain','fixture.example','fixture.example') RETURNING id")).rows[0].id;
  const goal=await graph.addGoal(id,{text:'verification',vulnclass:'fixture'}),intent=await graph.addIntent(id,{summary:'inspect',asset_ids:[Number(asset)]});
  const fact=await graph.recordFact(id,{summary:'observed',detail:'complete detail',evidence:'fixture command output',confidence:'observed',asset_ids:[Number(asset)]},'worker',intent);
  assert.deepEqual(await graph.proveGoal(id,goal,fact),{allMet:true,goals:1,completed:true});await graph.proveGoal(id,goal,fact);
  const result=await graph.graph(id);assert.equal(result.nodes.length,4);assert.equal(result.edges.length,4);
  assert.deepEqual(new Set(result.edges.map(e=>e.rel)),new Set(['spawns','derived_from','yields','proves']));
  assert.equal((await pool.query('SELECT 1 FROM exploration_anchors WHERE node_id=$1 AND asset_id=$2',[fact,asset])).rowCount,1);
  const page=await call(`/api/exploration/nodes?task=${id}&kind=fact&q=observed&size=1`);assert.equal(page.status,200);assert.equal(page.data.total,1);assert.equal(page.data.items[0].id,String(fact));
  assert.equal(page.data.items[0].type,'fact');assert.equal(JSON.parse(page.data.items[0].payload).evidence,'fixture command output');
  assert.equal(page.data.edges[0].rel,'yields');assert.ok(page.data.refs[String(intent)]);assert.equal(page.data.assets[String(fact)][0].value,'fixture.example');
  const frontier=await call(`/api/exploration/frontier?task=${id}`);assert.equal(frontier.data.length,0,'last goal proof closes all remaining intents');
  assert.equal((await tasks.get(id))!.status,'done');
  assert.equal((await pool.query("SELECT state FROM exploration_nodes WHERE id=$1",[intent])).rows[0].state,'stopped');
});
test('G07: invalid parents/assets roll back atomically and sources are read-only',async()=>{
  const id=await task(),source=await task(),stranger=await task();const srcIntent=await graph.addIntent(source,{summary:'source direction'});
  const fact=await graph.recordFact(source,{summary:'source evidence'},'worker',srcIntent);const unrelated=await graph.recordFact(stranger,{summary:'unrelated'});
  await pool.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[id,source]);
  const before=(await graph.nodes(id)).length;
  // Original GetNodeWithSources hides live source intent even from parent validation.
  await assert.rejects(graph.addIntent(id,{summary:'bad parent',parent_ids:[srcIntent]}),/不存在于本任务或直接关联任务/);
  await assert.rejects(graph.addIntent(id,{summary:'bad asset',asset_ids:[999999999]}),/foreign key/);
  await assert.rejects(graph.addIntent(id,{summary:'unrelated',parent_ids:[unrelated]}),/不存在/);
  assert.equal((await graph.nodes(id)).length,before);
  const intent=await graph.addIntent(id,{summary:'derived source',parent_ids:[fact]}),goal=await graph.addGoal(id,{text:'proof'});
  assert.ok((await graph.proveGoal(id,goal,fact)).allMet);
  await assert.rejects(graph.recordFact(id,{summary:'foreign write',intent_id:srcIntent}),/关联任务意图只读/);
  const view=await graph.graph(id);assert.ok(view.nodes.some(n=>n.id===String(fact)&&'inherited' in n));assert.ok(!view.nodes.some(n=>n.id===String(srcIntent)),'active source intents never enter inherited history');
  assert.ok((await graph.node(id,fact))!.inherited);assert.equal(await graph.node(id,unrelated),null);
  assert.ok(view.nodes.some(n=>n.id===String(intent)));
});
test('G07: goal/constraint UI CRUD share domain writes and goal edits revive',async()=>{
  const id=await task(),g=await call(`/api/tasks/${id}/goals`,'POST',{text:'operator goal',vulnclass:'fixture'});
  assert.equal(g.status,200);assert.equal(g.data.text,'operator goal');assert.equal(g.data.vulnclass,'fixture');assert.equal(resumed,1);
  const list=await call(`/api/tasks/${id}/goals`);assert.deepEqual(list.data.goals,[g.data]);
  await pool.query("UPDATE tasks SET status='done' WHERE id=$1",[id]);await pool.query("UPDATE explorations SET status='achieved' WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)",[id]);
  const edit=await call(`/api/tasks/${id}/goals/${g.data.id}`,'PUT',{text:'revised'});assert.equal(edit.status,200);assert.equal(edit.data.text,'revised');assert.equal(resumed,2);
  assert.equal((await pool.query('SELECT status FROM explorations WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)',[id])).rows[0].status,'open','explicit goal edits reopen the achieved graph');
  const empty=await call(`/api/tasks/${id}/goals`,'POST',{text:' '});assert.equal(empty.status,400);assert.equal(empty.data.error,'目标内容不能为空');
  const c=await call(`/api/tasks/${id}/constraints`,'POST',{kind:'allow',text:'fixture only'});assert.equal(c.status,200);assert.equal(c.data.kind,'allow');
  const constraints=await call(`/api/tasks/${id}/constraints`);assert.equal(constraints.data.constraints[0].text,'fixture only');assert.equal(resumed,2,'constraints do not revive');
  assert.equal((await call(`/api/tasks/${id}/constraints/${c.data.id}`,'DELETE')).status,200);
  assert.equal((await call(`/api/tasks/${id}/goals/${g.data.id}`,'DELETE')).status,200);assert.equal(resumed,2,'goal deletion does not revive');
});
test('G14: original default bindings/reset + complete nested schema + approval-time revocation',async()=>{
  const id=await task(),context={businessKind:'worker',businessId:`fixture-${id}`,agentKey:'worker',taskId:id};
  const visible=await assembleTools(pool,['record_fact','add_intent','goal_met'],context,{});assert.deepEqual(visible.map(t=>t.name),['record_fact']);
  assert.ok(validateParams(getTool('record_fact')!,{facts:[{summary:45}]}),'array element schema is enforced');
  await tools.updateBuiltin('record_fact',{enabled:false,description:'changed',agents:[]});assert.equal((await assembleTools(pool,['record_fact'],context,{})).length,0);
  assert.equal(await tools.reset('record_fact'),true);
  const exact=(await pool.query('SELECT t.description=d.description AND t.schema=d.schema AND t.agents=d.agents AS exact FROM tools t JOIN tool_defaults d USING(key) WHERE t.key=\'record_fact\'')).rows[0].exact;assert.equal(exact,true);
  const gate=await runTool(pool,'record_fact',{summary:'revoked'},context,{rules:[{toolPattern:/^record_fact$/,action:'ask'}],requestApproval:async()=>{await tools.updateBuiltin('record_fact',{enabled:false});return 'approved';}});
  assert.equal(gate.status,'not-visible');assert.equal((await graph.nodes(id,'fact')).filter(n=>n.payload.summary==='revoked').length,0);await tools.reset('record_fact');
});
test('G01/G02/G07: real Pi decomposer → graph planner → worker fact → prove_goal completes',async()=>{
  const responder=(b:Record<string,unknown>):ToolCallSpec|undefined=>{
    const names=(b.tools as {name:string}[]).map(t=>t.name),messages=b.messages as {role:string;content:{type:string;text?:string}[]}[];
    const last=messages.at(-1);if(last?.content.some(c=>c.type==='tool_result'))return undefined;
    const input=last?.content.filter(c=>c.type==='text').map(c=>c.text).join('')??'';
    if(names.includes('prove_goal')){
      const overview=JSON.parse(input.split('任务探索图概览：\n')[1]!.split('\n操作约束：')[0]!);
      const fact=overview.recent_facts.find((f:any)=>f.state==='confirmed');
      if(fact)return {name:'prove_goal',input:{goal_id:overview.goals[0].id,evidence_id:fact.id,reason:'fixture verified'}};
      if(!overview.open_intents.length&&!overview.running_intents.length&&!overview.done_intents_total)return {name:'add_intent',input:{summary:'verify fixture'}};
      return undefined;
    }
    if(names.includes('record_fact'))return {name:'record_fact',input:{summary:'fixture verified',confidence:'observed',evidence:'deterministic fixture'}};
    if(names.includes('set_goals'))return {name:'set_goals',input:{text:'fixture verified'}};
    return undefined;
  };
  const {server,state}=await startMockAnthropic(0,{marker:'GRAPH_OK',tool:responder});servers.push(server);
  const llm=new LlmService(pool,dlq,config.pi.modelsPath),profile=await llm.createProfile({name:'graph-mock',model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,api_key:'fixture'});
  await llm.activate(Number(profile.profile!.id));const runtime=await llm.compileToPiRuntime();assert.ok(!('error' in runtime));config.pi.provider=runtime.provider;config.pi.modelId=runtime.modelId;resetPiRuntime();
  const id=await task();await engine.launch(id);const deadline=Date.now()+20000;
  while(Date.now()<deadline&&(await tasks.get(id))?.status!=='done')await new Promise(r=>setTimeout(r,50));
  assert.equal((await tasks.get(id))?.status,'done',JSON.stringify(await tasks.get(id)));await engine.drain(id);
  const rows=(await pool.query('SELECT tool_key,native_tool_call_id,is_error FROM tool_calls WHERE business_id LIKE $1 ORDER BY id',[`task-${id}%`])).rows;
  assert.deepEqual(rows.map(r=>r.tool_key),['set_goals','add_intent','record_fact','prove_goal']);assert.ok(rows.every(r=>r.native_tool_call_id&&!r.is_error));
  assert.equal(state.calls.length,7,'goal proof ends the planner without an unnecessary post-completion model call');
  const result=await graph.graph(id);assert.equal(result.edges.filter(e=>e.rel==='proves').length,1);assert.ok(result.nodes.some(n=>n.type==='goal'&&n.state==='met'));
  assert.equal((await pool.query("SELECT 1 FROM business_events WHERE business_id=$1 AND event_type='planner_parse_fallback'",[String(id)])).rowCount,0,'no invented intents from text parse failure');
  const rounds=(await pool.query('SELECT round_no FROM explorations WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)',[id])).rows[0].round_no;assert.equal(Number(rounds),2,'worker completion triggers a second planning round');
});
