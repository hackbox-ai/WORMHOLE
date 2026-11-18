/** Refresh known shipped content; preserve user edits and current permissions. */
import {createHash} from 'node:crypto';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {methodologySkills} from '../src/domains/skills/methodology.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';

const config=loadConfig(),root=path.join(config.pi.agentDir,'skills');
const backup=path.join(config.dataDir,'methodology-evidence','before-v2');
await mkdir(backup,{recursive:true,mode:0o700});
for(const name of methodologySkills){
 for(const file of ['SKILL.md','NOTICE.md']){
  try{await copyFile(path.join(root,name,file),path.join(backup,name+'-'+file),1);}
  catch(error){if(!['ENOENT','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 }
}
await seedBuiltinSkills(root);
const status=[];
for(const name of methodologySkills){
 const live=await readFile(path.join(root,name,'SKILL.md'));
 const bundled=await readFile(path.join(import.meta.dirname,'../builtin-skills',name,'SKILL.md'));
 status.push({name,bundled_current:live.equals(bundled),sha256:createHash('sha256').update(live).digest('hex')});
}
await writeFile(path.join(config.dataDir,'methodology-evidence','upgrade-v2.json'),JSON.stringify({ok:true,skills:status},null,2));
console.log(JSON.stringify({ok:true,skills:status},null,2));
