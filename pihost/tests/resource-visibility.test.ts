import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService} from '../src/auth/service.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {seedBuiltinSkills} from '../src/domains/skills/seed-builtin.ts';
import {routeRequest} from '../src/api/server.ts';
test('authenticated resource grants persist for stable builtin/custom keys; malformed and missing resources cannot mutate grants',async()=>{
 const config=loadConfig(),schema='resource_grants_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-grants-'));
 const auth=new AuthService(pool,path.join(dir,'jwt.key')),skills=new SkillsService(pool,path.join(dir,'dlq'),path.join(dir,'skills'));
 const ctx={pool,auth,skills} as any,server=createServer((req,res)=>void routeRequest(req,res,ctx));
 try{
  await runMigrations(pool);await seedBuiltinSkills(path.join(dir,'skills'));const init=await auth.init('fixture-password');assert.ok(init.ok);
  await pool.query("INSERT INTO agents(key,name) VALUES('custom_grant','Custom grant')");
  const mcp=(await pool.query("INSERT INTO mcp_servers(name,transport) VALUES('grant fixture','stdio') RETURNING id")).rows[0];
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as any).port;
  const post=(url:string,body:any,authenticated=true)=>fetch(origin+'/api/visibility'+url,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+init.token}:{})},body:JSON.stringify(body)});
  for(const key of ['worker','custom_grant'])for(const [url,resource] of [['/skill/toggle',{skill_name:'wormhole-test-method'}],['/toggle',{kind:'mcp',resource_id:Number(mcp.id)}]] as const){
   for(const visible of [true,true,false,false]){
    assert.equal((await post(url,{agent_id:key,...resource,visible})).status,200);
    const kind=url.includes('skill')?'skill':'mcp',id=kind==='skill'?'wormhole-test-method':String(mcp.id);
    assert.equal((await pool.query('SELECT 1 FROM agent_visibility WHERE agent_key=$1 AND resource_kind=$2 AND resource_id=$3',[key,kind,id])).rowCount,visible?1:0);
   }
  }
  const body={agent_id:'worker',skill_name:'wormhole-test-method',visible:true};
  assert.equal((await post('/skill/toggle',body,false)).status,401);
  assert.equal((await post('/skill/toggle',{...body,visible:'false'})).status,400);
  assert.equal((await post('/skill/toggle',{...body,agent_id:'4'})).status,404);
  assert.equal((await post('/skill/toggle',{...body,skill_name:'absent'})).status,404);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
