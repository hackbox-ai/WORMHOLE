import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {registerTool} from '../src/domains/tools/gate.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {WorkerHandoffs,HANDOFF_TOOLS} from '../src/domains/tasks/handoff.ts';
import {ArtifactStore} from '../src/storage/artifacts.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

test('native worker externalizes a large result and a fresh worker resumes from handoff without replaying the side effect',async()=>{
  const base=loadConfig(),schema=`wormhole_storage_native_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-storage-native-'));
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});let host:HostedSession|undefined,effects=0;
  const mock=await startMockAnthropic(0,{marker:'FINISHED',tool:body=>{
    const text=JSON.stringify(body.messages);return text.includes('RESUME_HANDOFF')||text.includes('tool_result')?undefined:{name:'storage_probe',input:{}};
  }});
  try{
    await runMigrations(pool);const agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,'{"providers":{}}');
    const config={...base,dataDir:dir,storage:{enabled:false,workerSessionBytes:65536},pi:{...base.pi,agentDir,modelsPath}};
    const supplier='http://127.0.0.1:'+(mock.server.address() as {port:number}).port;
    await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('storage fixture','anthropic','mock-1',$1,'fixture',true)",[supplier]);
    await pool.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key='worker'");
    const taskId=Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('storage native fixture','continue without duplicate effect','running') RETURNING id")).rows[0].id),graph=new ExplorationService(pool);await graph.ensure(taskId);
    const intentId=await graph.addIntent(taskId,{summary:'local controlled effect'}),businessId=`task-${taskId}-intent-${intentId}`,handoffs=new WorkerHandoffs(pool,dir);handoffs.register();
    const large='fixture content '.repeat(100000)+'TAIL_CRITICAL_EVIDENCE';
    registerTool({key:'storage_probe',description:'local fixture effect',params:{},required:[],schema:{type:'object',properties:{}},execute:async()=>{effects++;return large;}});
    const tools=await assembleTools(pool,['storage_probe',...HANDOFF_TOOLS],{businessKind:'worker',businessId,taskId,intentId,agentKey:'worker',canExecute:async()=>true},{rules:[]});
    const create=()=>createHostedSession(pool,config,{kind:'worker',businessId,systemPrompt:'Use local fixture tools. Resume from the structured checkpoint.',customTools:tools,activity:{taskId,nodeId:intentId,worker:'worker'}});
    host=await create();await host.session.prompt('OLD_CONTEXT_MARKER '+('x'.repeat(100000)));await host.flushEvents();await host.dispose();host=undefined;
    assert.equal(effects,1);assert.equal(mock.state.calls.length,2);const second=JSON.stringify(mock.state.calls[1]!.body);assert.ok(second.includes('read_worker_artifact'));assert.ok(!second.includes('TAIL_CRITICAL_EVIDENCE'));
    const refs=(await pool.query('SELECT hash,layout FROM storage_artifacts WHERE task_id=$1',[taskId])).rows;assert.equal(refs.length,1);assert.equal(refs[0].layout,'frames-v2');
    const store=new ArtifactStore(pool,dir),page=await store.read(taskId,refs[0].hash,JSON.stringify({content:[{type:'text',text:large}],details:{}}).length-100,200);
    assert.ok(page.text.includes('TAIL_CRITICAL_EVIDENCE'));
    await handoffs.save(taskId,intentId,{progress:'local effect completed',next_step:'inspect saved artifact; do not run storage_probe again',artifact:refs[0].hash});
    host=await create();assert.ok(!JSON.stringify(host.session.messages).includes('OLD_CONTEXT_MARKER'),'large old checkpoint is not loaded into the new worker');
    await host.session.prompt('RESUME_HANDOFF '+JSON.stringify(await handoffs.packet(taskId,intentId)));await host.flushEvents();await host.dispose();host=undefined;
    assert.equal(effects,1);assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('do not run storage_probe again'));
    assert.equal((await readdir(path.join(dir,'pi-sessions','worker-'+businessId))).filter(name=>name.endsWith('.jsonl')).length,2);
  }finally{await host?.dispose();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(resolve=>mock.server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
