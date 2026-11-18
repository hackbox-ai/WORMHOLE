import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {vulnIntelGuidance} from '../src/domains/skills/vuln-intel.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {IntelClient} from '../src/domains/intel/client.ts';
import {seedIntelTools,registerIntelTools} from '../src/domains/intel/tools.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

test('intelligence routing belongs to granted workers and leaves other roles untouched',()=>{
 assert.equal(vulnIntelGuidance('worker',[]),'');
 for(const role of ['planner','auto','reporter','custom'])assert.equal(vulnIntelGuidance(role,['wormhole-vuln-intel']),'');
 assert.match(vulnIntelGuidance('worker',['wormhole-vuln-intel']),/Skill\(name="wormhole-vuln-intel"\)/);
 assert.match(vulnIntelGuidance('pentest',['wormhole-vuln-intel']),/record_fact/);
});

test('native Worker loads intelligence Skill, queries OSV and writes task evidence; grant revocation survives',async()=>{
 const base=loadConfig(),schema='intel_skill_'+process.pid+'_'+Date.now();
 const admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-intel-')),skillRoot=path.join(dir,'agent/skills'),dlq=path.join(dir,'dlq');
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};
 const fetchOriginal=globalThis.fetch;
 let upstreamCalls=0;
 let mock:Awaited<ReturnType<typeof startMockAnthropic>>|undefined;
 let host:Awaited<ReturnType<typeof createHostedSession>>|undefined;
 try{
  await runMigrations(pool);await seedBuiltinSkills(skillRoot);await mkdir(config.pi.agentDir,{recursive:true});
  const installed=path.join(skillRoot,'wormhole-vuln-intel/SKILL.md');
  const body=await readFile(installed,'utf8');assert.match(body,/hunt_source_ids/);
  await writeFile(installed,'---\nname: wormhole-vuln-intel\ndescription: operator override\n---\noperator instructions');
  await seedBuiltinSkills(skillRoot);assert.match(await readFile(installed,'utf8'),/operator instructions/);
  await writeFile(installed,body);
  await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','skill','wormhole-vuln-intel') ON CONFLICT DO NOTHING");
  const agents=new AgentsService(pool,dlq),skills=new SkillsService(pool,dlq,skillRoot),mcp=new McpService(pool,dlq);
  await agents.putPrompt('worker','Execute the assigned intent using available tools.');
  const promptVersion=(await agents.prompts('worker'))[0]!.id;
  const spec=await agents.resolveSessionSpec('worker');assert.match(spec.systemPrompt,/wormhole-vuln-intel/);
  const created=await new TaskService(pool,dlq,()=>{}).create({name:'intel fixture',goal:'Review package evidence',queued:true});
  assert.ok(created.ok);const taskId=Number(created.task.id);
  const graph=new ExplorationService(pool);await graph.ensure(taskId);
  const intentId=await graph.addIntent(taskId,{summary:'Review lodash 4.17.15 package vulnerability conditions'});
  registerGraphTools(pool,graph,()=>{});
  const client=new IntelClient(pool);await seedIntelTools(client,pool);registerIntelTools(client);
  globalThis.fetch=async(input,init)=>{
   if(String(input)==='https://api.osv.dev/v1/query'){
    upstreamCalls++;assert.deepEqual(JSON.parse(String(init?.body)),{package:{name:'lodash',ecosystem:'npm'},version:'4.17.15'});
    return new Response(JSON.stringify({vulns:[{id:'GHSA-fixture',aliases:['CVE-2021-23337'],summary:'Fixture advisory',references:[{type:'ADVISORY',url:'https://example.org/advisory'}],affected:[{package:{name:'lodash',ecosystem:'npm'},ranges:[{type:'SEMVER',events:[{introduced:'0'},{fixed:'4.17.21'}]}]}]}]}),{status:200,headers:{'content-type':'application/json'}});
   }
   return fetchOriginal(input,init);
  };
  mock=await startMockAnthropic(0,{tool:(_body,n)=>[
   {name:'Skill',input:{name:'wormhole-vuln-intel'}},
   {name:'osv_lookup',input:{name:'lodash',version:'4.17.15',ecosystem:'npm'}},
   {name:'osv_lookup',input:{name:'lodash',version:'4.17.15',ecosystem:'npm'}},
   {name:'record_fact',input:{summary:'Public advisory candidate; target impact unverified',evidence:'OSV GHSA-fixture / CVE-2021-23337; https://example.org/advisory; package supplied by current intent, no exploitation or confirmed finding',confidence:'candidate'}}
  ][n-1]});
  const port=(mock.server.address() as {port:number}).port,llm=new LlmService(pool,dlq,config.pi.modelsPath);
  const profile=await llm.createProfile({name:'intel mock',format:'anthropic',model:'mock-1',base_url:'http://127.0.0.1:'+port,api_key:'fixture'});assert.ok(profile.ok);
  await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
  config.pi.provider='profile-'+profile.profile!.id;config.pi.modelId='mock-1';
  const ctx={businessKind:'worker',businessId:'task-'+taskId+'-intent-'+intentId,agentKey:'worker',taskId,intentId};
  const augmentation=await augmentSession(pool,mcp,skills,ctx,{});
  const tools=bindAugmentation([...await assembleTools(pool,['osv_lookup','record_fact'],ctx,{}),...augmentation.tools],augmentation);
  host=await createHostedSession(pool,config,{kind:'worker',businessId:ctx.businessId,systemPrompt:spec.systemPrompt,customTools:tools,activity:{taskId,nodeId:intentId,worker:'intel-fixture'}});
  await host.session.prompt('Existing task package evidence: lodash 4.17.15 npm. Local PoC conditions incomplete; review public advisory and record uncertainty.');await host.flushEvents();
  assert.equal(upstreamCalls,1,'identical queries use public intelligence cache');
  const usage=await pool.query("SELECT 1 FROM skill_usage WHERE business_id=$1 AND skill='wormhole-vuln-intel'",[ctx.businessId]);assert.equal(usage.rowCount,1);
  const calls=(await pool.query('SELECT tool_key,is_error FROM tool_calls WHERE business_id=$1 ORDER BY id',[ctx.businessId])).rows;
  assert.ok(calls.some(c=>c.tool_key==='osv_lookup'&&!c.is_error));
  assert.ok(calls.some(c=>c.tool_key==='record_fact'&&!c.is_error));
  const facts=await graph.nodes(taskId,'fact');assert.ok(facts.some(f=>String(f.payload.evidence).includes('GHSA-fixture')));
  assert.equal((await pool.query('SELECT count(*)::int n FROM findings')).rows[0].n,0);
  assert.ok(mock.state.calls.slice(1).some(c=>JSON.stringify(c.body).includes('hunt_source_ids')),'loaded Skill reaches subsequent provider input');
  await pool.query("DELETE FROM agent_visibility WHERE agent_key='worker' AND resource_kind='skill' AND resource_id='wormhole-vuln-intel'");
  assert.doesNotMatch((await agents.resolveSessionSpec('worker')).systemPrompt,/wormhole-vuln-intel/);
  assert.equal((await agents.prompts('worker'))[0]!.id,promptVersion,'runtime guidance never rewrites editable prompt versions');
 }finally{
  globalThis.fetch=fetchOriginal;await host?.dispose();
  if(mock)await new Promise<void>(resolve=>mock!.server.close(()=>resolve()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
