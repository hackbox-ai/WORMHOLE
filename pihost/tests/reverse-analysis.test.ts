import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {zipSync,strToU8} from 'fflate';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {CodeIntelService} from '../src/domains/codeintel/service.ts';
import {WhiteboxClient} from '../src/domains/codeintel/client.ts';
import {downloadArtifact,downloadTo,registerCodeIntelTools} from '../src/domains/codeintel/tools.ts';
import {ReverseRuntime} from '../src/domains/reverse/runtime.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {SkillsService} from '../src/domains/skills/service.ts';
import {augmentSession} from '../src/domains/mcp/session.ts';
import {AnalysisSlots,analysisSlots} from '../src/domains/reverse/resources.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
import {TrafficProxy} from '../src/domains/traffic/proxy.ts';
import {bindTargetRoute,targetRequest} from '../src/domains/traffic/network.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
import {getTool} from '../src/domains/tools/gate.ts';

test('analysis leases bound memory residency, preserve FIFO and cancel queued work',async()=>{
 const slots=new AnalysisSlots(),release=await slots.acquire(),abort=new AbortController(),order:string[]=[];
 const blocked=slots.acquire(abort.signal);abort.abort();await assert.rejects(blocked,/取消/);
 const second=slots.acquire().then(r=>{order.push('second');return r;});
 assert.deepEqual(slots.status(),{limit:1,active:1,queued:1});release();release();
 const end=await second;assert.deepEqual(order,['second']);assert.equal(slots.status().active,1);end();assert.equal(slots.status().active,0);
});

test('Worker code tools, strict external API contract, inferred evidence, settings and full MITM download',{timeout:120000},async t=>{
 const base=loadConfig(),schema='reverse_analysis_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:base.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-analysis-'));
 const code=new CodeIntelService(pool,dir),runtime=new ReverseRuntime(pool,code),servers:ReturnType<typeof createServer>[]=[],receipts:{method:string;url:string;body:Buffer}[]=[];
 let status='running',slowCancel=false,proxy:TrafficProxy|undefined,store:TrafficStore|undefined;
 const serve=async(handler:Parameters<typeof createServer>[0])=>{const s=createServer(handler);servers.push(s);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(s.address() as {port:number}).port;};
 try{
  await runMigrations(pool);await runtime.initialize();registerCodeIntelTools(code);
  const task=Number((await pool.query("WITH e AS(INSERT INTO explorations(goal) VALUES('local contract test') RETURNING id) INSERT INTO tasks(name,goal,status,exploration_id) SELECT 'analysis fixture','local fixture','running',id FROM e RETURNING id")).rows[0].id);
  const artifact=zipSync({'app.py':strToU8('def handler(request):\n return db.execute(request.args["q"])\n')});
  const endpoint=await serve(async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);const body=Buffer.concat(chunks),url=req.url!;
   receipts.push({method:req.method!,url,body});
   if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401);res.end('{}');return;}
   res.setHeader('content-type','application/json');
   if(url==='/api/health'){res.end('{"ok":true}');return;}
   if(url==='/api/repos/zip'){assert.match(req.headers['content-type']!,/multipart/);assert.ok(body.includes(Buffer.from('app.py')));res.end('{"repo":{"id":"repo-fixture","source":"zip"}}');return;}
   if(url==='/api/tasks'&&req.method==='POST'){const input=JSON.parse(body.toString());assert.deepEqual(input.repo_ids,['repo-fixture']);assert.equal(input.rounds,1);res.end('{"tasks":[{"id":"audit-fixture"}]}');return;}
   if(url==='/api/tasks/audit-fixture/stop'){assert.equal(req.method,'POST');if(slowCancel)return;status='stopped';res.end('{"ok":true}');return;}
   if(url==='/api/tasks/audit-fixture/findings'){res.end(JSON.stringify({findings:[{key:'proof-1',task_id:'audit-fixture',repo_id:'repo-fixture',title:'untrusted query',category:'SQL injection',file:'app.py',lines:'2',evidence:'fixture only'}]}));return;}
   if(url==='/api/tasks/audit-fixture'){res.end(JSON.stringify({task:{status,findings:status==='done'?[{}]:[]}}));return;}
   if(url.startsWith('/api/repos/repo-fixture/search?')){res.end('{"matches":[{"path":"app.py","line":2,"text":"db.execute(request.args[q])"}],"scanned":1,"truncated":false}');return;}
   if(url.startsWith('/api/repos/repo-fixture/file?')){res.end('{"content":"def handler(request): return db.execute(request.args[q])","lines":2,"truncated":false}');return;}
   if(url.startsWith('/api/repos/repo-fixture/tree?')){res.end('{"files":[{"name":"app.py","path":"app.py"}],"dirs":[],"total":1}');return;}
   res.writeHead(404);res.end('{}');
  });
  const auth=new AuthService(pool,path.join(dir,'auth.key')),token=(await auth.init('local-fixture-only-1234')).token!;
  const ctx={pool,config:{...base,dataDir:dir},auth,taskEngine:{reverseRuntime:runtime}} as unknown as AppContext;
  const api=await serve((q,r)=>void routeRequest(q,r,ctx));
  const call=async(route:string,method='GET',body?:unknown)=>{const r=await fetch(api+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};};
  await t.test('authenticated settings, validation, live config and secret redaction',async()=>{
   assert.equal((await fetch(api+'/api/reverse/capabilities')).status,401);
   assert.equal((await call('/api/reverse/capabilities','PUT',{native_concurrency:4})).status,400);
   assert.equal((await call('/api/reverse/capabilities','PUT',{audit_enabled:true})).status,400);
   const saved=await call('/api/reverse/capabilities','PUT',{service_url:endpoint,service_token:'fixture-token',index_enabled:true});
   assert.equal(saved.status,200);assert.equal(saved.data.settings.service_token_set,true);assert.ok(!JSON.stringify(saved.data).includes('fixture-token'));
   assert.equal(saved.data.components.find((c:any)=>c.key==='whitebox').state,'available');
   const events=(await pool.query("SELECT payload FROM business_events WHERE event_type='reverse_settings_changed'")).rows;assert.ok(!JSON.stringify(events).includes('fixture-token'));
  });
  await writeFile(path.join(dir,'fixture.c'),'int main(){return 23;}');
  if(process.env.WORMHOLE_REVERSE_INTEGRATION==='1')execFileSync('gcc',[path.join(dir,'fixture.c'),'-o',path.join(dir,'fixture-bin')]);
  await t.test('Worker Skill unlock calls actual REA, stop cancels queued sessions and releases memory lease',{skip:process.env.WORMHOLE_REVERSE_INTEGRATION!=='1'},async()=>{
   const mcp=new McpService(pool,dir+'/events.jsonl'),skills=new SkillsService(pool,dir+'/events.jsonl',dir+'/skills');
   const root=process.env.WORMHOLE_TOOLS_DIR??'/opt/wormhole/tools';
   const created=await mcp.create({name:'rea',transport:'stdio',command:process.execPath,args:[root+'/rea/node_modules/rea-agents/scripts/rea.mjs','--mcp'],enabled:true,env:{GHIDRA_INSTALL_DIR:root+'/ghidra',JAVA_HOME:root+'/jdk',GHIDRA_HEADLESS_MAXMEM:'1G',JAVA_TOOL_OPTIONS:'-XX:ActiveProcessorCount=2'}});
   assert.ok(created.ok);assert.equal((await mcp.refresh(Number(created.server.id))).ok,true);
   await skills.create('local-rea','fixture');
   await skills.writeFile('local-rea','SKILL.md',"---\nname: local-rea\ndescription: actual REA fixture\nmcps: [rea]\n---\nInspect the fixture only.\n");
   await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','skill','local-rea') ON CONFLICT DO NOTHING");
   const firstAbort=new AbortController(),secondAbort=new AbortController();
   const make=(signal:AbortSignal,id:string)=>augmentSession(pool,mcp,skills,{taskId:task,agentKey:'worker',businessKind:'worker',businessId:id,cwd:dir,signal},{});
   const first=await make(firstAbort.signal,'first'),second=await make(secondAbort.signal,'second');
   const invoke=(a:typeof first,name:string,args:unknown)=>(a.tools.find(t=>t.name===name)!.execute as any)('fixture-'+Date.now(),args);
   try{
    await invoke(first,'Skill',{name:'local-rea'});await invoke(second,'Skill',{name:'local-rea'});
    const schema=await invoke(first,'SearchExtraTools',{query:'select:open_binary'});assert.match(JSON.stringify(schema),/mcp__rea__open_binary/);
    const answer=await invoke(first,'ExecuteExtraTool',{tool_name:'mcp__rea__open_binary',params:{path:path.join(dir,'fixture-bin')}});
    assert.ok(!answer.isError);assert.equal(analysisSlots.status().active,1);
    const waiting=invoke(second,'ExecuteExtraTool',{tool_name:'mcp__rea__open_binary',params:{path:path.join(dir,'fixture-bin')}});
    const rejected=assert.rejects(waiting,/取消|abort/i);
    for(let i=0;i<100&&analysisSlots.status().queued!==1;i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(analysisSlots.status().queued,1);secondAbort.abort();await rejected;
    firstAbort.abort();
   }finally{await first.dispose();await second.dispose();}
   assert.deepEqual(analysisSlots.status(),{active:0,queued:0,limit:1});
  });
  const source=path.join(dir,'fixture.zip');await writeFile(source,artifact);
  await t.test('index import → Worker search/read → one audit → inferred graph clues without confirmed findings',async()=>{
   await code.ingestFile(task,0,source);await code.tick(task);
   const toolCtx={taskId:task,businessKind:'worker',businessId:'fixture',agentKey:'worker',cwd:dir};
   const search=await getTool('search_target_code')!.execute({pattern:'db.execute'},toolCtx);
   assert.match(JSON.stringify(search),/app.py/);
   assert.match(JSON.stringify(await getTool('read_target_code')!.execute({path:'app.py'},toolCtx)),/handler/);
   await getTool('list_target_code')!.execute({},toolCtx);
   await getTool('audit_target_code')!.execute({},toolCtx);
   await getTool('audit_target_code')!.execute({},toolCtx);
   assert.equal(receipts.filter(x=>x.url==='/api/tasks'&&x.method==='POST').length,1);
   status='done';await code.tick(task,undefined,'collect');await code.tick(task,undefined,'collect');
   const clues=(await pool.query("SELECT payload FROM exploration_nodes WHERE task_id=$1 AND payload->>'kind'='code_finding'",[task])).rows;
   assert.equal(clues.length,1);assert.equal(clues[0].payload.confidence,'inferred');
   assert.equal(Number((await pool.query('SELECT count(*) FROM findings')).rows[0].count),0);
   const summary=await call('/api/tasks/'+task+'/code-analysis');assert.equal(summary.data.clues,1);assert.equal(summary.data.sources[0].state,'indexed');
  });
  await t.test('stop persists cancellation before an unresponsive service and returns in a bounded interval',async()=>{
   const row=(await pool.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND payload->>'kind'='code_ready'",[task])).rows[0];
   await pool.query("UPDATE exploration_nodes SET payload=payload || '{\"audit_state\":\"running\",\"audit_task_id\":\"audit-fixture\"}'::jsonb WHERE id=$1",[row.id]);
   slowCancel=true;const start=Date.now();await code.stopTask(task);assert.ok(Date.now()-start<8000);
   assert.equal((await pool.query('SELECT payload FROM exploration_nodes WHERE id=$1',[row.id])).rows[0].payload.audit_state,'cancel_pending');
   assert.equal((await call('/api/reverse/capabilities','PUT',{service_url:'http://127.0.0.1:1'})).status,400);
   slowCancel=false;await code.stopTask(task);
   assert.equal((await pool.query('SELECT payload FROM exploration_nodes WHERE id=$1',[row.id])).rows[0].payload.audit_state,'stopped');
   assert.ok(receipts.every(r=>r.method!=='DELETE'),'external records are retained');
  });
  await t.test('20 MiB binary streams through actual MITM with full blob, matching hash, attribution and cleanup',async()=>{
   const body=Buffer.alloc(20*1024*1024,0x61);body[0]=0;
   const target=await serve((req,res)=>{if(req.url==='/zip'){res.writeHead(200,{'content-type':'application/zip'});res.end(artifact);return;}res.writeHead(200,{'content-type':'application/octet-stream','content-length':body.length});res.end(body);});
   store=new TrafficStore(path.join(dir,'traffic'));proxy=new TrafficProxy(store);await proxy.start();bindTargetRoute(()=>({proxy:proxy!.address(),caFile:proxy!.caFile,capture:store}));
   const dest=path.join(dir,'large.bin'),result=await downloadTo(target+'/large',dest,body.length+1,undefined,{taskId:task,intentId:0});
   assert.equal(result.sha256,createHash('sha256').update(body).digest('hex'));assert.equal((await readFile(dest)).length,body.length);
   const row=store.page(new URLSearchParams(),0,100).exchanges[0]!;assert.equal(row.resp_len,body.length);
   const raw=store.get(row.id);assert.ok(raw);assert.match(JSON.stringify(raw),new RegExp(result.sha256));
   assert.equal(store.context(row.id)?.taskId,task);
   assert.equal(store.receipt(store.context(row.id)!.requestId,'wire'),row.id);
   assert.equal(createHash('sha256').update(await readFile(store.blobFile(result.sha256).file)).digest('hex'),result.sha256);
   assert.equal((await readdir(path.join(store.dir,'_capture-tmp'))).length,0);
   await assert.rejects(downloadTo(target+'/large',path.join(dir,'rejected.bin'),1024),/过大/);
   await assert.rejects(readFile(path.join(dir,'rejected.bin')),/ENOENT/);
   const limited=await targetRequest(target+'/large','GET',undefined,AbortSignal.timeout(10000));assert.equal(limited.truncated,true);assert.equal(limited.bytes.length,16*1024*1024);
   code.configure({enabled:false});
   const downloaded=await downloadArtifact(code,{taskId:task,intentId:0,cwd:dir},{url:target+'/zip'});assert.equal(downloaded.indexed,false);
   const summary=await runtime.taskSummary(task);assert.equal(summary.sources.length,1,'same SHA is shown once, preferring the indexed source');
   assert.equal(Number((await pool.query("SELECT count(*) FROM exploration_nodes WHERE task_id=$1 AND payload->>'kind'='artifact_download'",[task])).rows[0].count),1,'downloads remain recorded while indexing is disabled');
  });
 }finally{
  bindTargetRoute(null);code.stopCancelSweeper();await proxy?.stop();store?.close();
  for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
