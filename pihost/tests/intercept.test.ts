/** Rules and decisions use real HTTP; execution is a native Pi tool_use, not editor preview. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService} from '../src/auth/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {ToolsService} from '../src/domains/tools/service.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
const base=loadConfig(),tag=process.pid+'_'+Date.now(),schema='codex_intercept_http_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-intercept-http-')),admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);await pool.query('DELETE FROM intercept_rules');await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),JSON.stringify({providers:{}}));
const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}},dlq=path.join(dir,'dlq'),intercept=new InterceptService(pool,dlq),tools=new ToolsService(pool,dlq),auth=new AuthService(pool,path.join(dir,'auth.key')),token=(await auth.init('intercept-native-http')).token!;
const server=createServer((req,res)=>void routeRequest(req,res,{pool,config,tools,intercept,auth} as AppContext));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
const mock=await startMockAnthropic(0,{marker:'INTERCEPT_COMPLETE',tool:body=>{const messages=body.messages as any[],all=JSON.stringify(messages);if(all.includes('"name":"echo_tool"'))return undefined;const mode=messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text)).join(' ');return {name:'echo_tool',input:{text:mode.includes('MODE:block')?'rm -rf /tmp/fixture-only':mode.includes('MODE:deny')?'sudo two':'sudo make'}};}});
const profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('intercept HTTP native','anthropic','mock-1',$1,'fixture',true) RETURNING id",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port])).rows[0].id);
await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['echo_tool'])]);let host:HostedSession|undefined;
after(async()=>{await host?.dispose();resetPiRuntime();for(const s of [server,mock.server]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
async function call(method:string,route:string,body?:unknown){const r=await fetch(origin+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json() as any};}
async function until(fn:()=>Promise<boolean>){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('native approval did not appear');}
async function run(mode:string){const initial=await assembleTools(pool,[],{businessKind:'chat',businessId:mode,agentKey:'auto'},{rules:[],getRules:()=>intercept.gateRules(),requestApproval:(id,reason,ms,action,signal)=>intercept.requestApproval(id,reason,ms,action,signal)});
 host=await createHostedSession(pool,config,{kind:'chat',businessId:mode,systemPrompt:'Call only the local echo fixture.',cwd:dir,provider:'profile-'+profile,profileBinding:true,customTools:initial,freshContext:true});return host.session.prompt('MODE:'+mode);}
async function finish(){await host!.flushEvents();await host!.dispose();host=undefined;}
test('F17 rules CRUD and regex validation through authenticated HTTP',async()=>{
 assert.equal((await call('POST','/api/intercept/rules',{name:'bad',match_target:'tool_name',match_type:'regex',pattern:'(',action:'deny'})).status,400);
 const block=await call('POST','/api/intercept/rules',{name:'危险命令',match_target:'tool_input',match_type:'string',pattern:'rm -rf',action:'deny',message:'危险',priority:10,enabled:true});assert.equal(block.status,200);
 const ask=await call('POST','/api/intercept/rules',{name:'sudo 审批',match_target:'tool_input',match_type:'string',pattern:'sudo',action:'ask',message:'需审批',priority:5,enabled:true});assert.equal(ask.status,200);
 assert.equal((await call('PUT','/api/intercept/rules/'+ask.json.id,{name:'sudo 审批',match_target:'tool_input',match_type:'string',pattern:'sudo',action:'ask',message:'需审批2',priority:5,enabled:true})).status,200);
 assert.equal((await call('GET','/api/intercept/rules')).json.rules.length,2);
});
test('F17/F19 native block/ask/approve/deny: side effect count and actual tool id retained',async()=>{
 assert.equal((await call('POST','/api/tools/custom',{key:'echo_tool',kind:'command',schema:{type:'object',properties:{text:{type:'string'}},required:['text']},exec:{command:'printf %s {text}'},agents:['auto'],enabled:true})).status,200);
 await run('block');await finish();const blocked=(await pool.query("SELECT native_tool_call_id,is_error,result,error_text FROM tool_calls WHERE business_id='block' AND tool_key='echo_tool'")).rows[0];assert.ok(blocked.native_tool_call_id);assert.equal(blocked.is_error,true);assert.equal(blocked.result,null);assert.match(blocked.error_text,/危险/);
 const approved=run('approve');await until(async()=>(await intercept.pending()).length===1);const pending=(await call('GET','/api/intercept/pending')).json.pending;assert.equal(pending.length,1);assert.equal(pending[0].tool_name,'echo_tool');const id=Number(pending[0].id);
 assert.equal((await call('GET','/api/intercept/history/'+id)).status,200);assert.equal((await call('POST','/api/intercept/decide',{id,decision:'approved'})).status,200);await approved;await finish();
 const executed=(await pool.query("SELECT native_tool_call_id,is_error,result FROM tool_calls WHERE business_id='approve' AND tool_key='echo_tool'")).rows;assert.equal(executed.length,1);assert.ok(executed[0].native_tool_call_id);assert.equal(executed[0].is_error,false);assert.match(JSON.stringify(executed[0].result),/sudo make/);
 assert.equal((await call('POST','/api/intercept/decide',{id,decision:'denied'})).status,409);
 const denied=run('deny');await until(async()=>(await intercept.pending()).length===1);const next=(await call('GET','/api/intercept/pending')).json.pending[0];assert.equal((await call('POST','/api/intercept/decide',{id:next.id,decision:'denied'})).status,200);await denied;await finish();
 const deniedCall=(await pool.query("SELECT is_error,result FROM tool_calls WHERE business_id='deny' AND tool_key='echo_tool'")).rows[0];assert.equal(deniedCall.is_error,true);assert.equal(deniedCall.result,null);assert.ok((await call('GET','/api/intercept/history')).json.items.length>=2);
});
