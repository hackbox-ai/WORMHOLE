import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';

test('previous shipped test method upgrades and receives workflow resources without overwriting operator edits', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-workflow-seed-'));
  try {
    const skill=path.join(root,'wormhole-test-method');
    await mkdir(skill,{recursive:true});
    await writeFile(path.join(skill,'SKILL.md'),await readFile('tests/fixtures/workflow-method-before.txt'));
    await seedBuiltinSkills(root);
    assert.match(await readFile(path.join(skill,'SKILL.md'),'utf8'),/references\/workflow-analysis\.md/);
    await access(path.join(skill,'scripts/workflow_tools.py'));
    const helper=path.join(skill,'scripts/workflow_tools.py');
    await writeFile(helper,'# operator edited helper');
    const ref=path.join(skill,'references/workflow-analysis.md');
    assert.match(await readFile(ref,'utf8'),/离线/);
    await writeFile(ref,'operator edited workflow reference');
    await seedBuiltinSkills(root);
    assert.equal(await readFile(ref,'utf8'),'operator edited workflow reference');
    assert.equal(await readFile(helper,'utf8'),'# operator edited helper');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('workflow helper does not introduce another Skill grant or host scheduler',async()=>{
  const body=await readFile('builtin-skills/wormhole-test-method/SKILL.md','utf8');
  const reference=await readFile('builtin-skills/wormhole-test-method/references/workflow-analysis.md','utf8');
  assert.match(body,/name: wormhole-test-method/);
  assert.doesNotMatch(reference,/demo-identity-discovery|\/root\//);
  assert.match(reference,/宿主 checkpoint 与探索图/);
});

test('method references stay domain neutral for other systems',async()=>{
  const leak=/demo-identity-discovery|10\.10\.\d+\.\d+|\/root\//;
  for(const name of ['references/auth-session.md','references/js-recon.md','references/exposure-components.md','references/workflow-analysis.md']){
    const text=await readFile('builtin-skills/wormhole-test-method/'+name,'utf8');
    assert.doesNotMatch(text,leak,name);
  }
  const auth=await readFile('builtin-skills/wormhole-test-method/references/auth-session.md','utf8');
  assert.match(auth,/CeWL/);
  assert.match(auth,/节流/);
  const recon=await readFile('builtin-skills/wormhole-test-method/references/js-recon.md','utf8');
  assert.match(recon,/能力链接/);
  const exposure=await readFile('builtin-skills/wormhole-test-method/references/exposure-components.md','utf8');
  assert.match(exposure,/Disallow/);
  assert.match(exposure,/归档\/迁移目录|migration/);
});


test('previous workflow deployment references upgrade while customized helpers remain unchanged',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wormhole-method-ref-upgrade-'));
 try{
  const names=['SKILL.md','references/auth-session.md','references/web-tests.md'];
  for(const name of names){const file=path.join(root,'wormhole-test-method',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,await readFile('tests/fixtures/skill-upgrade-20261116/'+name));}
  await seedBuiltinSkills(root);
  for(const name of names)assert.deepEqual(await readFile(path.join(root,'wormhole-test-method',name)),await readFile('builtin-skills/wormhole-test-method/'+name));
  assert.doesNotMatch(await readFile(path.join(root,'wormhole-test-method/references/exposure-components.md'),'utf8'),/每条 Disallow 都对应一个真实目录/);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('upgrade preserves edited main and auth reference and rejects symlinks at every level',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wormhole-upgrade-guards-'));
 try {
  const skill=path.join(root,'skills','wormhole-test-method');await mkdir(path.join(skill,'references'),{recursive:true});
  await writeFile(path.join(skill,'SKILL.md'),'operator main');await writeFile(path.join(skill,'references/auth-session.md'),'operator auth');
  await seedBuiltinSkills(path.join(root,'skills'));
  assert.equal(await readFile(path.join(skill,'SKILL.md'),'utf8'),'operator main');
  assert.equal(await readFile(path.join(skill,'references/auth-session.md'),'utf8'),'operator auth');
  const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'SKILL.md'),'external');
  const link=path.join(root,'linked');await symlink(outside,link,'dir');await assert.rejects(seedBuiltinSkills(link),/symlink/);
  await rm(skill,{recursive:true});await symlink(outside,skill,'dir');await assert.rejects(seedBuiltinSkills(path.join(root,'skills')),/symlink/);
  assert.equal(await readFile(path.join(outside,'SKILL.md'),'utf8'),'external');
 }finally{await rm(root,{recursive:true,force:true});}
});
