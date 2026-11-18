/** Opt-in real Worker session + public OSV validation in an isolated DB schema. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {IntelClient} from '../src/domains/intel/client.ts';
import {seedIntelTools,registerIntelTools,INTEL_TOOLS} from '../src/domains/intel/tools.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
if(process.env.WORMHOLE_INTEL_LIVE!=='1')throw new Error('Requires explicit WORMHOLE_INTEL_LIVE=1');
const base=loadConfig(),admin=new Pool({connectionString:base.database.dsn}),schema='intel_live_'+process.pid+'_'+Date.now();
const liveConfig=JSON.parse(await readFile('/var/lib/wormhole/config.json','utf8'));
const live=new Pool({connectionString:liveConfig.database.dsn});
let source:any;
try{source=(await live.query("SELECT p.* FROM llm_profiles p ORDER BY is_default DESC,id LIMIT 1")).rows[0];}finally{await live.end();}
assert.ok(source?.api_key,'configured provider required');
await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-intel-live-')),skillRoot=path.join(dir,'agent/skills'),dlq=path.join(dir,'dlq');
const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};
let host:Awaited<ReturnType<typeof createHostedSession>>|undefined;
try{
 await runMigrations(pool);await seedBuiltinSkills(skillRoot);await mkdir(config.pi.agentDir,{recursive:true});
 await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','skill','wormhole-vuln-intel') ON CONFLICT DO NOTHING");
 const agents=new AgentsService(pool,dlq),skills=new SkillsService(pool,dlq,skillRoot),mcp=new McpService(pool,dlq);
 const created=await new TaskService(pool,dlq,()=>{}).create({name:'public intelligence live validation',goal:'核对公开组件安全公告',queued:true});
 assert.ok(created.ok);const taskId=Number(created.task.id);
 const graph=new ExplorationService(pool);await graph.ensure(taskId);
 const intentId=await graph.addIntent(taskId,{summary:'核对已知 npm lodash 4.17.15 的公开安全公告、版本适用条件和待验证项；当前仅资料核对，不访问任何客户目标。'});
 registerGraphTools(pool,graph,()=>{});
 const client=new IntelClient(pool);await seedIntelTools(client,pool);registerIntelTools(client);
 const llm=new LlmService(pool,dlq,config.pi.modelsPath);
 const profile=await llm.createProfile({...source,name:'intel live isolated',max_tokens:4096,thinking_type:'disabled',reasoning_effort:'',is_default:false});assert.ok(profile.ok);
 await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
 config.pi.provider='profile-'+profile.profile!.id;config.pi.modelId=String(source.model);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
 const ctx={businessKind:'worker',businessId:'task-'+taskId+'-intent-'+intentId,agentKey:'worker',taskId,intentId,signal:controller.signal};
 const augmentation=await augmentSession(pool,mcp,skills,ctx,{});
 const tools=bindAugmentation([...await assembleTools(pool,[...INTEL_TOOLS,'record_fact'],ctx,{}),...augmentation.tools],augmentation);
 const spec=await agents.resolveSessionSpec('worker');
 host=await createHostedSession(pool,config,{kind:'worker',businessId:ctx.businessId,systemPrompt:spec.systemPrompt,customTools:tools,activity:{taskId,nodeId:intentId,worker:'intel-live'}});
 const cancel=()=>void host?.session.abort();controller.signal.addEventListener('abort',cancel,{once:true});
 console.log(JSON.stringify({event:'intel_live_started',model:source.model}));
 try{await host.session.prompt('执行当前意图。交接包：产品/组件 npm lodash，版本 4.17.15；本地 PoC 候选为空，已有事实仅包含组件版本，缺少公开漏洞适用条件。请按现有方法核对并把结果和来源写回事实；不需要发现漏洞，不进行目标请求。使用少量查询，尽快收尾。');await host.flushEvents();}
 finally{clearTimeout(timer);controller.signal.removeEventListener('abort',cancel);}
 const calls=(await pool.query('SELECT tool_key,params,result,is_error,error_text FROM tool_calls WHERE business_id=$1 ORDER BY id',[ctx.businessId])).rows;
 const facts=await graph.nodes(taskId,'fact');
 const checks={skill_loaded:!!(await pool.query("SELECT 1 FROM skill_usage WHERE business_id=$1 AND skill='wormhole-vuln-intel'",[ctx.businessId])).rowCount,queried_osv:calls.some(c=>c.tool_key==='osv_lookup'&&!c.is_error&&c.result?.ok===true&&Number(c.result?.count)>0),fact_written:calls.some(c=>c.tool_key==='record_fact'&&!c.is_error),source_preserved:facts.some(f=>/https?:|GHSA-|CVE-/.test(String(f.payload.evidence)+' '+String(f.payload.detail))),no_finding:(await pool.query('SELECT count(*)::int n FROM findings')).rows[0].n===0,no_model_error:!host.modelFailure};
 const out=process.env.WORMHOLE_INTEL_EVIDENCE??'/root/wormhole-channel-editor-qa-20261110/intel-live-result.json';
 await writeFile(out,JSON.stringify({checks,model:source.model,calls,facts},null,2),{mode:0o600});
 console.log(JSON.stringify({event:'intel_live_result',checks,tools:calls.map(c=>({key:c.tool_key,error:c.is_error}))}));
 assert.ok(Object.values(checks).every(Boolean),'Inspect private evidence for incomplete live validation');
}finally{
 await host?.dispose();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
}
