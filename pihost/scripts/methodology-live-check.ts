import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {methodologySkills} from '../src/domains/skills/methodology.ts';

const base=process.env.WORMHOLE_CHECK_URL??'http://127.0.0.1:18887';
const password=(await readFile('/var/lib/wormhole/admin-creds.txt','utf8')).trim();
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'WORMHOLE',password})});
assert.equal(login.status,200,'operator login');const {token}=await login.json() as {token:string};assert.ok(token);
async function get(route:string){const response=await fetch(base+route,{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200,route);return response.json() as Promise<any>;}
const listing=await get('/api/skills');
for(const name of methodologySkills){const entry=listing.skills.find((s:any)=>s.name===name);assert.ok(entry,'management API shows '+name);assert.ok(entry.description);assert.ok(entry.files.length>0);}
for(const name of methodologySkills){
 const files=await get('/api/skills/'+name+'/files');
 assert.ok(!JSON.stringify(files).includes('NOTICE.md'),'provenance file not exposed in Skill');
 const main=await get('/api/skills/'+name+'/files/SKILL.md');
 assert.doesNotMatch(main.content,/蒸馏|无界安全|w1th0ut|源包/);
}
const concrete=await get('/api/skills/wormhole-test-method/files/references/object-authz.md');
assert.match(concrete.content,/403与404有差异只能证明响应差异/);
const index=await get('/api/skills/wormhole-test-method/files/references/web-tests.md');
assert.equal((index.content.match(/\$\{SKILL_DIR\}\/references\//g)??[]).length,21,'all concrete methods are routed');
const expected:Record<string,string[]>={auto:['wormhole-task-intake'],mainagent:['wormhole-task-intake'],goals:['wormhole-test-plan'],planner:['wormhole-test-plan'],worker:['wormhole-test-method','wormhole-src-review'],pentest:['wormhole-test-method','wormhole-src-review'],reporter:['wormhole-finding-report'],retester:['wormhole-retest']};
const bindings:Record<string,string[]>={};
for(const [agent,names] of Object.entries(expected)){const view=await get('/api/agents/'+agent+'/visibility');for(const name of names)assert.ok(view.skill.includes(name),agent+' '+name);bindings[agent]=view.skill;}
console.log(JSON.stringify({ok:true,skills:listing.skills.filter((s:any)=>methodologySkills.includes(s.name)).map((s:any)=>({name:s.name,files:s.files.length})),bindings},null,2));
