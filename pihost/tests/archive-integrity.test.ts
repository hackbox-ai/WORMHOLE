import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskArchives} from '../src/domains/tasks/archives.ts';
const exec=promisify(execFile);

test('F03 archive integrity: graph and approval cascade rows survive; injected compaction/restore failures roll back without false success',async()=>{
 const base=loadConfig(),schema=`codex_archive_integrity_${process.pid}_${Date.now()}`;
 const admin=new Pool({connectionString:base.database.dsn}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-archive-integrity-'));
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
 const archive=new TaskArchives(pool,dir);
 try{
  await runMigrations(pool);
  const exp=(await pool.query("INSERT INTO explorations(goal) VALUES('archive fixture') RETURNING id")).rows[0].id;
  const task=(await pool.query("INSERT INTO tasks(name,goal,status,exploration_id) VALUES('full graph','g','done',$1) RETURNING id",[exp])).rows[0].id;
  const a=(await pool.query("INSERT INTO exploration_nodes(exploration_id,task_id,kind,title,state,payload) VALUES($1,$2,'intent','i','done','{\"nested\":[1,2]}') RETURNING id",[exp,task])).rows[0].id;
  const b=(await pool.query("INSERT INTO exploration_nodes(exploration_id,task_id,kind,title,state) VALUES($1,$2,'fact','f','confirmed') RETURNING id",[exp,task])).rows[0].id;
  const asset=(await pool.query("INSERT INTO assets(type,domain,value,task_ids) VALUES('subdomain','archive.example','archive.example',$1::bigint[]) RETURNING id",[[task]])).rows[0].id;
  await pool.query("INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,'yields',$3)",[exp,a,b]);
  await pool.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)',[b,asset]);
  const call=(await pool.query("INSERT INTO tool_calls(business_kind,business_id,run_id,tool_key,params) VALUES('worker','fixture',$1,'fixture','{\"values\":[1,2]}') RETURNING id",[`task-${task}`])).rows[0].id;
  await pool.query("INSERT INTO tool_approvals(tool_call_id,status,reason) VALUES($1,'executed','retain history')",[call]);
  async function graph(){return {nodes:(await pool.query('SELECT row_to_json(t) AS row FROM exploration_nodes t WHERE task_id=$1 ORDER BY id',[task])).rows.map(r=>r.row),edges:(await pool.query('SELECT row_to_json(t) AS row FROM exploration_edges t WHERE exploration_id=$1',[exp])).rows.map(r=>r.row),anchors:(await pool.query('SELECT row_to_json(t) AS row FROM exploration_anchors t WHERE node_id=$1',[b])).rows.map(r=>r.row),approvals:(await pool.query('SELECT row_to_json(t) AS row FROM tool_approvals t WHERE tool_call_id=$1',[call])).rows.map(r=>r.row)};}
  const before=await graph();
  const first=await archive.queue(Number(task));
  // Abort after the first destructive statement: all hot rows must survive.
  await pool.query("CREATE FUNCTION fail_archive_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected compact failure'; END $$; CREATE TRIGGER archive_fault BEFORE DELETE ON llm_usage FOR EACH STATEMENT EXECUTE FUNCTION fail_archive_usage()");
  await assert.rejects(archive.runOne(),/injected compact failure/);
  assert.deepEqual(await graph(),before);
  assert.equal((await pool.query('SELECT archived FROM tasks WHERE id=$1',[task])).rows[0].archived,false);
  assert.equal((await archive.get(Number(first.id)))?.state,'archive_failed');
  await pool.query('DROP TRIGGER archive_fault ON llm_usage; DROP FUNCTION fail_archive_usage()');
  await archive.queue(Number(task));await archive.runOne();
  const archived=(await pool.query('SELECT * FROM task_archives WHERE id=$1',[first.id])).rows[0];
  assert.equal(archived.state,'ready');assert.equal((await graph()).nodes.length,0);assert.equal((await graph()).approvals.length,0);
  const bytes=await readFile(archived.archive_path);assert.ok(bytes.length>0);
  // Tamper a field type, recompute checksum: the typed row insert must fail atomically.
  const extracted=path.join(dir,'fixture-package');await mkdir(extracted);await exec('tar',['-xzf',archived.archive_path,'-C',extracted]);
  const nodes=JSON.parse(await readFile(path.join(extracted,'exploration_nodes.json'),'utf8'));nodes[1].task_id='not-an-integer';await writeFile(path.join(extracted,'exploration_nodes.json'),JSON.stringify(nodes));
  await exec('tar',['-czf',archived.archive_path,'-C',extracted,'.']);
  const {createHash}=await import('node:crypto');await pool.query('UPDATE task_archives SET sha256=$2 WHERE id=$1',[first.id,createHash('sha256').update(await readFile(archived.archive_path)).digest('hex')]);
  await archive.queueRestore(Number(first.id));await assert.rejects(archive.runOne(),/invalid input syntax/);
  assert.equal((await archive.get(Number(first.id)))?.state,'restore_failed');assert.equal((await graph()).nodes.length,0);
  assert.equal((await pool.query('SELECT archived FROM tasks WHERE id=$1',[task])).rows[0].archived,true);
  await readFile(archived.archive_path); // Retry material must remain on failure.
  await writeFile(archived.archive_path,bytes);await pool.query('UPDATE task_archives SET sha256=$2 WHERE id=$1',[first.id,archived.sha256]);
  await archive.queueRestore(Number(first.id));await archive.runOne();assert.deepEqual(await graph(),before);
  assert.equal(await archive.get(Number(first.id)),null,'original completion consumes metadata');
  await assert.rejects(readFile(archived.archive_path),{code:'ENOENT'});
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
