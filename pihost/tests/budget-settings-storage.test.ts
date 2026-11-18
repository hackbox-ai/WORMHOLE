import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {SettingsService} from '../src/domains/settings/service.ts';
import {EfficiencySupervisor,efficiencyDecision,efficiencyOptions} from '../src/domains/tasks/efficiency.ts';
import {durableSessionEvent} from '../src/pi/event-payload.ts';
import {EventBatchWriter} from '../src/events/batch-writer.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {projectActivity} from '../src/domains/activity/projector.ts';
import {createServer} from 'node:http';
import {streamEvents} from '../src/api/events.ts';

const base=loadConfig(),schema='wormhole_budget_storage_'+process.pid+'_'+Date.now();
const admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-budget-storage-'));
const settings=new SettingsService(pool,path.join(dir,'dlq'));
after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
async function task(){const id=Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('local budget fixture','read fixture','running') RETURNING id")).rows[0].id);await new ExplorationService(pool).ensure(id);return id;}

test('settings persist partial budgets, zero is unlimited, malformed patches never partially change budgets',async()=>{
 const defaults=(await settings.payload()).task_efficiency as any;
 assert.equal(defaults.maxActiveSeconds,0);assert.equal(defaults.maxModelCalls,0);assert.equal(defaults.maxTotalTokens,0);
 const patch={maxActiveSeconds:7200,maxModelCalls:23,maxTotalTokens:50000,maxOutputTokens:10000,enabled:false,plannerMaxTurns:18,plannerRunSeconds:800};
 assert.equal((await settings.apply({task_efficiency:patch})).ok,true);
 const supervisor=new EfficiencySupervisor(pool);await supervisor.refresh();
 assert.equal(supervisor.options.maxModelCalls,23);assert.equal(supervisor.options.enabled,false);
 const s:any={active_seconds:0,base_calls:0,base_output:0,base_total:0,empty_rounds:0,last_progress_at:new Date()};
 const sample:any={progress:'',revision:'',active:1,approvals:0,calls:23,output:0,total:0};
 assert.equal(efficiencyDecision(s,sample,supervisor.options,Date.now()),'model_call_budget','hard budgets remain active with idle protection off');
 assert.equal(efficiencyDecision(s,{...sample,calls:0,total:50000},supervisor.options,Date.now()),'total_token_budget');
 for(const bad of [{maxModelCalls:-1},{maxModelCalls:1.5},{maxModelCalls:'3'},{unknown:2},{enabled:1},{maxTotalTokens:Number.MAX_SAFE_INTEGER+1}]){
  const before=await settings.payload();assert.equal((await settings.apply({task_efficiency:bad})).ok,false);assert.deepEqual(await settings.payload(),before);
 }
 assert.equal((await settings.apply({task_efficiency:{maxModelCalls:0}})).ok,true);await supervisor.refresh();
 assert.equal(supervisor.options.maxModelCalls,0);assert.equal(supervisor.options.maxTotalTokens,50000);
 const counterId=await task();await pool.query("INSERT INTO llm_usage(task_id,input_tokens,output_tokens,cache_read,cache_write) VALUES($1,5,2,3,4)",[String(counterId)]);
 assert.equal((await supervisor.sample(counterId)).total,14,'all disjoint usage buckets count exactly once');
 const restarted=new SettingsService(pool,path.join(dir,'dlq'));assert.deepEqual(await restarted.payload(),await settings.payload());
 const audit=(await pool.query("SELECT payload FROM business_events WHERE event_type='settings_changed'")).rows;
 assert.equal(audit.length,2);assert.deepEqual(audit[0].payload.changed_fields,['task_efficiency']);
 await settings.apply({task_efficiency:efficiencyOptions()});
});

test('review checkpoints renew productive and in-flight work without pausing, survive restart, and respect explicit ceilings',async()=>{
 const id=await task(),supervisor=new EfficiencySupervisor(pool,{reviewSeconds:60});
 const sample:any={progress:'new verified coverage',revision:'r1',active:1,approvals:0,calls:12,output:500,total:1000};
 await supervisor.observe(id,{...sample,progress:'initial coverage'});await pool.query('UPDATE task_efficiency_state SET active_seconds=61 WHERE task_id=$1',[id]);
 assert.equal(await supervisor.review(id,sample),true);assert.equal(await supervisor.review(id,sample),false);
 assert.equal(await new EfficiencySupervisor(pool,{reviewSeconds:60}).review(id,sample),false,'restart cannot duplicate checkpoint');
 await pool.query('UPDATE task_efficiency_state SET active_seconds=122 WHERE task_id=$1',[id]);
 assert.equal(await supervisor.review(id,sample),true,'active verification can continue without premature negative judgment');
 const state=(await pool.query('SELECT * FROM task_efficiency_state WHERE task_id=$1',[id])).rows[0];
 assert.equal(efficiencyDecision(state,sample,supervisor.options,Date.now()),null);
 assert.equal((await pool.query('SELECT paused FROM tasks WHERE id=$1',[id])).rows[0].paused,false);
 const events=(await pool.query("SELECT payload FROM business_events WHERE business_id=$1 AND event_type='task_efficiency_review' ORDER BY seq",[String(id)])).rows;
 assert.deepEqual(events.map(e=>e.payload.reason),['new_progress','work_in_flight']);
 supervisor.options.maxActiveSeconds=100;assert.equal(await supervisor.pause(id,'active_time_budget',sample),true);
 await pool.query('UPDATE tasks SET paused=FALSE WHERE id=$1',[id]);await supervisor.resetIfSuspended(id);
 const resumed=(await pool.query('SELECT * FROM task_efficiency_state WHERE task_id=$1',[id])).rows[0];assert.equal(resumed.review_count,0);
});

test('stream delta storage is linear, preserves Unicode/tool fragments and final audited messages without changing native events',async()=>{
 const writer=new EventBatchWriter(pool,path.join(dir,'stream-dlq'));
 let originalBytes=0,storedBytes=0,complete='';const deltas:string[]=[];
 for(let n=0;n<500;n++){
  const delta='证据🙂'+n+'\n';deltas.push(delta);complete+=delta;
  const snapshot={role:'assistant',content:[{type:'text',text:complete}]};
  const original={type:'message_update',message:snapshot,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta,partial:snapshot}};
  const stored=durableSessionEvent(original);originalBytes+=Buffer.byteLength(JSON.stringify(original));storedBytes+=Buffer.byteLength(JSON.stringify(stored));
  assert.equal(original.message.content[0].text,complete);assert.equal(original.assistantMessageEvent.partial,snapshot,'native live events untouched');
  writer.append({business_kind:'storage',business_id:'replay',event_type:'message_update',payload:stored});
 }
 assert.ok(storedBytes<originalBytes/10,`expected >90% reduction, got ${storedBytes}/${originalBytes}`);
 const final={type:'message_end',message:{role:'assistant',content:[{type:'text',text:complete}],usage:{output:500}}};
 writer.append({business_kind:'storage',business_id:'replay',event_type:'message_end',payload:durableSessionEvent(final)});await writer.flush();
 const rows=(await pool.query("SELECT seq,payload FROM business_events WHERE business_kind='storage' ORDER BY seq")).rows;
 assert.equal(rows.slice(0,-1).map(r=>r.payload.assistantMessageEvent.delta).join(''),complete);assert.deepEqual(rows.at(-1)!.payload,final);
 const tool=durableSessionEvent({type:'message_update',message:{large:'duplicate'},assistantMessageEvent:{type:'toolcall_delta',contentIndex:1,delta:'{"url":',partial:{large:'duplicate'}}});
 assert.equal((tool.assistantMessageEvent as any).delta,'{"url":');assert.equal((tool.assistantMessageEvent as any).contentIndex,1);
 // Reconnect from a mid-message cursor: all subsequent deltas and final message survive actual SSE replay.
 const server=createServer((req,res)=>{void streamEvents(req,res,pool);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const controller=new AbortController();
 try{
  const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/events?kind=storage&id=replay`,{headers:{'last-event-id':String(rows[489]!.seq)},signal:controller.signal});
  const reader=r.body!.getReader();let raw='';const decoder=new TextDecoder();
  while(!raw.includes('event: message_end')){const part=await reader.read();if(part.done)break;raw+=decoder.decode(part.value,{stream:true});}
  const events=raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  assert.equal(events.length,11);assert.equal(events[0].payload.assistantMessageEvent.delta,deltas[490]);assert.deepEqual(events.at(-1).payload,final);
 }finally{controller.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 // Final-message activity projection still receives the complete text, not a delta.
 const conv=Number((await pool.query("INSERT INTO conversations(agent_key,title) VALUES('auto','storage fixture') RETURNING id")).rows[0].id);
 const message={...final,_activity:{conversationId:conv,worker:'auto',runId:'storage-final',ordinal:0}};
 writer.append({business_kind:'chat',business_id:'storage-final',event_type:'message_end',payload:durableSessionEvent(message)});await writer.flush();await projectActivity(pool,{runId:'storage-final'});
 const saved=(await pool.query('SELECT state FROM pi_activity_capture WHERE run_id=$1',['storage-final'])).rows[0];assert.equal(saved.state.pending,complete.trim());
 console.log(JSON.stringify({originalBytes,storedBytes,reduction:1-storedBytes/originalBytes}));
});
