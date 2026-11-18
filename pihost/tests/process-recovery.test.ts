/** Real src/main.ts processes and SIGKILL, using an isolated schema, files and loopback suppliers. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,rm,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {completionAsSSE} from '../src/domains/llm/profile-wire.ts';
import {expandRecordBodies} from '../src/storage/record-body.ts';
const original=loadConfig(),schema=`codex_process_${process.pid}_${Date.now()}`,dir=await mkdtemp(path.join(tmpdir(),'wormhole-process-'));
assert.match(schema,/^codex_process_\d+_\d+$/);assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
const admin=new Pool({connectionString:original.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const dsn=new URL(original.database.dsn);dsn.searchParams.set('options',`-c search_path=${schema}`);
const pool=new Pool({connectionString:dsn.toString()});await runMigrations(pool);
await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['http_request'])]);
const auth=new AuthService(pool,authKeyPath(dir)),token=(await auth.init('process-fixture-password')).token!;
const children=new Set<ChildProcess>(),servers:Server[]=[],exits=new WeakMap<ChildProcess,Promise<void>>();
let hits=0,hold=false,blocked=false,release!:()=>void,barrier=Promise.resolve();
const target=createServer((_req,res)=>{hits++;res.end('DURABLE_TOOL_RESULT');});await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));servers.push(target);
const targetUrl=`http://127.0.0.1:${(target.address() as {port:number}).port}/probe`;
const vendor=createServer((req,res)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{void(async()=>{
 const body=JSON.parse(text),messages=body.messages as any[],results=messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result'),done=results.some(b=>/DURABLE_TOOL_RESULT|denied|审批拒绝/.test(JSON.stringify(b.content)));
 if(hold&&done){blocked=true;await barrier;}if(res.destroyed)return;
 const content=done?[{type:'text',text:'RECOVERED_WITH_CONTEXT'}]:[{type:'tool_use',id:'call_'+Date.now(),name:'http_request',input:{url:targetUrl}}];
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(completionAsSSE('anthropic',{id:'fixture_'+Date.now(),role:'assistant',type:'message',model:'restart',content,stop_reason:done?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:13,output_tokens:5}}));
 })().catch(error=>res.destroy(error));});});await new Promise<void>(r=>vendor.listen(0,'127.0.0.1',r));servers.push(vendor);
const agentDir=path.join(dir,'agent');await mkdir(agentDir);const models=path.join(agentDir,'models.json');await writeFile(models,JSON.stringify({providers:{restartmock:{api:'anthropic-messages',baseUrl:`http://127.0.0.1:${(vendor.address() as {port:number}).port}`,apiKey:'fixture-only',models:[{id:'restart',name:'restart',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192}]}}}));
await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.workers','1'),('settings.traffic_capture','false'),('settings.llm_record','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
const config={...original,database:{dsn:dsn.toString()},dataDir:dir,pi:{provider:'restartmock',modelId:'restart',modelsPath:models,agentDir}};
async function until(check:()=>Promise<boolean>|boolean,label:string,ms=20000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,30));}assert.fail(label);}
async function boot(){
 const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
 const file=path.join(dir,'process-config.json');await writeFile(file,JSON.stringify({...config,listen:{host:'127.0.0.1',port}}));
 let diagnostics='';const child=spawn(process.execPath,['--import','tsx','src/main.ts'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WORMHOLE_CONFIG:file,PI_CODING_AGENT_DIR:agentDir},stdio:['ignore','pipe','pipe']});children.add(child);
 child.stdout!.on('data',b=>diagnostics=(diagnostics+b).slice(-6000));child.stderr!.on('data',b=>diagnostics=(diagnostics+b).slice(-6000));exits.set(child,new Promise(r=>child.once('exit',()=>{children.delete(child);r();})));
 const base=`http://127.0.0.1:${port}`;
 await until(async()=>{if(child.exitCode!==null)assert.fail('isolated host exited: '+diagnostics.replace(/:[^:@/]*@/g,':***@'));try{return(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'isolated host starts');return {child,base};
}
async function stop(child:ChildProcess,signal:NodeJS.Signals){if(!children.has(child))return;child.kill(signal);await Promise.race([exits.get(child),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('child failed to exit')),18000);timer.unref();})]);}
async function seed(name:string){const task=await new TaskService(pool,path.join(dir,'dlq.jsonl'),()=>{}).create({name,goal:'fixture',queued:true});assert.ok(task.ok);const id=Number(task.task.id);await pool.query("INSERT INTO exploration_nodes(task_id,kind,title) VALUES($1,'intent',$2)",[id,name]);await pool.query("UPDATE tasks SET status='running',queued=FALSE WHERE id=$1",[id]);return id;}
async function api(base:string,route:string,body?:unknown){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};}
after(async()=>{release?.();for(const child of [...children])await stop(child,'SIGKILL');for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});});
test('F03/F02 真 SIGKILL：持久工具结果后残留租约恢复、Pi上下文续接，不重复HTTP副作用',async()=>{
 hold=true;blocked=false;barrier=new Promise<void>(r=>{release=r;});const id=await seed('kill after tool');let host=await boot();
 await until(()=>blocked,'second supplier call after persisted tool result');await until(async()=>!!(await pool.query("SELECT 1 FROM activity WHERE kind='tool_result' AND exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1)",[id])).rowCount,'durable tool result');assert.equal(hits,1);
 const running=(await pool.query("SELECT state,attempts FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows[0];assert.equal(running.state,'running');assert.equal(running.attempts,1);
 await stop(host.child,'SIGKILL');hold=false;release();host=await boot();
 await until(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status==='done','actual recovered task completes');assert.equal(hits,1,'saved tool result prevents replay');
 const intent=(await pool.query("SELECT state,attempts FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows[0];assert.equal(intent.state,'done');assert.equal(intent.attempts,2,'boot reclaimed the dead lease');
 const files=await readdir(path.join(dir,'pi-sessions',`worker-task-${id}-intent-${(await pool.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND kind='intent'",[id])).rows[0].id}`));assert.ok(files.some(f=>f.endsWith('.jsonl')));
 const stored=(await pool.query("SELECT * FROM llm_records WHERE task_id=$1 AND status='ok' ORDER BY id DESC LIMIT 1",[String(id)])).rows[0];assert.ok(stored);const record=await expandRecordBodies(stored);assert.match(record.raw_request,/DURABLE_TOOL_RESULT/,'resumed request contains real preceding tool result');await stop(host.child,'SIGTERM');
});
test('F19 真审批中 SIGKILL：旧决定不解锁新调用，重新拒绝零执行、CAS重复决定409',async()=>{
 const before=hits;await pool.query("INSERT INTO intercept_rules(name,match_target,match_type,pattern,action,message,enabled,priority) VALUES('process ask','tool_name','string','http_request','ask','fixture approval',TRUE,100)");
 const id=await seed('kill during ask');let host=await boot();let pending:any;
 await until(async()=>{const result=await api(host.base,'/api/intercept/pending');pending=result.body.pending?.find((r:any)=>r.task_id===String(id));return !!pending;},'actual Pi ask is pending');const oldId=Number(pending.id);assert.equal(hits,before);
 await stop(host.child,'SIGKILL');host=await boot();let fresh:any;
 await until(async()=>{const result=await api(host.base,'/api/intercept/pending');fresh=result.body.pending?.find((r:any)=>Number(r.id)!==oldId&&r.task_id===String(id));return !!fresh;},'restarted worker requires a fresh approval');
 const old=await api(host.base,'/api/intercept/decide',{id:oldId,decision:'approved'});assert.equal(old.status,200);await new Promise(r=>setTimeout(r,150));assert.equal(hits,before,'old approval cannot authorize current tool id');
 assert.equal((await api(host.base,'/api/intercept/decide',{id:Number(fresh.id),decision:'denied'})).status,200);assert.equal((await api(host.base,'/api/intercept/decide',{id:Number(fresh.id),decision:'approved'})).status,409);
 await until(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status==='done','denied tool returns to real Pi loop');assert.equal(hits,before);await stop(host.child,'SIGTERM');
});
