/** Upload -> actual Pi native tool_use -> Read/Bash/Write -> UI-visible tree.
 * Model output alone is canned; no direct execution of the file tools in tests. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {createServer,request,type Server} from 'node:http';
import {mkdtemp,rm,mkdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {WorkspaceService} from '../src/domains/workspace/service.ts';
import {taskWorkDir,conversationWorkDir} from '../src/domains/workspace/layout.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {TaskService,TaskEngine} from '../src/domains/tasks/index.ts';
import {TaskChatService} from '../src/domains/tasks/chat.ts';
import {ConversationsService} from '../src/domains/conversations/service.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
const base=loadConfig(),schema=`codex_cwd_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`}),dir=await mkdtemp(path.join(tmpdir(),'cwd-native-'));
const config={...base,dataDir:dir,pi:{...base.pi,modelsPath:path.join(dir,'models.json'),agentDir:path.join(dir,'agent')}};await mkdir(config.pi.agentDir);await runMigrations(pool);
const dlq=path.join(dir,'dlq'),agents=new AgentsService(pool,dlq),engine=new TaskEngine(pool,config,{agents,assets:new AssetsService(pool,dlq),findings:new FindingsService(pool,dlq),intercept:new InterceptService(pool,dlq),settingsConsumers:null});
const tasks=new TaskService(pool,dlq,()=>{}),chat=new TaskChatService(pool,config,agents);
chat.wire(engine,(_id,signal,businessId)=>assembleTools(pool,[],{agentKey:'mainagent',businessKind:'mainagent',businessId,taskId:_id,signal},{}));
const conversations=new ConversationsService(pool,config,agents,dlq,(_key,ctx)=>assembleTools(pool,[],ctx,{}));
const auth=new AuthService(pool,authKeyPath(dir)),token=(await auth.init('cwd-native-fixture-password')).token!,workspace=new WorkspaceService(pool,dlq,path.join(dir,'workspace'));
const ctx={pool,config,auth,workspace,tasks,taskEngine:engine,taskChat:chat,conversations} as AppContext,servers:Server[]=[];
const server=createServer((req,res)=>void routeRequest(req,res,ctx));servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
after(async()=>{await engine.shutdown();await chat.shutdown();await conversations.shutdown();for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}resetPiRuntime();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});});
async function call(route:string,method='GET',body?:unknown){const r=await fetch(origin+route,{method,headers:{authorization:`Bearer ${token}`,...(body!==undefined&&!(body instanceof FormData)?{'content-type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
async function upload(scope:string,id:number,name='payload.txt',value='UPLOAD_SECRET_中文'){const f=new FormData();f.append('file',new Blob([value]),name);const r=await call(`/api/chat/upload?scope=${scope}&id=${id}`,'POST',f);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.attachments[0];}
async function until(fn:()=>Promise<boolean>|boolean,label:string){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,25));}assert.fail(label);}
async function mock(file:string){const started=await startMockAnthropic(0,{marker:'CWD_COMPLETE',tool:body=>{
  const names=((body.tools??[]) as any[]).map(t=>t.name);if(!names.includes('Read'))return undefined;
  const calls=(body.messages as any[]).flatMap(m=>m.content??[]).filter(c=>c.type==='tool_use').map(c=>c.name);
  if(!calls.includes('Read'))return {name:'Read',input:{file_path:file}};
  if(!calls.includes('Bash'))return {name:'Bash',input:{command:'pwd'}};
  if(!calls.includes('Write'))return {name:'Write',input:{file_path:'artifact.txt',content:'PI_NATIVE_ARTIFACT'}};
  return undefined;
 }});servers.push(started.server);const port=(started.server.address() as {port:number}).port,llm=new LlmService(pool,dlq,config.pi.modelsPath),profile=await llm.createProfile({name:'cwd-'+port,model:'mock-1',format:'anthropic',base_url:`http://127.0.0.1:${port}`,api_key:'fixture'});assert.ok(profile.ok);await llm.activate(Number(profile.profile!.id));const compiled=await llm.compileToPiRuntime();assert.ok(!('error' in compiled));config.pi.provider=compiled.provider;config.pi.modelId=compiled.modelId;resetPiRuntime();return started.state;}
test('F10 task attachment -> task main Pi tools; manifest and activity card survive reload',async()=>{
 const t=await tasks.create({name:'attachment',goal:'fixture',queued:true});assert.ok(t.ok);const id=Number(t.task.id),att=await upload('task',id),state=await mock(att.abs);
 const response=await call('/api/chat?task='+id,'POST',{message:'检查附件',attachments:[att]});assert.equal(response.status,202);await until(()=>!chat.isBusy(id),'main chat did not finish');
 assert.equal(await readFile(path.join(taskWorkDir(config,id),'artifact.txt'),'utf8'),'PI_NATIVE_ARTIFACT');
 const last=JSON.stringify(state.calls.at(-1)?.body);assert.match(last,/UPLOAD_SECRET_中文/);assert.ok(last.includes(taskWorkDir(config,id)));assert.ok(JSON.stringify(state.calls[0]?.body).includes(att.abs));
 const user=(await pool.query("SELECT * FROM activity WHERE exploration_id=$1 AND kind='user'",[t.task.exploration_id])).rows;assert.equal(user.length,1);assert.equal(user[0].summary,'检查附件');assert.deepEqual(JSON.parse(user[0].detail),{text:'检查附件',attachments:[att]});
 const tools=(await pool.query("SELECT tool,is_error FROM activity WHERE exploration_id=$1 AND kind='tool_result'",[t.task.exploration_id])).rows;assert.deepEqual(tools.map(r=>r.tool),['Read','Bash','Write']);assert.ok(tools.every(r=>!r.is_error));
});
test('F10 conversation attachment -> native tools in sessions/id with distinct checkpoint directory',async()=>{
 const c=await conversations.create('auto','fixture',null);assert.ok(c.ok);const id=Number(c.conv.id),att=await upload('session',id),state=await mock(att.abs);
 assert.equal((await conversations.send(id,'检查附件',[att])).status,202);await until(()=>!conversations.isRunning(id),'conversation did not finish');
 assert.equal(await readFile(path.join(conversationWorkDir(config,id),'artifact.txt'),'utf8'),'PI_NATIVE_ARTIFACT');assert.match(JSON.stringify(state.calls.at(-1)?.body),/UPLOAD_SECRET_中文/);
 const user=(await pool.query("SELECT summary,detail FROM conversation_activities WHERE conversation_id=$1 AND kind='user'",[id])).rows;assert.equal(user.length,1);assert.deepEqual(JSON.parse(user[0].detail),{text:'检查附件',attachments:[att]});
 assert.ok((await stat(path.join(dir,'pi-sessions','chat-conv-'+id))).isDirectory());assert.ok(!(await stat(path.join(dir,'pi-sessions','chat-conv-'+id,'artifact.txt')).catch(()=>null)));
});
test('F10 worker artifacts use per-intent directories rather than checkpoint directories',async()=>{
 const t=await tasks.create({name:'worker files',goal:'fixture',queued:true});assert.ok(t.ok);const id=Number(t.task.id),att=await upload('task',id);const node=(await pool.query("INSERT INTO exploration_nodes(task_id,kind,title) VALUES($1,'intent','native file work') RETURNING id",[id])).rows[0],intent=Number(node.id),state=await mock(att.abs);
 await engine.launch(id);await until(async()=>String((await tasks.get(id))?.status)==='done','worker did not finish');await engine.drain(id);
 const cwd=taskWorkDir(config,id,intent);assert.equal(await readFile(path.join(cwd,'artifact.txt'),'utf8'),'PI_NATIVE_ARTIFACT');
 const workerCalls=state.calls.filter(c=>((c.body?.tools??[]) as any[]).some(t=>t.name==='insert_assets'));assert.ok(workerCalls.length>=4);assert.match(JSON.stringify(workerCalls.at(-1)?.body),/UPLOAD_SECRET_中文/);assert.ok(JSON.stringify(workerCalls.at(-1)?.body).includes(cwd),'worker Bash pwd is returned to its own next model call');
 const root=await call(`/api/workspace/list?path=tasks/${id}/i${intent}`);assert.equal(root.status,200);assert.ok(root.data.entries.some((e:any)=>e.path===`tasks/${id}/i${intent}/artifact.txt`));
});
test('F10 concurrent repeated uploads preserve original attachments and deletion waits for admitted upload',async()=>{
 const t=await tasks.create({name:'upload guard',queued:true});assert.ok(t.ok);const id=Number(t.task.id),rows=await Promise.all([upload('task',id,'same.txt','first'),upload('task',id,'same.txt','second')]);assert.deepEqual(rows.map(a=>a.name).sort(),['same-1.txt','same.txt']);assert.deepEqual((await Promise.all(rows.map(a=>readFile(a.abs,'utf8')))).sort(),['first','second']);
 await until(()=>!(engine as any).operations.get(id)?.size,'earlier completed upload cleanup did not finish');
 const boundary='upload-guard',prefix=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\n\r\n`;
 const req=request(origin+`/api/chat/upload?scope=task&id=${id}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':`multipart/form-data; boundary=${boundary}`}});
 const response=new Promise<number>((resolve,reject)=>{req.once('response',res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));});req.once('error',reject);});response.catch(()=>{});req.write(prefix+'PARTIAL');
 await until(()=>(engine as any).operations.get(id)?.size>0,'upload admission not reached');let drained=false;const deletion=engine.beginDelete(id).then(()=>{drained=true;});await new Promise(r=>setTimeout(r,30));assert.equal(drained,false,'deletion must await active multipart parsing');
 try{assert.equal((await uploadDuringDelete(id)).status,409);req.end(`DONE\r\n--${boundary}--\r\n`);assert.equal(await response,200);await deletion;assert.equal(drained,true);assert.equal(await readFile(path.join(taskWorkDir(config,id),'uploads','slow.txt'),'utf8'),'PARTIALDONE');}
 finally{req.destroy();await deletion;engine.endDelete(id);}
});
async function uploadDuringDelete(id:number){const f=new FormData();f.append('file',new Blob(['x']),'blocked.txt');return call(`/api/chat/upload?scope=task&id=${id}`,'POST',f);}
