import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import {EvidenceStore} from '../src/domains/findings/evidence.ts';
import {seedEvidenceTools} from '../src/domains/findings/evidence-tools.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {startMockAnthropic,type ToolCallSpec} from './fixtures/mock-anthropic.ts';

test('native Pi loads role Skills and references, performs controlled baseline/proof/control, writes graph/finding/report; denial produces zero target requests',async()=>{
 const base=loadConfig(),schema='method_native_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-method-native-')),agentDir=path.join(dir,'agent'),modelsPath=path.join(agentDir,'models.json'),skillRoot=path.join(agentDir,'skills');
 await mkdir(agentDir);await writeFile(modelsPath,JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}},dlq=path.join(dir,'dlq');
 const skills=new SkillsService(pool,dlq,skillRoot),mcp=new McpService(pool,dlq),agents=new AgentsService(pool,dlq);
 const traffic=new TrafficStore(path.join(dir,'traffic')),store=new EvidenceStore(pool,traffic,path.join(dir,'evidence')),findings=new FindingsService(pool,dlq,store);
 let calls=0,sequence:ToolCallSpec[]=[],step=0,active:HostedSession|undefined;
 const receiver=createServer((req,res)=>{calls++;const missing=req.url?.includes('/missing');res.writeHead(missing?404:200,{'content-type':'application/json'});res.end(JSON.stringify(missing?{error:'object not found'}:{owner:req.url?.includes('/other')?'B':'A',fixture:true}));});
 const mock=await startMockAnthropic(0,{marker:'METHOD_COMPLETE',tool:()=>sequence[step++]});
 async function session(agentKey:string,businessId:string,taskId:number,keys:string[],intentId?:number,deny=false){
  const gate={rules:deny?await new InterceptService(pool,dlq).gateRules():[]};
  const ctx={agentKey,businessKind:'worker',businessId,taskId,intentId};
  const augmentation=await augmentSession(pool,mcp,skills,ctx,gate);
  const tools=bindAugmentation([...(await assembleTools(pool,keys,ctx,gate)),...augmentation.tools],augmentation);
  const spec=await agents.resolveSessionSpec(agentKey);
  active=await createHostedSession(pool,config,{kind:'chat',businessId,cwd:dir,systemPrompt:spec.systemPrompt,provider:spec.provider,modelId:spec.modelId,profileBinding:true,customTools:tools});
 }
 try{
  await runMigrations(pool);await seedBuiltinSkills(skillRoot);await seedEvidenceTools(store);
  await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));
  const target='http://127.0.0.1:'+(receiver.address() as {port:number}).port;
  const profile=(await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('method-local','anthropic','mock-1',$1,'fixture',TRUE) RETURNING id",['http://127.0.0.1:'+(mock.server.address() as {port:number}).port])).rows[0].id;
  const task=await new TaskService(pool,dlq,()=>{}).create({goal:'local controlled fixture only',llm_profile_id:Number(profile)});assert.ok(task.ok);
  const taskId=Number(task.task.id),graph=new ExplorationService(pool),intentId=await graph.addIntent(taskId,{summary:'compare own/other/missing local objects'});
  registerGraphTools(pool,graph,()=>{});registerBusinessTools({assets:new AssetsService(pool,dlq),findings});
  sequence=[
   {name:'Skill',input:{name:'wormhole-test-method'}},
   {name:'Read',input:{file_path:path.join(skillRoot,'wormhole-test-method/references/evidence.md')}},
   {name:'Read',input:{file_path:path.join(skillRoot,'wormhole-test-method/references/object-authz.md')}},
   {name:'http_request',input:{url:target+'/own'}},
   {name:'http_request',input:{url:target+'/other'}},
   {name:'http_request',input:{url:target+'/missing'}},
   {name:'record_fact',input:{summary:'local fixture cross-owner access',detail:'baseline=A;changed_variable=object;observed=owner B;control=404;outcome=supported;coverage=DONE',evidence:'real local HTTP results: own 200 A, other 200 B, missing 404',confidence:'observed'}},
   {name:'report_finding',input:{name:'controlled fixture finding',vulnclass:'fixture',severity:'medium',summary:'local A can read B fixture',evidence:'own 200 A;other 200 B;missing 404'}},
  ];step=0;
  await session('worker','method-worker',taskId,['http_request','record_fact','report_finding'],intentId);
  await active!.session.prompt('Only perform the controlled local fixture baseline/proof/negative control and persist its evidence.');await active!.flushEvents();
  assert.equal(calls,3);
  const results=active!.session.messages.filter((m:any)=>m.role==='toolResult') as any[];
  assert.ok(results.length>=7);assert.ok(results.every(m=>!m.isError),JSON.stringify(results.filter(m=>m.isError)));
  assert.ok(mock.state.calls.some(c=>JSON.stringify(c.body).includes('## 最小验证循环')),'next actual provider request includes loaded methodology');
  assert.ok(mock.state.calls.some(c=>JSON.stringify(c.body).includes('hypothesis：可否定的安全不变量')),'reference reaches model via actual Read');
  assert.ok(mock.state.calls.some(c=>JSON.stringify(c.body).includes('A 读到 OB 独立私有标记')),'concrete object matrix reaches the actual model request');
  const fact=(await pool.query("SELECT payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'summary'='local fixture cross-owner access'",[taskId])).rows[0];assert.ok(fact);assert.match(fact.payload.detail,/control=404/);
  const finding=(await pool.query("SELECT id,node_id,evidence_version FROM findings WHERE task_id=$1 AND name='controlled fixture finding'",[taskId])).rows[0];assert.ok(finding);
  await active!.dispose();active=undefined;
  const report='# Controlled fixture report\n\n## 复现步骤\n1. own → 200 A\n2. other → 200 B\n3. missing → 404\n\n## 证据与限制\n真实本地 HTTP 工具结果；没有流量绑定。';
  sequence=[
   {name:'Skill',input:{name:'wormhole-finding-report'}},
   {name:'Read',input:{file_path:path.join(skillRoot,'wormhole-finding-report/references/report.md')}},
   {name:'get_finding_traffic',input:{finding_id:String(finding.id)}},
   {name:'update_finding_report',input:{finding_id:Number(finding.node_id),report,evidence_version:Number(finding.evidence_version)}},
  ];step=0;
  await session('reporter','method-reporter',taskId,['get_finding_traffic','update_finding_report']);
  await active!.session.prompt('Read the fixture evidence and save the detailed report without sending new target requests.');await active!.flushEvents();
  assert.equal(calls,3,'reporter never repeats target probes');
  assert.equal((await pool.query('SELECT report FROM findings WHERE id=$1',[finding.id])).rows[0].report,report);
  assert.ok((active!.session.messages.filter((m:any)=>m.role==='toolResult') as any[]).every(m=>!m.isError));
  await active!.dispose();active=undefined;
  // Enable intercept scope exactly for the denied operation.
  await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools','[\"http_request\"]') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  assert.ok((await new InterceptService(pool,dlq).createRule({name:'local controlled test blocked',match_target:'tool_name',match_type:'string',pattern:'http_request',action:'deny',enabled:true})).ok);
  sequence=[{name:'Skill',input:{name:'wormhole-test-method'}},{name:'http_request',input:{url:target+'/other'}}];step=0;
  await session('worker','method-denied',taskId,['http_request'],intentId,true);
  await active!.session.prompt('Exercise local tool denial only.');await active!.flushEvents();
  const denied=active!.session.messages.find((m:any)=>m.role==='toolResult'&&m.toolName==='http_request') as any;
  assert.ok(denied?.isError);assert.equal(calls,3,'methodology cannot bypass the tool gate');
  const usage=(await pool.query('SELECT agent_key,skill FROM skill_usage ORDER BY id')).rows;
  assert.deepEqual(usage.map(r=>[r.agent_key,r.skill]),[['worker','wormhole-test-method'],['reporter','wormhole-finding-report'],['worker','wormhole-test-method']]);
 }finally{
  await active?.dispose();resetPiRuntime();traffic.close();
  for(const server of [receiver,mock.server]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
