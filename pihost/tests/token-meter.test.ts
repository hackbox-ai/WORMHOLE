import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TokenMeter} from '../src/domains/observability/token-meter.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';

test('meter: one ledger, Shanghai dates, stable profiles, task/chat dedupe and exact drill-down',async()=>{
 const cfg=loadConfig(),schema='meter_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:cfg.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:cfg.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-meter-'));let server:ReturnType<typeof createServer>|undefined;
 try{
  await runMigrations(pool);
  const profiles=new LlmService(pool,dir+'/events',dir+'/models.json');
  const pa=await profiles.createProfile({name:'Alpha',format:'anthropic',model:'same-model',api_key:'fixture',base_url:'https://fixture.invalid'});
  const pb=await profiles.createProfile({name:'Beta',format:'anthropic',model:'different-model',api_key:'fixture',base_url:'https://fixture.invalid'});
  assert.ok(pa.ok&&pb.ok);const aid=Number(pa.profile!.id),bid=Number(pb.profile!.id);
  const tasks=new TaskService(pool,dir+'/events',()=>{});
  const a=await tasks.create({name:'Test task',goal:'fixture',queued:true}),b=await tasks.create({name:'Model task',goal:'fixture',queued:true});
  assert.ok(a.ok&&b.ok);const task=Number(a.task.id),modeling=Number(b.task.id);
  await pool.query("UPDATE tasks SET kind='modeling' WHERE id=$1",[modeling]);
  const conv=(await pool.query("INSERT INTO conversations(agent_key,task_id) VALUES('pentest',$1) RETURNING id",[task])).rows[0].id;
  const start=Number((await pool.query("SELECT extract(epoch FROM ((now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai'))*1000 ms")).rows[0].ms);
  const add=async(profile:number|null,kind:string,business:string,taskId:number|null,ts:number,tokens:number[],model='same-model',worker='worker',status='ok')=>
   pool.query("INSERT INTO llm_usage(profile_id,profile_name,model,business_kind,business_id,task_id,worker,status,ts,input_tokens,output_tokens,cache_read,cache_write) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [profile,profile===aid?'Alpha':profile===bid?'Beta':'',model,kind,business,taskId?.toString()??null,worker,status,new Date(ts),...tokens]);
  await add(aid,'worker','task-a',task,start,[100,20,300,40]);
  await add(aid,'chat',String(conv),null,start-1,[20,10,10,0],'same-model','pentest','error');
  await add(bid,'worker','task-model',modeling,start+1,[12,3,0,0],'model-version-1','modeler');
  await add(bid,'worker','task-model',modeling,start+2,[7,2,1,0],'model-version-2','modeler');
  await add(null,'chat','missing-conversation',null,start+3,[5,1,0,0]);
  await add(null,'btw','side-question',null,start+4,[2,3,0,0],'other-model','btw');
  for(let i=0;i<5;i++)await add(aid,'worker','older',task,start-6*86400000-1,[1800000000,0,0,0]);
  const meter=new TokenMeter(pool),q=(value:string)=>new URLSearchParams(value);
  const result:any=await meter.usage(q('days=7'));
  assert.equal(result.summary.total_tokens,536);assert.equal(result.summary.calls,6);assert.equal(result.summary.tasks,2);assert.equal(result.summary.failed_calls,1);
  assert.equal(result.daily.length,7);assert.equal(result.daily[0].calls,0);
  const sum=(items:any[],key:string)=>items.reduce((a,b)=>a+Number(b[key]),0);
  for(const key of ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','total_tokens','calls']){
   assert.equal(sum(result.daily,key),result.summary[key]);assert.equal(sum(result.by_profile,key),result.summary[key]);assert.equal(sum(result.by_source,key),result.summary[key]);
  }
  assert.equal(result.daily.at(-1).total_tokens,496,'local midnight stays on the local day');
  assert.equal(result.daily.at(-2).total_tokens,40);
  assert.ok(result.daily.every((d:any)=>/^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  const alpha:any=await meter.usage(q('days=7&profile=profile:'+aid));assert.equal(alpha.summary.total_tokens,500);
  const beta:any=await meter.usage(q('days=7&profile=profile:'+bid));assert.equal(beta.summary.total_tokens,25);
  const unknown:any=await meter.usage(q('days=7&profile=unassigned'));assert.equal(unknown.summary.total_tokens,11);
  const scoped:any=await meter.usage(q('days=7&source=task&task='+task));assert.equal(scoped.summary.total_tokens,500);
  const models:any=await meter.usage(q('days=7&source=modeling'));assert.equal(models.summary.total_tokens,25);
  const long:any=await meter.usage(q('days=30'));assert.equal(long.summary.total_tokens,9000000536,'large sums do not overflow int32');
  await pool.query("UPDATE llm_profiles SET name='Renamed' WHERE id=$1",[aid]);
  await pool.query("UPDATE llm_profiles SET is_default=(id=$1)",[bid]);
  const rename:any=await meter.usage(q('days=7&profile=profile:'+aid));assert.equal(rename.summary.total_tokens,500);assert.equal(rename.by_profile[0].profile_name,'Renamed');
  assert.ok(rename.profiles.some((p:any)=>p.key==='unassigned'&&p.name==='未归属配置'));
  const graph=new ExplorationService(pool);await graph.ensure(task);
  const eid=(await pool.query('SELECT exploration_id FROM tasks WHERE id=$1',[task])).rows[0].exploration_id;
  await pool.query("INSERT INTO activity(exploration_id,worker,kind,summary,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,metadata) VALUES($1,'mainagent','result','legacy duplicate',99999,99999,99999,99999,$2::jsonb)",[eid,JSON.stringify({source_conversation_id:conv})]);
  await pool.query("INSERT INTO conversation_activities(conversation_id,seq,worker,kind,summary,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES($1,1,'pentest','result','legacy duplicate',99999,99999,99999,99999)",[conv]);
  assert.equal((await meter.usage(q('days=7')) as any).summary.total_tokens,536,'activity read models never add a second copy');
  const pages=[];for(let page=1;page<=3;page++)pages.push(await meter.calls(q('days=7&page_size=2&page='+page)));
  assert.equal(pages[0]!.total,6);assert.equal(sum(pages.flatMap(p=>p.items),'total_tokens'),536);assert.equal(new Set(pages.flatMap(p=>p.items).map(r=>r.id)).size,6);
  const empty:any=await meter.usage(q('days=7&profile=profile:999999'));assert.equal(empty.summary.total_tokens,0);assert.equal(empty.daily.length,7);
  await assert.rejects(meter.usage(q('days=-1')));await assert.rejects(meter.usage(q('source=invalid')));await assert.rejects(meter.calls(q('page_size=1000')));
  const auth=new AuthService(pool,dir+'/jwt.key'),token=(await auth.init('meter-fixture-only-123')).token!;
  server=createServer((req,res)=>void routeRequest(req,res,{pool,config:cfg,auth} as any));await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const read=async(p:string)=>{const r=await fetch(base+p,{headers:{authorization:'Bearer '+token}});return {status:r.status,body:await r.json() as any};};
  assert.equal((await read('/api/tokens/usage?days=7')).body.summary.total_tokens,536);
  assert.equal((await read('/api/tokens/usage/calls?days=7')).body.total,6);
  assert.equal((await read('/api/tokens/usage?days=bad')).status,400);
  const client=await pool.connect(),originalQuery=client.query.bind(client);let inserted=false;
  (client as any).query=async(sql:string,args?:unknown[])=>{
   const rows=await originalQuery(sql,args);
   if(!inserted&&sql.endsWith(' FROM filtered')){
    inserted=true;
    await admin.query('INSERT INTO '+schema+".llm_usage(model,business_kind,business_id,input_tokens,output_tokens,cache_read,cache_write) VALUES('concurrent','btw','later',10,7,0,0)");
   }
   return rows;
  };
  let consistent:any;
  try{consistent=await new TokenMeter({connect:async()=>client} as any).usage(q('days=7'));}
  finally{(client as any).query=originalQuery;}
  assert.ok(inserted);assert.equal(consistent.summary.total_tokens,536);
  assert.equal(sum(consistent.daily,'total_tokens'),536,'concurrent inserts cannot split one response into inconsistent aggregates');
  assert.equal((await meter.usage(q('days=7')) as any).summary.total_tokens,553);

 }finally{
  server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
