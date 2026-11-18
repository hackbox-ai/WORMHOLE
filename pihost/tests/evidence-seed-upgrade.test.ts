import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import metadata from '../src/domains/findings/evidence-metadata.json' with {type:'json'};
test('F04 evidence seed precedence: fresh install and provable 0051 upgrade preserve edited/disabled bindings',async()=>{
 const config=loadConfig(),schema='codex_evidence_upgrade_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
 try{await runMigrations(pool);
  for(const seed of metadata)assert.deepEqual((await pool.query('SELECT agents FROM tools WHERE key=$1',[seed.key])).rows[0].agents,seed.agents,'fresh '+seed.key);
  await pool.query("UPDATE tools t SET agents='[\"auto\"]',description=d.description,schema=d.schema,enabled=true,created_at=m.applied_at,updated_at=m.applied_at FROM tool_defaults d,schema_migrations m WHERE t.key='get_finding_traffic' AND d.key=t.key AND m.name='0051_platform_tool_defaults.sql'");
  await pool.query("UPDATE tools SET agents='[\"auto\"]',updated_at=now() WHERE key='update_finding_report';UPDATE tools SET agents='[]',enabled=false WHERE key='bind_finding_traffic'");
  const edited=(await pool.query("SELECT key,agents,enabled,updated_at FROM tools WHERE key IN('update_finding_report','bind_finding_traffic') ORDER BY key")).rows;
  const sql=await readFile('migrations/0052_evidence_seed_precedence.sql','utf8');await pool.query(sql);
  assert.deepEqual((await pool.query("SELECT agents FROM tools WHERE key='get_finding_traffic'")).rows[0].agents,metadata.find(s=>s.key==='get_finding_traffic')!.agents);
  assert.deepEqual((await pool.query("SELECT key,agents,enabled,updated_at FROM tools WHERE key IN('update_finding_report','bind_finding_traffic') ORDER BY key")).rows,edited,'deliberate auto-only/disabled user edits are never regranted');
  const first=(await pool.query("SELECT agents,updated_at FROM tools WHERE key='get_finding_traffic'")).rows[0];await pool.query(sql);assert.deepEqual((await pool.query("SELECT agents,updated_at FROM tools WHERE key='get_finding_traffic'")).rows[0],first,'repair idempotent');
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
