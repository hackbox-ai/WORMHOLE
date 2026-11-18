/** Real configured model, controlled loopback target, isolated SQL schema and
 * session/files. Never runs a scan against operator tasks or external targets. */
import assert from 'node:assert/strict';
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
import {TaskService} from '../src/domains/tasks/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {augmentSession,bindAugmentation} from '../src/domains/mcp/session.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import type {GateOptions} from '../src/domains/tools/gate.ts';

const base=loadConfig(),schema='method_real_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
const profile=(await admin.query('SELECT * FROM llm_profiles WHERE api_key<>\'\' ORDER BY is_default DESC,id LIMIT 1')).rows[0];
if(!profile){await admin.end();throw new Error('No configured model; real smoke not run');}
await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-method-real-')),agentDir=path.join(dir,'agent'),modelsPath=path.join(agentDir,'models.json');
await mkdir(agentDir);await writeFile(modelsPath,JSON.stringify({providers:{}}));
const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}},dlq=path.join(dir,'dlq'),skillRoot=path.join(agentDir,'skills');
const skills=new SkillsService(pool,dlq,skillRoot),mcp=new McpService(pool,dlq),agents=new AgentsService(pool,dlq);
let active:HostedSession|undefined,budgetTimer:ReturnType<typeof setTimeout>|undefined;const hits:string[]=[];
const receiver=createServer((req,res)=>{const p=(req.url??'').split('?')[0]!;hits.push(p);
 const code=p==='/own'?200:p==='/other'?403:404;
 res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(code===200?{owner:'A',object:'own',fixture:true}:{error:code===403?'forbidden':'not found',fixture:true}));
});
try{
 await runMigrations(pool);await seedBuiltinSkills(skillRoot);
 // Copy only this fixture's selected provider fields to its own schema.
 const cols=['name','format','model','base_url','api_key','proxy'];const vals=cols.map(k=>profile[k]);
 const p=(await pool.query('INSERT INTO llm_profiles('+cols.join(',')+',is_default) VALUES('+cols.map((_,i)=>'$'+(i+1)).join(',')+',TRUE) RETURNING id',vals)).rows[0];
 await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const target='http://127.0.0.1:'+(receiver.address() as {port:number}).port;
 const task=await new TaskService(pool,dlq,()=>{}).create({goal:"Verify the access difference of three local test objects, zero vulnerability is a legal result",llm_profile_id:Number(p.id)});assert.ok(task.ok);
 const taskId=Number(task.task.id),graph=new ExplorationService(pool),intentId=await graph.addIntent(taskId,{summary:'only own/other/missing local fixture'});
 registerGraphTools(pool,graph,()=>{});registerBusinessTools({assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq)});
 const ctx={agentKey:'worker',businessKind:'worker',businessId:'real-method-'+Date.now(),taskId,intentId};
 const allowed=new Set(['Skill','Read','http_request','record_fact']);
 // Apply the existing final gate to ALL other operation names and URLs.
 await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
  [JSON.stringify(['Skill','Read','http_request','record_fact','Bash','Write','Edit','MultiEdit','Glob','Grep','TaskList','TaskStop','TaskOutput','report_finding'])]);
 const gate:GateOptions={rules:[
  {toolPattern:{test:(name:string)=>!allowed.has(name)},action:'block',reason:'controlled fixture exposes only Skill/Read/http_request/record_fact'},
  {toolPattern:/^http_request$/,paramPattern:{test:(raw:string)=>{try{return ![target+'/own',target+'/other',target+'/missing'].includes(JSON.parse(raw).url);}catch{return true;}}},action:'block',reason:'only three exact local fixture URLs allowed'},
  {toolPattern:/^Read$/,paramPattern:{test:(raw:string)=>{try{const file=path.resolve(String(JSON.parse(raw).file_path)),root=path.resolve(skillRoot)+path.sep;return !file.startsWith(root);}catch{return true;}}},action:'block',reason:'read only installed method references'},
 ]};
 const augmentation=await augmentSession(pool,mcp,skills,ctx,gate);
 const tools=bindAugmentation([...(await assembleTools(pool,['http_request','record_fact','report_finding'],ctx,gate)),...augmentation.tools],augmentation);
 const spec=await agents.resolveSessionSpec('worker');
 await pool.query("UPDATE agents SET run_seconds=150,max_turns=16 WHERE key='worker'");
 active=await createHostedSession(pool,config,{kind:'chat',businessId:ctx.businessId,cwd:dir,systemPrompt:spec.systemPrompt,provider:spec.provider,modelId:spec.modelId,profileBinding:true,customTools:tools});
 budgetTimer=setTimeout(()=>void active?.session.abort(),155_000);budgetTimer.unref();
 await active.session.prompt("This is the only controlled native method verification task allowed. First load the applicable method according to the configured test method skill, read the special index, and then select and read the object authorization special steps. Only allowed for "+target+'/own、'+target+'/other、'+target+"/missing sends one GET each, and the three URLs are the legal own objects of test identity A, other identity objects, and random non-existent objects. The identity of this fixture has been fixed to A, without B login credentials, do not make up a second identity baseline. The maximum of three HTTP requests is a budget for this fixture, not a general task limit. No coding variants, no stretching targets, no running Bash. Observe real results and use record_fact to write back hypotheses, baselines, negative controls, results, and limitations. Report_finding must not be reported without true out of bounds. Then it stops.");
 await active.flushEvents();if(active.modelFailure)throw new Error(active.modelFailure);
 const results=active.session.messages.filter((m:any)=>m.role==='toolResult') as any[];
 assert.ok(results.some(m=>m.toolName==='Skill'&&!m.isError),'real model selects and loads Skill');
 assert.ok(results.some(m=>m.toolName==='Read'&&!m.isError&&JSON.stringify(m.content).includes("Object and tenant authorization matrix")),'real model reads concrete authz method');
 const usage=(await pool.query("SELECT count(*)::int n FROM skill_usage WHERE business_id=$1 AND skill='wormhole-test-method'",[ctx.businessId])).rows[0].n;assert.ok(usage>0);
 assert.deepEqual([...hits].sort(),['/missing','/other','/own']);assert.equal(hits.length,3,'bounded real requests');
 const facts=(await pool.query("SELECT payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND origin='worker'",[taskId])).rows;assert.ok(facts.length>0,'real model persists fact');
 assert.equal((await pool.query('SELECT count(*)::int n FROM findings WHERE task_id=$1',[taskId])).rows[0].n,0,'negative controls do not manufacture findings');
 console.log(JSON.stringify({ok:true,provider_format:profile.format,model:profile.model,skill_usage:usage,target_requests:hits,tool_results:results.map(m=>({name:m.toolName,error:!!m.isError})),facts:facts.map(f=>f.payload),findings:0},null,2));
}finally{
 clearTimeout(budgetTimer);
 await active?.dispose();resetPiRuntime();receiver.closeAllConnections();await new Promise<void>(r=>receiver.close(()=>r()));
 await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
}
