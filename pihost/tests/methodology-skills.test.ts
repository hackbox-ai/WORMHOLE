import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {methodologySkills,methodologyGuidance} from '../src/domains/skills/methodology.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';

test('methodology install is self-contained, keeps edits; migration and runtime routing respect role/revocation',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-method-')),config=loadConfig(),schema='methodology_'+process.pid+'_'+Date.now();
 const admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
 try{
  const installed=await seedBuiltinSkills(dir);for(const name of methodologySkills)assert.ok(installed.includes(name));
  // Every routed on-demand reference actually ships with the bundle.
  for(const name of methodologySkills){
   const root=path.join(dir,name),body=await readFile(path.join(root,'SKILL.md'),'utf8');
   const verify=async(file:string)=>{
    const content=await readFile(file,'utf8');
    assert.doesNotMatch(content,/蒸馏|无界安全|w1th0ut|U-Sec|源包/,'no provenance prose in model-loaded instructions');
    for(const link of content.matchAll(/\$\{SKILL_DIR\}\/([^)\"\s]+)/g))assert.ok((await readFile(path.join(root,link[1]!))).length);
   };
   await verify(path.join(root,'SKILL.md'));
   const refs=path.join(root,'references');
   try{for(const ref of await readdir(refs))if(ref.endsWith('.md'))await verify(path.join(refs,ref));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   assert.ok(!(await readdir(root)).includes('NOTICE.md'));
  }
  const edited=path.join(dir,'wormhole-test-method','SKILL.md');await writeFile(edited,'operator edited method');
  await seedBuiltinSkills(dir);assert.equal(await readFile(edited,'utf8'),'operator edited method');
  await runMigrations(pool);
  const skills=new SkillsService(pool,path.join(dir,'dlq'),dir),agents=new AgentsService(pool,path.join(dir,'dlq'));
  assert.ok((await skills.visible('planner')).some(s=>s.key==='wormhole-test-plan'));
  assert.ok(!(await skills.visible('auto')).some(s=>s.key==='wormhole-test-method'),'Auto grant never leaks worker method');
  assert.ok(!(await skills.visible('reporter')).some(s=>s.key==='wormhole-src-review'),'reporter does not gain execution strategy');
  await agents.putPrompt('planner','operator custom planning prompt');
  const before=(await agents.prompts('planner'))[0];
  const spec=await agents.resolveSessionSpec('planner');assert.ok(spec.systemPrompt.startsWith('operator custom planning prompt'));
  assert.ok(spec.systemPrompt.includes('wormhole-test-plan'));
  assert.equal((await agents.prompts('planner'))[0]!.id,before!.id,'routing does not overwrite prompt versions');
  await pool.query("DELETE FROM agent_visibility WHERE agent_key='planner' AND resource_id='wormhole-test-plan'");
  const sql=await readFile('migrations/0055_methodology_skills.sql','utf8');await pool.query(sql);
  assert.equal((await skills.visible('planner')).some(s=>s.key==='wormhole-test-plan'),false,'repeat seed does not regrant removed visibility');
  assert.equal((await agents.resolveSessionSpec('planner')).systemPrompt,'operator custom planning prompt','revocation removes runtime routing');
  assert.equal(methodologyGuidance('custom_agent',methodologySkills),'','custom roles untouched');
  assert.equal(methodologyGuidance('auto',[]),'','no global Skill instructions without grant');
  const files=await readdir(path.join(dir,'wormhole-test-method'));assert.ok(!files.includes('state.sqlite'));
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});

test('CVSS helper rejects ambiguous vectors and handles changed scope / zero impact / integer roundup',async()=>{
 // The standalone .mjs intentionally needs no installed dependencies.
 const {calculate,roundup}=await import('../builtin-skills/wormhole-finding-report/scripts/cvss31.mjs');
 const cases:[string,number][]=[
  ['AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',9.8],
  ['AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H',9.9],
  ['AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',6.1],
  ['AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N',0],
  ['CVSS:3.1/S:U/AV:N/AC:L/PR:H/UI:N/C:L/I:L/A:N',3.8],
 ];
 for(const [vector,score] of cases)assert.equal(calculate(vector).score,score,vector);
 for(const vector of ['AV:N/AC:L/PR:N/UI:N/S:Q/C:H/I:H/A:H','AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/AV:N','CVSS:4.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H','AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H'])assert.throws(()=>calculate(vector));
 assert.equal(roundup(0.1+0.2),0.3);assert.equal(roundup(4.02),4.1);
});
