import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {Server as McpBackend} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {startMockAnthropic,type ToolCallSpec} from './fixtures/mock-anthropic.ts';

test('configured custom Agent → Skill → search → actual MCP HTTP → approval → model result; compaction/resume and failed-load branches',async(t)=>{
 const base=loadConfig(),schema='codex_native_mcp_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-native-mcp-')),agentDir=path.join(dir,'agent');
 await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}},dlq=path.join(dir,'dlq');
 const mcp=new McpService(pool,dlq),skills=new SkillsService(pool,dlq,path.join(dir,'skills')),agents=new AgentsService(pool,dlq),intercept=new InterceptService(pool,dlq),auth=new AuthService(pool,path.join(dir,'auth.key'));
 let effects=0,attempts=0,disconnect=false,sequence:ToolCallSpec[]=[],step=0;
 const backend=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined}),server=new McpBackend({name:'native-endpoint',version:'1'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'record',description:'writes to a local fixture receiver',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]}));
  server.setRequestHandler(CallToolRequestSchema,async(request)=>{
   attempts++;
   if(disconnect){disconnect=false;res.destroy();await server.close();throw new Error('fixture disconnect after request');}
   effects++;return {content:[{type:'text',text:'MCP_ACTUAL_RECEIPT:'+request.params.arguments?.value}],structuredContent:{effect:effects}};
  });
  res.on('close',()=>void server.close());await server.connect(transport);await transport.handleRequest(req,res);
 });
 const mock=await startMockAnthropic(0,{marker:'CHAIN_COMPLETE',tool:(body)=>Array.isArray(body.tools)&&body.tools.length?sequence[step++]:undefined});
 const apiServer=createServer((req,res)=>void routeRequest(req,res,{pool,config,auth,intercept} as AppContext));
 let active:HostedSession|undefined,token='',api='',serverId=0;
 const assemblies:Awaited<ReturnType<typeof augmentSession>>[]=[];
 const invoke=async(a:Awaited<ReturnType<typeof augmentSession>>,name:string,params:unknown)=>(a.tools.find(tool=>tool.name===name)!.execute as any)('native-'+Date.now(),params);
 async function pending(businessId:string){const end=Date.now()+15_000;while(Date.now()<end){const r=(await pool.query("SELECT ip.id FROM intercept_pending ip JOIN tool_calls c ON c.id=ip.tool_call_id WHERE c.business_id=$1 AND ip.status='pending'",[businessId])).rows[0];if(r)return Number(r.id);await new Promise(r=>setTimeout(r,20));}throw new Error('approval not produced by native Pi');}
 async function assemble(id:string){const a=await augmentSession(pool,mcp,skills,{businessKind:'chat',businessId:id,agentKey:'custom_chain'}, {rules:await intercept.gateRules(),getRules:()=>intercept.gateRules(),requestApproval:(...args)=>intercept.requestApproval(...args)});assemblies.push(a);return a;}
 try{
  await runMigrations(pool);
  await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));await new Promise<void>(r=>apiServer.listen(0,'127.0.0.1',r));
  api='http://127.0.0.1:'+(apiServer.address() as {port:number}).port;token=(await auth.init('chain-fixture-12345')).token!;
  const created=await mcp.create({name:'native-endpoint',transport:'http',url:'http://127.0.0.1:'+(backend.address() as {port:number}).port});assert.ok(created.ok);serverId=Number(created.server.id);
  assert.deepEqual(await mcp.refresh(serverId),{ok:true,count:1});
  assert.ok((await skills.create('chain-skill','chain fixture')).ok);
  await skills.writeFile('chain-skill','SKILL.md','---\nname: chain-skill\ndescription: local MCP receipt\nmcps:\n  - native-endpoint\n---\nLoad this skill before executing the local endpoint.\n');
  const profile=(await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('chain-fixture','anthropic','mock-1',$1,'fixture',true) RETURNING id",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port])).rows[0].id;
  assert.ok((await agents.create({key:'custom_chain',name:'custom fixture',llm_profile_id:Number(profile)})).ok);
  await agents.putPrompt('custom_chain','Use only the provided local fixture tools.');
  await agents.putVisibility('custom_chain',{skill:['chain-skill'],mcp:[String(serverId)]});
  await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['mcp__native-endpoint__record'])]);
  const spec=await agents.resolveSessionSpec('custom_chain');assert.equal(spec.provider,'profile-'+profile);assert.match(spec.systemPrompt,/local fixture/);
  const key='mcp__native-endpoint__record';
  for(const scenario of ['approved','denied','load-failure'])await t.test(scenario,async()=>{
   await pool.query('DELETE FROM intercept_rules');
   if(scenario!=='load-failure')assert.ok((await intercept.createRule({name:scenario,match_target:'tool_name',match_type:'string',pattern:key,action:'ask',enabled:true})).ok);
   if(scenario==='load-failure')await pool.query("CREATE FUNCTION fail_skill_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failed Skill persistence'; END $$;CREATE TRIGGER fail_skill_usage BEFORE INSERT ON skill_usage FOR EACH ROW EXECUTE FUNCTION fail_skill_usage()");
   const before=effects,businessId='chain-'+scenario;
   sequence=[{name:'Skill',input:{name:'chain-skill'}},{name:'SearchExtraTools',input:{query:'select:record'}},{name:'ExecuteExtraTool',input:{tool_name:key,params:{value:scenario}}}];step=0;
   const augmentation=await assemble(businessId);
   active=await createHostedSession(pool,config,{kind:'chat',businessId,systemPrompt:spec.systemPrompt,provider:spec.provider,modelId:spec.modelId,profileBinding:true,customTools:bindAugmentation(augmentation.tools,augmentation)});
   const work=active.session.prompt('Perform the local Skill/search/MCP chain.');
   if(scenario!=='load-failure'){
    const id=await pending(businessId);assert.equal(effects,before,'zero effects while ask waits');
    const response=await fetch(api+'/api/intercept/pending/'+id+'/decide',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({decision:scenario==='approved'?'allowed':'denied'})});
    assert.equal(response.status,200);
   }
   await work;await active.flushEvents();
   const result=active.session.messages.find((m:any)=>m.role==='toolResult'&&m.toolName==='ExecuteExtraTool') as any;
   assert.ok(result);assert.equal(result.isError,scenario!=='approved');
   assert.equal(effects-before,scenario==='approved'?1:0);
   if(scenario==='approved'){
    assert.ok(result.content.some((c:any)=>c.text.includes('MCP_ACTUAL_RECEIPT:approved')));
    sequence=[];step=0;
    active.session.settingsManager.applyOverrides({compaction:{keepRecentTokens:1}});
    const compacted=await active.session.compact('Keep the local fixture receipt.');
    assert.ok(compacted.summary);
    assert.ok(active.session.sessionManager.getBranch().some(e=>e.type==='compaction'),'actual SDK compaction persisted');
   }
   await active.dispose();active=undefined;
   if(scenario==='load-failure')await pool.query('DROP TRIGGER fail_skill_usage ON skill_usage;DROP FUNCTION fail_skill_usage()');
   const restored=await assemble(businessId);
   active=await createHostedSession(pool,config,{kind:'chat',businessId,provider:spec.provider,modelId:spec.modelId,profileBinding:true,customTools:bindAugmentation(restored.tools,restored)});
   if(scenario==='load-failure'){
    await assert.rejects(invoke(restored,'ExecuteExtraTool',{tool_name:key,params:{value:'failed-resume'}}),/未解锁/);
    assert.equal(effects,before,'failed Skill result never grants on restore');
    assert.equal((await pool.query('SELECT count(*)::int n FROM skill_usage WHERE business_id=$1',[businessId])).rows[0].n,0);
   }else if(scenario==='approved'){
    await pool.query('DELETE FROM intercept_rules');
    // The assembly's snapshot still has ask: construct a new session policy after removal.
    await active.dispose();active=undefined;
    const next=await assemble(businessId);
    active=await createHostedSession(pool,config,{kind:'chat',businessId,provider:spec.provider,modelId:spec.modelId,profileBinding:true,customTools:bindAugmentation(next.tools,next)});
    sequence=[{name:'ExecuteExtraTool',input:{tool_name:key,params:{value:'after-compaction-restart'}}}];step=0;
    await active.session.prompt('Use the already loaded Skill after compaction and restart.');await active.flushEvents();
    assert.equal(effects-before,2);
    assert.ok(mock.state.calls.some(c=>JSON.stringify(c.body).includes('MCP_ACTUAL_RECEIPT:after-compaction-restart')),'model receives real resumed tool output');
   }
   await active.dispose();active=undefined;
  });
  await t.test('schema replacement refuses stale session and explicit post-disconnect call reconnects without replay',async()=>{
   await pool.query('DELETE FROM intercept_rules');const a=await assemble('disconnect');
   await invoke(a,'Skill',{name:'chain-skill'});
   const live=await intercept.createRule({name:'hot policy',match_target:'tool_name',match_type:'string',pattern:key,action:'deny',enabled:true});assert.ok(live.ok);
   const hotCount=attempts;await assert.rejects(invoke(a,'ExecuteExtraTool',{tool_name:key,params:{value:'hot-denied'}}),/禁止/);assert.equal(attempts,hotCount);
   await pool.query('DELETE FROM intercept_rules');
   const before=attempts;disconnect=true;
   await assert.rejects(invoke(a,'ExecuteExtraTool',{tool_name:key,params:{value:'disconnect'}}));
   assert.equal(attempts-before,1,'no transparent tools/call replay');
   assert.equal((await invoke(a,'ExecuteExtraTool',{tool_name:key,params:{value:'explicit-recovery'}})).content[0].text,'MCP_ACTUAL_RECEIPT:explicit-recovery');
   assert.equal(attempts-before,2,'one new explicit call after reconnect');
   const old=(await pool.query('SELECT schema FROM mcp_tools_cache WHERE server_id=$1',[serverId])).rows[0].schema;
   await pool.query('UPDATE mcp_tools_cache SET schema=$2 WHERE server_id=$1',[serverId,JSON.stringify({...old,required:['value','additional']})]);
   await assert.rejects(invoke(a,'ExecuteExtraTool',{tool_name:key,params:{value:'stale'}}),/schema.*变更/);
   assert.equal(attempts-before,2);
  });
 }finally{
  await active?.dispose();await Promise.allSettled(assemblies.map(a=>a.dispose()));resetPiRuntime();
  for(const server of [backend,apiServer,mock.server]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});

