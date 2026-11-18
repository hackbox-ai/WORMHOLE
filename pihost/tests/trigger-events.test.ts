/** Actual F12 finding source integration, replacing the old interval simulation.
 * Only task-linked committed graph findings are scheduler input in WORMHOLE. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TriggerScheduler,NotifyDebouncer} from '../src/domains/tasks/scheduler.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';

test('F12 actual on_finding with interval=0: domain commit → graph event → fire → persisted cursor',async()=>{
 const base=loadConfig(),schema='codex_finding_trigger_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema}),fired:string[]=[];
 const scheduler=new TriggerScheduler(pool,'/tmp/trigger-fixture-unused',async(key,msg)=>{fired.push(key+':'+msg);},40);
 try{
  await runMigrations(pool);
  await pool.query("INSERT INTO agent_triggers(agent_key,enabled,interval_sec,on_finding,finding_message) VALUES('reporter',true,0,true,'新发现需要关注')");
  const task=await new TaskService(pool,'/tmp/trigger-fixture-unused',()=>{}).create({name:'finding trigger',goal:'local fixture',queued:true});assert.ok(task.ok);
  await scheduler.initialize();scheduler.start();
  const findings=new FindingsService(pool,'/tmp/trigger-fixture-unused');
  const written=await findings.record({task_id:Number(task.task.id),name:'实际事件发现',vulnclass:'fixture',severity:'high',summary:'实际事件发现'});assert.ok(written.finding_id);
  const end=Date.now()+5000;while(Date.now()<end&&!fired.length)await new Promise(r=>setTimeout(r,20));
  await scheduler.stop();assert.equal(fired.length,1);assert.match(fired[0]!,/reporter:.*新发现需要关注/s);
  const graph=(await pool.query("SELECT id FROM exploration_nodes WHERE kind='finding'")).rows;assert.equal(graph.length,1);
  const saved=(await pool.query("SELECT value FROM scheduler_watermarks WHERE key='last_finding_id'")).rows[0].value;assert.equal(saved,String(graph[0].id));
  assert.equal((await pool.query('SELECT last_fire FROM agent_triggers')).rows[0].last_fire,null,'no interval fired');
 }finally{await scheduler.stop();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
test('F03 notification debouncer consumes one combined round',async()=>{
 const d=new NotifyDebouncer();d.notify();d.notify();assert.equal(await d.settle(80),true);assert.equal(await d.settle(80),false);
});

