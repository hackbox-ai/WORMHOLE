import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {EvidenceStore} from '../src/domains/findings/evidence.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {TaskArchives} from '../src/domains/tasks/archives.ts';
import {completeAchievedTask} from '../src/domains/tasks/completion.ts';
import {requestDiscoveryFinish,finishDiscoveryIfReady} from '../src/domains/tasks/continuous.ts';
import {checkpointTaskReport,withTaskReport,taskMarkdown,reportLeadSeconds} from '../src/domains/tasks/report.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
import type {PihostConfig} from '../src/config.ts';
const dsn=process.env.WORMHOLE_POC_TEST_DSN;
if(!dsn){test('task reports need isolated DB',{skip:true},()=>{});}else{
 assert.ok(new URL(dsn).pathname.startsWith('/wormhole_poc_test'));
 const admin=new Pool({connectionString:dsn}),schema='report_'+process.pid+'_'+Date.now();let pool:Pool,dir:string,tasks:TaskService,graph:ExplorationService,findings:FindingsService,store:EvidenceStore,traffic:TrafficStore;
 before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:dsn,options:'-c search_path='+schema});await runMigrations(pool);dir=await mkdtemp(path.join(tmpdir(),'wormhole-report-'));tasks=new TaskService(pool,path.join(dir,'dlq'),()=>{});graph=new ExplorationService(pool);traffic=new TrafficStore(path.join(dir,'traffic'));store=new EvidenceStore(pool,traffic,path.join(dir,'evidence'));findings=new FindingsService(pool,path.join(dir,'dlq'),store);});
 after(async()=>{await traffic?.close();await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
 async function task(){const r=await tasks.create({name:'报告收尾夹具',goal:'受控报告检查',queued:true});assert.ok(r.ok);const id=Number(r.task.id);await pool.query("UPDATE tasks SET status='running',queued=false,modeling_initialized=true WHERE id=$1",[id]);await graph.ensure(id);return id;}
 const finding=(id:number,name='受控发现')=>findings.record({task_id:id,vulnclass:'fixture',name,severity:'info',summary:'合成夹具已观察响应，仅验证报告交付',evidence:'GET /proof => 200\ncontrolled-evidence-marker\n```embedded fence```'});
 test('new findings have evidence-based baseline reports and blank enrichment cannot erase them',async()=>{const id=await task(),f=await finding(id);const row=(await pool.query('SELECT report FROM findings WHERE id=$1',[f.finding_id])).rows[0];assert.match(row.report,/controlled-evidence-marker/);assert.match(row.report,/仍需核验/);await assert.rejects(store.updateReport(Number(f.finding_node_id),'  '),/不能为空/);});
 test('draft precedes termination, final report includes late findings and preserves existing analysis',async()=>{
  const id=await task(),first=await finding(id,'早期发现');await store.updateReport(Number(first.finding_node_id),'# 已有人工分析\n\nverified-analysis-marker',0);
  await checkpointTaskReport(pool,id);let saved=(await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0];assert.equal(saved.phase,'draft');assert.equal(saved.finding_count,1);assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'running');
  const late=await finding(id,'截止前新增发现');await pool.query("UPDATE findings SET report='' WHERE id=$1",[late.finding_id]);
  await tasks.control(id,'stop');saved=(await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0];assert.equal(saved.phase,'final');assert.equal(saved.finding_count,2);assert.match(saved.markdown,/verified-analysis-marker/);assert.match(saved.markdown,/截止前新增发现/);assert.ok((await pool.query("SELECT report FROM findings WHERE id=$1",[late.finding_id])).rows[0].report.trim());
  await checkpointTaskReport(pool,id);assert.equal((await pool.query('SELECT phase FROM task_reports WHERE task_id=$1',[id])).rows[0].phase,'final','late draft cannot replace final');
  await store.updateReport(Number(late.finding_node_id),'# 后续 Reporter 分析\nlate-enrichment-marker',0);assert.match((await pool.query('SELECT markdown FROM task_reports WHERE task_id=$1',[id])).rows[0].markdown,/late-enrichment-marker/);
 });
 test('report and terminal state roll back together; ordinary and continuous completion both persist reports',async()=>{
  const id=await task();await finding(id);await assert.rejects(withTaskReport(pool,id,'回滚检查',async c=>{await c.query("UPDATE tasks SET status='done' WHERE id=$1",[id]);throw new Error('fixture rollback');}));assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'running');assert.equal((await pool.query('SELECT 1 FROM task_reports WHERE task_id=$1',[id])).rowCount,0);
  assert.equal(await completeAchievedTask(pool,id),true);assert.equal((await pool.query('SELECT phase FROM task_reports WHERE task_id=$1',[id])).rows[0].phase,'final');
  const continuous=await task();await pool.query("UPDATE tasks SET execution_mode='continuous' WHERE id=$1",[continuous]);const fact=await graph.recordFact(continuous,{summary:'受控阴性检查',evidence:'GET /proof fixture actual response'});await requestDiscoveryFinish(pool,continuous,'已核对授权入口和实际响应，没有可执行的新方向，保存实际检查结果。',[fact],[{area:'受控入口',outcome:'tested',reason:'证据已保存'}]);assert.equal(await finishDiscoveryIfReady(pool,continuous),true);assert.match((await pool.query('SELECT markdown FROM task_reports WHERE task_id=$1',[continuous])).rows[0].markdown,/本次未登记漏洞/);
 });
 test('a pause does not produce a final report, and a finding racing with stop cannot be omitted',async()=>{
  const paused=await task();await pool.query('UPDATE tasks SET paused=true WHERE id=$1',[paused]);await withTaskReport(pool,paused,'未实际结束',c=>c.query("UPDATE tasks SET status='done' WHERE id=$1 AND NOT paused",[paused]));assert.equal((await pool.query('SELECT 1 FROM task_reports WHERE task_id=$1',[paused])).rowCount,0);
  const id=await task();await Promise.all([tasks.control(id,'stop'),finding(id,'与停止并发的发现')]);const count=Number((await pool.query('SELECT count(*)::int n FROM findings WHERE task_id=$1',[id])).rows[0].n),saved=(await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0];assert.equal(saved.phase,'final');assert.equal(saved.finding_count,count);assert.equal(count,1);assert.match(saved.markdown,/与停止并发的发现/);
 });
 test('canonical findings render without graph nodes, assets stay scoped and report snapshots archive and restore',async()=>{
  const id=await task(),other=await task();await pool.query("INSERT INTO findings(task_id,name,vulnclass,severity,summary,evidence) VALUES($1,'独立发现','fixture','low','canonical-only-marker','real-text-evidence')",[id]);
  await pool.query("INSERT INTO assets(type,url,task_ids) VALUES('service','http://192.0.2.44/',ARRAY[$1]::bigint[])",[other]);const markdown=await taskMarkdown(pool,id);assert.match(markdown!,/canonical-only-marker/);assert.match(markdown!,/本任务资产：暂无已关联资产/);await tasks.control(id,'stop');const before=(await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0];
  const archives=new TaskArchives(pool,dir,{isTaskRunning:()=>false,abortTask:()=>{},drainSide:async()=>{}}),job=await archives.queue(id);await archives.runOne();assert.equal((await archives.get(Number(job.id)))?.state,'ready');assert.equal((await pool.query('SELECT 1 FROM task_reports WHERE task_id=$1',[id])).rowCount,0);await archives.queueRestore(Number(job.id));await archives.runOne();assert.deepEqual((await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0],before);
 });
 test('real task writes a draft before deadline and keeps its finding report even when final model fails',async()=>{
  let hits=0;const endpoint=createServer((_req,res)=>{hits++;res.end('controlled-evidence-marker');});await new Promise<void>(r=>endpoint.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(endpoint.address() as {port:number}).port+'/proof';
  const mock=await startMockAnthropic(0,{delayMs:40,tool:body=>{const names=(body.tools as {name:string}[]??[]).map(t=>t.name),messages=body.messages as any[],used=(name:string)=>messages.some(m=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='tool_use'&&c.name===name));if(names.includes('http_request')){if(!used('http_request'))return {name:'http_request',input:{url,method:'GET'}};if(!used('report_finding'))return {name:'report_finding',input:{name:'真实 HTTP 夹具发现',vulnclass:'fixture',severity:'info',summary:'受控响应报告交付检查',evidence:'GET '+url+' => 200 controlled-evidence-marker'}};}return undefined;}});
  const config:PihostConfig={listen:{host:'127.0.0.1',port:0},database:{dsn},dataDir:dir,pi:{agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json'),provider:'fixture',modelId:'mock-1'}};await mkdir(config.pi.agentDir,{recursive:true});await writeFile(config.pi.modelsPath,'{"providers":{}}');const profile=await new LlmService(pool,path.join(dir,'dlq'),config.pi.modelsPath).createProfile({name:'report-fixture',model:'mock-1',format:'anthropic',base_url:'http://127.0.0.1:'+(mock.server.address() as {port:number}).port,api_key:'fixture',is_default:true});assert.ok(profile.ok);resetPiRuntime();
  const engine=new TaskEngine(pool,config,{assets:new AssetsService(pool,path.join(dir,'dlq')),findings,agents:new AgentsService(pool,path.join(dir,'dlq')),intercept:new InterceptService(pool,path.join(dir,'dlq')),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});
  const result=await tasks.create({name:'截止收尾',goal:'受控报告测试',queued:true,timeout_seconds:5,seed_first_intent:true,llm_profile_ids:[Number(profile.profile.id)]});assert.ok(result.ok);const id=Number(result.task.id);await pool.query("UPDATE tasks SET execution_mode='continuous',modeling_initialized=true WHERE id=$1",[id]);await pool.query("INSERT INTO task_scope(task_id,kind,net,source) VALUES($1,'ip','127.0.0.1/32','manual')",[id]);
  (engine as any).finalPlannerRound=async()=>{throw new Error('fixture final model unavailable');};
  const until=async(fn:()=>Promise<boolean>,label:string)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail(label);};
  try{await engine.launch(id);await until(async()=>!!(await pool.query("SELECT 1 FROM task_reports WHERE task_id=$1 AND phase='draft'",[id])).rowCount,'pre-deadline draft');await until(async()=>!!(await pool.query('SELECT 1 FROM findings WHERE task_id=$1',[id])).rowCount,'actual HTTP finding');await until(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status==='timeout','deadline finalization');await engine.drain(id);const saved=(await pool.query('SELECT * FROM task_reports WHERE task_id=$1',[id])).rows[0];assert.equal(saved.phase,'final');assert.equal(saved.finding_count,1);assert.match(saved.markdown,/controlled-evidence-marker/);assert.ok(hits>0);assert.equal(engine.slots.size,0);assert.equal(reportLeadSeconds(1800),60);}
  finally{await engine.shutdown();for(const s of [endpoint,mock.server]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}}
 });
}
