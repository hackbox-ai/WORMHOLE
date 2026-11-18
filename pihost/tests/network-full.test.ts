import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,connect,type Socket} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {Pool} from 'pg';
import {unzipSync,strFromU8} from 'fflate';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {NetworkChannels} from '../src/domains/network/channels.ts';
import {TrafficRuntime} from '../src/domains/traffic/runtime.ts';
import {bindNetworkProvider,inTaskNetwork} from '../src/domains/network/context.ts';
import {bindTargetRoute,targetRequest} from '../src/domains/traffic/network.ts';
import {targetSpawn} from '../src/domains/network/sandbox.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {ReverseProxies} from '../src/domains/reverse/proxy.ts';
import {McpService} from '../src/domains/mcp/service.ts';
import {connectMcp} from '../src/domains/mcp/client.ts';
import {augmentSession} from '../src/domains/mcp/session.ts';
const runtime=process.env.WORMHOLE_FRP_DIR??'/opt/wormhole/network/frp-0.72.0';
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
async function wait(fn:()=>Promise<boolean>,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('condition deadline');}
async function kill(p:ChildProcess){if(p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGTERM');await Promise.race([once(p,'exit'),new Promise(r=>setTimeout(r,4000))]);if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');}
test('complete network: two-hop routing, raw protocols, MCP and JS crypto isolation',{skip:process.env.WORMHOLE_NETWORK_INTEGRATION!=='1',timeout:180000},async t=>{
 const config=loadConfig();assert.match(new URL(config.database.dsn).pathname,/test/i);
 const dir=await mkdtemp('/tmp/wormhole-network-full-'),schema='codex_network_full_'+process.pid+'_'+Date.now();
 const admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
 const traffic=new TrafficRuntime(dir,{get:()=>({trafficCapture:true,globalProxy:''})} as any);
 const entry=await port(),channels=new NetworkChannels(pool,traffic,dir,entry),tasks=new TaskService(pool,dir+'/events.jsonl',()=>{});
 const children:ChildProcess[]=[],sockets=new Set<Socket>(),proof:Record<string,boolean>={};
 const bridge=createServer(c=>{const up=connect(entry,'127.0.0.1');for(const peer of [c,up]){sockets.add(peer);peer.on('error',()=>{c.destroy();up.destroy();});peer.on('close',()=>sockets.delete(peer));}c.pipe(up).pipe(c);});
 const site=httpServer((_q,r)=>{r.writeHead(404);r.end();});site.on('connect',(req,socket,head)=>void channels.handleConnect(req,socket as Socket,head));
 let reverse:ReverseProxies|undefined;
 try{
  await runMigrations(pool);await traffic.start();await channels.start();site.listen(entry,'127.0.0.1');await once(site,'listening');bridge.listen(dir+'/entry.sock');await once(bridge,'listening');
  bindNetworkProvider(id=>channels.scope(id));bindTargetRoute(()=>traffic.route());
  const parentRelay=await port();
  const make=async(name:string,parent?:any,scopes=['inside.full.test','10.88.0.2','fd90::2'])=>{
   const channel=await channels.create({name,server_host:'127.0.0.1',parent_channel_id:parent?.row.id??null,relay_listen:parent?'':'127.0.0.1:'+parentRelay,full_network:true,scopes});
   const folder=dir+'/'+name;await mkdir(folder);const archive=unzipSync(await channels.connector(Number(channel.id),'linux_amd64'));
   const cfg=JSON.parse(strFromU8(archive['connector.json']!));cfg.frpc=runtime+'/frpc';
   await writeFile(folder+'/connector.json',JSON.stringify(cfg),{mode:0o600});await writeFile(folder+'/frpc.toml',archive['frpc.toml']!,{mode:0o600});await writeFile(folder+'/ca.pem',archive['ca.pem']!);
   await writeFile(folder+'/hosts','127.0.0.1 localhost\n10.88.0.2 inside.full.test\n');
   const control=parent?parent.folder+'/relay.sock':dir+'/entry.sock',entryPort=parent?parentRelay:entry;
   const child=spawn('unshare',['--mount','--net','--pid','--fork','--kill-child','--propagation','private','python3',path.join(import.meta.dirname,'fixtures/network-full-jump.py'),folder,control,String(entryPort),String(parent?0:parentRelay),name,runtime+'/wormhole-connector'],{stdio:['ignore','pipe','pipe']});children.push(child);
   let diagnostics='';child.stderr?.on('data',b=>diagnostics+=b);child.stdout?.on('data',b=>diagnostics+=b);
   try{await wait(async()=>(await channels.list()).find(c=>c.id===channel.id)?.status==='online');}catch(e){throw Error(String(e)+' '+diagnostics.slice(-1800));}
   const created=await tasks.create({name,goal:'http://inside.full.test:19000',queued:true,network_mode:'jump',network_channel_id:Number(channel.id)});assert.ok(created.ok);const task=Number(created.task.id);
   await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[task]);
   const intent=Number((await pool.query("INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,state) SELECT $1,exploration_id,'intent','full network','running' FROM tasks WHERE id=$1 RETURNING id",[task])).rows[0].id);
   const cwd=path.join(dir,'workspace','tasks',String(task),'i'+intent);await mkdir(cwd,{recursive:true});
   return {row:channel,folder,child,task,intent,cwd,diagnostics:()=>diagnostics};
  };
  const a=await make('HOP_A'),b=await make('HOP_B',a);
  const census=(item:typeof a)=>new Promise<any>((resolve,reject)=>{const socket=connect(item.folder+'/diag.sock');let body='';socket.on('data',b=>body+=b);socket.on('error',reject);socket.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});});
  const request=(task:number,url='http://inside.full.test:19000/')=>inTaskNetwork(task,()=>targetRequest(url,'GET',undefined,AbortSignal.timeout(8000),undefined,{taskId:task}));
  const command=(item:typeof a,cmd:string,timeout=20000)=>inTaskNetwork(item.task,async()=>{
   const spec=targetSpawn({command:cmd,cwd:item.cwd,env:process.env});const child=spawn('/bin/bash',['-c',spec.command],{cwd:spec.cwd,env:spec.env,stdio:['ignore','pipe','pipe'],signal:AbortSignal.timeout(timeout)});
   let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
   const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)console.log('network diagnostics',JSON.stringify(await census(item)));assert.equal(code,0,err+'\n'+out);return out;
  });
  await t.test('deep site has no direct WORMHOLE entry, reaches WORMHOLE only via its parent relay',async()=>{
   assert.equal(JSON.parse((await request(b.task)).body).marker,'HOP_B');
   assert.deepEqual(b.row.chain.map((x:any)=>x.name),['HOP_A','HOP_B']);
   assert.equal((await channels.list()).find(c=>c.id===b.row.id)?.full_network_ready,true);
   const data=await Promise.all([request(a.task),request(b.task)]);assert.deepEqual(data.map(r=>JSON.parse(r.body).marker),['HOP_A','HOP_B']);
   await assert.rejects(()=>targetRequest('http://10.88.0.2:19000','GET',undefined,AbortSignal.timeout(1000),undefined,undefined,{}, {proxy:'',caFile:''}));
   proof.twoHop=true;proof.parallelIsolation=true;proof.noDirectRoute=true;
  });
  await t.test('child relay rejects web/API forwarding and packet service rejects invalid credentials',async()=>{
   const response=await new Promise<string>((resolve,reject)=>{const socket=connect(a.folder+'/relay.sock');let body='';socket.on('connect',()=>socket.end('GET /api/health HTTP/1.1\r\nHost: WORMHOLE\r\n\r\n'));socket.on('data',b=>body+=b);socket.on('end',()=>resolve(body));socket.on('error',reject);});assert.equal(response,'');
   const unauthorized=await new Promise<string>((resolve,reject)=>{const socket=connect(b.row.packet_port!,'127.0.0.1');let body='';socket.on('connect',()=>socket.write(JSON.stringify({op:'packets',token:'0'.repeat(64)})+'\n'));socket.on('data',b=>body+=b);socket.on('end',()=>resolve(body));socket.on('error',reject);});assert.equal(unauthorized,'');
   proof.relayRestricted=true;proof.packetAuthentication=true;
  });
  await t.test('native TCP/UDP, remote DNS, ICMPv4/v6 and IPv6 UDP traverse task TUN',async()=>{
   const script="import socket; s=socket.create_connection(('inside.full.test',19002),3);s.sendall(b'tcp');print(s.recv(100).decode());s.close();u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(3);u.sendto(b'udp',('10.88.0.2',19001));print(u.recv(100).decode());u.close();v=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);v.settimeout(3);v.sendto(b'udp6',('fd90::2',19001));print(v.recv(100).decode())";
   const out=await command(b,"python3 -c "+JSON.stringify(script));assert.match(out,/HOP_B:tcp/);assert.match(out,/HOP_B:udp/);assert.match(out,/HOP_B:udp6/);
   assert.match(await command(b,'ping -c 1 -W 3 10.88.0.2'),/1 received/);assert.match(await command(b,'ping -6 -c 1 -W 3 fd90::2'),/1 received/);
   proof.tcp=true;proof.udp=true;proof.remoteDNS=true;proof.icmp=true;proof.ipv6=true;
  });
  await t.test('connect and raw SYN port scans distinguish open/closed ports at remote site',async()=>{
   for(const kind of ['-sT','-sS']){const out=await command(b,'nmap -n -Pn '+kind+' --max-retries 1 --host-timeout 12s -p 19002,19003 -oX - 10.88.0.2');assert.match(out,/portid="19002"[\s\S]*?state="open"/);assert.match(out,/portid="19003"[\s\S]*?state="closed"/);}
   proof.connectScan=true;proof.synScan=true;
  });
  await t.test('out-of-scope packets have no egress and task has no host network access',async()=>{
   const script="import socket; s=socket.socket();s.settimeout(1);print(s.connect_ex(('10.88.0.6',19002)));s.close();print(open('/proc/self/status').read().split('CapBnd:')[1].splitlines()[0])";
   const out=await command(b,"python3 -c "+JSON.stringify(script));assert.equal((await census(b)).outsideReachable,true,'scope negative control target is actually reachable from connector');assert.match(out,/^(11|110)\n/);assert.match(out,/0000000000002000/);proof.scopeEnforced=true;proof.noHostNetwork=true;
  });
  await t.test('local stdio MCP runs in the task network and respects role-tool dispatch',async()=>{
   await writeFile(b.cwd+'/mcp.py',await readFile(path.join(import.meta.dirname,'fixtures/network-stdio-mcp.py')));
   const mcp=new McpService(pool,dir+'/events.jsonl'),created=await mcp.create({name:'jump-local',transport:'stdio',command:'/usr/bin/python3',args:['-u',b.cwd+'/mcp.py']});assert.ok(created.ok);const id=Number(created.server.id);
   assert.deepEqual(await inTaskNetwork(b.task,()=>mcp.refresh(id)),{ok:true,count:1});
   await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','mcp',$1)",[String(id)]);
   const ctx={agentKey:'worker',businessKind:'worker',businessId:'jump-mcp',taskId:b.task,intentId:b.intent,cwd:b.cwd,signal:AbortSignal.timeout(20000)};
   const assembly=await augmentSession(pool,mcp,undefined,ctx,{});
   try{const tool=assembly.tools.find(t=>t.name==='ExecuteExtraTool')!;const result=await (tool.execute as any)('jump-mcp',{tool_name:'mcp__jump-local__echo_site',params:{}});assert.match(result.content[0].text,/HOP_B:mcp/);}finally{await assembly.dispose();}
   proof.stdioMCP=true;proof.mcpToolDispatch=true;
  });
  await t.test('REA native analysis and protocol tool run inside the isolated jump workspace',{skip:process.env.WORMHOLE_REVERSE_INTEGRATION!=='1'},async()=>{
   const root='/opt/wormhole/tools';
   await writeFile(b.cwd+'/fixture.c','int calculate_total(int a,int b){return a*7+b;} int main(){return calculate_total(3,4);}');
   execFileSync('gcc',['-g','-O0',b.cwd+'/fixture.c','-o',b.cwd+'/fixture']);
   const connection=await inTaskNetwork(b.task,()=>connectMcp({name:'rea',transport:'stdio',command:process.execPath,args:[root+'/rea/node_modules/rea-agents/scripts/rea.mjs','--mcp'],env:{GHIDRA_INSTALL_DIR:root+'/ghidra',JAVA_HOME:root+'/jdk',GHIDRA_HEADLESS_MAXMEM:'1G',JAVA_TOOL_OPTIONS:'-XX:ActiveProcessorCount=2'}},AbortSignal.timeout(80000),b.cwd));
   try{
    for(const [name,args] of [['open_binary',{path:b.cwd+'/fixture'}],['analyze_function',{procedure:'calculate_total'}],['close_binary',{}]] as const){
     const reply=await connection.client.callTool({name,arguments:args},undefined,{timeout:65000});assert.ok(!reply.isError,JSON.stringify(reply).slice(0,2000));if(name==='analyze_function')assert.ok(JSON.stringify(reply).includes('return b + a * 7;'));
    }
   }finally{await connection.close();}
   assert.match(await command(b,root+'/bin/proto-re --help'),/proto-re/);proof.nativeReverseInJump=true;proof.protocolInJump=true;
  });
  await t.test('HTTP MCP connects to private endpoint through authenticated task MITM',async()=>{
   const connection=await inTaskNetwork(b.task,()=>connectMcp({name:'private-mcp',transport:'http',url:'http://inside.full.test:19000/mcp'})).catch(e=>{console.log('fixture diagnostics',b.diagnostics().slice(-2500));throw e;});
   try{const tools=await connection.client.listTools();assert.equal(tools.tools[0]!.name,'site');const result=await connection.client.callTool({name:'site',arguments:{}});assert.match(JSON.stringify(result),/HOP_B/);}finally{await connection.close();}
   proof.httpMCP=true;
  });
  await t.test('JS AES/HMAC adapter runs isolated, reaches jump target and records plaintext plus wire',async()=>{
   reverse=new ReverseProxies(pool,dir);
   const reverseDir=path.join(b.cwd,'r'.repeat(Math.max(1,75-Buffer.byteLength(b.cwd)-1)));await mkdir(reverseDir,{recursive:true});
   await writeFile(reverseDir+'/adapter.mjs',await readFile(path.join(import.meta.dirname,'fixtures/network-crypto-adapter.mjs')));
   const ctx={taskId:b.task,intentId:b.intent,cwd:reverseDir,businessKind:'worker',businessId:'js-jump',agentKey:'worker',signal:AbortSignal.timeout(25000)};
   const started=await inTaskNetwork(b.task,()=>reverse!.start(ctx,{script_path:'adapter.mjs',url:'http://inside.full.test:19000/secure',method:'POST',usage:'AES/HMAC fixture'}));
   const reply=await inTaskNetwork(b.task,()=>targetRequest('http://inside.full.test:19000/secure','POST','{"q":"jump-crypto"}',AbortSignal.timeout(10000),String(started.proxy_url),{taskId:b.task,intentId:b.intent},{'content-type':'application/json'}));
   assert.deepEqual(JSON.parse(reply.body),{marker:'HOP_B',echo:{q:'jump-crypto'}});assert.ok(reply.capture_id);assert.ok(reply.wire_capture_id);assert.notEqual(reply.capture_id,reply.wire_capture_id);
   proof.jsCrypto=true;proof.wireAndPlaintext=true;
  });
  await t.test('domain-only raw sessions survive DNS cache expiry without permitting pre-resolution IP access',{skip:process.env.WORMHOLE_NETWORK_SHORT==='1'},async()=>{
   const item=await make('DNS_ONLY',a,['inside.full.test']);
   const script="import socket,time; denied=socket.socket();denied.settimeout(.5);assert denied.connect_ex(('10.88.0.2',19002))!=0;denied.close();s=socket.create_connection(('inside.full.test',19002),3);s.sendall(b'first');assert s.recv(100)==b'DNS_ONLY:first';time.sleep(61);s.sendall(b'after-dns-ttl');print(s.recv(100).decode());s.close()";
   assert.match(await command(item,"python3 -c "+JSON.stringify(script),80000),/DNS_ONLY:after-dns-ttl/);proof.dnsSessionContinuity=true;
  });
  await t.test('Windows bundle includes authenticated wrapper and pinned signed TUN runtime',async()=>{
   const archive=unzipSync(await channels.connector(Number(b.row.id),'windows_amd64'));
   for(const name of ['frpc.exe','wormhole-connector.exe','wintun.dll'])assert.equal(Buffer.from(archive[name]!).subarray(0,2).toString(),'MZ');
   assert.ok(archive['WINTUN-LICENSE.txt']);proof.windowsBundle=true;
  });
  await t.test('ancestor disable blocks descendants immediately; binding never changes',async()=>{
   await channels.update(Number(a.row.id),{enabled:false});await assert.rejects(()=>request(b.task));assert.equal((await channels.list()).find(c=>c.id===b.row.id)?.status,'offline');
   await channels.update(Number(a.row.id),{enabled:true});await wait(async()=>{try{return JSON.parse((await request(b.task)).body).marker==='HOP_B';}catch{return false;}});
   assert.equal((await pool.query('SELECT network_channel_id FROM tasks WHERE id=$1',[b.task])).rows[0].network_channel_id,b.row.id);
   proof.ancestorDisable=true;proof.immutableChain=true;
  });
  await t.test('stop drains raw connections and reverse proxy processes',async()=>{
   const running=command(b,'python3 -c "import socket,time; s=socket.create_connection((\'10.88.0.2\',19002),3);time.sleep(45)"').then(()=>false,()=>true);
   await wait(async()=>(await census(b)).links.some((x:any)=>/^gty[0-9a-f]{8}$/.test(x.ifname)));
   await reverse?.stopTask(b.task);await pool.query("UPDATE tasks SET status='done' WHERE id=$1",[b.task]);const stopped=Date.now();await channels.stopTask(b.task);
   assert.equal(await running,true);assert.ok(Date.now()-stopped<5000);
   await wait(async()=>{const state=await census(b);return !state.links.some((x:any)=>/^gty[0-9a-f]{8}$/.test(x.ifname))&&!state.rules.includes('wormhole-network-runtime:gty');});
   await assert.rejects(()=>request(b.task));await assert.rejects(()=>command(b,'ping -c1 10.88.0.2'));proof.stop=true;proof.inFlightStopped=true;proof.remoteResourceCleanup=true;
  });
  await t.test('connector shutdown restores forwarding and removes only its own firewall resources',async()=>{
   await writeFile(b.folder+'/stop-connector','stop');
   const original=JSON.parse(await readFile(b.folder+'/initial.json','utf8'));
   let last:any;await wait(async()=>{last=await census(b);return last.forwarding===original.forwarding&&last.forward6===original.forward6&&!last.rules.includes('WORMHOLE_FWD_GUARD')&&!last.rules.includes('wormhole-network-runtime:');},10000).catch(e=>{console.log('shutdown state',JSON.stringify({original,last}),b.diagnostics().slice(-1200));throw e;});
   assert.equal(JSON.parse((await request(a.task)).body).marker,'HOP_A');proof.connectorShutdownCleanup=true;
  });
  await writeFile(process.env.WORMHOLE_NETWORK_PROOF??'/tmp/wormhole-network-full-proof.json',JSON.stringify(proof,null,2));
 }finally{
  await reverse?.stopAll();await channels.close();bindNetworkProvider(undefined);bindTargetRoute(null);
  for(const child of children.reverse())await kill(child);for(const s of sockets)s.destroy();await new Promise<void>(r=>bridge.close(()=>r()));await new Promise<void>(r=>site.close(()=>r()));await traffic.close();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
