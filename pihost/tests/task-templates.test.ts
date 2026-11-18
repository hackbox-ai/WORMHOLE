import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {routeTaskTemplates} from '../src/api/task-templates.ts';

test('legacy template migration and HTTP create/edit/list preserve complete task form fields',async()=>{
 const config=loadConfig(),admin=new Pool({connectionString:config.database.dsn}),schema='templates_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
 const server=createServer((req,res)=>{void routeTaskTemplates(req,res,new URL(req.url!,'http://localhost'),pool,(r,s,v)=>{r.writeHead(s,{'content-type':'application/json'});r.end(JSON.stringify(v));});});
 try{
  await runMigrations(pool);
  await pool.query('ALTER TABLE task_templates DROP COLUMN description,DROP COLUMN category_id,DROP COLUMN intercept_rules,DROP COLUMN updated_at');
  const category=Number((await pool.query("INSERT INTO task_categories(name) VALUES('legacy category') RETURNING id")).rows[0].id);
  await pool.query("INSERT INTO task_templates(name,goal,category) VALUES('legacy template','legacy goal','legacy category')");
  await pool.query(await readFile('migrations/0076_task_template_fields.sql','utf8'));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/task-templates';
  const call=async(path='',method='GET',body?:unknown)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  const legacy=(await call()).body.templates[0];
  assert.equal(typeof legacy.id,'number');assert.equal(legacy.description,'');assert.equal(legacy.goal,'legacy goal');assert.equal(legacy.category_id,category);assert.deepEqual(legacy.intercept_rules,[]);
  const input={name:'roundtrip',description:'saved description',goal:'saved goal',category_id:category,intercept_rules:[{action:'allow',kind:'exact_domain',pattern:'example.org',note:'controlled rule',enabled:true}]};
  const created=await call('','POST',input);assert.equal(created.status,200);
  for(const [key,value] of Object.entries(input))assert.deepEqual(created.body[key],value);
  const id=created.body.id;
  const edited=await call('/'+id,'PATCH',{description:'edited description'});assert.equal(edited.status,200);
  assert.equal(edited.body.description,'edited description');assert.deepEqual(edited.body.intercept_rules,input.intercept_rules);assert.equal(edited.body.goal,input.goal);
  const listed=(await call()).body.templates.find((t:any)=>t.id===id);assert.deepEqual(listed,edited.body);
  assert.equal((await call('/'+id,'PATCH',{intercept_rules:[{kind:'invalid',pattern:'x'}]})).status,400);
  assert.equal((await call('/'+id,'PATCH',{category_id:99999999})).status,400);
  assert.equal((await call('/99999999','PATCH',{goal:'missing'})).status,404);
  assert.equal((await call('/'+id,'PATCH',{name:'legacy template'})).status,409);
  await call('/'+id,'PATCH',{category_id:null,intercept_rules:[]});
  assert.equal((await call('/'+id,'DELETE')).status,200);
  assert.equal((await call()).body.templates.length,1);
 }finally{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 }
});
