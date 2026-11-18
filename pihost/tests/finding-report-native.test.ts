import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.ts';import {runMigrations} from '../src/db/migrate.ts';
import {AgentsService} from '../src/domains/agents/service.ts';import {ConversationsService} from '../src/domains/conversations/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';import {FindingReports} from '../src/domains/findings/report-jobs.ts';
import {FindingsService} from '../src/domains/findings/service.ts';import {TaskService} from '../src/domains/tasks/service.ts';
import {EvidenceStore} from '../src/domains/findings/evidence.ts';import {TrafficStore} from '../src/domains/traffic/store.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';import {resetPiRuntime} from '../src/pi/session-host.ts';
import {assessmentFields} from '../src/domains/findings/report-quality.ts';import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
test('actual Pi report loop has only owned evidence tools, publishes durably, and never starts test work',async()=>{
 const base=loadConfig(),admin=new Pool({connectionString:base.database.dsn}),schema='report_native_'+process.pid;await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-report-native-'));
 let conversations:ConversationsService|undefined,reports:FindingReports|undefined,traffic:TrafficStore|undefined,mock:Awaited<ReturnType<typeof startMockAnthropic>>|undefined;
 try{
  await runMigrations(pool);const config={...base,dataDir:dir,pi:{...base.pi,modelsPath:path.join(dir,'models.json'),agentDir:path.join(dir,'agent')}};await mkdir(config.pi.agentDir);
  const dlq=path.join(dir,'dlq'),agents=new AgentsService(pool,dlq);
  const text='# 合成状态校验\n## 前置身份与权限\n本人测试身份，初始余额 10。\n## 复现步骤\n使用已记录请求提交，再读取余额。\n## 证据\n记录前后余额 10→20。\n## 已验证影响与边界\n仅限当前对象，其他账户未验证。\n## 根因分析\n服务端缺少金额上限约束，代码未审计。\n## 修复建议\n服务端从订单计算金额并验证上限。\n## 复测方法\n重置状态，合法金额成功，超限金额拒绝且余额不变。';
  let findingId=0;mock=await startMockAnthropic(0,{tool:body=>{
   const names=((body.tools??[]) as any[]).map(t=>t.name);assert.deepEqual(names.sort(),['get_report_job_context','get_report_job_trace','get_report_job_traffic','get_report_job_file','submit_report_job'].sort());
   const calls=(body.messages as any[]).flatMap(m=>m.content??[]).filter(c=>c.type==='tool_use').map(c=>c.name);
   if(!calls.includes('get_report_job_context'))return {name:'get_report_job_context',input:{}};
   if(!calls.includes('submit_report_job'))return {name:'submit_report_job',input:{report:text,assessment:Object.fromEntries(assessmentFields.map(k=>[k,'依据合成原始记录核对，未知范围明确说明'])),source_refs:['finding:'+findingId],evidence_gaps:[]}};
  }});
  const port=(mock.server.address() as {port:number}).port,llm=new LlmService(pool,dlq,config.pi.modelsPath),profile=await llm.createProfile({name:'report native fixture',model:'mock-1',format:'anthropic',base_url:'http://127.0.0.1:'+port,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile!.id));const runtime=await llm.compileToPiRuntime();assert.ok(!('error'in runtime));config.pi.provider=runtime.provider;config.pi.modelId=runtime.modelId;resetPiRuntime();
  conversations=new ConversationsService(pool,config,agents,dlq,async(key,ctx)=>{const keys=(await pool.query("SELECT key FROM tools WHERE enabled AND agents @> $1::jsonb",[JSON.stringify([key])])).rows.map(t=>t.key);const tools=await assembleTools(pool,keys,ctx,{});for(const name of ['Bash','http_request','spawn_task'])tools.push({name,label:name,description:'must never be exposed',parameters:{type:'object',properties:{}} as any,execute:async()=>{throw new Error('unsafe tool exposed');}});return tools;});
  traffic=new TrafficStore(path.join(dir,'traffic'));const evidence=new EvidenceStore(pool,traffic,path.join(dir,'evidence'));reports=new FindingReports(pool,config,agents,conversations,evidence);await reports.seed();
  const tasks=new TaskService(pool,dlq,()=>{throw new Error('test task must never launch');}),task=await tasks.create({name:'report loop fixture',goal:'synthetic',queued:true});assert.ok(task.ok);const taskId=Number(task.task.id);await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=$1",[taskId]);
  const findings=new FindingsService(pool,dlq,evidence),f=await findings.record({task_id:taskId,name:'合成状态校验',vulnclass:'fixture',severity:'medium',summary:'合成前后状态',evidence:'原始合成记录：余额 10→20'});findingId=Number(f.finding_id);
  await reports.step();const deadline=Date.now()+25000;let row:any;
  do{await new Promise(r=>setTimeout(r,100));row=(await pool.query('SELECT report_status,report FROM findings WHERE id=$1',[findingId])).rows[0];}while(row.report_status!=='completed'&&Date.now()<deadline);
  assert.equal(row.report_status,'completed',JSON.stringify((await pool.query('SELECT state,error FROM finding_report_jobs')).rows));assert.equal(row.report,text);assert.ok(mock.state.calls.length>=3);
  assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[taskId])).rows[0].status,'done');assert.equal((await pool.query('SELECT count(*) FROM tasks')).rows[0].count,'1');
 }finally{await reports?.shutdown();await conversations?.shutdown();traffic?.close();if(mock){mock.server.closeAllConnections();await new Promise<void>(r=>mock!.server.close(()=>r()));}resetPiRuntime();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
