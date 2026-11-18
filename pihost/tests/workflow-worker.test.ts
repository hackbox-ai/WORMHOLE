import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

test('native Worker loads workflow method, reads reference, runs offline helper and records task evidence',async()=>{
 const base=loadConfig(),admin=new Pool({connectionString:base.database.dsn}),schema='workflow_worker_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-workflow-worker-')),dlq=path.join(dir,'dlq');
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};
 const skillsRoot=path.join(config.pi.agentDir,'skills'),cwd=path.join(dir,'workspace');
 let mock:Awaited<ReturnType<typeof startMockAnthropic>>|undefined,host:Awaited<ReturnType<typeof createHostedSession>>|undefined;
 try{
  await runMigrations(pool);await seedBuiltinSkills(skillsRoot);await mkdir(cwd,{recursive:true});
  await writeFile(path.join(cwd,'input.json'),JSON.stringify({parts:[['sample'],['01','02']]}));
  const skillPath=path.join(skillsRoot,'wormhole-test-method');
  const created=await new TaskService(pool,dlq,()=>{}).create({name:'workflow method fixture',goal:'offline supplied-material analysis only',queued:true});
  assert.ok(created.ok);const taskId=Number(created.task.id);
  const graph=new ExplorationService(pool);await graph.ensure(taskId);
  const intentId=await graph.addIntent(taskId,{summary:'Analyze supplied synthetic observations offline'});
  registerGraphTools(pool,graph,()=>{});
  const skillService=new SkillsService(pool,dlq,skillsRoot);
  assert.ok((await skillService.visible('worker')).some(s=>s.key==='wormhole-test-method'));
  mock=await startMockAnthropic(0,{tool:(_body,n)=>[
   {name:'Skill',input:{name:'wormhole-test-method'}},
   {name:'Read',input:{file_path:path.join(skillPath,'references/workflow-analysis.md')}},
   {name:'Bash',input:{command:'python3 "'+path.join(skillPath,'scripts/workflow_tools.py')+'" candidates --input input.json --output output.json'}},
   {name:'record_fact',input:{summary:'Offline candidate plan generated; no target validation performed',evidence:'workspace/output.json contains sample01 and sample02, from supplied input.json without joins; candidates remain unverified',confidence:'observed'}}
  ][n-1]});
  const llm=new LlmService(pool,dlq,config.pi.modelsPath),port=(mock.server.address() as {port:number}).port;
  const profile=await llm.createProfile({name:'workflow fixture',format:'anthropic',model:'mock-1',base_url:'http://127.0.0.1:'+port,api_key:'fixture'});assert.ok(profile.ok);
  await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
  config.pi.provider='profile-'+profile.profile!.id;config.pi.modelId='mock-1';
  const ctx={businessKind:'worker',businessId:'task-'+taskId+'-intent-'+intentId,agentKey:'worker',taskId,intentId,cwd};
  const augmentation=await augmentSession(pool,new McpService(pool,dlq),skillService,ctx,{});
  const tools=bindAugmentation([...await assembleTools(pool,['record_fact'],ctx,{}),...augmentation.tools],augmentation);
  const spec=await new AgentsService(pool,dlq).resolveSessionSpec('worker');
  host=await createHostedSession(pool,config,{kind:'worker',businessId:ctx.businessId,cwd,systemPrompt:spec.systemPrompt,customTools:tools,activity:{taskId,nodeId:intentId,worker:'workflow-fixture'}});
  await host.session.prompt('Analyze only the supplied offline fixture; load the method, read workflow guidance, generate candidates and save a fact.');await host.flushEvents();
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'output.json'),'utf8')).candidates,['sample01','sample02']);
  const calls=(await pool.query('SELECT tool_key,is_error FROM tool_calls WHERE business_id=$1',[ctx.businessId])).rows;
  for(const key of ['Skill','Read','Bash','record_fact'])assert.ok(calls.some(c=>c.tool_key===key&&!c.is_error),key);
  assert.ok((await graph.nodes(taskId,'fact')).some(f=>String(f.payload.evidence).includes('output.json')));
  assert.equal((await pool.query('SELECT count(*)::int n FROM findings')).rows[0].n,0);
 }finally{
  await host?.dispose();if(mock)await new Promise<void>(r=>mock!.server.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
