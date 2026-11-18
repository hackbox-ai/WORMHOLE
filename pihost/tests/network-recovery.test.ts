import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer,type Socket} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {unzipSync,strFromU8} from 'fflate';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {NetworkChannels} from '../src/domains/network/channels.ts';
import {TrafficRuntime} from '../src/domains/traffic/runtime.ts';
async function freePort(){const s=tcpServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
async function wait(fn:()=>Promise<boolean>,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('recovery deadline');}
test('actual bundled connector waits for server and recovers without reviving disabled channels',{skip:process.env.WORMHOLE_NETWORK_RECOVERY!=='1',timeout:150000},async t=>{
 const config=loadConfig();assert.match(new URL(config.database.dsn).pathname,/test/i);
 const dir=await mkdtemp('/tmp/wormhole-recovery-'),schema='wormhole_recovery_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:config.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema}),runtime=dir+'/runtime',bundle=dir+'/bundle',original=process.env.WORMHOLE_FRP_DIR;
 await mkdir(runtime);await mkdir(bundle);
 const installed=original??'/opt/wormhole/network/frp-0.72.0';
 for(const name of await readdir(installed)){if(name==='wormhole-connector')continue;await symlink(path.join(installed,name),runtime+'/'+name);}
 await symlink(process.env.WORMHOLE_CONNECTOR_BINARY??installed+'/wormhole-connector',runtime+'/wormhole-connector');process.env.WORMHOLE_FRP_DIR=runtime;
 const traffic=new TrafficRuntime(dir,{get:()=>({trafficCapture:false,globalProxy:''})} as any),port=await freePort(),channels=new NetworkChannels(pool,traffic,dir,port);
 const peers=new Set<Socket>(),site=httpServer((_q,r)=>{r.writeHead(404);r.end();});
 site.on('connect',(req,socket,head)=>{const peer=socket as Socket;peers.add(peer);peer.on('close',()=>peers.delete(peer));void channels.handleConnect(req,peer,head);});
 let child:ChildProcess|undefined,logs='',siteOpen=false;const proof:Record<string,unknown>={};
 try{
  await runMigrations(pool);await traffic.start();await channels.start();
  const row=await channels.create({name:'recovery-fixture',server_host:'127.0.0.1',scopes:['127.0.0.1'],full_network:false}),id=Number(row.id),archive=unzipSync(await channels.connector(id,'linux_amd64'));
  for(const[name,bytes]of Object.entries(archive))await writeFile(bundle+'/'+name,bytes,{mode:['frpc','wormhole-connector'].includes(name)?0o700:0o600});
  let toml=strFromU8(archive['frpc.toml']!);assert.ok(/^loginFailExit = false$/m.test(toml),'bundle must retry when its server is not ready');
  // The connector and server share a host in this fixture; move only its local
  // packet listener to another free port so it does not collide with frps.
  const cfg=JSON.parse(strFromU8(archive['connector.json']!)),oldLocal=Number(String(cfg.listen).split(':').at(-1)),local=await freePort();
  cfg.listen='127.0.0.1:'+local;toml=toml.replace('localPort = '+oldLocal+'\n','localPort = '+local+'\n');
  await writeFile(bundle+'/connector.json',JSON.stringify(cfg),{mode:0o600});await writeFile(bundle+'/frpc.toml',toml,{mode:0o600});
  child=spawn(bundle+'/wormhole-connector',['-config','connector.json'],{cwd:bundle,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout?.on('data',v=>logs+=v);child.stderr?.on('data',v=>logs+=v);
  await t.test('startup while entry is offline remains alive, later connects with same PID',async()=>{
   const pid=child!.pid;await new Promise(r=>setTimeout(r,2200));assert.equal(child!.exitCode,null,logs);
   assert.equal((await channels.list()).find(c=>Number(c.id)===id)!.status,'offline');
   await new Promise<void>(r=>site.listen(port,'127.0.0.1',r));siteOpen=true;
   await wait(async()=>(await channels.list()).find(c=>Number(c.id)===id)?.status==='online',35000);
   assert.equal(child!.pid,pid);proof.lateServer=true;proof.connectorPID=pid;
  });
  await t.test('frps crash restarts enabled channel and existing connector recovers',async()=>{
   const old=(channels as any).children.get(String(id)) as ChildProcess;assert.ok(old.pid);old.kill('SIGKILL');
   await wait(async()=>{const current=(channels as any).children.get(String(id));return current?.pid&&current.pid!==old.pid&&(await channels.list()).find(c=>Number(c.id)===id)?.status==='online';},35000);
   assert.equal(child!.exitCode,null);proof.serverCrashRecovered=true;
  });
  await t.test('explicit disable is not undone by recovery and re-enable reconnects',async()=>{
   await channels.update(id,{enabled:false});await new Promise(r=>setTimeout(r,2600));assert.equal((channels as any).children.has(String(id)),false);
   assert.equal((await channels.list()).find(c=>Number(c.id)===id)!.status,'disabled');
   assert.equal((channels as any).restarts.size,0);
   await channels.update(id,{enabled:true});await wait(async()=>(await channels.list()).find(c=>Number(c.id)===id)?.status==='online',35000);proof.disableRespected=true;
  });
  await t.test('closing server cancels recovery and connector stops successfully',async()=>{
   await channels.close();for(const s of peers)s.destroy();
   const exited=once(child!,'exit');child!.kill('SIGTERM');const[code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
   await new Promise(r=>setTimeout(r,2200));assert.equal((channels as any).children.size,0);assert.equal((channels as any).restarts.size,0);proof.cleanStop=true;
  });
  if(process.env.WORMHOLE_RECOVERY_PROOF)await writeFile(process.env.WORMHOLE_RECOVERY_PROOF,JSON.stringify(proof,null,2));
 }finally{
  await channels.close();if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await Promise.race([ended,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null&&child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}}
  for(const s of peers)s.destroy();if(siteOpen)await new Promise<void>(r=>site.close(()=>r()));await traffic.close();
  if(original===undefined)delete process.env.WORMHOLE_FRP_DIR;else process.env.WORMHOLE_FRP_DIR=original;
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
