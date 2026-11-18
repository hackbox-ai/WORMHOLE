import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {registerPlatformTools,chatToolsFor} from '../src/domains/tools/platform.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import hostSeeds from '../src/domains/tools/platform-tool-seeds.json' with {type:'json'};
test('F12-F15 real native Auto platform writes -> next-session Skill/custom execution; cross-task trace and approval side-effect boundary',async(t)=>{
 const base=loadConfig(),tag=process.pid+'_'+Date.now(),schema='codex_platform_native_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-platform-native-')),admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
 await mkdir(path.join(dir,'agent'));await mkdir(path.join(dir,'skills'));await writeFile(path.join(dir,'agent/models.json'),JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}},dlq=path.join(dir,'dlq'),skills=new SkillsService(pool,dlq,path.join(dir,'skills')),mcp=new McpService(pool,dlq),intercept=new InterceptService(pool,dlq);
 const deps={pool,dlqPath:dlq,skills,mcp,intercept,assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),tasks:new TaskService(pool,dlq,()=>{})};registerPlatformTools(deps);await pool.query('DELETE FROM mcp_servers;ALTER SEQUENCE mcp_servers_id_seq RESTART WITH 1');
 await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['delete_assets_by_host','create_custom_tool'])]);
 const plans:Record<string,{name:string;input:Record<string,unknown>}[]>={
  manage:[
   {name:'create_skill',input:{name:'managed-skill',description:'local native fixture',instructions:'NATIVE_SKILL_INSTRUCTIONS\n'}},
   {name:'update_skill_file',input:{name:'managed-skill',file:'scripts/run.py',content:'print("MANAGED_FILE")\n'}},
   {name:'create_custom_tool',input:{key:'managed_command',kind:'command',exec:{command:'echo FIRST'},agents:['auto']}},
   {name:'update_custom_tool',input:{key:'managed_command',kind:'script',exec:{code:'print("MANAGED_CUSTOM_RECEIPT")'},agents:['auto']}},
   {name:'create_mcp',input:{name:'managed-mcp',transport:'http',url:'http://127.0.0.1:9',enabled:false,args:['arg'],env:{X:'local'}}},
   {name:'update_mcp',input:{id:1,name:'managed-mcp-updated',transport:'stdio',command:'never-start-this-fixture',args:['new'],env:{Y:'fixture'},enabled:false}},
   {name:'delete_assets_by_host',input:{host:'fixture.example'}}
  ],
  resumeAbort:[{name:'Skill',input:{name:'managed-skill'}},{name:'managed_command',input:{}}],
  consume:[{name:'Skill',input:{name:'managed-skill'}},{name:'managed_command',input:{}}],
  trace:[{name:'list_task_worker_traces',input:{task_id:'10'}},{name:'search_task_worker_traces',input:{task_id:'10',q:'MATCH_BODY'}},{name:'get_task_worker_trace',input:{task_id:'10',intent_id:301,step_ids:[1,2,3,4,5,6]}}],
  deny:[{name:'create_custom_tool',input:{key:'denied_create',kind:'command',exec:{command:'echo MUST_NOT_CREATE'},agents:['auto']}}],
  approve:[{name:'delete_assets_by_host',input:{host:'approval.example'}}],
  revoke:[{name:'delete_assets_by_host',input:{host:'revocation.example'}}]
 };
 const mock=await startMockAnthropic(0,{marker:'PLATFORM_DONE',tool:body=>{
  const messages=body.messages as any[],texts=messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text)).join(' '),mode=/MODE:(\w+)/.exec(texts)?.[1]??'',used=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter((c:any)=>c.type==='tool_use'));
  return plans[mode]?.[used.length];
 }});const profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('platform native','anthropic','mock-1',$1,'fixture',true) RETURNING id",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port])).rows[0].id);
 let host:HostedSession|undefined;
 async function run(mode:string,fresh=true,beforePrompt?:(h:HostedSession)=>void){const cwd=path.join(dir,'work',mode);await mkdir(cwd,{recursive:true});const ctx={businessKind:'chat',businessId:mode,agentKey:'auto',cwd};const tools=await chatToolsFor('auto',ctx,deps);host=await createHostedSession(pool,config,{kind:'chat',businessId:mode,systemPrompt:'Execute only the provided local fixture operations.',provider:'profile-'+profile,profileBinding:true,customTools:tools,cwd,freshContext:fresh});beforePrompt?.(host);return host.session.prompt('MODE:'+mode);}
 async function finish(){await host!.flushEvents();await host!.dispose();host=undefined;}
 async function until(fn:()=>Promise<boolean>){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('native approval was not created');}
 try{
  await t.test('all seven original platform operations execute from native tool_use with owning audit',async()=>{
   await pool.query("INSERT INTO assets(type,domain,root_domain) VALUES('root_domain','fixture.example',''),('subdomain','a.fixture.example','fixture.example'),('root_domain','keep.example','')");await run('manage');await finish();
   assert.equal(await readFile(path.join(dir,'skills/managed-skill/SKILL.md'),'utf8'),'---\nname: managed-skill\ndescription: local native fixture\n---\nNATIVE_SKILL_INSTRUCTIONS\n');assert.equal(await readFile(path.join(dir,'skills/managed-skill/scripts/run.py'),'utf8'),'print("MANAGED_FILE")\n');
   const tool=(await pool.query("SELECT kind,exec,enabled,agents FROM tools WHERE key='managed_command'")).rows[0];assert.deepEqual(tool,{kind:'script',exec:{code:'print("MANAGED_CUSTOM_RECEIPT")'},enabled:true,agents:['auto']});
   const server=(await pool.query("SELECT name,transport,args,env,enabled FROM mcp_servers WHERE id=1")).rows[0];assert.deepEqual(server,{name:'managed-mcp-updated',transport:'stdio',args:['new'],env:{Y:'fixture'},enabled:false});
   assert.equal(Number((await pool.query("SELECT count(*) FROM assets WHERE domain IN ('fixture.example','a.fixture.example')")).rows[0].count),0);assert.equal(Number((await pool.query("SELECT count(*) FROM assets WHERE domain='keep.example'")).rows[0].count),1);
   const rows=(await pool.query("SELECT tool_key,native_tool_call_id,is_error FROM tool_calls WHERE business_id='manage' ORDER BY id")).rows;assert.deepEqual(rows.map(r=>r.tool_key),plans.manage!.map(s=>s.name));assert.ok(rows.every(r=>r.native_tool_call_id&&!r.is_error));
   const initial=(mock.state.calls[0]!.body?.tools??[]) as any[];for(const seed of hostSeeds.filter(s=>plans.manage!.some(p=>p.name===s.key)))assert.deepEqual(initial.find(t=>t.name===seed.key)?.input_schema,seed.schema,seed.key+' complete provider schema');
  });
  await t.test('new custom spec and skill file are consumed by a subsequent real Pi session',async()=>{
   await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('auto','skill','managed-skill')");await run('consume');await finish();await writeFile('/tmp/codex-platform-native-consume-20261012.json',JSON.stringify({calls:mock.state.calls,audit:(await pool.query("SELECT tool_key,error_text,result FROM tool_calls WHERE business_id='consume'")).rows},null,2));const received=JSON.stringify(mock.state.calls.at(-1)!.body?.messages);assert.ok(received.includes('NATIVE_SKILL_INSTRUCTIONS'));assert.ok(received.includes('MANAGED_CUSTOM_RECEIPT'));
   const calls=mock.state.calls.filter(c=>JSON.stringify(c.body?.messages).includes('MODE:consume'));assert.equal(calls.length,3,'one owner loop, no synthetic second prompt');assert.ok(JSON.stringify(calls[1]!.body?.messages).includes('NATIVE_SKILL_INSTRUCTIONS'),'guidance before the model chooses its next tool');
   for(const call of calls){const messages=call.body!.messages as any[];for(let i=0;i<messages.length;i++){if(messages[i].role!=='assistant')continue;for(const use of messages[i].content.filter((c:any)=>c.type==='tool_use')){const next=messages[i+1];assert.ok(next?.role==='user'&&next.content.some((c:any)=>c.type==='tool_result'&&c.tool_use_id===use.id),'custom guidance never splits call/result adjacency');}}} 
   assert.equal(Number((await pool.query("SELECT count(*) FROM skill_usage WHERE skill='managed-skill'")).rows[0].count),1);assert.equal(Number((await pool.query("SELECT count(*) FROM tool_usage WHERE tool_key='managed_command'")).rows[0].count),1);
  });
  await t.test('completed Skill tool survives abort before the next model call and restores instructions',async()=>{
    let stopped=false;
    await run('resumeAbort',true,h=>h.session.subscribe(event=>{if(event.type==='tool_execution_end'&&event.toolName==='Skill'&&!stopped){stopped=true;void h.session.abort();}}));
    assert.ok(stopped);await finish();const before=mock.state.calls.length;
    await run('resumeAbort',false);await finish();
    assert.ok(JSON.stringify(mock.state.calls[before]!.body?.messages).includes('NATIVE_SKILL_INSTRUCTIONS'),'restored successful load has guidance before first model request');
  });
  await t.test('three cross-task trace tools read activity, preserve full-step limit and exclude reasoning',async()=>{
   await pool.query("INSERT INTO explorations(id,goal) VALUES(10,'fixture');INSERT INTO tasks(id,exploration_id,name,goal) VALUES(10,10,'trace','fixture');INSERT INTO exploration_nodes(id,task_id,exploration_id,kind,state,payload) VALUES(301,10,10,'intent','done','{\"summary\":\"completed native work\"}');");
   for(let i=1;i<=7;i++)await pool.query("INSERT INTO activity(id,exploration_id,node_id,worker,kind,summary,detail) VALUES($1,10,301,'fixture-worker',$2,$3,$4)",[i,i===2?'thinking':'tool_result','step '+i,'MATCH_BODY '+i]);
   await run('trace');await finish();const rows=(await pool.query("SELECT tool_key,result,is_error FROM tool_calls WHERE business_id='trace' ORDER BY id")).rows;assert.deepEqual(rows.map(r=>r.tool_key),plans.trace!.map(p=>p.name));assert.ok(rows.every(r=>!r.is_error));assert.equal(rows[0].result.works[0].intent_id,301);assert.ok(rows[1].result.hits.every((h:any)=>h.kind!=='thinking'));assert.deepEqual(rows[2].result.returned_step_ids,[1,2,3,4,5]);assert.deepEqual(rows[2].result.omitted_step_ids,[6]);assert.ok(rows[2].result.steps.every((s:any)=>s.kind!=='thinking'));assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('MATCH_BODY 1'));
  });
  await t.test('native platform deny prevents catalog creation; ask/approve deletes exactly once',async()=>{
   await intercept.createRule({name:'deny platform',match_target:'tool_name',match_type:'string',pattern:'create_custom_tool',action:'deny',enabled:true});await run('deny');await finish();assert.equal(Number((await pool.query("SELECT count(*) FROM tools WHERE key='denied_create'")).rows[0].count),0);await pool.query('DELETE FROM intercept_rules');
   await intercept.createRule({name:'ask delete',match_target:'tool_name',match_type:'string',pattern:'delete_assets_by_host',action:'ask',enabled:true});await pool.query("INSERT INTO assets(type,domain) VALUES('root_domain','approval.example')");const work=run('approve');await until(async()=>(await intercept.pending()).length===1);assert.equal(Number((await pool.query("SELECT count(*) FROM assets WHERE domain='approval.example'")).rows[0].count),1);const id=Number((await intercept.pending())[0]!.id);assert.equal((await intercept.decide(id,'approved')).ok,true);await work;await finish();assert.equal(Number((await pool.query("SELECT count(*) FROM assets WHERE domain='approval.example'")).rows[0].count),0);assert.equal((await intercept.decide(id,'approved')).status,409);assert.equal(Number((await pool.query("SELECT count(*) FROM tool_usage WHERE tool_key='delete_assets_by_host' AND session_id='approve'")).rows[0].count),1);
  });
  await t.test('approval-time visibility revocation preserves asset and produces auditable rejection',async()=>{
   await pool.query("INSERT INTO assets(type,domain) VALUES('root_domain','revocation.example')");const work=run('revoke');await until(async()=>(await intercept.pending()).length===1);await pool.query("UPDATE tools SET agents='[]'::jsonb WHERE key='delete_assets_by_host'");await intercept.decide(Number((await intercept.pending())[0]!.id),'approved');await work;await finish();assert.equal(Number((await pool.query("SELECT count(*) FROM assets WHERE domain='revocation.example'")).rows[0].count),1);const audit=(await pool.query("SELECT is_error,error_text,native_tool_call_id FROM tool_calls WHERE business_id='revoke' AND tool_key='delete_assets_by_host'")).rows[0];assert.equal(audit.is_error,true);assert.equal(audit.error_text,'复验失败：可见性已收回');assert.ok(audit.native_tool_call_id);
  });
 }finally{await host?.dispose();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
