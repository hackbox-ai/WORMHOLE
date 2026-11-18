import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskEngine} from '../src/domains/tasks/engine.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';

test('modeling admission survives full primary capacity, pause/resume and recovery; leases protect workspace',async()=>{
 const base=loadConfig(),admin=new Pool({connectionString:base.database.dsn}),schema='model_admission_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-model-slots-'));
 const config={...base,dataDir:dir},dlq=path.join(dir,'dlq');
 let engine:TaskEngine|undefined;
 const until=async(fn:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('admission condition timed out');};
 try{
  await runMigrations(pool);
  const makeEngine=(limit=3)=>{
   const e=new TaskEngine(pool,config,{agents:new AgentsService(pool,dlq),assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:{get:()=>({workers:3,taskConcurrencyEnabled:true,taskConcurrencyLimit:limit,trafficCapture:false}),getRebuildCount:()=>0}});
   // Keep real admission/lease/recovery paths; hold execution without target/model traffic.
   (e as any).ready=async()=>true;(e as any).startDeadlineCoordinator=()=>{};(e as any).startCodeIntel=()=>{};
   (e as any).supervise=async(run:any)=>{
    await pool.query("UPDATE tasks SET status='running',queued=false,first_run_at=COALESCE(first_run_at,now()) WHERE id=$1",[run.taskId]);
    await new Promise<void>(r=>{if(run.abort.signal.aborted)r();else run.abort.signal.addEventListener('abort',()=>r(),{once:true});});
   };return e;
  };
  engine=makeEngine();const tasks=new TaskService(pool,dlq,()=>{}),primary:number[]=[],models:number[]=[];
  for(let i=0;i<4;i++){const t=await tasks.create({name:'primary '+i,queued:true});assert.ok(t.ok);primary.push(Number(t.task.id));}
  for(let i=0;i<4;i++){const t=await tasks.create({name:'model '+i,queued:true});assert.ok(t.ok);models.push(Number(t.task.id));await pool.query("UPDATE tasks SET kind='modeling' WHERE id=$1",[t.task.id]);}
  await engine.pumpQueue();await until(()=>primary.slice(0,3).every(id=>engine!.isRunning(id))&&models.every(id=>engine!.isRunning(id)));
  assert.equal(engine.slots.size,3);assert.equal(engine.isRunning(primary[3]!),false);
  assert.equal(await engine.admitFollowUp(models[0]!),false,'model follow-up does not wait for primary capacity/backlog');
  await pool.query('UPDATE tasks SET paused=true,queued=false WHERE id=$1',[models[0]]);
  engine.pause(models[0]!);await until(()=>!(engine as any).modelingLeases.has(models[0]));
  await pool.query('UPDATE tasks SET paused=false,queued=true WHERE id=$1',[models[0]]);
  await engine.pumpQueue();await until(()=>(engine as any).modelingLeases.has(models[0])&&!(engine as any).runs.get(models[0]).paused);
  assert.equal(engine.slots.size,3);
  const release1=await engine.acquireTaskSession(models[0]!,new AbortController().signal),release2=await engine.acquireTaskSession(models[0]!,new AbortController().signal);
  engine.abort(models[0]!);await engine.drain(models[0]!);
  assert.equal(engine.workspaceBusy(models[0]!),true);release1();assert.equal(engine.workspaceBusy(models[0]!),true);release2();
  assert.equal((engine as any).modelingLeases.has(models[0]),false);
  await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=$1",[models[0]]);
  await pool.query('UPDATE tasks SET paused=true,queued=false WHERE id=$1',[models[1]]);engine.pause(models[1]!);
  await engine.shutdown();engine=makeEngine();await engine.recover();
  await until(()=>primary.slice(0,3).every(id=>engine!.isRunning(id))&&models.slice(2).every(id=>engine!.isRunning(id)));
  assert.equal(engine.isRunning(models[1]!),false,'recovery preserves modeling pause');
  assert.equal(engine.isRunning(primary[3]!),false);assert.equal(engine.slots.size,3);
  await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=$1",[primary[0]]);engine.abort(primary[0]!);await engine.drain(primary[0]!);await engine.pumpQueue();
  await until(()=>engine!.isRunning(primary[3]!));assert.equal(engine.slots.size,3);
  await engine.shutdown();engine=makeEngine(1);await engine.recover();
  await until(()=>models.slice(2).every(id=>engine!.isRunning(id)));
  assert.equal(engine.slots.size,1,'a lower primary limit still allows independent models');
 }finally{await engine?.shutdown();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
