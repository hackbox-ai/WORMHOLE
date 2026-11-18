/** Opt-in real-provider validation. No mocked model responses or fingerprint products. */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
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
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {getTool,registerTool} from '../src/domains/tools/gate.ts';
import type {PihostConfig} from '../src/config.ts';

if(process.env.WORMHOLE_FINGERPRINT_LIVE!=='1')throw new Error('Opt-in requires WORMHOLE_FINGERPRINT_LIVE=1');
const dir=process.env.WORMHOLE_FINGERPRINT_VALIDATION_DIR??'/root/wormhole-fingerprint-orchestration-20261020',config=JSON.parse(await readFile(dir+'/config.test.json','utf8')) as PihostConfig;
if(!new URL(config.database.dsn).pathname.startsWith('/wormhole_fp_orchestration_test'))throw new Error('Requires dedicated isolated database');
const base=JSON.parse(await readFile('/var/lib/wormhole/config.json','utf8')),live=new Pool({connectionString:base.database.dsn}),pool=new Pool({connectionString:config.database.dsn});
await runMigrations(pool);await mkdir(config.pi.agentDir,{recursive:true});
let source:Record<string,unknown>;try{source=(await live.query('SELECT * FROM llm_profiles WHERE id=1 AND api_key<>\'\'')).rows[0];assert.ok(source,'configured model profile required');}finally{await live.end()}
const llm=new LlmService(pool,path.join(config.dataDir,'live-dlq.jsonl'),config.pi.modelsPath),createdProfile=await llm.createProfile({...source,name:'fingerprint-live-validation-'+Date.now(),model:String(source.model),format:String(source.format),base_url:String(source.base_url),api_key:String(source.api_key),is_default:false});assert.ok(createdProfile.ok);
config.efficiency={maxActiveSeconds:420,maxModelCalls:24,maxOutputTokens:18000,maxTotalTokens:160000,idleSeconds:45,emptyRounds:2,plannerMaxTurns:12,plannerRunSeconds:180};
await pool.query("UPDATE agents SET max_turns=CASE WHEN key='goals' THEN 5 ELSE 12 END,run_seconds=180 WHERE key IN('goals','planner','worker')");
const allowed=['http_request','get_asset_fingerprints','identify_asset','graph_overview','list_facts','node_detail','list_goals','add_intent','prove_goal','resolve_goal','goal_met','expand_digest','set_goals','set_constraints','record_fact','list_assets','list_untested_assets','list_companies','get_asset_detail','read_worker_handoff','save_worker_checkpoint','read_worker_artifact'];
await pool.query('UPDATE tools SET enabled=false WHERE NOT(key=ANY($1::text[]))',[allowed]);
const fingerprints=new FingerprintService(pool);await fingerprints.seed();await fingerprints.snapshot();await seedFingerprintTools(fingerprints);registerFingerprintTools(fingerprints);
const dlq=path.join(config.dataDir,'live-dlq.jsonl'),assets=new AssetsService(pool,dlq),findings=new FindingsService(pool,dlq);resetPiRuntime();
await pool.query("UPDATE tasks SET status='failed',queued=false WHERE status IN('created','running','paused')");
const engine=new TaskEngine(pool,config,{fingerprints,assets,findings,agents:new AgentsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:1,taskConcurrencyEnabled:true,taskConcurrencyLimit:1,trafficCapture:false}),getRebuildCount:()=>0}});
fingerprints.bindNotify((id,change)=>engine.notifyFingerprints(id,change));fingerprints.start();
const goal='本任务验证指纹信息能否辅助真实任务执行。仅检查任务范围内已登记的本地 Web 服务，先比较产品识别及来源，再依据产品信息安排少量有针对性的只读核验。公开路径 /fingerprint-proof 可供核验，随机不存在路径可作阴性对照。使用实际响应记录结论；识别失败要说明，不得编造产品或版本。无须发现漏洞，不要把技术栈命中当作漏洞。禁止访问其他主机/端口，禁止写入、爆破和漏洞利用，不需要新增资产或业务建模。最多 12 次 HTTP 请求，完成后给出阳性识别与阴性对照的证据。';
const tasks=new TaskService(pool,dlq,()=>{}),result=await tasks.create({name:'指纹编排真实模型验收',goal,queued:true,timeout_seconds:420,llm_profile_ids:[Number(createdProfile.profile.id)]});assert.ok(result.ok);const id=Number(result.task.id);
const origins=(process.env.WORMHOLE_FINGERPRINT_LIVE_TARGETS??'http://127.0.0.1:31691/,http://127.0.0.1:31692/').split(',');
for(const url of origins){const u=new URL(url);assert.ok(u.hostname.startsWith('127.'),'controlled loopback fixture only');await new AssetContextService(pool).addScope(id,'ip',u.hostname,'本次受控只读验收服务');const r=await assets.upsertSource({type:'service',url,service_type:'http',task_id:id,page_title:'受控指纹编排验收入口'});assert.ok(r.ok);}
const transport=getTool('http_request')!;let targetRequests=0;
registerTool({...transport,execute:async(p,ctx)=>{if(ctx.taskId===id){const u=new URL(String(p.url));if(!origins.some(v=>new URL(v).origin===u.origin)||String(p.method??'GET').toUpperCase()!=='GET')throw new Error('Live validation scope permits GET on the two controlled origins only');if(++targetRequests>12)throw new Error('Live validation request budget exhausted');}return transport.execute(p,ctx)}});
await pool.query("UPDATE tasks SET status='created',queued=false,paused=false WHERE id=$1",[id]);
console.log(JSON.stringify({event:'real_model_task_started',task_id:id,model:source.model,targets:origins}));
let final:Record<string,unknown>|undefined;
try{
 await engine.launch(id);const end=Date.now()+510000;let lastProgress=0;
 while(Date.now()<end){final=(await pool.query('SELECT id,status,paused,stopped_reason FROM tasks WHERE id=$1',[id])).rows[0];if(['done','failed','timeout'].includes(String(final?.status))||final?.paused)break;if(Date.now()-lastProgress>10000){lastProgress=Date.now();console.log(JSON.stringify({event:'progress',task_id:id,status:final?.status,requests:targetRequests,observations:(await fingerprints.read(id)).observations.length,calls:Number((await pool.query("SELECT count(*) n FROM activity WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1) AND kind='usage'",[id])).rows[0].n)}));}await new Promise(r=>setTimeout(r,250));}
 await engine.shutdown();await fingerprints.drain();
 const observed=await fingerprints.read(id),intents=(await pool.query("SELECT id,state,title,payload,last_error FROM exploration_nodes WHERE task_id=$1 AND kind='intent' ORDER BY id",[id])).rows;
 const calls=(await pool.query("SELECT id,tool_key,params,result,is_error,error_text,finished_at FROM tool_calls WHERE run_id='task-'||$1::text OR business_id='task-'||$1::text OR business_id LIKE 'task-'||$1::text||'-%' ORDER BY id",[id])).rows;
 const deliveries=(await pool.query('SELECT * FROM fingerprint_deliveries WHERE task_id=$1 ORDER BY id',[id])).rows,events=(await pool.query("SELECT seq,event_type,payload,ts FROM business_events WHERE business_kind='task' AND business_id=$1 AND (event_type LIKE 'fingerprint_%' OR event_type IN('planner_done','task_done','goal_resolved','goal_proved')) ORDER BY seq",[String(id)])).rows;
 const facts=(await pool.query("SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND state='confirmed' ORDER BY id",[id])).rows;
 const linked=intents.filter(i=>i.payload?.fingerprint_observation_ids?.length),proof={mode:'real_model',task_id:id,model:source.model,task:final,target_requests:targetRequests,observed,deliveries,intents,facts,tool_calls:calls,events,checks:{recognized_real_product:observed.observations.some(o=>/nginx/i.test(o.product)),fingerprint_linked_intent:linked.length>0,model_read_fingerprints:calls.some(c=>c.tool_key==='get_asset_fingerprints'&&!c.is_error),followup_http:calls.some(c=>c.tool_key==='http_request'&&JSON.stringify(c.params).includes('fingerprint-proof')&&!c.is_error),worker_received_relevant_context:deliveries.some(d=>d.recipient==='worker'&&d.observation_ids.length),completed:final?.status==='done'}};
 await writeFile(dir+'/real-model-result.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify({event:'real_model_result',task_id:id,...proof.checks,target_requests:targetRequests}));assert.ok(Object.values(proof.checks).every(Boolean),'real task did not meet all evidence requirements; inspect real-model-result.json');
}finally{await engine.shutdown();await fingerprints.close();await pool.end()}
