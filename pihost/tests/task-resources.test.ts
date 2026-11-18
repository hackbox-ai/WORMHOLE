import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {WorkspaceService} from '../src/domains/workspace/service.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {archiveColdEvents} from '../src/storage/cold-events.ts';
import {storagePolicy} from '../src/storage/policy.ts';
import {registerTaskResource,taskToolEnvironment} from '../src/domains/workspace/resource-paths.ts';
const config=loadConfig(),admin=new Pool({connectionString:config.database.dsn}),schema='resource_test_'+process.pid+'_'+Date.now();
let pool:Pool,dir:string,workspace:WorkspaceService,traffic:TrafficStore,tasks:TaskService;
const busy=new Set<number>(),leases=new Set<number>();
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
 dir=await mkdtemp(path.join(tmpdir(),'wormhole-resource-test-'));workspace=new WorkspaceService(pool,path.join(dir,'dlq'),path.join(dir,'workspace'));await workspace.ensure();
 workspace.maintenance.bind({taskBusy:id=>busy.has(id)||leases.has(id),acquireTask:id=>{if(busy.has(id)||leases.has(id))return null;leases.add(id);return()=>{leases.delete(id);};},sessionBusy:()=>false});
 traffic=new TrafficStore(path.join(dir,'traffic'));workspace.resources.bind(traffic);tasks=new TaskService(pool,path.join(dir,'dlq'),()=>{});
});
after(async()=>{traffic?.close();await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
async function task(){const r=await tasks.create({name:'resource fixture',goal:'synthetic',queued:true});assert.ok(r.ok);const id=Number(r.task.id);await pool.query("UPDATE tasks SET status='done',queued=false,paused=false WHERE id=$1",[id]);return id;}
async function file(id:number,name:string,body='x'.repeat(12000)){const full=path.join(workspace.root,'tasks',String(id),name);await mkdir(path.dirname(full),{recursive:true});await writeFile(full,body);return full;}
async function capture(id:number,body:string){return traffic.record({url:'http://fixture.invalid/api',method:'GET',status:200,contentType:'application/octet-stream',requestType:'',reqHead:'GET /api HTTP/1.1',respHead:'HTTP/1.1 200 OK',reqBody:Buffer.alloc(0),respBody:Buffer.from(body),context:{taskId:id,requestId:randomUUID()}});}
async function record(id:number){return (await pool.query("INSERT INTO llm_records(task_id,request_text,response_text,request_body,response_body,raw_request,raw_response) VALUES($1,$2,$2,$2,$2,$2,$2) RETURNING id",[String(id),'model-body-'.repeat(2000)])).rows[0].id;}
const exists=async(p:string)=>!!await lstat(p).catch(()=>null);
test('unified accounting and cleanup covers JS/sqlite, recordings, traffic and sessions while retaining proof',async()=>{
 const id=await task(),other=await task(),large=await file(id,'captured.js'),sqlite=await file(id,'result.sqlite'),proof=await file(id,'evidence/screenshot.png'),upload=await file(id,'uploads/input.txt'),keep=await file(id,'proof.py'),otherFile=await file(other,'keep.js');
 await pool.query("INSERT INTO task_reports(task_id,phase,markdown) VALUES($1,'final',$2)",[id,'proof '+keep]);
 const rec=await record(id),otherRec=await record(other),flow=await capture(id,'task-only-'.repeat(5000)),otherFlow=await capture(other,'other-'.repeat(5000));
 const session=path.join(dir,'pi-sessions','worker-task-'+id+'-i1');await mkdir(session,{recursive:true});await writeFile(path.join(session,'checkpoint.jsonl'),'session'.repeat(10000));await registerTaskResource(pool,id,'sessions',session);
 const detail=await workspace.resources.detail(id);assert.ok(detail.associated_bytes>200000);assert.ok(detail.categories.find(c=>c.category==='traffic')!.bytes>10000);assert.ok(detail.items.some(i=>i.path===sqlite));assert.ok(detail.items.find(i=>i.path===keep)?.protected_reason);
 const plan=await workspace.resources.preview(id,['files','traffic','recordings','sessions']);const result=await workspace.resources.execute(plan.token);assert.deepEqual(result.failed,[]);assert.ok(result.released_file_bytes>10000);assert.ok(result.database_reusable_bytes>10000);
 for(const p of [large,sqlite,session])assert.equal(await exists(p),false);for(const p of [proof,upload,keep,otherFile])assert.equal(await exists(p),true);
 const r=(await pool.query('SELECT * FROM llm_records WHERE id=$1',[rec])).rows[0];assert.equal(r.request_text,'');assert.ok(r.workspace_cleaned_at);assert.equal((await pool.query('SELECT request_text FROM llm_records WHERE id=$1',[otherRec])).rows[0].request_text.length>0,true);
 assert.equal(traffic.context(flow),undefined);assert.equal(traffic.context(otherFlow)?.taskId,other);
 await assert.rejects(()=>workspace.resources.execute(plan.token),/失效/);assert.equal(leases.size,0);
});
test('shared traffic blobs remain until other references disappear and referenced flow survives',async()=>{
 const a=await task(),b=await task(),body='shared-binary'.repeat(50000);const first=await capture(a,body),second=await capture(b,body);
 const blob=traffic.taskResources(a).blobs[0]!;assert.ok(blob.file);assert.ok((await workspace.resources.detail(a)).items.find(i=>i.key==='blob:'+blob.hash)?.protected_reason);
 const p=await workspace.resources.preview(a,['traffic']);await workspace.resources.execute(p.token);assert.equal(traffic.context(first),undefined);assert.ok(await exists(blob.file));assert.ok(traffic.context(second));
 const p2=await workspace.resources.preview(b,['traffic']);await workspace.resources.execute(p2.token);assert.equal(await exists(blob.file),false);
 const c=await task(),keep=await capture(c,'evidence'.repeat(10000));await pool.query("INSERT INTO task_reports(task_id,phase,markdown) VALUES($1,'final',$2)",[c,'traffic id '+keep]);
 const cp=await workspace.resources.preview(c,['traffic']);await workspace.resources.execute(cp.token);assert.ok(traffic.context(keep));
});
test('active, queued and busy tasks are blocked; stale preview cannot remove changed data',async()=>{
 const id=await task(),f=await file(id,'temp.js');let p=await workspace.resources.preview(id,['files']);await writeFile(f,'changed');await assert.rejects(()=>workspace.resources.execute(p.token),/变化/);assert.ok(await exists(f));
 p=await workspace.resources.preview(id,['files']);busy.add(id);await assert.rejects(()=>workspace.resources.execute(p.token),/使用|未结束/);busy.delete(id);
 await pool.query("UPDATE tasks SET status='running' WHERE id=$1",[id]);await assert.rejects(()=>workspace.resources.preview(id,['files']),/结束/);
 await pool.query("UPDATE tasks SET status='done',queued=true WHERE id=$1",[id]);await assert.rejects(()=>workspace.resources.preview(id,['files']),/结束/);
});
test('cold streaming archive cleanup preserves semantic events and cursor identities',async()=>{
 const id=await task(),archive=randomUUID(),root=path.join(dir,'storage/events',archive);await mkdir(root,{recursive:true});await writeFile(path.join(root,'frames.bin'),'cold'.repeat(10000));
 await pool.query("INSERT INTO storage_event_archives(id,task_id,first_seq,last_seq,rows,raw_bytes,stored_bytes,raw_hash,manifest_hash,codec) VALUES($1,$2,1,1,1,40000,40000,$3,$3,'identity')",[archive,id,'a'.repeat(64)]);
 const event=(await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload,cold_archive_id) VALUES('task',$1,'message_update','{}',$2) RETURNING seq,event_uid",[String(id),archive])).rows[0];
 await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'message_end','{\"text\":\"final evidence retained\"}')",[String(id)]);
 const p=await workspace.resources.preview(id,['history']);await workspace.resources.execute(p.token);assert.equal(await exists(root),false);
 const retained=(await pool.query('SELECT * FROM business_events WHERE seq=$1',[event.seq])).rows[0];assert.equal(retained.event_uid,event.event_uid);assert.equal(retained.cold_archive_id,null);assert.equal(retained.payload.workspace_cleaned,true);assert.equal((await pool.query("SELECT count(*) n FROM business_events WHERE business_id=$1 AND event_type='message_end'",[String(id)])).rows[0].n,'1');
});
test('tool artifacts honor cross-task references and clean metadata without deleting reports',async()=>{
 const id=await task(),other=await task(),body='large tool result'.repeat(10000),hash=createHash('sha256').update(body).digest('hex'),file=path.join(dir,'storage/objects',hash+'.identity.blob');
 await mkdir(path.dirname(file),{recursive:true});await writeFile(file,body);
 for(const owner of [id,other])await pool.query("INSERT INTO storage_artifacts(task_id,intent_id,hash,raw_bytes,stored_bytes,codec) VALUES($1,0,$2,$3,$3,'identity')",[owner,hash,body.length]);
 const p=await workspace.resources.preview(id,['artifacts']);assert.ok(p.protected_count);await workspace.resources.execute(p.token);assert.ok(await exists(file));
 await pool.query('DELETE FROM storage_artifacts WHERE task_id=$1',[other]);const p2=await workspace.resources.preview(id,['artifacts']);await workspace.resources.execute(p2.token);assert.equal(await exists(file),false);
});
test('task-local temp and cache paths do not escape the task directory',async()=>{
 const cwd=path.join(workspace.root,'tasks',String(await task()),'i1');const env=await taskToolEnvironment(cwd);for(const p of Object.values(env)){assert.ok(p.startsWith(cwd+path.sep));assert.ok(await exists(p));}
});

test('private modeling resources are grouped with parent; shared modeling is protected',async()=>{
 const parent=await task(),child=await task(),other=await task();
 await pool.query("UPDATE tasks SET kind='modeling' WHERE id=$1",[child]);const childFile=await file(child,'modeling.tmp');
 const system=(await pool.query("INSERT INTO business_systems(name,target) VALUES('fixture','http://model.fixture') RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO task_business_models(task_id,system_id,modeling_task_id) VALUES($1,$2,$3)",[parent,system,child]);
 let detail=await workspace.resources.detail(parent);assert.ok(detail.items.some(i=>i.path===childFile));busy.add(child);await assert.rejects(()=>workspace.resources.preview(parent,['files']),/使用|未结束/);busy.delete(child);
 await pool.query("INSERT INTO task_business_models(task_id,system_id,modeling_task_id) VALUES($1,$2,$3)",[other,system,child]);
 detail=await workspace.resources.detail(parent);assert.equal(detail.items.some(i=>i.path===childFile),false);assert.equal(Number(detail.linked_tasks[0].refs),2);
 const p=await workspace.resources.preview(parent,['files']);await workspace.resources.execute(p.token);assert.ok(await exists(childFile));
});
test('interrupted cross-store cleanup leaves pending files visible and retryable',async()=>{
 const id=await task(),hash='b'.repeat(64),file=path.join(dir,'storage/objects',hash+'.identity.blob');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'orphan raw content'.repeat(1000));
 const metadata={key:'artifact:'+id+':0:'+hash,category:'artifacts',source:'artifact',owner:id,bytes:18000,disk_bytes:20480,path:file,kind:'file',protected_reason:'',meta:{task_id:id,intent_id:0,hash,codec:'identity',layout:'body-v1',root:path.join(dir,'storage/objects')}};
 const run=randomUUID();await pool.query("INSERT INTO task_resource_cleanup_runs(id,task_id,state,categories,manifest,fingerprint,expires_at,progress) VALUES($1,$2,'running','[\"artifacts\"]','{}','fixture',now(),$3)",[run,id,JSON.stringify({pending:[metadata]})]);
 await workspace.resources.recover();const detail=await workspace.resources.detail(id);assert.ok(detail.items.some(i=>i.path===file));
 const p=await workspace.resources.preview(id,['artifacts']);await workspace.resources.execute(p.token);assert.equal(await exists(file),false);
 const h=(await workspace.resources.history()).items.find(x=>x.id===run);assert.equal(h.state,'interrupted');
});
test('new report reference invalidates a preview and symlinks never traverse external files',async()=>{
 const id=await task(),target=await file(await task(),'keep.txt'),own=await file(id,'temp.js');await symlink(target,path.join(workspace.root,'tasks',String(id),'outside'));
 const p=await workspace.resources.preview(id,['files']);await pool.query("INSERT INTO task_reports(task_id,phase,markdown) VALUES($1,'final',$2)",[id,own]);await assert.rejects(()=>workspace.resources.execute(p.token),/变化/);
 const fresh=await workspace.resources.preview(id,['files']);await workspace.resources.execute(fresh.token);assert.ok(await exists(target));assert.ok(await exists(own));assert.ok(await exists(path.join(workspace.root,'tasks',String(id),'outside')));
});

test('manual stream cleanup markers are excluded from subsequent automatic cold archiving',async()=>{
 const id=await task();await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload,ts) VALUES('task',$1,'message_update','{\"workspace_cleaned\":true}',now()-interval '20 days')",[String(id)]);
 const result=await archiveColdEvents(pool,dir,storagePolicy({hotDays:1}));assert.equal(result.rows,0);
});

test('single-connection resource accounting and execution do not deadlock',async()=>{
 const id=await task();await file(id,'single-pool.tmp');const single=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:1000});
 try{const instance=new WorkspaceService(single,path.join(dir,'dlq'),workspace.root);instance.resources.bind(traffic);instance.maintenance.bind({taskBusy:()=>false,acquireTask:()=>()=>{},sessionBusy:()=>false});const p=await instance.resources.preview(id,['files']);const result=await instance.resources.execute(p.token);assert.equal(result.failed.length,0);}finally{await single.end();}
});

test('single-pass catalogue matches exact per-task scope without similar-ID bleed',async()=>{
 const id=await task();await file(id,'bulk-summary.js');
 for(const [kind,business] of [['worker','task-'+id+'-intent-12'],['task',String(id)],['worker','task-'+id+'0-intent-12']])await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES($1,$2,'message_update',$3)",[kind,business,JSON.stringify({text:'x'.repeat(1000)})]);
 const detail=await workspace.resources.detail(id),list=await workspace.resources.list(true);assert.deepEqual(list.errors,[]);const row=list.tasks.find((t:any)=>t.task_id===id);assert.ok(row);assert.deepEqual(row.categories,detail.categories);
});
