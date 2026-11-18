/** Source Behavior: task supervision, planning, execution, pause and recovery.
 * v0.4. actual schema,  transports. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Server as McpServer} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import type {ToolContext,GateOptions} from '../src/domains/tools/gate.ts';

const base=loadConfig(),schema=`codex_mcp_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-mcp-')),config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};await mkdir(config.pi.agentDir);
const mcp=new McpService(pool,path.join(dir,'dlq')),skills=new SkillsService(pool,path.join(dir,'dlq'),path.join(config.pi.agentDir,'skills'));
const result=await mcp.create({name:'stdio-fixture',transport:'stdio',command:process.execPath,args:[path.resolve('tests/fixtures/mock-mcp-server.mjs')]});assert.ok(result.ok);
const serverId=Number(result.ok?result.server.id:0);assert.equal((await mcp.refresh(serverId)).count,2);
const role=(agentKey:string,businessId:string):ToolContext=>({agentKey,businessId,businessKind:'chat'});
const invoke=async(assembly:Awaited<ReturnType<typeof augmentSession>>,name:string,params:unknown,signal?:AbortSignal)=>(assembly.tools.find(t=>t.name===name)!.execute as any)(`native-${name}-${Date.now()}`,params,signal);
const assemblies:Awaited<ReturnType<typeof augmentSession>>[]=[];
const assemble=async(ctx:ToolContext,gate:GateOptions={})=>{const a=await augmentSession(pool,mcp,skills,ctx,gate);assemblies.push(a);return a;};
after(async()=>{await Promise.allSettled(assemblies.map(a=>a.dispose()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('MCP direct role binding, actual stdio tools/call, rich results and error audit',async()=>{
  await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','mcp',$1)",[String(serverId)]);
  assert.deepEqual(await mcp.cachedToolsByAgent('planner'),[]);
  assert.equal((await mcp.cachedToolsByAgent('worker'))[0].serverName,'stdio-fixture');
  const planner=await assemble(role('planner','unbound'));assert.deepEqual(planner.tools,[]);
  const worker=await assemble(role('worker','direct'));
  const search=await invoke(worker,'SearchExtraTools',{query:'select:mock_echo'});assert.match(search.content[0].text,/mcp__stdio-fixture__mock_echo/);
  const output=await invoke(worker,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'hello'}});
  assert.equal(output.content[0].text,'echo:hello');assert.deepEqual(output.details.structuredContent,{v:'hello'});
  await assert.rejects(invoke(worker,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_ping'}),/remote failure/);
  const calls=await pool.query("SELECT tool_key,is_error,native_tool_call_id FROM tool_calls WHERE business_id='direct' AND tool_key LIKE 'mcp__%' ORDER BY id");
  assert.equal(calls.rowCount,2);assert.equal(calls.rows[1].is_error,true);assert.ok(calls.rows.every(r=>r.native_tool_call_id));
});

test('MCP Skill gates override direct binding; loads preserve body and unlock only this session',async()=>{
  assert.ok((await skills.create('recon','recon')).ok);
  await skills.writeFile('recon','SKILL.md','---\nname: Recon\ndescription: original\nmcps:\n  - stdio-fixture\nlicense: MIT\n---\nRun ${SKILL_DIR}/scripts/probe.py exactly.\n');
  await skills.updateMeta('recon',{description:'changed'});
  const text=await skills.readFile('recon','SKILL.md');assert.match(text!,/Run \$\{SKILL_DIR\}/);assert.match(text!,/stdio-fixture/);assert.match(text!,/license: MIT/);
  await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','skill','recon')");
  const a=await assemble(role('worker','skill-a')),b=await assemble(role('worker','skill-b'));
  await assert.rejects(invoke(a,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'locked'}}),/未解锁/);
  await invoke(a,'Skill',{name:'Recon'});
  assert.equal((await invoke(a,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'unlocked'}})).content[0].text,'echo:unlocked');
  await assert.rejects(invoke(b,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'other'}}),/未解锁/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM skill_usage WHERE business_id='skill-a'")).rows[0].n,1);
});

test('MCP native Pi Skill→search→execute; resume reconstructs unlock from successful session history',async()=>{
  const sequence=[{name:'Skill',input:{name:'Recon',args:'additional evidence'}},{name:'SearchExtraTools',input:{query:'select:mock_echo'}},{name:'ExecuteExtraTool',input:{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'pi-native'}}}];
  const mock=await startMockAnthropic(0,{marker:'MCP_DONE',tool:(_body,n)=>sequence[n-1]});
  const port=(mock.server.address() as {port:number}).port,llm=new LlmService(pool,path.join(dir,'dlq'),config.pi.modelsPath);
  const profile=await llm.createProfile({name:'mock',format:'anthropic',model:'mock-1',base_url:`http://127.0.0.1:${port}`,api_key:'fixture'});assert.ok(profile.ok);
  await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
  config.pi.provider=`profile-${profile.profile!.id}`;config.pi.modelId='mock-1';
  const a=await assemble(role('worker','pi-native')),toolArray=bindAugmentation(a.tools,a);
  const h=await createHostedSession(pool,config,{kind:'worker',businessId:'pi-native',systemPrompt:'Follow provided tools.',customTools:toolArray});
  try{
    await h.session.prompt('Load Recon, discover mock_echo, then invoke it.');await h.flushEvents();
    assert.ok(h.session.messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='ExecuteExtraTool'&&m.content.some((c:any)=>c.text==='echo:pi-native')));
    const guidance=h.session.messages.find((m:any)=>m.role==='custom'&&m.customType==='wormhole-skill') as any;assert.match(guidance.content,/additional evidence/);assert.ok(!guidance.content.includes('${SKILL_DIR}'));
  }finally{await h.dispose();await new Promise<void>(resolve=>mock.server.close(()=>resolve()));}
  const resumed=await assemble(role('worker','pi-native')),r=await createHostedSession(pool,config,{kind:'worker',businessId:'pi-native',systemPrompt:'Resume.',customTools:bindAugmentation(resumed.tools,resumed)});
  try{assert.equal((await invoke(resumed,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'resumed'}})).content[0].text,'echo:resumed');}finally{await r.dispose();}
});

test('MCP cancellation, approval revocation and failed refresh retain prior cache',async()=>{
  const a=await assemble(role('worker','cancel'));await invoke(a,'Skill',{name:'Recon'});
  const signal=new AbortController(),pending=invoke(a,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'slow'}},signal.signal);setTimeout(()=>signal.abort(),100);
  await assert.rejects(pending,/abort|cancel/i);
  await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(['mcp__stdio-fixture__mock_echo'])]);
  const b=await assemble(role('worker','revoked'),{rules:[{toolPattern:/^mcp__/,action:'ask'}],requestApproval:async()=>{await pool.query('UPDATE mcp_servers SET enabled=false WHERE id=$1',[serverId]);return 'approved';}});
  await invoke(b,'Skill',{name:'Recon'});
  await assert.rejects(invoke(b,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'never-called'}}),/未解锁|撤销/);
  await pool.query("UPDATE mcp_servers SET enabled=true,command='/missing-mcp-fixture' WHERE id=$1",[serverId]);
  assert.equal((await mcp.refresh(serverId)).ok,false);assert.equal((await mcp.cachedTools(serverId))!.length,2);
  await pool.query('UPDATE mcp_servers SET command=$1 WHERE id=$2',[process.execPath,serverId]);
});

test('Streamable HTTP initialize, header env, paged tool discovery and tools/call through SDK',async()=>{
  let calls=0;
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='fixture-token'){res.writeHead(401);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined}),backend=new McpServer({name:'http-fixture',version:'1'},{capabilities:{tools:{}}});
    backend.setRequestHandler(ListToolsRequestSchema,async(request)=>({tools:[{name:request.params?.cursor?'second':'first',description:'fixture',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}],...(!request.params?.cursor?{nextCursor:'next'}:{})}));
    backend.setRequestHandler(CallToolRequestSchema,async(request)=>{calls++;return {content:[{type:'text',text:String(request.params.arguments?.value)}]};});
    res.on('close',()=>void backend.close());await backend.connect(transport);await transport.handleRequest(req,res);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await mcp.create({name:'http-fixture',transport:'http',url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,env:{authorization:'fixture-token'}});assert.ok(result.ok);
    const id=Number(result.ok?result.server.id:0);assert.deepEqual(await mcp.refresh(id),{ok:true,count:2});
    await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('planner','mcp',$1)",[String(id)]);
    const a=await assemble(role('planner','http'));
    assert.equal((await invoke(a,'ExecuteExtraTool',{tool_name:'mcp__http-fixture__second',params:{value:'second-page'}})).content[0].text,'second-page');assert.equal(calls,1);
    await a.dispose();
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('legacy SSE transport and HTTP→SSE fallback retain env headers and execute actual calls',async()=>{
  const backends=new Map<string,{transport:SSEServerTransport;backend:McpServer}>();let calls=0;
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='sse-fixture'){res.writeHead(401);res.end();return;}
    const url=new URL(req.url??'/',`http://${req.headers.host}`);
    if(req.method==='GET'&&url.pathname==='/sse'){
      const transport=new SSEServerTransport('/messages',res),backend=new McpServer({name:'sse-fixture',version:'1'},{capabilities:{tools:{}}});
      backend.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'ping',description:'SSE fixture',inputSchema:{type:'object'}}]}));
      backend.setRequestHandler(CallToolRequestSchema,async()=>{calls++;return {content:[{type:'text',text:'sse-pong'}]};});
      backends.set(transport.sessionId,{transport,backend});res.on('close',()=>{backends.delete(transport.sessionId);void backend.close();});await backend.connect(transport);return;
    }
    if(req.method==='POST'&&url.pathname==='/messages'){
      const connection=backends.get(url.searchParams.get('sessionId')??'');if(connection){await connection.transport.handlePostMessage(req,res);return;}
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const transport of ['sse','http']){
      const created=await mcp.create({name:`legacy-${transport}`,transport,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/sse`,env:{authorization:'sse-fixture'}});assert.ok(created.ok);
      const id=Number(created.ok?created.server.id:0);assert.deepEqual(await mcp.refresh(id),{ok:true,count:1});
      await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('planner','mcp',$1)",[String(id)]);
      const a=await assemble(role('planner',`sse-${transport}`));
      assert.equal((await invoke(a,'ExecuteExtraTool',{tool_name:`mcp__legacy-${transport}__ping`})).content[0].text,'sse-pong');await a.dispose();
    }
    assert.equal(calls,2);
  }finally{await Promise.allSettled([...backends.values()].map(b=>b.backend.close()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('historical Skill guidance restores deferred access and reinjects using the current message type',async()=>{
 const a=await assemble(role('worker','historical-guidance'));
 await a.restore([
  {role:'custom',customType:'previous-skill',content:'Historical guidance must remain available.',details:{key:'recon',args:'keep'}},
  {role:'assistant',content:[{type:'toolCall',id:'historical-call',name:'Skill',arguments:{name:'Recon'}}]},
  {role:'toolResult',toolName:'Skill',toolCallId:'historical-call',isError:false}
 ]);
 const restored=await invoke(a,'ExecuteExtraTool',{tool_name:'mcp__stdio-fixture__mock_echo',params:{v:'history-restored'}});
 assert.equal(restored.content[0].text,'echo:history-restored');
 const messages:any[]=[];let emit:(event:any)=>void=()=>{};
 await a.attach({isStreaming:false,sendCustomMessage:async(message:any)=>{messages.push(message);},subscribe:(listener:any)=>{emit=listener;return()=>{};}} as any);
 emit({type:'compaction_end',aborted:false,result:{}});
 await new Promise(r=>setImmediate(r));
 assert.equal(messages[0]?.customType,'wormhole-skill');
 assert.match(messages[0]?.content,/Historical guidance/);
});
