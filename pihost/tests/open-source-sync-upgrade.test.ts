import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readdir,readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService} from '../src/auth/service.ts';

test('upgrade from 0.1.0 preserves identity, revoked grants, manual reports and custom triggers',async()=>{
 const config=loadConfig(),schema='sync_upgrade_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-sync-upgrade-'));
 try{
  await pool.query('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')&&f<'0080').sort()){
   await pool.query(await readFile(path.join('migrations',file),'utf8'));await pool.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
  }
  const auth=new AuthService(pool,path.join(dir,'jwt.key'));assert.ok((await auth.init('isolated-fixture-pass','sync_operator')).ok);
  await pool.query("DELETE FROM agent_visibility WHERE agent_key='worker' AND resource_id='wormhole-test-method'");
  const f=(await pool.query("INSERT INTO findings(name,report) VALUES('upgrade fixture','operator report') RETURNING id")).rows[0];
  const trigger=(await pool.query("INSERT INTO agent_triggers(agent_key,enabled,on_tool_call,tool_names,tool_call_message) VALUES('reporter',true,true,'[\"report_finding\"]','operator callback') RETURNING id")).rows[0];
  assert.deepEqual(await runMigrations(pool),['0080_task_resource_cleanup.sql','0081_finding_report_jobs.sql']);
  assert.ok((await auth.login('sync_operator','isolated-fixture-pass')).ok);
  assert.equal((await pool.query("SELECT 1 FROM agent_visibility WHERE agent_key='worker' AND resource_id='wormhole-test-method'")).rowCount,0);
  assert.equal((await pool.query('SELECT report FROM findings WHERE id=$1',[f.id])).rows[0].report,'operator report');
  assert.equal((await pool.query('SELECT count(*)::int n FROM finding_report_jobs')).rows[0].n,0);
  assert.equal((await pool.query('SELECT enabled FROM agent_triggers WHERE id=$1',[trigger.id])).rows[0].enabled,true);
  assert.equal((await pool.query("SELECT enabled FROM agent_triggers WHERE tool_call_message LIKE '刚有一个漏洞被%'")).rows[0].enabled,false);
  assert.deepEqual(await runMigrations(pool),[]);
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
