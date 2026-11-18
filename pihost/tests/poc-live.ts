/** Opt-in real provider + imported libraries + official Nginx response validation. */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {AssetContextService} from '../src/domains/assets/context.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {FingerprintService} from '../src/domains/fingerprints/service.ts';
import {seedFingerprintTools,registerFingerprintTools} from '../src/domains/fingerprints/tools.ts';
import {PocService} from '../src/domains/pocs/service.ts';
import {seedPocTools,registerPocTools} from '../src/domains/pocs/tools.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {getTool,registerTool} from '../src/domains/tools/gate.ts';
import type {PihostConfig} from '../src/config.ts';
if(process.env.WORMHOLE_POC_LIVE!=='1')throw new Error('Opt-in requires WORMHOLE_POC_LIVE=1');
const root=process.env.WORMHOLE_POC_VALIDATION_DIR??'/root/wormhole-poc-orchestration-20261021',config=JSON.parse(await readFile(root+'/config.test.json','utf8')) as PihostConfig;
if(!new URL(config.database.dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('dedicated test database required');
const pool=new Pool({connectionString:config.database.dsn}),base=JSON.parse(await readFile('/var/lib/wormhole/config.json','utf8')),live=new Pool({connectionString:base.database.dsn});
await runMigrations(pool);let source:Record<string,unknown>;try{source=(await live.query("SELECT * FROM llm_profiles WHERE id=1 AND api_key<>''")).rows[0];assert.ok(source,'configured provider profile required');}finally{await live.end();}
await mkdir(config.pi.agentDir,{recursive:true});const profile=await new LlmService(pool,path.join(config.dataDir,'live-dlq.jsonl'),config.pi.modelsPath).createProfile({...source,name:'poc-live-'+Date.now(),model:String(source.model),format:String(source.format),base_url:String(source.base_url),api_key:String(source.api_key),max_tokens:4096,thinking_type:"disabled",reasoning_effort:"",is_default:false});assert.ok(profile.ok);
config.efficiency={maxActiveSeconds:600,maxModelCalls:32,maxOutputTokens:20000,maxTotalTokens:200000,idleSeconds:60,emptyRounds:2,plannerMaxTurns:12,plannerRunSeconds:180};
await pool.query("UPDATE agents SET max_turns=CASE WHEN key='goals' THEN 5 ELSE 14 END,run_seconds=180 WHERE key IN('goals','planner','worker')");
const allowed=['http_request','search_pocs','read_poc','get_asset_fingerprints','identify_asset','graph_overview','list_facts','node_detail','list_goals','add_intent','prove_goal','resolve_goal','goal_met','expand_digest','set_goals','set_constraints','record_fact','list_assets','list_untested_assets','list_companies','get_asset_detail','read_worker_handoff','save_worker_checkpoint','read_worker_artifact'];
await pool.query('UPDATE tools SET enabled=false WHERE NOT(key=ANY($1::text[]))',[allowed]);
const fp=new FingerprintService(pool);await fp.seed();await fp.snapshot();await seedFingerprintTools(fp);registerFingerprintTools(fp);const pocs=new PocService(pool);await pocs.seed();await seedPocTools(pocs);registerPocTools(pocs);
const dlq=path.join(config.dataDir,'live-dlq.jsonl'),assets=new AssetsService(pool,dlq),findings=new FindingsService(pool,dlq);resetPiRuntime();
const negative=createServer((req,res)=>{res.setHeader('content-type','text/plain');res.statusCode=req.url==='/'?200:404;res.end(req.url==='/'?'Controlled plain response. No product banner.':'Resource absent.');});await new Promise<void>(r=>negative.listen(31792,'127.0.0.1',r));
const origins=['http://127.0.0.1:31791/','http://127.0.0.1:31792/'];
const engine=new TaskEngine(pool,config,{pocs,fingerprints:fp,assets,findings,agents:new AgentsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});fp.bindNotify((id,change)=>engine.notifyFingerprints(id,change));fp.start();
const goal='仅核验任务范围内两处已登记本地 Web 服务的技术特征。本次重点验证 PoC 知识供给是否能帮助实际任务：根据宿主提供的指纹及 PoC 候选，由规划选择适用的技术识别类候选并委派 Worker；Worker 阅读原始模板后据此进行少量只读 HTTP 核验，记录实际结果并保留采用的候选引用；另一服务作为未识别对照。允许读取公开根路径及一个随机不存在路径，最多 8 次 GET。产品和版本以真实响应为准，未知要说明。不要测试漏洞利用、写入、登录、爆破、上传、外联或访问其他主机端口。不需要新增资产或业务建模，不要求发现漏洞，不把指纹、模板命中或知识检索当成漏洞证据。';
const created=await new TaskService(pool,dlq,()=>{}).create({name:'PoC 知识供给真实模型验收',goal,queued:true,timeout_seconds:600,llm_profile_ids:[Number(profile.profile.id)]});assert.ok(created.ok);const id=Number(created.task.id);
for(const url of origins){await new AssetContextService(pool).addScope(id,'ip','127.0.0.1','受控只读验收服务');const a=await assets.upsertSource({type:'service',url,service_type:'http',task_id:id,page_title:'受控验收入口'});assert.ok(a.ok);}
const http=getTool('http_request')!;let requests=0;registerTool({...http,execute:async(p,ctx)=>{if(ctx.taskId===id){const target=new URL(String(p.url));if(!origins.some(o=>new URL(o).origin===target.origin)||String(p.method??'GET').toUpperCase()!=='GET')throw new Error('Live validation permits controlled GET only');if(++requests>8)throw new Error('Live request budget exhausted');}return http.execute(p,ctx);}});
await pool.query("UPDATE tasks SET status='created',queued=false,paused=false WHERE id=$1",[id]);console.log(JSON.stringify({event:'poc_live_started',task_id:id,model:source.model}));let final:Record<string,unknown>|undefined;
try{await engine.launch(id);const deadline=Date.now()+690000;let last=0;while(Date.now()<deadline){final=(await pool.query('SELECT id,status,paused,stopped_reason FROM tasks WHERE id=$1',[id])).rows[0];if(['done','failed','timeout'].includes(String(final?.status))||final?.paused)break;if(Date.now()-last>15000){last=Date.now();console.log(JSON.stringify({event:'progress',task_id:id,status:final?.status,requests,candidates:(await pocs.candidates(id)).total}));}await new Promise(r=>setTimeout(r,250));}
 await engine.shutdown();await fp.drain();
 const calls=(await pool.query("SELECT id,tool_key,params,result,is_error,error_text FROM tool_calls WHERE run_id='task-'||$1::text OR business_id='task-'||$1::text OR business_id LIKE 'task-'||$1::text||'-%' ORDER BY id",[id])).rows;
 const intents=(await pool.query("SELECT id,title,state,payload,last_error FROM exploration_nodes WHERE task_id=$1 AND kind='intent' ORDER BY id",[id])).rows;
 const facts=(await pool.query("SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND state='confirmed' ORDER BY id",[id])).rows;
 const candidates=await pocs.candidates(id,{limit:50}),observed=await fp.read(id),events=(await pool.query("SELECT seq,event_type,payload FROM business_events WHERE business_kind='task' AND business_id=$1 AND (event_type LIKE 'poc_%' OR event_type LIKE 'fingerprint_%' OR event_type IN('task_done','planner_done','goal_resolved')) ORDER BY seq",[String(id)])).rows;
 const checks={real_library_candidates:candidates.items.some(c=>['legacy-wormhole','nuclei-legacy','nuclei-modern'].includes(c.source_key)),candidate_linked_intent:intents.some(i=>i.payload?.poc_candidate_ids?.length),model_read_original:calls.some(c=>c.tool_key==='read_poc'&&!c.is_error),worker_received_candidates:!!(await pool.query("SELECT 1 FROM poc_deliveries WHERE task_id=$1 AND recipient='worker' AND cardinality(candidate_ids)>0",[id])).rowCount,actual_followup_http:calls.filter(c=>c.tool_key==='http_request'&&!c.is_error).length>2,fact_links_candidate:facts.some(f=>f.payload?.poc_candidate_ids?.length),negative_not_assigned_product:!observed.observations.some(o=>o.url.startsWith(origins[1]!)),completed:final?.status==='done'};
 const proof={mode:'real_model',task_id:id,model:source.model,validation_profile:{max_tokens:4096,thinking_type:'disabled'},task:final,target_requests:requests,checks,candidates,observed,intents,facts,tool_calls:calls,events};await writeFile(root+'/evidence/real-model-result.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify({event:'poc_live_result',task_id:id,...checks,requests}));assert.ok(Object.values(checks).every(Boolean),'inspect real-model-result.json for incomplete evidence');
}finally{await engine.shutdown();await fp.close();negative.closeAllConnections();await new Promise<void>(r=>negative.close(()=>r()));await pool.end();}
