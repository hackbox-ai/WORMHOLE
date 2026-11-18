import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';
const config=loadConfig(),suffix=`${process.pid}_${Date.now()}`,schema=`codex_llm_records_${suffix}`,admin=new Pool({connectionString:config.database.dsn});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
const auth=new AuthService(pool,path.join(tmpdir(),`${schema}.key`)),token=(await auth.init('llm-records-fixture-123')).token!;
const ctx={pool,config,auth} as any,server=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function api(path:string,method='GET'){const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`}});return {status:r.status,body:await r.json() as any};}
// ── F07 写路径：真实 mock 供应商 → 会话 → llm_usage/llm_records 全链 ──
import {setCallRecorder,createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
import {expandRecordBodies} from '../src/storage/record-body.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
const {LlmService} = await import('../src/domains/llm/service.ts');
const writer=new LlmRecords(pool);
setCallRecorder(async(e,on)=>{
 const row=(await pool.query("SELECT value FROM app_settings WHERE key='settings.llm_record'")).rows[0];
 await writer.recordCall(e,on&&row?.value==='true',e.businessKind);
});
const echoTool={name:'f07_echo',label:'echo',description:'回显输入',parameters:{type:'object',properties:{msg:{type:'string'}},required:['msg']},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})} as unknown as ToolDefinition;
async function runCall(port:number,failFirst:number,prompt:string,tools:ToolDefinition[],activity?:{taskId:number;worker:string}){
 const {server:m}=await startMockAnthropic(port,{marker:'F07_OK',failFirst});
 await pool.query("DELETE FROM llm_profiles");
 const prof=(await pool.query("INSERT INTO llm_profiles (name,model,format,base_url,api_key,is_default) VALUES ($1,'mock-1','anthropic',$2,'mk',TRUE) RETURNING id,name",[`f07-${port}`,`http://127.0.0.1:${port}`])).rows[0];
 const compiled=await new LlmService(pool,'/tmp/pihost-test-dlq.jsonl',config.pi.modelsPath).compileToPiRuntime();
 if('error' in compiled)throw new Error(JSON.stringify(compiled));
 resetPiRuntime();
 const h=await createHostedSession(pool,config,{kind:activity?'worker':'chat',businessId:activity?`task-${activity.taskId}-intent-1`:'conv-f07',systemPrompt:'你是测试助手。',provider:`profile-${prof.id}`,modelId:'mock-1',customTools:tools,activity});
 await h.session.prompt(prompt);await h.flushEvents();await h.dispose();
 m.close();return prof;
}
test('F07 写路径：usage 恒记 + bodies 门控 + raw 线缆字节 + 工具 schema',async()=>{
 await pool.query("INSERT INTO app_settings (key,value) VALUES ('settings.llm_record','true') ON CONFLICT (key) DO UPDATE SET value='true'");
 await pool.query("INSERT INTO explorations (id,goal) VALUES (77,'g') ON CONFLICT (id) DO NOTHING");
 const t=(await pool.query("INSERT INTO tasks (name,goal,exploration_id) VALUES ('f07','g',77) RETURNING id")).rows[0].id;
 const before=(await pool.query('SELECT count(*)::int AS n FROM llm_records')).rows[0].n,ubefore=(await pool.query('SELECT count(*)::int AS n FROM llm_usage')).rows[0].n;
 const prof=await runCall(18801,0,'回复 F07_OK 一次',[echoTool],{taskId:Number(t),worker:'worker'});
 const usage=(await pool.query('SELECT * FROM llm_usage ORDER BY id DESC LIMIT 1')).rows[0];
 assert.equal(usage.model,'mock-1');assert.equal(usage.profile_name,`f07-18801`);assert.equal(usage.task_id,String(t));
 assert.equal(usage.worker,'worker');assert.equal(Number(usage.exploration_id),77);assert.equal(usage.status,'ok');
 assert.ok(Number(usage.latency_ms)>=0);assert.ok(Number(usage.input_tokens)>0,'metering 恒记（含输入 token）');
 assert.equal(usage.performance.version,1);assert.equal(usage.performance.httpAttempts,1);
 assert.ok(usage.performance.firstContentMs!==null);assert.ok(usage.performance.totalMs>=usage.performance.firstContentMs);
 assert.ok(usage.performance.requestBytes>0);assert.ok(usage.performance.responseBytes>0);assert.equal(usage.performance.tools,1);
 const stored=(await pool.query(`SELECT * FROM llm_records WHERE session_id='task-${t}-intent-1' ORDER BY id DESC LIMIT 1`)).rows[0];
 assert.equal(stored.raw_request,null);assert.ok(stored.body_storage,'new body is stored once in a compressed envelope');
 const rows=await expandRecordBodies(stored);

 assert.equal(rows.worker,'worker');assert.equal(rows.task_id,String(t));assert.equal(rows.status,'ok');
 // raw_request：真实发送字节——含完整消息与工具 schema（含 parameters）
 const rawReq=JSON.parse(rows.raw_request);
 assert.ok(rawReq.messages.length>=1,'raw_request 含实际 messages');
 const tool=rawReq.tools?.find((x:any)=>x.name==='f07_echo');
 assert.ok(tool&&(tool.input_schema||tool.parameters),'raw_request 保留完整工具 schema（规范化视图只留名字）');
 // raw_response：真实 SSE 线缆字节（message_start/message_stop 帧）
 assert.match(rows.raw_response,/message_start/);assert.match(rows.raw_response,/message_stop/);
 // request_body：归一化视图（工具只留名字 + tools_count）
 const reqBody=JSON.parse(rows.request_body);
 assert.deepEqual(reqBody.tools,['f07_echo']);assert.equal(reqBody.tools_count,1);
 assert.deepEqual(reqBody.system,Array.isArray(rawReq.system)?rawReq.system.map((s:any)=>typeof s==='string'?s:s.text):[rawReq.system]);assert.match(reqBody.system[0],/^你是测试助手。/);assert.equal(reqBody.messages[0].role,'user');assert.equal(reqBody.messages[0].content[0].type,'text');
 // response_body：归一化结果（text/stop_reason/usage）
 const respBody=JSON.parse(rows.response_body);
 assert.equal(respBody.stop_reason,'end_turn','stop_reason 保留原Norma外部词表');assert.ok(respBody.usage.input_tokens>0);assert.match(respBody.text,/F07_OK/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_records')).rows[0].n,before+1,'恰好一行记录');
 void prof;
});
test('F07 写路径：SDK 重试的多 attempt 按原格式拼接（HTTP 500 头行）',async()=>{
 await pool.query("INSERT INTO app_settings (key,value) VALUES ('settings.llm_record','true') ON CONFLICT (key) DO UPDATE SET value='true'");
 const t=(await pool.query("INSERT INTO tasks (name,goal) VALUES ('f07r','g') RETURNING id")).rows[0].id;
 await runCall(18802,1,'再回复一次',[echoTool],{taskId:Number(t),worker:'worker'});
 const all=await Promise.all((await pool.query(`SELECT * FROM llm_records WHERE session_id LIKE 'task-${t}%' ORDER BY id ASC`)).rows.map(expandRecordBodies));
 assert.ok(all.length>=1,'重试路径至少留一行');
 // 每次真实 HTTP 往返一行（taskStream 内层尝试各记录一次）；
 // 同一行内的 SDK 层重 fetch 才拼接为 attempt N/M。此处断言 500 往返以头行留痕：
  const bad=all.find(r=>r.status==='error');
 assert.ok(bad,'失败往返成行（status=error）');
 assert.match(bad.raw_response,/mock failure/,'失败往返保留原始错误 body');
 const errRow=(await pool.query(`SELECT error FROM llm_records WHERE session_id LIKE 'task-${t}%' AND status='error' ORDER BY id DESC LIMIT 1`)).rows[0];
 assert.match(errRow.error??'',/HTTP 500/,'error 携带 HTTP 状态码（原 Attempts 诊断能力）');
 assert.ok(all.some(r=>r.status==='ok'&&/message_start/.test(r.raw_response??'')),'重试成功往返保留（SSE 原字节）');
});
test('F07 写路径：流中断——abort 后 usage/bodies 仍落（原 finish(err) 语义）',async()=>{
 await pool.query("INSERT INTO app_settings (key,value) VALUES ('settings.llm_record','true') ON CONFLICT (key) DO UPDATE SET value='true'");
 const {server:m}=await startMockAnthropic(18804,{marker:'F07_SLOW',delayMs:4000});
 await pool.query('DELETE FROM llm_profiles');
 const prof=(await pool.query("INSERT INTO llm_profiles (name,model,format,base_url,api_key,is_default) VALUES ('f07-slow','mock-1','anthropic','http://127.0.0.1:18804','mk',TRUE) RETURNING id")).rows[0];
 const compiled=await new LlmService(pool,'/tmp/pihost-test-dlq.jsonl',config.pi.modelsPath).compileToPiRuntime();
 if('error' in compiled)throw new Error(JSON.stringify(compiled));
 resetPiRuntime();
 const h=await createHostedSession(pool,config,{kind:'chat',businessId:'conv-f07-abort',systemPrompt:'慢回',provider:`profile-${prof.id}`,modelId:'mock-1'});
 const p=h.session.prompt('慢慢回复');await new Promise(r=>setTimeout(r,1200));
 await h.session.abort?.();await p.catch(()=>{});await h.flushEvents().catch(()=>{});await h.dispose();
 const rows=await Promise.all((await pool.query("SELECT * FROM llm_records WHERE session_id='conv-f07-abort'")).rows.map(expandRecordBodies));
 assert.ok(rows.length>=1,'中断调用仍留 bodies 行');
 assert.ok(rows.every(r=>r.status==='error'||r.status==='ok'),'status 归一 ok/error');
 const usage=(await pool.query("SELECT status FROM llm_usage WHERE business_id='conv-f07-abort'")).rows;
 assert.ok(usage.length>=1,'中断调用 usage 恒记');
 m.close();
});

test('F07 写路径：录制关仅停 bodies，usage 仍恒记',async()=>{
 await pool.query("UPDATE app_settings SET value='false' WHERE key='settings.llm_record'");
 const before=(await pool.query('SELECT count(*)::int AS n FROM llm_records')).rows[0].n;
 await runCall(18803,0,'关录制的一轮',[],undefined);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_records')).rows[0].n,before,'bodies 不新增');
 const usage=(await pool.query('SELECT worker,task_id FROM llm_usage ORDER BY id DESC LIMIT 1')).rows[0];
 assert.ok(usage.worker===null||usage.worker==='','对话场景 worker 为空（NULLIF 原语义）');
 assert.ok(!usage.task_id);
});

test('F07 环境模型真实 Pi loop 保留线缆，当前会话切换录制立即生效且无重复计量',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-f07-env-')),{server:m,state}=await startMockAnthropic(0,{marker:'ENV_CAPTURE'});
 const port=(m.address() as {port:number}).port,isolated={...config,dataDir:dir,pi:{...config.pi,agentDir:dir,modelsPath:path.join(dir,'models.json')}};
 await writeFile(isolated.pi.modelsPath,JSON.stringify({providers:{envcapture:{baseUrl:`http://127.0.0.1:${port}`,api:'anthropic-messages',apiKey:'fixture-key',models:[{id:'mock-1',name:'mock-1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192}]}}}));
 resetPiRuntime();const id='conv-env-'+suffix,host=await createHostedSession(pool,isolated,{kind:'chat',businessId:id,systemPrompt:'fixture',provider:'envcapture',modelId:'mock-1'});
 try{
  await pool.query("UPDATE app_settings SET value='false' WHERE key='settings.llm_record'");await host.session.prompt('record off');await host.flushEvents();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_records WHERE session_id=$1',[id])).rows[0].n,0);
  await pool.query("UPDATE app_settings SET value='true' WHERE key='settings.llm_record'");await host.session.prompt('record on');await host.flushEvents();
  const rows=await Promise.all((await pool.query('SELECT * FROM llm_records WHERE session_id=$1',[id])).rows.map(expandRecordBodies));assert.equal(rows.length,1);
  assert.match(rows[0].raw_response,/ENV_CAPTURE_2/);assert.deepEqual(JSON.parse(rows[0].raw_request),state.calls[1]!.body);assert.ok(JSON.parse(rows[0].request_body).messages.length>=2);
  const usage=(await pool.query('SELECT profile_id,input_tokens FROM llm_usage WHERE business_id=$1',[id])).rows;assert.equal(usage.length,2);assert.ok(usage.every(r=>r.profile_id===null&&r.input_tokens===11));
 }finally{await host.dispose();resetPiRuntime();m.closeAllConnections();await new Promise<void>(r=>m.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(path.join(tmpdir(),`${schema}.key`),{force:true});});

test('F07 LLM record API matches WORMHOLE filters, page shape, details, task picker, aggregates, and exact-task deletion',async()=>{
 await pool.query('DELETE FROM llm_records');await pool.query('DELETE FROM llm_usage');
 const first=(await pool.query(`INSERT INTO llm_records(model,profile_name,session_id,task_id,worker,latency_ms,input_tokens,output_tokens,cache_read,cache_write,status,request_body,response_body,raw_request,raw_response)
 VALUES('m1','profile','session alpha','task-17','worker',12,5,7,2,1,'ok','request body','response body','raw wire request','raw wire response') RETURNING id`)).rows[0].id;
 await pool.query(`INSERT INTO llm_records(model,profile_name,session_id,task_id,worker,latency_ms,input_tokens,output_tokens,cache_read,cache_write,status)
 VALUES('m1','profile','session beta','task-17','planner',8,3,4,0,0,'ok'),('m2','','other','task-18','mainagent',1,1,1,0,0,'error')`);
 await pool.query(`INSERT INTO llm_usage(model,task_id,input_tokens,output_tokens,cache_read,cache_write) VALUES('m1','task-17',8,11,2,1),('m2','task-17',1,1,0,0)`);
 const page=await api('/api/llm/records?model=m1&session=alpha&task=task-17&page=0&size=1');assert.equal(page.status,200);assert.equal(page.body.total,1);assert.equal(page.body.records.length,1);
 const summary=page.body.records[0];assert.equal(summary.id,Number(first));assert.equal(summary.profile_name,'profile');assert.equal(summary.worker,'worker');assert.equal(summary.input_tokens,5);assert.ok(!('request_body' in summary));assert.ok(!('raw_request' in summary));
 const detail=await api(`/api/llm/records/${first}`);assert.equal(detail.status,200);assert.equal(detail.body.request_body,'request body');assert.equal(detail.body.response_body,'response body');assert.equal(detail.body.raw_request,'raw wire request');assert.equal(detail.body.raw_response,'raw wire response');
 const tasks=await api('/api/llm/records/tasks');assert.deepEqual(tasks.body.tasks,[{task_id:'task-18',count:1},{task_id:'task-17',count:2}]);
 const models=await api('/api/llm/records/by-model?task=task-17');assert.equal(models.status,200);assert.deepEqual(models.body.models.map((x:any)=>x.model),['m1','m2']);assert.equal(models.body.models[0].input_tokens,8);
 assert.deepEqual((await api('/api/llm/records/by-model')).body,{error:'missing task'});
 assert.deepEqual((await api('/api/llm/records/not-an-id')).body,{error:'invalid id'});
 assert.deepEqual((await api('/api/llm/records/999999')).body,{error:'not found'});
 assert.equal((await api('/api/llm/records/-1')).status,404);assert.equal((await api('/api/llm/records/9223372036854775808')).status,400);assert.equal((await api(`/api/llm/records/+${first}`)).status,200);
 assert.equal((await api('/api/llm/records','DELETE')).status,400);
 assert.deepEqual((await api('/api/llm/records?task=task-17','DELETE')).body,{deleted:2});
 assert.equal((await api('/api/llm/records?task=task-17')).body.total,0);
});

test('F07 empty task picker preserves WORMHOLE nil-slice JSON null',async()=>{
 await pool.query('DELETE FROM llm_records');assert.deepEqual((await api('/api/llm/records/tasks')).body,{tasks:null});
});
