import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {Type} from 'typebox';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {registerTool} from '../src/domains/tools/gate.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {runJudge} from '../src/domains/tools/judge.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

test('F17/F19 native Pi matrix: rule allow/block, API approve/deny, timeout allow/deny, judge failure policies and cancel; counts and native audit IDs',async(t)=>{
 const base=loadConfig(),schema=`codex_native_approval_${process.pid}_${Date.now()}`;
 const admin=new Pool({connectionString:base.database.dsn}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-native-approval-'));
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
 const agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}};
 const intercept=new InterceptService(pool,path.join(dir,'dlq')),other=new InterceptService(pool,path.join(dir,'dlq'));
 let executed=0;const bodies:string[]=[];
 const receiver=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{executed++;bodies.push(body);res.end(JSON.stringify({proof:'ACTUAL_LOCAL_EFFECT'}));});});
 const mock=await startMockAnthropic(0,{marker:'APPROVAL_DONE',tool:body=>{
  const last=(body.messages as any[]).at(-1);return last?.content.some((c:any)=>c.type==='tool_result')?undefined:{name:'approval_native_probe',input:{value:'LOCAL_ONLY'}};
 }});
 const http=createServer((req,res)=>void routeRequest(req,res,{pool,config,auth,intercept} as AppContext));
 const httpOther=createServer((req,res)=>void routeRequest(req,res,{pool,config,auth,intercept:other} as AppContext));
 const auth=new AuthService(pool,path.join(dir,'auth.key'));let token='',api='',otherApi='';let current:HostedSession|undefined;
 async function wait(check:()=>Promise<boolean>){const end=Date.now()+20_000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('native approval fixture condition timeout');}
 async function call(method:string,pathname:string,body?:unknown,target=api){const r=await fetch(target+pathname,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json() as any};}
 try{
  await runMigrations(pool);token=(await auth.init('native-fixture-123456')).token!;
  await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  await new Promise<void>(r=>httpOther.listen(0,'127.0.0.1',r));otherApi=`http://127.0.0.1:${(httpOther.address() as {port:number}).port}`;
  api=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  assert.equal((await call('PUT','/api/intercept/tool-config',{enabled_tools:['approval_native_probe']})).status,200);
  const supplier=`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`;
  const profile=(await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('approval fixture','anthropic','mock-1',$1,'fixture-key',TRUE) RETURNING id",[supplier])).rows[0].id;
  registerTool({key:'approval_native_probe',description:'local receiver only',schema:Type.Object({value:Type.String()}),params:{value:'string'},required:['value'],execute:async p=>{const r=await fetch(`http://127.0.0.1:${(receiver.address() as {port:number}).port}`,{method:'POST',body:JSON.stringify(p)});return await r.json();}});
  for(const scenario of ['allow','block','approve','deny','timeout-allow','timeout-deny','cancel','judge-error-allow','judge-error-deny','judge-error-ask'])await t.test(scenario,async()=>{
   await pool.query('DELETE FROM intercept_rules');await pool.query("DELETE FROM app_settings WHERE key='intercept.judge'");
   const before=executed,starts=mock.state.calls.length,businessId='native-'+scenario+'-'+Date.now();
   const judge=scenario.startsWith('judge-');
   if(judge)await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept.judge',$1)",[JSON.stringify({enabled:true,profile_id:Number(profile)+100000,fail_action:scenario.split('-').at(-1),ask_timeout_seconds:1,ask_timeout_action:'deny'})]);
   else assert.equal((await call('POST','/api/intercept/rules',{name:scenario,match_target:'tool_name',match_type:'string',pattern:'approval_native_probe',action:scenario==='allow'?'allow':scenario==='block'?'deny':'ask',enabled:true,message:'fixture-'+scenario,timeout_enabled:scenario.startsWith('timeout'),timeout_seconds:1,timeout_action:scenario==='timeout-allow'?'allow':'deny'})).status,200);
   const ctrl=new AbortController();
   const options={rules:await intercept.gateRules(),requestApproval:(id:number,reason?:string,ms?:number,action?:'allow'|'deny',signal?:AbortSignal)=>intercept.requestApproval(id,reason,ms,action,signal),judge:(tool:string,params:Record<string,unknown>,context:any)=>runJudge({pool,config,tool,params,context})};
   const tools=await assembleTools(pool,['approval_native_probe'],{agentKey:'worker',businessKind:'worker',businessId,runId:businessId,signal:ctrl.signal},options);
   current=await createHostedSession(pool,config,{kind:'worker',businessId,customTools:tools,provider:`profile-${profile}`,profileBinding:true});
   const host=current;const work=host.session.prompt('Execute the single provided local fixture tool.');
   const awaiting=['approve','deny','cancel','timeout-allow','timeout-deny','judge-error-ask'].includes(scenario);
   if(awaiting){
    await wait(async()=>!!(await pool.query("SELECT 1 FROM tool_approvals a JOIN tool_calls c ON c.id=a.tool_call_id WHERE c.business_id=$1 AND a.status='pending'",[businessId])).rowCount);
    const row=(await pool.query('SELECT ip.id FROM intercept_pending ip JOIN tool_calls c ON c.id=ip.tool_call_id WHERE c.business_id=$1',[businessId])).rows[0];
    assert.equal(executed,before,'approval is durable before any effect');
    if(scenario==='approve'||scenario==='deny'){
     // Second service instance shares the DB but does not own the in-process waiter.
     const r=await call('POST',`/api/intercept/pending/${row.id}/decide`,{decision:scenario==='approve'?'allowed':'denied'},otherApi);assert.equal(r.status,200);
     assert.equal((await call('POST',`/api/intercept/pending/${row.id}/decide`,{decision:'allowed'})).status,409);
    }
    if(scenario==='cancel')ctrl.abort();
   }
   await work;await host.flushEvents();await host.dispose();current=undefined;
   const expected=['allow','approve','timeout-allow','judge-error-allow'].includes(scenario)?1:0;
   assert.equal(executed-before,expected,'actual local HTTP side effect count');
   const calls=(await pool.query('SELECT * FROM tool_calls WHERE business_id=$1',[businessId])).rows;
   assert.equal(calls.length,1);assert.ok(calls[0].native_tool_call_id);assert.equal(calls[0].is_error,!expected);
   const review=(await pool.query('SELECT * FROM intercept_pending WHERE tool_call_id=$1',[calls[0].id])).rows[0];assert.ok(review);
   assert.equal(review.audit.tool_use_id,calls[0].native_tool_call_id);assert.equal(review.audit.correlation,'exact');
   assert.equal(review.decision_source,judge?'model':'rule');assert.equal(review.audit.execution_status,expected?'succeeded':'not_executed');
   assert.equal(review.status,scenario.startsWith('timeout')||scenario==='judge-error-ask'?'timeout':expected?'allowed':'denied');
   const page=await call('GET',`/api/intercept/history/${review.id}`);assert.equal(page.status,200);assert.equal(page.json.audit.input_digest,review.audit.input_digest);
   if(judge)assert.ok(page.json.audit.model_input.arguments);
   assert.equal((await call('GET',`/api/intercept/history?status=${review.status}&decision_source=${review.decision_source}&size=1`)).json.total>=1,true);
   const requests=mock.state.calls.slice(starts);
   if(scenario==='cancel'){
    assert.equal(requests.length,1,'cancellation must not start another provider request');
    assert.ok(host.session.messages.some(message=>message.role==='toolResult'&&message.isError),'cancelled tool result remains in the checkpoint');
   }else{
    assert.ok(requests.some(r=>JSON.stringify(r.body).includes('tool_result')),'tool result/error returns through real Pi to supplier');
    if(expected)assert.ok(JSON.stringify(requests).includes('ACTUAL_LOCAL_EFFECT'));else assert.ok(JSON.stringify(requests).includes('is_error'));
   }
   if(awaiting){const rows=(await pool.query('SELECT status,decided_by FROM tool_approvals WHERE tool_call_id=$1',[calls[0].id])).rows;assert.equal(rows.length,1);assert.notEqual(rows[0].status,'pending');}
  });
  assert.equal(bodies.length,executed);
 }finally{await current?.dispose();resetPiRuntime();for(const server of [receiver,http,httpOther,mock.server]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});

test('F19 early decisions and human-versus-timeout CAS do not get lost or overwritten; disabled timeout waits for cancellation',async()=>{
 const config=loadConfig(),schema=`codex_waiter_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:config.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});
 const svc=new InterceptService(pool,'/tmp/unused-approval-dlq');
 try{
  await runMigrations(pool);
  async function insert(){const c=(await pool.query("INSERT INTO tool_calls(business_kind,business_id,tool_key) VALUES('fixture','fixture','probe') RETURNING id")).rows[0].id;const a=(await pool.query('INSERT INTO tool_approvals(tool_call_id) VALUES($1) RETURNING id',[c])).rows[0].id;return {c,a};}
  const early=await insert();await svc.decide(Number(early.a),'approved');assert.equal(await svc.requestApproval(Number(early.c),'early',10,'deny'),'approved');
  assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[early.a])).rows[0].status,'approved');
  const indefinitely=await insert(),ctrl=new AbortController();let settled=false;const waiting=svc.requestApproval(Number(indefinitely.c),'no timeout',0,'allow',ctrl.signal).then(v=>{settled=true;return v;});
  await new Promise(r=>setTimeout(r,120));assert.equal(settled,false);ctrl.abort();assert.equal(await waiting,'denied');
  const race=await insert();const result=svc.requestApproval(Number(race.c),'race',20,'deny');await new InterceptService(pool,'/tmp/unused-approval-dlq').decide(Number(race.a),'approved');assert.equal(await result,'approved');await new Promise(r=>setTimeout(r,50));assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[race.a])).rows[0].status,'approved');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
