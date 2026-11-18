import {executeCustom} from '../src/domains/tools/custom-executor.ts';
import {generalTools} from '../src/domains/tools/general.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer as tcpServer,connect} from 'node:net';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {Pool} from 'pg';
import {unzipSync,strFromU8} from 'fflate';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {NetworkChannels} from '../src/domains/network/channels.ts';
import {bindNetworkProvider,inTaskNetwork} from '../src/domains/network/context.ts';
import {TrafficRuntime} from '../src/domains/traffic/runtime.ts';
import {targetRequest,bindTargetRoute} from '../src/domains/traffic/network.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {ModelingService} from '../src/domains/modeling/service.ts';
import {SettingsService} from '../src/domains/settings/service.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {TaskBrowsers} from '../src/domains/browser/task-browser.ts';
import {targetSpawn} from '../src/domains/network/sandbox.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import {runTool} from '../src/domains/tools/gate.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';
const frp=process.env.WORMHOLE_FRP_DIR??'/opt/wormhole/network/frp-0.72.0';
async function port(){const s=tcpServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return n;}
async function wait(check:()=>Promise<boolean>,ms=15000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('condition timeout');}
async function kill(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
test('real reverse channels isolate tasks and namespaces without direct fallback',
 {skip:process.env.WORMHOLE_NETWORK_INTEGRATION!=='1',timeout:120000},async t=>{
 const config=loadConfig();assert.match(new URL(config.database.dsn).pathname,/test/i);
 const schema='codex_network_'+process.pid+'_'+Date.now(),dir=await mkdtemp('/tmp/wormhole-network-');
 config.dataDir=dir;config.pi={...config.pi,agentDir:dir+'/agent',modelsPath:dir+'/models.json'};await mkdir(config.pi.agentDir);await writeFile(config.pi.modelsPath,'{"providers":{}}');
 const admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
 const settings=new SettingsService(pool,dir+'/events.jsonl');
 const traffic=new TrafficRuntime(dir,{get:()=>({trafficCapture:true,globalProxy:''})} as any);
 const entryPort=await port();
 const channels=new NetworkChannels(pool,traffic,dir,entryPort),tasks=new TaskService(pool,dir+'/events.jsonl',()=>{}),models=new ModelingService(pool);
 const children:ChildProcess[]=[],bridges:ReturnType<typeof tcpServer>[]=[];
 const sockets=new Set<import('node:net').Socket>();
 let browsers:TaskBrowsers|undefined;let site:ReturnType<typeof createServer>|undefined;
 let childB=0;
 const proof:Record<string,unknown>={};
 try{
  await runMigrations(pool);await traffic.start();await channels.start();
  site=createServer((_req,res)=>{res.writeHead(404);res.end();});
  site.on('connect',(req,socket,head)=>void channels.handleConnect(req,socket as import('node:net').Socket,head));
  site.listen(entryPort,'127.0.0.1');await once(site,'listening');
  bindTargetRoute(()=>traffic.route());bindNetworkProvider((id,human)=>channels.scope(id,human));
  const assets=new AssetsService(pool,dir+'/events.jsonl'),findings=new FindingsService(pool,dir+'/events.jsonl');
  registerBusinessTools({assets,findings});
  const httpPort=await port(),tlsPort=await port();
  const make=async(marker:string)=>{
   const row=await channels.create({name:marker,server_host:'127.0.0.1',scopes:['inside.wormhole.test','127.0.0.1']});
   const folder=dir+'/'+marker;await mkdir(folder);
   const archive=unzipSync(await channels.connector(Number(row.id),'linux_amd64'));
   assert.ok(!Object.keys(archive).includes('server.key'));
   let client=strFromU8(archive['frpc.toml']!);
   await writeFile(folder+'/frpc.toml',client,{mode:0o600});await writeFile(folder+'/ca.pem',archive['ca.pem']!);
   await writeFile(folder+'/hosts','127.0.0.1 localhost inside.wormhole.test\n');
   const ca=path.dirname(traffic.proxy.caFile);
   execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',folder+'/target.key','-out',folder+'/target.csr','-subj','/CN=inside.wormhole.test'],{stdio:'ignore'});
   await writeFile(folder+'/target.ext','subjectAltName=DNS:inside.wormhole.test,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
   execFileSync('openssl',['x509','-req','-in',folder+'/target.csr','-CA',traffic.proxy.caFile,'-CAkey',ca+'/rootCA.key','-set_serial',String(Number(row.id)),'-out',folder+'/target.crt','-days','1','-extfile',folder+'/target.ext'],{stdio:'ignore'});
   const controlSocket=folder+'/control.sock';
   const bridge=tcpServer(incoming=>{const outgoing=connect(entryPort,'127.0.0.1');for(const s of [incoming,outgoing]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{incoming.destroy();outgoing.destroy();});}incoming.pipe(outgoing).pipe(incoming);});
   bridge.listen(controlSocket);await once(bridge,'listening');bridges.push(bridge);
   const child=spawn('unshare',['--mount','--net','--pid','--fork','--kill-child','--propagation','private','python3',path.join(import.meta.dirname,'fixtures/network-jump.py'),controlSocket,String(entryPort),String(httpPort),String(tlsPort),folder,marker,frp+'/frpc'],{stdio:['ignore','pipe','pipe']});
   let diagnostics='';child.stderr?.on('data',x=>diagnostics+=x);child.stdout?.on('data',x=>diagnostics+=x);children.push(child);
   try{await wait(async()=>(await channels.list()).find(c=>c.id===row.id)?.status==='online');}catch(e){throw new Error(String(e)+'; connector='+diagnostics.slice(0,1200));}
   const created=await tasks.create({name:marker,goal:'http://inside.wormhole.test:'+httpPort,queued:true,network_mode:'jump',network_channel_id:Number(row.id)});assert.ok(created.ok);
   const task=Number(created.task.id);await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[task]);
   await mkdir(dir+'/work-'+task);
   return {row,task,child,client,folder};
  };
  const a=await make('JUMP_A'),b=await make('JUMP_B');
  const ctx=(id:number)=>({agentKey:'worker',taskId:id,businessKind:'worker',businessId:'task-'+id,cwd:dir+'/work-'+id,signal:AbortSignal.timeout(15000),manualInvocation:true,intentId:1});
  const request=(id:number,url='http://inside.wormhole.test:'+httpPort+'/api',method='GET',body?:string)=>inTaskNetwork(id,()=>targetRequest(url,method,body,AbortSignal.timeout(8000),undefined,{taskId:id}));
  await t.test('S cannot reach target directly; authenticated tunnel and remote DNS work',async()=>{
   await assert.rejects(()=>targetRequest('http://127.0.0.1:'+httpPort,'GET',undefined,AbortSignal.timeout(1500),undefined,undefined,{}, {proxy:'',caFile:''}));
   await assert.rejects(()=>targetRequest('http://inside.wormhole.test:'+httpPort,'GET',undefined,AbortSignal.timeout(1500),undefined,undefined,{}, {proxy:'',caFile:''}));
   const response=await request(a.task);assert.equal(JSON.parse(response.body).marker,'JUMP_A');assert.ok(response.capture_id);
   const https=await request(a.task,'https://inside.wormhole.test:'+tlsPort+'/secure');assert.equal(JSON.parse(https.body).marker,'JUMP_A');
   const post=await request(a.task,undefined,'POST','payload');assert.equal(JSON.parse(post.body).body,'payload');
   proof.directBlocked=true;proof.remoteDNS=true;proof.https=true;proof.capture=true;
  });
  await t.test('parallel tasks using the same private address do not cross routes',async()=>{
   const responses=await Promise.all(Array.from({length:8},(_,i)=>request(i%2?a.task:b.task,'http://127.0.0.1:'+httpPort+'/same')));
   assert.deepEqual(responses.map(r=>JSON.parse(r.body).marker),Array.from({length:8},(_,i)=>i%2?'JUMP_A':'JUMP_B'));
   const tool=await runTool(pool,'http_request',{url:'http://inside.wormhole.test:'+httpPort},ctx(a.task));
   assert.equal(tool.status,'executed');assert.equal(JSON.parse((tool.output as any).body).marker,'JUMP_A');proof.parallelIsolation=true;proof.realToolGate=true;
  });
  await t.test('custom HTTP and Python tools inherit the same isolated task route',async()=>{
   const url='http://inside.wormhole.test:'+httpPort+'/custom';
   const http=await inTaskNetwork(a.task,()=>executeCustom(pool,{key:'fixture_http',kind:'http',exec:{url}}, {},ctx(a.task) as any));
   assert.ok(JSON.stringify(http).includes('JUMP_A'));
   const code="import urllib.request,socket; print(urllib.request.urlopen('"+url+"',timeout=5).read().decode()); s=socket.socket(); s.settimeout(1); assert s.connect_ex(('127.0.0.1',"+httpPort+")) != 0; print('SCRIPT_DIRECT_BLOCKED')";
   const script=await inTaskNetwork(a.task,()=>executeCustom(pool,{key:'fixture_python',kind:'script',exec:{code}}, {},ctx(a.task) as any));
   assert.ok(JSON.stringify(script).includes('JUMP_A'));assert.ok(JSON.stringify(script).includes('SCRIPT_DIRECT_BLOCKED'));
   await assert.rejects(()=>inTaskNetwork(a.task,()=>executeCustom(pool,{key:'fixture_http',kind:'http',exec:{url:'http://outside.wormhole.test'}},{},ctx(a.task) as any)));
   proof.customHTTP=true;proof.customPython=true;
  });
  await t.test('native Pi worker uses server-side model calls and writes real jump response evidence',async()=>{
   const {startMockAnthropic}=await import('./fixtures/mock-anthropic.ts');
   const {LlmService}=await import('../src/domains/llm/service.ts');
   const {createHostedSession,resetPiRuntime}=await import('../src/pi/session-host.ts');
   const {assembleTools}=await import('../src/domains/tools/assembly.ts');
   const mock=await startMockAnthropic(0,{marker:'NETWORK_WORKER_DONE',tool:(body:any,n:number)=>{
    if(n===1)return {name:'http_request',input:{url:'http://inside.wormhole.test:'+httpPort+'/agent'}};
    if(n===2){const results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result');return {name:'Write',input:{file_path:'network-worker-proof.json',content:JSON.stringify(results)}};}
    return undefined;
   }});
   const llm=new LlmService(pool,dir+'/events.jsonl',config.pi.modelsPath);
   const profile=await llm.createProfile({name:'network-fixture',format:'anthropic',model:'mock-1',base_url:'http://127.0.0.1:'+(mock.server.address() as {port:number}).port,api_key:'synthetic-fixture-key'});
   assert.ok(profile.ok);await llm.activate(Number(profile.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
   const intent=Number((await pool.query("INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,state,claimed_by) SELECT id,exploration_id,'intent','Verify network path','{}','running','native-worker' FROM tasks WHERE id=$1 RETURNING id",[a.task])).rows[0].id);
   const owner={...ctx(a.task),manualInvocation:false,intentId:intent,businessId:'native-worker'};
   let session:Awaited<ReturnType<typeof createHostedSession>>|undefined;
   try{
    session=await createHostedSession(pool,config,{kind:'worker',businessId:'native-worker',cwd:owner.cwd,systemPrompt:'Use http_request to retrieve the endpoint. Save its actual tool result with Write, then finish.',provider:'profile-'+profile.profile!.id,modelId:'mock-1',customTools:await assembleTools(pool,['http_request'],owner as any,{}),activity:{taskId:a.task,nodeId:intent,worker:'native-worker'}});
    await session.session.prompt('Retrieve the supplied endpoint and save the observed response.');await session.flushEvents();
    const evidence=await readFile(owner.cwd+'/network-worker-proof.json','utf8');
    assert.match(evidence,/JUMP_A/);assert.ok(mock.state.calls.length>=3);
    assert.ok((await pool.query("SELECT 1 FROM tool_calls WHERE business_id=$1 AND tool_key='http_request' AND native_tool_call_id IS NOT NULL AND NOT is_error",['native-worker'])).rowCount);
    proof.nativeWorker=true;proof.nativeWorkerEvidence=true;
   }finally{await session?.dispose();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(resolve=>mock.server.close(()=>resolve()));}
  });
  await t.test('channel scopes reject other destinations before sending',async()=>{
   await assert.rejects(()=>request(a.task,'http://outside.wormhole.test:'+httpPort),/网络|通道/);
  });
  await t.test('changing defaults leaves existing bindings fixed and modeling inherits the parent',async()=>{
   assert.equal((await settings.apply({network_mode:'jump',network_channel_id:Number(b.row.id)})).ok,true);
   const next=await tasks.create({goal:'new default',queued:true});assert.ok(next.ok);assert.equal(String(next.task.network_channel_id),b.row.id);
   assert.equal(String((await tasks.get(a.task))!.network_channel_id),a.row.id);
   const model=await models.request({target:'http://inside.wormhole.test:'+httpPort,task_id:a.task,trigger:"initial",queued:true});
   assert.equal(String((await tasks.get(model.task_id))!.network_channel_id),a.row.id);
   const other=await models.request({target:'http://inside.wormhole.test:'+httpPort,task_id:b.task,trigger:"initial",queued:true});
   childB=other.task_id;assert.notEqual(model.task_id,other.task_id);
   proof.bindingSnapshot=true;proof.modelingInheritance=true;
  });
  await t.test('capture disabled keeps jump routing; bypassing proxy in shell cannot reach target',async()=>{
   (traffic as any).settings.get=()=>({trafficCapture:false,globalProxy:''});
   const r=await request(a.task);assert.equal(JSON.parse(r.body).marker,'JUMP_A');assert.equal(r.capture_id,undefined);
   const output=await inTaskNetwork(a.task,async()=>{
    const launch=targetSpawn({command:`curl -fsS --max-time 5 http://inside.wormhole.test:${httpPort}/shell; if curl --noproxy "*" -fsS --max-time 1 http://127.0.0.1:${httpPort}/ >/dev/null 2>&1; then exit 42; fi; python3 -c "import socket; s=socket.socket(); s.settimeout(1); assert s.connect_ex(('127.0.0.1',${httpPort})) != 0; print('DIRECT_BLOCKED')"`,cwd:dir+'/work-'+a.task,env:{...process.env}});
    return new Promise<string>((resolve,reject)=>{const c=spawn('bash',['-c',launch.command],{cwd:dir,env:launch.env});let text='';c.stdout.on('data',b=>text+=b);c.stderr.on('data',b=>text+=b);c.on('error',reject);c.on('exit',code=>code===0?resolve(text):reject(new Error(text)));});
   });assert.match(output,/JUMP_A/);assert.match(output,/DIRECT_BLOCKED/);proof.shellEgressIsolation=true;proof.captureOff=true;
  });
  await t.test('stopping the real shell tool drains its isolated background process',async()=>{
   const cwd=dir+'/work-'+a.task,heartbeat=cwd+'/heartbeat';
   const tools=await generalTools(pool,cwd,ctx(a.task) as any,{});
   try{
    const bash=tools.tools.find(x=>x.name==='Bash')!;
    await (bash.execute as any)('network-bg',{command:'while true; do printf x >> heartbeat; sleep 0.1; done',run_in_background:true});
    await wait(async()=>{try{return (await readFile(heartbeat)).length>0;}catch{return false;}});
    await tools.dispose();
    const length=(await readFile(heartbeat)).length;await new Promise(r=>setTimeout(r,250));
    assert.equal((await readFile(heartbeat)).length,length);
    proof.workerShellStopped=true;
   }finally{await tools.dispose();}
  });
  await t.test('browser login and HTTP observations use the selected channel',async()=>{
   browsers=new TaskBrowsers(pool,traffic,assets,()=>{});
   await pool.query("INSERT INTO task_scope(task_id,kind,domain) VALUES($1,'subdomain','inside.wormhole.test')",[a.task]);
   await assets.upsertSource({type:'service',url:'http://inside.wormhole.test:'+httpPort,task_id:a.task});
   const opened=await browsers.execute({...ctx(a.task),manualInvocation:false} as any,{action:'open',url:'http://inside.wormhole.test:'+httpPort+'/login'});
   assert.ok(JSON.stringify(opened).includes('JUMP_A'));
   const browserCtx={...ctx(a.task),manualInvocation:false} as any;
   await browsers.execute(browserCtx,{action:'fill',selector:'input[name=user]',text:'fixture-user'});
   await browsers.execute(browserCtx,{action:'click',selector:'button'});
   const after=await browsers.execute(browserCtx,{action:'navigate',url:'http://inside.wormhole.test:'+httpPort+'/after-login'});
   assert.ok(JSON.stringify(after).includes('fixture=JUMP_A'));
   proof.browser=true;proof.browserLogin=true;
  });
  await t.test('paused human browser keeps the selected jump channel while Worker traffic stops',async()=>{
   const environment=browsers!.list(a.task)[0]!,tab=environment.tabs[0]!;
   await browsers!.humanAction(a.task,environment.id,'take',{tab_id:tab.id});
   await pool.query('UPDATE tasks SET paused=true WHERE id=$1',[a.task]);
   browsers!.pauseTask(a.task);await channels.stopTask(a.task);
   await assert.rejects(()=>request(a.task));
   await assert.rejects(()=>browsers!.execute({...ctx(a.task),manualInvocation:false} as any,{action:'list'}));
   const result=await browsers!.humanAction(a.task,environment.id,'navigate',{tab_id:tab.id,url:'http://inside.wormhole.test:'+httpPort+'/after-login'});
   assert.ok(JSON.stringify(result).includes('fixture=JUMP_A'));
   await pool.query('UPDATE tasks SET paused=false WHERE id=$1',[a.task]);
   proof.pausedHumanBrowser=true;
  });
  await t.test('shared CONNECT entry rejects missing credentials and arbitrary destinations',async()=>{
   const {request:rawRequest}=await import('node:http');
   const check=(target:string,auth?:string)=>new Promise<number>(resolve=>{
    const req=rawRequest({host:'127.0.0.1',port:entryPort,method:'CONNECT',path:target,headers:auth?{'Proxy-Authorization':auth}:{}});
    req.on('connect',(res,socket)=>{resolve(res.statusCode??0);socket.destroy();});
    req.on('response',res=>{resolve(res.statusCode??0);res.resume();});req.on('error',()=>resolve(0));req.end();
   });
   assert.equal(await check('127.0.0.1:1'),407);
   const raw=a.client.match(/transport.proxyURL = "([^"]+)"/)![1]!,proxy=new URL(raw);
   assert.equal(await check('127.0.0.1:1','Basic '+Buffer.from(proxy.username+':'+proxy.password).toString('base64')),403);
   proof.sharedEntryAuthenticated=true;
  });
  await t.test('connector rejects invalid server identity and does not expose socks externally',async()=>{
   const bad=a.client.replace('loginFailExit = false','loginFailExit = true').replace('serverName = "wormhole-network-channel"','serverName = "wrong-identity"');
   await writeFile(a.folder+'/bad.toml',bad,{mode:0o600});
   const child=spawn(frp+'/frpc',['-c',a.folder+'/bad.toml'],{cwd:a.folder,stdio:['ignore','pipe','pipe']});children.push(child);let rejected='';child.stdout?.on('data',v=>rejected+=v);child.stderr?.on('data',v=>rejected+=v);
   const code=await Promise.race([new Promise<number|null>(resolve=>child.once('exit',resolve)),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('invalid TLS fixture did not exit')),5000))]);assert.notEqual(code,0);assert.match(rejected,/x509|certificate/i);proof.tlsIdentityVerified=true;
  });
  await t.test('disconnect fails closed and another channel stays operational',async()=>{
   await kill(a.child);await wait(async()=>(await channels.list()).find(c=>c.id===a.row.id)?.status==='offline');
   await assert.rejects(()=>request(a.task),/网络|通道|proxy|502/i);
   assert.equal(JSON.parse((await request(b.task)).body).marker,'JUMP_B');proof.disconnectNoFallback=true;
  });
  await t.test('pause/stop deny new traffic and release the task gateway',async()=>{
   await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[childB]);
   assert.equal(JSON.parse((await request(childB)).body).marker,'JUMP_B');
   const pending=request(b.task,'http://inside.wormhole.test:'+httpPort+'/slow');pending.catch(()=>{});
   await wait(async()=>{try{await readFile(b.folder+'/slow.started');return true;}catch{return false;}});
   await pool.query("UPDATE tasks SET status='failed',paused=false WHERE id=$1",[b.task]);await channels.stopTask(b.task);
   const outcome=await Promise.race([pending.then(()=>false,()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),1500))]);
   assert.equal(outcome,true,'in-flight HTTP must drain without waiting for its own deadline');
   await assert.rejects(()=>request(b.task));await assert.rejects(()=>request(childB));proof.backgroundModelStopped=true;proof.stop=true;proof.inFlightStopped=true;
  });
  if(process.env.WORMHOLE_NETWORK_PROOF)await writeFile(process.env.WORMHOLE_NETWORK_PROOF,JSON.stringify(proof,null,2));
 }finally{
  await browsers?.shutdown();await channels.close();await traffic.close();bindNetworkProvider(undefined);bindTargetRoute(null);
  for(const child of children)await kill(child);
  if(site){site.closeAllConnections();await new Promise<void>(r=>site!.close(()=>r()));}
  for(const s of sockets)s.destroy();for(const bridge of bridges)await new Promise<void>(r=>bridge.close(()=>r()));
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
