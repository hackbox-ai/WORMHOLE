import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {ToolsService} from '../src/domains/tools/service.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
test('F15 real Pi custom tool paths: script/command/deferred HTTP, gate approval/revocation, spill and cancel',async(t)=>{
 const base=loadConfig(),tag=process.pid+'_'+Date.now(),schema='codex_custom_native_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-custom-native-')),admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,modelsPath:path.join(dir,'agent/models.json'),agentDir:path.join(dir,'agent')}},dlq=path.join(dir,'dlq'),tools=new ToolsService(pool,dlq),intercept=new InterceptService(pool,dlq);let host:HostedSession|undefined,hits=0,lastRequest:{method:string;header:string;body:string}|undefined;
 const target=createServer((req,res)=>{hits++;let body='';req.on('data',b=>body+=b);req.on('end',()=>{lastRequest={method:req.method??'',header:Buffer.from(String(req.headers['x-input']??''),'latin1').toString('utf8'),body};res.end('CUSTOM_HTTP_RECEIPT');});});await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(target.address() as {port:number}).port;
 const mock=await startMockAnthropic(0,{marker:'CUSTOM_DONE',tool:body=>{
  const messages=body.messages as any[],all=JSON.stringify(messages),text=messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text)).join(' '),names=(body.tools as any[]??[]).map(t=>t.name);
  if(text.includes('MODE:deferred')){
   if(!all.includes('"name":"SearchExtraTools"'))return {name:'SearchExtraTools',input:{query:'select:custom_http'}};
   if(!all.includes('"name":"ExecuteExtraTool"'))return {name:'ExecuteExtraTool',input:{tool_name:'custom_http',params:{text:'space 中文 & symbols'}}};return undefined;
  }
  if(text.includes('MODE:spill')){
   if(!all.includes('"name":"custom_spill"'))return {name:'custom_spill',input:{}};
   if(!all.includes('"name":"Read"')){const pointer=/Full output saved to  ([^ ]+) <\/persisted-output>/.exec(all)?.[1];return {name:'Read',input:{file_path:pointer?.replaceAll('\\n','')??'missing'}};}return undefined;
  }
  const tool=text.includes('MODE:cancel')?'custom_slow':text.includes('MODE:command')?'custom_command':'custom_script';
  if(!all.includes('"name":"'+tool+'"'))return {name:tool,input:{text:"中文 quote' $HOME; echo NEVER_RUN",flag:true}};return undefined;
 }});
 const supplier='http://127.0.0.1:'+(mock.server.address() as {port:number}).port,profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('custom native','anthropic','mock-1',$1,'fixture',true) RETURNING id",[supplier])).rows[0].id);
 await pool.query("INSERT INTO agents(key,name,role,builtin,enabled,run_seconds) VALUES('custom_fixture','custom','assistant',FALSE,TRUE,0)");
 const schemaObj={type:'object',properties:{text:{type:'string'},flag:{type:'boolean'}}};
 for(const input of [
  {key:'installed_tool',kind:'shell',description:'installed fixture environment',schema:{},exec:{}},
  {key:'custom_script',kind:'script',schema:schemaObj,exec:{code:'import os,sys,json\np=json.load(sys.stdin)\nprint(json.dumps({"params":p,"env":os.getenv("TOOL_TEXT"),"cwd":os.getcwd()},ensure_ascii=False))'}},
  {key:'custom_command',kind:'command',schema:schemaObj,exec:{command:'printf %s {text}'}},
  {key:'custom_http',kind:'http',schema:schemaObj,deferred:true,exec:{url:url+'/echo',method:'post',headers:{'X-Input':'{text}'},body:'CUSTOM_BODY {text}'}},
  {key:'custom_spill',kind:'script',schema:{},exec:{code:'print("S"*40000)'}},
  {key:'custom_slow',kind:'script',schema:schemaObj,exec:{code:'import time\nprint("STARTED",flush=True)\ntime.sleep(10)\nprint("MUST_NOT_COMPLETE")'}}
 ]){const r=await tools.createCustom({...input,agents:['custom_fixture'],enabled:true});assert.ok(r.ok);}
 await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['custom_http'])]);
 const gate={rules:[],getRules:()=>intercept.gateRules(),requestApproval:(id:number,reason?:string,ms?:number,action?:'deny'|'allow',signal?:AbortSignal)=>intercept.requestApproval(id,reason,ms,action,signal)};
 async function create(id:string){const cwd=path.join(dir,'work',id);await mkdir(cwd,{recursive:true});const ctx={businessKind:'chat',businessId:id,agentKey:'custom_fixture',cwd};const initial=await assembleTools(pool,[],ctx,gate);host=await createHostedSession(pool,config,{kind:'chat',businessId:id,systemPrompt:'Execute only the supplied local fixture tools.',cwd,provider:'profile-'+profile,profileBinding:true,freshContext:true,customTools:initial});return host;}
 async function finish(){await host?.flushEvents();await host?.dispose();host=undefined;}
 async function until(fn:()=>Promise<boolean>,message:string){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail(message);}
 try{
  await t.test('script stdin + scalar environment + owning CWD reaches next model request',async()=>{const h=await create('script-owner'),start=mock.state.calls.length;assert.ok(!h.session.getActiveToolNames().includes('installed_tool'));await h.session.prompt('MODE:script');const bash=((mock.state.calls[start]!.body?.tools??[]) as any[]).find(tool=>tool.name==='Bash');assert.ok(bash.description.includes('- installed_tool: installed fixture environment'));const result=JSON.stringify(mock.state.calls.at(-1)!.body?.messages);assert.ok(result.includes('TOOL_TEXT')===false);assert.ok(result.includes('quote'));assert.ok(result.includes(path.join(dir,'work','script-owner')));assert.ok(result.includes('params'));assert.equal(mock.state.calls.length-start,2);await finish();});
  await t.test('command quotes parameter as data; shell syntax never becomes another command',async()=>{const h=await create('command-owner');await h.session.prompt('MODE:command');const result=JSON.stringify(mock.state.calls.at(-1)!.body?.messages);assert.ok(result.includes("$HOME; echo NEVER_RUN"));assert.ok(!result.includes('\\nNEVER_RUN'));await finish();});
  await t.test('deferred schema hidden -> native search -> execute -> actual HTTP -> model receipt; inner audit and meter',async()=>{
   const h=await create('deferred-owner');assert.ok(!h.session.getActiveToolNames().includes('custom_http'));const before=hits;await h.session.prompt('MODE:deferred');assert.equal(hits-before,1);assert.deepEqual(lastRequest,{method:'POST',header:'space 中文 & symbols',body:'CUSTOM_BODY space 中文 & symbols'});assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('CUSTOM_HTTP_RECEIPT'));
   assert.equal(Number((await pool.query("SELECT count(*) FROM tool_usage WHERE tool_key='custom_http'")).rows[0].count),1);const audit=(await pool.query("SELECT native_tool_call_id,is_error FROM tool_calls WHERE tool_key='custom_http'")).rows;assert.equal(audit.length,1);assert.ok(audit[0].native_tool_call_id);assert.equal(audit[0].is_error,false);await finish();
  });
  await t.test('deferred invocation waits for real approval, then executes once',async()=>{
   await intercept.createRule({name:'native custom approval',match_target:'tool_name',match_type:'string',pattern:'custom_http',action:'ask',enabled:true});const h=await create('approval-owner'),before=hits,work=h.session.prompt('MODE:deferred');
   await until(async()=>(await intercept.pending()).length===1,'custom call did not request approval');assert.equal(hits,before);const pending=(await intercept.pending())[0]!;assert.equal((await intercept.decide(Number(pending.id),'approved')).ok,true);await work;assert.equal(hits-before,1);await finish();await pool.query('DELETE FROM intercept_rules');
  });
  await t.test('approval-time revocation denies side effect on the same existing session',async()=>{
   await intercept.createRule({name:'custom revoke',match_target:'tool_name',match_type:'string',pattern:'custom_http',action:'ask',enabled:true});const h=await create('revoke-owner'),before=hits,work=h.session.prompt('MODE:deferred');await until(async()=>(await intercept.pending()).length===1,'revocation call did not await approval');
   await pool.query("UPDATE tools SET agents='[]'::jsonb WHERE key='custom_http'");await intercept.decide(Number((await intercept.pending())[0]!.id),'approved');await work;assert.equal(hits,before);assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('不可见'));await finish();await pool.query("UPDATE tools SET agents='[\"custom_fixture\"]'::jsonb WHERE key='custom_http'");await pool.query('DELETE FROM intercept_rules');
  });
  await t.test('large script output persists full bytes and native Read consumes actual spill',async()=>{
   const h=await create('spill-owner');await h.session.prompt('MODE:spill');const files=await readdir(path.join(dir,'work','spill-owner','cmd-output'));assert.equal(files.length,1);assert.equal((await readFile(path.join(dir,'work','spill-owner','cmd-output',files[0]!))).length,40001);assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('persisted-output'));const read=(await pool.query("SELECT is_error FROM tool_calls WHERE business_id='spill-owner' AND tool_key='Read'")).rows;assert.equal(read.length,1);assert.equal(read[0].is_error,false);await finish();
  });
  await t.test('owner abort kills script, removes temp code, and does not request another model turn',async()=>{
   const h=await create('cancel-owner'),start=mock.state.calls.length,work=h.session.prompt('MODE:cancel'),temp=path.join(dir,'work','cancel-owner','.tools');await until(async()=>(await readdir(temp).catch(()=>[])).length===1,'script did not start');await h.session.abort();await work;assert.deepEqual(await readdir(temp),[]);assert.equal(mock.state.calls.length-start,1);await finish();
  });
 }finally{await host?.dispose();resetPiRuntime();for(const server of [target,mock.server]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
