import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {ToolsService} from '../src/domains/tools/service.ts';
import seeds from '../src/domains/tools/business-tool-seeds.json' with {type:'json'};
test('F15 original seed reset covers every builtin, preserves kind/exec/deferred and inserts missing code row',async()=>{
 const config=loadConfig(),schema='codex_tool_reset_'+process.pid+'_'+Date.now(),dir=await mkdtemp(path.join(tmpdir(),'wormhole-tool-reset-')),admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),tools=new ToolsService(pool,path.join(dir,'dlq'));
 try{
  await runMigrations(pool);
  for(const seed of seeds){
   await pool.query("UPDATE tools SET description='USER_EDIT',schema='{}',agents='[]',enabled=FALSE,deferred=TRUE,exec='{\"keep\":\"user\"}' WHERE key=$1",[seed.Key]);
   assert.equal(await tools.reset(seed.Key),true,seed.Key);
   const row=(await pool.query('SELECT * FROM tools WHERE key=$1',[seed.Key])).rows[0];assert.equal(row.description,seed.Desc);assert.deepEqual(row.schema,seed.Schema);assert.deepEqual(row.agents,seed.Agents);assert.equal(row.enabled,true);assert.equal(row.deferred,true,'source reset does not touch deferred');assert.deepEqual(row.exec,{keep:'user'},'source reset does not touch exec');
  }
  await pool.query("DELETE FROM tools WHERE key='graph_overview'");assert.equal(await tools.reset('graph_overview'),true,'source reset upserts a missing builtin row');assert.equal((await pool.query("SELECT system FROM tools WHERE key='graph_overview'")).rows[0].system,true);
  assert.equal(await tools.reset('unknown_custom'),false);assert.equal(await tools.removeCustom('graph_overview'),true);assert.ok((await pool.query("SELECT 1 FROM tools WHERE key='graph_overview'")).rowCount,'custom delete acknowledges but retains builtin');
  assert.equal(await tools.removeCustom('unknown_custom'),true,'source delete is idempotent');
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
