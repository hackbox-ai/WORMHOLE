import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';

test('administrator username changes require a session and current password, retain data and survive restart',async()=>{
 const config=loadConfig(),schema='wormhole_username_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-username-'));
 const auth=new AuthService(pool,authKeyPath(dir));
 const server=createServer((req,res)=>void routeRequest(req,res,{pool,config,auth} as any));
 try{
  await runMigrations(pool);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  async function request(method:string,route:string,body?:unknown,token?:string){
   const r=await fetch(origin+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,body:await r.json() as any};
  }
  const init=await auth.init('original-password-123');assert.ok(init.ok);const token=init.token;
  await pool.query("DELETE FROM app_settings WHERE key='auth.admin_username'");
  assert.equal(await auth.username(),'WORMHOLE');assert.ok((await auth.login('WORMHOLE','original-password-123')).ok);assert.ok((await auth.login('WORMHOLE','original-password-123')).ok);
  const hash=(await pool.query("SELECT value FROM app_settings WHERE key='auth.admin_pass_hash'")).rows[0].value;
  const unauthorized=await request('GET','/api/auth/account');assert.equal(unauthorized.status,401);assert.ok(!('username' in unauthorized.body));
  assert.equal((await request('PATCH','/api/auth/account',{username:'new-admin',current_password:'original-password-123'})).status,401);
  const expired=await auth.signTokenForTest(-1);assert.equal((await request('GET','/api/auth/account',undefined,expired)).status,401);
  assert.equal((await request('PATCH','/api/auth/account',{username:'new-admin',current_password:'wrong-password'},token)).status,400);
  for(const username of ['','a','has space','<script>','x'.repeat(49),'bad'+String.fromCharCode(10)+'name'])assert.equal((await auth.changeUsername(username,'original-password-123')).ok,false);
  assert.equal(await auth.username(),'WORMHOLE');
  const changed=await request('PATCH','/api/auth/account',{username:'审计_admin',current_password:'original-password-123'},token);
  assert.equal(changed.status,200);assert.equal(changed.body.username,'审计_admin');assert.ok(await auth.verifyToken(changed.body.token));assert.ok(await auth.verifyToken(token),'existing sessions remain valid');
  assert.equal(JSON.parse(Buffer.from(changed.body.token.split('.')[1],'base64url').toString()).sub,'审计_admin');
  assert.equal((await auth.login('WORMHOLE','original-password-123')).ok,false);assert.equal((await auth.login('WORMHOLE','original-password-123')).ok,false);assert.ok((await auth.login('审计_admin','original-password-123')).ok);
  assert.equal((await request('GET','/api/auth/account',undefined,token)).body.username,'审计_admin');
  assert.equal((await pool.query("SELECT value FROM app_settings WHERE key='auth.admin_pass_hash'")).rows[0].value,hash);
  const restarted=new AuthService(pool,authKeyPath(dir));assert.equal(await restarted.username(),'审计_admin');assert.ok((await restarted.login('审计_admin','original-password-123')).ok);
  assert.equal((await auth.init('different-password','overwritten-admin')).ok,false);assert.equal(await auth.username(),'审计_admin');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});

test('first setup stores username and password atomically; competing initializations cannot replace the winner',async()=>{
 const config=loadConfig(),schema='wormhole_username_init_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-username-init-'));
 const auth=new AuthService(pool,authKeyPath(dir));
 try{
  await runMigrations(pool);
  assert.equal((await auth.init('valid-password-123','bad username')).ok,false);assert.equal(await auth.initialized(),false);
  const passwords=['password-one-123','password-two-123'],names=['first-admin','second-admin'];
  const results=await Promise.all(names.map((name,i)=>auth.init(passwords[i]!,name)));
  assert.equal(results.filter(r=>r.ok).length,1);
  const winner=results.findIndex(r=>r.ok),loser=1-winner;
  assert.equal(await auth.username(),names[winner]);assert.ok((await auth.login(names[winner]!,passwords[winner]!)).ok);assert.equal((await auth.login(names[loser]!,passwords[loser]!)).ok,false);
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
