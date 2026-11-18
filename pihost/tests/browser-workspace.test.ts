import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {registerGraphTools} from '../src/domains/exploration/tools.ts';
import {BROWSER_GUIDANCE} from '../src/domains/browser/tools.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {AssetContextService} from '../src/domains/assets/context.ts';
import {TaskBrowsers} from '../src/domains/browser/task-browser.ts';
import {TrafficRuntime} from '../src/domains/traffic/runtime.ts';
import {bindTargetRoute} from '../src/domains/traffic/network.ts';
import {bindNetworkProvider} from '../src/domains/network/context.ts';
import {bindBrowserAuth} from '../src/domains/browser/auth.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import {registerTaskBrowserTool} from '../src/domains/browser/tools.ts';
import {runTool} from '../src/domains/tools/gate.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';

test('real Chromium workspace: human login, isolated environments, tabs, Worker/HTTP auth, pause, cancellation and capture',async()=>{
 const cfg=loadConfig(),schema='browser_workspace_'+process.pid+'_'+Date.now();
 const admin=new Pool({connectionString:cfg.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:cfg.database.dsn,options:'-c search_path='+schema}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-browser-workspace-test-'));
 const requests:{url:string;sid:string;auth:string}[]=[];
 const target=createServer((req,res)=>{
  const url=new URL(req.url!,'http://fixture'),sid=/sid=([^;]+)/.exec(req.headers.cookie??'')?.[1]??'anonymous';
  requests.push({url:req.url!,sid,auth:req.headers.authorization??''});
  if(url.pathname==='/login'&&req.method==='POST'){
   let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{const user=new URLSearchParams(data).get('user');res.writeHead(303,{'set-cookie':'sid='+user+'; HttpOnly; Path=/; SameSite=Lax',location:'/home'});res.end();});return;
  }
  if(url.pathname==='/rotate'){res.setHeader('set-cookie','sid=rotated; HttpOnly; Path=/');res.end('rotated');return;}
  if(url.pathname==='/slow'){setTimeout(()=>{if(!res.destroyed)res.end('slow');},2000);return;}
  if(url.pathname==='/who'||url.pathname==='/token'){res.setHeader('content-type','application/json');res.end(JSON.stringify({sid,authorization:req.headers.authorization??''}));return;}
  res.setHeader('content-type','text/html');
  if(url.pathname==='/login')res.end('<form method="POST" action="/login"><input autofocus name="user" aria-label="Account"><button>Login</button></form>');
  else if(url.pathname==='/session')res.end('<div id="state"></div><script>document.querySelector("#state").textContent="Session "+(sessionStorage.getItem("tab")||"blank")+" Local "+(localStorage.getItem("account")||"blank")</script>');
  else res.end('<h1>Signed '+sid+'</h1><script>localStorage.setItem("account",'+JSON.stringify(sid)+');sessionStorage.setItem("tab",'+JSON.stringify(sid)+');fetch("/token",{headers:{Authorization:"Bearer-'+sid+'"}})</script>');
 });
 await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(target.address() as {port:number}).port;
 const settings={get:()=>({trafficCapture:true,globalProxy:''})} as any,traffic=new TrafficRuntime(dir,settings),notes:string[]=[];
 const assets=new AssetsService(pool,path.join(dir,'events')),browsers=new TaskBrowsers(pool,traffic,assets,async(_id,message)=>{if(message)notes.push(message);});
 let web:ReturnType<typeof createServer>|undefined;
 const browserScopes:boolean[]=[];
 try{
  await runMigrations(pool);await traffic.start();
  bindTargetRoute(()=>({proxy:traffic.proxy.address(),caFile:traffic.proxy.caFile,capture:traffic.store}));
  bindNetworkProvider(async(taskId,human)=>{browserScopes.push(!!human);return {taskId,mode:'standard'};});
  bindBrowserAuth((ctx,id,url)=>browsers.authHeaders(ctx,id,url));
  const tasks=new TaskService(pool,path.join(dir,'events'),()=>{});
  const made=await tasks.create({name:'browser integration fixture',goal:'Inspect '+origin,modeling_targets:[origin],queued:true});assert.ok(made.ok);
  const taskId=Number(made.task.id);await new AssetContextService(pool).addScope(taskId,'ip','127.0.0.1','controlled fixture');
  const auth=new AuthService(pool,path.join(dir,'jwt.key')),token=(await auth.init('browser-fixture-auth-123')).token!;
  web=createServer((req,res)=>void routeRequest(req,res,{pool,config:cfg,auth,taskBrowsers:browsers} as any));
  await new Promise<void>(resolve=>web!.listen(0,'127.0.0.1',resolve));
  const apiBase='http://127.0.0.1:'+(web.address() as {port:number}).port+'/api/tasks/'+taskId+'/browser';
  const api=async(endpoint:string,body?:unknown)=>{
   const res=await fetch(apiBase+endpoint,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
   const result=await res.json() as any;assert.equal(res.status,200,JSON.stringify(result));return result;
  };
  assert.equal((await api('')).can_open,true,'browser is available before Agent startup');
  const a=await api('',{url:origin+'/login',name:'customer workspace'});
  const b=await api('',{url:origin+'/login',name:'independent workspace'});
  const human=(env:any,action:string,params:Record<string,unknown>={})=>api('/'+env.environment_id,{action,tab_id:env.tab_id,...params});
  const login=async(env:any,user:string)=>{
   await human(env,'point',{x:70,y:18});await human(env,'type',{text:user});await human(env,'enter');
   for(let i=0;i<40;i++){if(browsers.list(taskId).find(e=>e.id===env.environment_id)?.tabs.some(t=>t.url===origin+'/home'))break;await new Promise(r=>setTimeout(r,50));}
   await new Promise(r=>setTimeout(r,150));
  };
  await login(a,'alice');await login(b,'bob');
  await assert.rejects(browsers.execute({agentKey:'worker',businessKind:'worker',businessId:'worker-before-start',taskId},{action:'list'}),/任务当前/);
  await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[taskId]);
  const ctx={agentKey:'worker',businessKind:'worker',businessId:'workspace-worker',taskId};
  const blocked=await browsers.execute(ctx,{action:'snapshot',environment_id:a.environment_id,tab_id:a.tab_id});
  assert.equal((blocked as any).status,'waiting_for_user');
  await human(a,'handoff',{note:'Use current login to review the page'});
  await human(b,'handoff',{note:'Independent account'});
  assert.equal(notes.length,2);
  const authA=await browsers.authHeaders(ctx,a.environment_id,origin+'/who'),authB=await browsers.authHeaders(ctx,b.environment_id,origin+'/who');
  assert.match(authA.headers.cookie,/sid=alice/);assert.match(authB.headers.cookie,/sid=bob/);
  assert.equal(authA.headers.authorization,'Bearer-alice');assert.equal(authB.headers.authorization,'Bearer-bob');
  const snapshot=await browsers.execute(ctx,{action:'snapshot',environment_id:a.environment_id,tab_id:a.tab_id});assert.match(JSON.stringify(snapshot),/Signed alice/);
  const tab=await browsers.execute(ctx,{action:'new_tab',environment_id:a.environment_id,url:origin+'/session'}) as any;
  assert.notEqual(tab.tab_id,a.tab_id);assert.match(tab.snapshot,/Session blank Local alice/);
  registerBusinessTools({assets,findings:new FindingsService(pool,path.join(dir,'events'))});await registerTaskBrowserTool(pool,browsers);
  const who=await runTool(pool,'http_request',{url:origin+'/who',browser_environment:b.environment_id},ctx);
  assert.equal(who.status,'executed',JSON.stringify(who));assert.match(JSON.stringify(who.output),/bob/);
  assert.ok((who.output as any).capture_id);assert.equal((who.output as any).browser_auth.environment_id,b.environment_id);
  assert.equal(requests.filter(r=>r.url==='/who').at(-1)?.sid,'bob');
  assert.equal(requests.filter(r=>r.url==='/who').at(-1)?.auth,'Bearer-bob');
  const anonymous=await runTool(pool,'http_request',{url:origin+'/who'},ctx);assert.match(JSON.stringify(anonymous.output),/anonymous/);
  const clean=await browsers.execute(ctx,{action:'new_environment',name:'anonymous',url:origin+'/home'}) as any;
  assert.match(clean.snapshot,/Signed anonymous/);
  await assert.rejects(browsers.humanOpen(taskId,{url:origin+'/login'}),/并发已满/);
  await browsers.humanAction(taskId,clean.environment_id,'close_environment',{});
  if(process.env.WORMHOLE_BROWSER_LIVE==='1'){
    browsers.releaseWorker(taskId,ctx.businessId);
    const production=JSON.parse(await readFile('/var/lib/wormhole/config.json','utf8'));
    const live=new Pool({connectionString:production.database.dsn});let source:any;
    try{source=(await live.query('SELECT * FROM llm_profiles ORDER BY is_default DESC,id LIMIT 1')).rows[0];}finally{await live.end();}
    assert.ok(source?.api_key);
    const config={...cfg,dataDir:dir,pi:{...cfg.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};
    const llm=new LlmService(pool,path.join(dir,'events'),config.pi.modelsPath);
    const profile=await llm.createProfile({...source,name:'browser-real-model-qa',max_tokens:4096,thinking_type:'disabled',reasoning_effort:'',is_default:false});assert.ok(profile.ok);
    await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
    const graph=new ExplorationService(pool);await graph.ensure(taskId);
    const intentId=await graph.addIntent(taskId,{summary:'核对两个已交接浏览器环境的当前登录身份，保存证据，不测试漏洞'});
    registerGraphTools(pool,graph,()=>{});
    const ctl=new AbortController(),businessId='task-'+taskId+'-intent-'+intentId;
    const liveCtx={...ctx,businessId,intentId,signal:ctl.signal};
    const tools=await assembleTools(pool,['task_browser','http_request','record_fact'],liveCtx,{});
    const spec=await new AgentsService(pool,path.join(dir,'events')).resolveSessionSpec('worker');
    const host=await createHostedSession(pool,config,{kind:'worker',businessId,systemPrompt:spec.systemPrompt+BROWSER_GUIDANCE,provider:'profile-'+profile.profile!.id,modelId:source.model,customTools:tools,customToolsOnly:true,activity:{taskId,nodeId:intentId,worker:'browser-live'}});
    const timer=setTimeout(()=>{ctl.abort();void host.session.abort();},180000);
    try{
      await host.session.prompt('执行本轮意图：用户已在任务浏览器的 customer workspace 和 independent workspace 完成登录并交接。请查看现有环境，分别使用其认证请求 '+origin+'/who，核对两个环境各自返回的身份，把来源请求、结果和环境名称用 record_fact 写回。不要新建环境、不要登录、不要测试漏洞。仅允许各环境一次 /who GET。浏览器信息以工具返回为准，最多六次工具调用后收尾。');
      await host.flushEvents();assert.ok(!host.modelFailure);
      const calls=(await pool.query('SELECT tool_key,params,result,is_error FROM tool_calls WHERE business_id=$1 ORDER BY id',[businessId])).rows;
      assert.ok(calls.some(c=>c.tool_key==='task_browser'&&c.params.action==='list'&&!c.is_error));
      const http=calls.filter(c=>c.tool_key==='http_request'&&!c.is_error);
      assert.ok(http.some(c=>c.params.browser_environment===a.environment_id&&JSON.stringify(c.result).includes('alice')));
      assert.ok(http.some(c=>c.params.browser_environment===b.environment_id&&JSON.stringify(c.result).includes('bob')));
      assert.ok(calls.some(c=>c.tool_key==='record_fact'&&!c.is_error));
      await writeFile('/root/wormhole-browser-workspace-qa-20261112/live-model.json',JSON.stringify({model:source.model,checks:{environment_list:true,account_alice:true,account_bob:true,fact_written:true},tools:calls.map(c=>({tool:c.tool_key,error:c.is_error}))}),{mode:0o600});
    }finally{clearTimeout(timer);await host.dispose();browsers.releaseWorker(taskId,businessId);}
  }
  const rotated=await runTool(pool,'http_request',{url:origin+'/rotate',browser_environment:a.environment_id},ctx);assert.equal(rotated.status,'executed');
  assert.match((await browsers.authHeaders(ctx,a.environment_id,origin+'/who')).headers.cookie,/sid=rotated/);
  await assert.rejects(browsers.authHeaders({...ctx,taskId:taskId+999},a.environment_id,origin+'/who'));
  await assert.rejects(browsers.authHeaders(ctx,a.environment_id,'http://127.0.0.1:1/outside'));
  // User takes an existing page, while the task pauses Agent execution.
  await browsers.execute(ctx,{action:'snapshot',environment_id:a.environment_id,tab_id:tab.tab_id});
  const beforePauseB=browsers.list(taskId).find(e=>e.id===b.environment_id)!.tabs.length;
  await human(a,'take');await pool.query('UPDATE tasks SET paused=true WHERE id=$1',[taskId]);browsers.pauseTask(taskId);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(browsers.list(taskId).find(e=>e.id===b.environment_id)!.tabs.length,beforePauseB,'idle pages survive pause');
  await human(a,'navigate',{url:origin+'/home'});
  assert.ok(browsers.list(taskId).some(e=>e.id===a.environment_id&&e.tabs.some(t=>t.human)));
  await assert.rejects(browsers.execute(ctx,{action:'list'}),/任务当前/);
  await assert.rejects(browsers.authHeaders(ctx,a.environment_id,origin+'/who'),/任务当前/);
  await pool.query('UPDATE tasks SET paused=false WHERE id=$1',[taskId]);
  await human(a,'handoff');
  const resumed=await browsers.execute(ctx,{action:'open',environment_id:a.environment_id,url:origin+'/home'}) as any;
  assert.match(resumed.snapshot,/Signed rotated/,'Worker resumes in a free page without stale ownership');
  const ctl=new AbortController();
  const slow=browsers.execute({...ctx,signal:ctl.signal},{action:'open',environment_id:a.environment_id,url:origin+'/slow'});
  setTimeout(()=>ctl.abort(),150);await assert.rejects(slow);
  assert.ok(browsers.list(taskId).some(e=>e.id===b.environment_id),'cancellation never destroys other environments');
  assert.ok(browserScopes.includes(true),'browser uses browser-specific network admission');
  await browsers.stopTask(taskId);assert.deepEqual(browsers.list(taskId),[]);
 }finally{
  await browsers.shutdown();await traffic.close();bindBrowserAuth(undefined);bindNetworkProvider(undefined);bindTargetRoute(null);
  web?.closeAllConnections();if(web)await new Promise<void>(r=>web!.close(()=>r()));
  target.closeAllConnections();await new Promise<void>(r=>target.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
