import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {mkdtemp,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FindingReports} from '../src/domains/findings/report-jobs.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {EvidenceStore} from '../src/domains/findings/evidence.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
import {assessmentFields,checkFindingReport} from '../src/domains/findings/report-quality.ts';
const config=loadConfig(),admin=new Pool({connectionString:config.database.dsn}),schema='report_jobs_'+process.pid+'_'+Date.now();
let pool:Pool,dir:string,reports:FindingReports,findings:FindingsService,tasks:TaskService,traffic:TrafficStore;
const turns=new Map<number,any>(),allowed:string[][]=[];
const agents={get:async()=>({enabled:true,run_seconds:60})} as any;
const conversations:any={create:async(key:string,title:string)=>({ok:true,conv:(await pool.query('INSERT INTO conversations(agent_key,title) VALUES($1,$2) RETURNING *',[key,title])).rows[0]}),send:async(id:number,_msg:string,_files:any[],owned:any)=>{assert.ok(await owned.start());turns.set(id,owned);allowed.push(owned.toolNames);return {status:202};},stop:async(id:number)=>{const turn=turns.get(id);if(turn){turns.delete(id);await turn.finish('stopped','cancelled');}}};
before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);dir=await mkdtemp(path.join(tmpdir(),'wormhole-report-jobs-'));traffic=new TrafficStore(path.join(dir,'traffic'));const evidence=new EvidenceStore(pool,traffic,path.join(dir,'evidence'));reports=new FindingReports(pool,{...config,dataDir:dir},agents,conversations,evidence);await reports.seed();findings=new FindingsService(pool,path.join(dir,'dlq'),evidence);tasks=new TaskService(pool,path.join(dir,'dlq'),()=>{});});
after(async()=>{await reports?.shutdown();traffic?.close();await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
const report='# 合成发现\n## 概述\n已有证据证明测试结果。\n## 前置身份与权限\n使用本人测试账号，初始状态见证据。\n## 复现步骤\n依照记录输入并读取结果。\n## 证据\n原始输出显示状态发生变化。\n## 已验证影响与边界\n仅已观察的当前对象；其他账户未验证。\n## 根因分析\n缺少输入约束，代码层面尚未核实。\n## 修复建议\n服务端校验对象状态及参数上限。\n## 复测方法\n复用初始状态，合法输入成功，超限输入拒绝且状态不变。';
const assessment=Object.fromEntries(assessmentFields.map(k=>[k,'依据实际记录核对，未覆盖部分明确说明']));
async function create(){const task=await tasks.create({name:'report fixture',goal:'synthetic',queued:true});assert.ok(task.ok);const id=Number(task.task.id);await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=$1",[id]);const f=await findings.record({task_id:id,vulnclass:'fixture',name:'合成发现',severity:'medium',summary:'合成状态变化',evidence:'原始输出：before=1 after=2'});return {task:id,id:Number(f.finding_id),node:Number(f.finding_node_id)};}
async function job(id:number){return (await pool.query('SELECT * FROM finding_report_jobs WHERE finding_id=$1 ORDER BY id DESC',[id])).rows[0];}
async function begin(id:number){await reports.step();const j=await job(id);assert.equal(j.state,'running');return j;}
async function submit(j:any,gaps:string[]=[]){const ctx=await reports.context(Number(j.conversation_id));return reports.submit(Number(j.conversation_id),{report,assessment,source_refs:[ctx.source_ref],evidence_gaps:gaps});}
async function finish(j:any,status='completed'){const turn=turns.get(Number(j.conversation_id));turns.delete(Number(j.conversation_id));await turn.finish(status,status==='completed'?'':'synthetic interruption');}
test('finding and pending report job commit atomically; rollback leaves no job',async()=>{
 const f=await create();assert.equal((await job(f.id)).state,'pending');assert.equal((await pool.query('SELECT report_status FROM findings WHERE id=$1',[f.id])).rows[0].report_status,'pending');
 const c=await pool.connect();try{await c.query('BEGIN');const row=(await c.query("INSERT INTO findings(name) VALUES('rollback') RETURNING id")).rows[0];assert.equal((await c.query('SELECT count(*) FROM finding_report_jobs WHERE finding_id=$1',[row.id])).rows[0].count,'1');await c.query('ROLLBACK');assert.equal((await pool.query('SELECT count(*) FROM finding_report_jobs WHERE finding_id=$1',[row.id])).rows[0].count,'0');}finally{c.release();}
 const j=await begin(f.id);assert.ok((await submit(j)).saved);await finish(j);assert.equal((await job(f.id)).state,'completed');
});
test('fixed report queue is independent of disabled trigger and task pause/finish; tools are read-only',async()=>{
 await pool.query("UPDATE agent_triggers SET enabled=false");const f=await create();await pool.query("UPDATE tasks SET status='running',paused=true WHERE id=$1",[f.task]);const j=await begin(f.id);assert.deepEqual(allowed.at(-1),['get_report_job_context','get_report_job_trace','get_report_job_traffic','get_report_job_file','submit_report_job']);assert.ok((await submit(j)).saved);await finish(j);
 const row=(await pool.query('SELECT report,report_status FROM findings WHERE id=$1',[f.id])).rows[0];assert.equal(row.report,report);assert.equal(row.report_status,'completed');assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[f.task])).rows[0].paused,true);assert.ok((await reports.detail(f.id)).versions.length);
});
test('quality check rejects placeholder template, invented references and missing reproduction sections',async()=>{
 const f=await create(),j=await begin(f.id);let result=await reports.submit(Number(j.conversation_id),{report:'短报告',assessment:{},source_refs:['invented'],evidence_gaps:[]});assert.equal(result.saved,false);assert.equal((await job(f.id)).draft,'');
 await submit(j,['缺少独立对照，不能扩展影响范围']);await finish(j);const row=(await pool.query('SELECT report,report_status FROM findings WHERE id=$1',[f.id])).rows[0];assert.equal(row.report_status,'needs_evidence');assert.notEqual(row.report,report);assert.equal((await reports.detail(f.id)).jobs[0].draft,report);
});
test('evidence version changes supersede stale jobs and prevent late writes',async()=>{
 const f=await create(),j=await begin(f.id);await submit(j);await pool.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[f.id]);assert.equal((await pool.query('SELECT state FROM finding_report_jobs WHERE id=$1',[j.id])).rows[0].state,'superseded');await assert.rejects(()=>reports.submit(Number(j.conversation_id),{report,assessment,source_refs:[],evidence_gaps:[]}),/ended|updated/);await finish(j);assert.notEqual((await pool.query('SELECT report FROM findings WHERE id=$1',[f.id])).rows[0].report,report);await reports.cancel(f.id);
});
test('manual report edits survive in-flight publication; retries use bounded attempts and lease recovery',async()=>{
 const f=await create(),j=await begin(f.id);await submit(j);await pool.query("UPDATE findings SET report='operator report',report_status='completed' WHERE id=$1",[f.id]);await finish(j);assert.equal((await pool.query('SELECT report FROM findings WHERE id=$1',[f.id])).rows[0].report,'operator report');assert.equal((await job(f.id)).state,'superseded');
 const next=await create();let attempt=await begin(next.id);await finish(attempt,'failed');assert.equal((await job(next.id)).state,'pending');await pool.query("UPDATE finding_report_jobs SET attempts=2,next_attempt_at=now() WHERE finding_id=$1",[next.id]);attempt=await begin(next.id);await finish(attempt,'failed');assert.equal((await job(next.id)).state,'failed');
 await reports.request(next.id);attempt=await begin(next.id);await pool.query("UPDATE finding_report_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[attempt.id]);await reports.recover();assert.equal((await job(next.id)).state,'pending');await reports.cancel(next.id);
});
test('report cancellation and historical backfill never restart tests or overwrite complete reports',async()=>{
 const a=await create(),b=await create(),j=await begin(a.id);await reports.cancel(a.id);assert.equal((await job(a.id)).state,'cancelled');await assert.rejects(()=>reports.context(Number(j.conversation_id)),/ended/);
 await pool.query("UPDATE findings SET report='complete historical report',report_status='completed' WHERE id=$1",[b.id]);await reports.cancel(b.id);
 const preview=await reports.backfill([a.id,b.id]);assert.equal(preview.eligible,1);await reports.backfill([a.id,b.id],false);assert.equal((await pool.query('SELECT report FROM findings WHERE id=$1',[b.id])).rows[0].report,'complete historical report');await reports.cancel(a.id);
});
test('report file reads reject foreign task paths and symlinks',async()=>{
 const f=await create(),other=await create(),j=await begin(f.id),root=path.join(dir,'workspace/tasks',String(f.task));await mkdir(root,{recursive:true});await writeFile(path.join(root,'proof.txt'),'proof');assert.equal((await reports.file(Number(j.conversation_id),{path:'proof.txt'})).text,'proof');
 await assert.rejects(()=>reports.file(Number(j.conversation_id),{path:'../'+other.task+'/proof.txt'}),/Illegal|Invalid|invalid/);await symlink('/etc/hosts',path.join(root,'outside'));await assert.rejects(()=>reports.file(Number(j.conversation_id),{path:'outside'}),/link/i);await reports.cancel(f.id);await reports.cancel(other.id);
});
test('completed report never publishes on failed conversation; reports with unread refs cannot pass',async()=>{
 const f=await create(),j=await begin(f.id);const result=await reports.submit(Number(j.conversation_id),{report,assessment,source_refs:['finding:'+f.id],evidence_gaps:[]});assert.equal(result.saved,false);await submit(j);await finish(j,'failed');assert.notEqual((await pool.query('SELECT report FROM findings WHERE id=$1',[f.id])).rows[0].report,report);await reports.cancel(f.id);
 assert.equal(checkFindingReport('# 题目\n## 前置条件\n## 复现步骤\n## 证据\n## 影响\n## 根因分析\n## 修复建议\n## 复测方法',assessment,['s'],new Set(['s']),[]).passed,false);
 assert.equal(checkFindingReport(report.replace('仅已观察的当前对象；其他账户未验证。','本次仅单次订单验证，可重复循环放大余额。循环放大链未实际执行。'),assessment,['s'],new Set(['s']),[]).passed,false);
 assert.equal(checkFindingReport(report.replace('仅已观察的当前对象；其他账户未验证。','单请求可无限放大余额。'),assessment,['s'],new Set(['s']),[]).passed,false);
 assert.equal(checkFindingReport(report.replace('依照记录输入并读取结果。','curl -b "..." URL'),assessment,['s'],new Set(['s']),[]).passed,false);
});

test('report HTTP actions are authenticated, scoped, and expose draft/history without starting tests',async()=>{
 const {createServer}=await import('node:http'),{AuthService,authKeyPath}=await import('../src/auth/service.ts'),{routeRequest}=await import('../src/api/server.ts');
 const auth=new AuthService(pool,authKeyPath(dir)),login=await auth.init('isolated-report-fixture');assert.ok(login.ok);
 const ctx={pool,config:{...config,dataDir:dir},auth,findings,findingReports:reports} as any;
 const server=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{const f=await create(),base='/api/exploration/findings/'+f.id+'/report';
  const call=(url:string,method='GET',body?:unknown,authorized=true)=>fetch(origin+url,{method,headers:{...(authorized?{authorization:'Bearer '+login.token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await call(base+'/cancel','POST',{},false)).status,401);assert.equal((await job(f.id)).state,'pending');
  const response=await call(base);assert.equal(response.status,200);assert.equal((await response.json()).jobs.length,1);
  const preview=await call('/api/finding-reports/backfill','POST',{finding_ids:[f.id],dry_run:true});assert.equal(preview.status,200);assert.equal((await preview.json()).eligible,1);
  assert.equal((await call(base+'/cancel','POST',{})).status,200);assert.equal((await job(f.id)).state,'cancelled');assert.equal((await call(base+'/retry','POST',{})).status,202);await reports.cancel(f.id);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('report concurrency is bounded independently, while further jobs remain durable',async()=>{
 const a=await create(),b=await create(),c=await create();await reports.step();const jobs=(await pool.query("SELECT finding_id,state FROM finding_report_jobs WHERE finding_id=ANY($1::bigint[])",[[a.id,b.id,c.id]])).rows;
 assert.equal(jobs.filter(j=>j.state==='running').length,2);assert.equal(jobs.filter(j=>j.state==='pending').length,1);
 for(const f of [a,b,c])await reports.cancel(f.id);
});
test('trace reading has a visible budget and final crash recovery cannot retry indefinitely',async()=>{
 const f=await create(),j=await begin(f.id);await reports.context(Number(j.conversation_id));
 for(let n=0;n<80;n++)await pool.query("INSERT INTO finding_report_reads(job_id,attempt,ref,body_hash,bytes) VALUES($1,$2,$3,'fixture',1)",[j.id,j.attempts,'budget:'+n]);
 assert.equal((await reports.trace(Number(j.conversation_id),{})).budget_depleted,true);
 await pool.query("UPDATE finding_report_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1",[j.id]);await reports.recover();assert.equal((await job(f.id)).state,'failed');await reports.cancel(f.id);await conversations.stop(Number(j.conversation_id));
});
test('explicit conversation stop cancels reporting, normal service stop remains recoverable',async()=>{
 const f=await create(),j=await begin(f.id);const owned=turns.get(Number(j.conversation_id));turns.delete(Number(j.conversation_id));await owned.finish('stopped','user_stop');assert.equal((await job(f.id)).state,'cancelled');
});

test('fixed jobs cannot be duplicated by re-enabling the legacy reporter trigger',async()=>{
 const {TriggerScheduler}=await import('../src/domains/tasks/scheduler.ts');const scheduler=new TriggerScheduler(pool,path.join(dir,'dlq'),async()=>{},5000,true);await scheduler.initialize();
 await pool.query("UPDATE agent_triggers SET enabled=true WHERE agent_key='reporter'");
 const f=await create();const eid=(await pool.query('SELECT exploration_id FROM tasks WHERE id=$1',[f.task])).rows[0].exploration_id;
 await pool.query("INSERT INTO activity(exploration_id,kind,tool,tool_use_id,detail) VALUES($1,'tool_result','report_finding','fixed-report-trigger','finding recorded')",[eid]);
 await scheduler.step();assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE business_kind='scheduler' AND business_id='reporter' AND payload->>'task_id'=$1",[String(f.task)])).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM finding_report_jobs WHERE finding_id=$1',[f.id])).rows[0].count,'1');await reports.cancel(f.id);await scheduler.stop();
});
test('graceful report shutdown returns owned work without consuming its retry budget',async()=>{
 const f=await create(),j=await begin(f.id);assert.equal(Number(j.attempts),1);await reports.shutdown();const row=await job(f.id);assert.equal(row.state,'pending');assert.equal(Number(row.attempts),0);
});
