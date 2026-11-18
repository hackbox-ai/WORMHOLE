import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {unzipSync,strFromU8} from 'fflate';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {NetworkChannels} from '../src/domains/network/channels.ts';
import {TrafficRuntime} from '../src/domains/traffic/runtime.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
const config=loadConfig();assert.match(new URL(config.database.dsn).pathname,/test/i);
const admin=new Pool({connectionString:config.database.dsn}),schema='channel_edit_'+process.pid+'_'+Date.now();
await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
await runMigrations(pool);
const dir=await mkdtemp('/tmp/wormhole-channel-edit-');
const traffic=new TrafficRuntime(dir,{get:()=>({trafficCapture:false,globalProxy:''})} as any);
async function port(){const s=tcpServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return n;}
const entryPort=await port(),channels=new NetworkChannels(pool,traffic,dir,entryPort),peers=new Set<Socket>();
await traffic.start();await channels.start();
const entry=httpServer((_q,r)=>{r.writeHead(404);r.end();});
entry.on('connect',(q,s,h)=>{peers.add(s);s.on('close',()=>peers.delete(s));void channels.handleConnect(q,s,h);});
entry.listen(entryPort,'127.0.0.1');await once(entry,'listening');
const tasks=new TaskService(pool,dir+'/events.jsonl',()=>{});
const a=await channels.create({name:'parent',server_host:'127.0.0.1',relay_listen:'127.0.0.1:23881',scopes:['127.0.0.1']});
const b=await channels.create({name:'child',server_host:'127.0.0.1',parent_channel_id:Number(a.id),relay_listen:'127.0.0.1:23882',scopes:['127.0.0.1']});
const c=await channels.create({name:'leaf',server_host:'127.0.0.1',parent_channel_id:Number(b.id),scopes:['127.0.0.1']});
const custom=await channels.create({name:'custom relay address',server_host:'custom-relay.example.test',parent_channel_id:Number(a.id),scopes:['127.0.0.1']});
let connector:ChildProcess|undefined;let targetHits=0;
const target=httpServer((_q,r)=>{targetHits++;r.writeHead(200,{'Content-Type':'application/json'});r.end('{"marker":"CHANNEL_EDIT_OK"}');});
target.listen(0,'127.0.0.1');await once(target,'listening');
const targetURL='http://127.0.0.1:'+(target.address() as {port:number}).port+'/health';
async function stopConnector(){if(connector&&connector.exitCode===null&&connector.signalCode===null){const done=once(connector,'exit');connector.kill('SIGTERM');await done;}connector=undefined;}
after(async()=>{await stopConnector();await channels.close();await traffic.close();for(const p of peers)p.destroy();await new Promise<void>(r=>entry.close(()=>r()));await new Promise<void>(r=>target.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
async function wait(check:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,150));}throw Error('deadline');}
async function startConnector(id:number){
 const folder=dir+'/connector-'+id+'-'+Date.now();await mkdir(folder);
 const zip=unzipSync(await channels.connector(id,'linux_amd64'));
 for(const[name,bytes]of Object.entries(zip))await writeFile(folder+'/'+name,bytes,{mode:['frpc','wormhole-connector'].includes(name)?0o700:0o600});
 const cfg=JSON.parse(strFromU8(zip['connector.json']!)),old=Number(cfg.listen.split(':').at(-1)),local=await port();
 cfg.listen='127.0.0.1:'+local;
 await writeFile(folder+'/connector.json',JSON.stringify(cfg),{mode:0o600});
 await writeFile(folder+'/frpc.toml',strFromU8(zip['frpc.toml']!).replace('localPort = '+old+'\n','localPort = '+local+'\n'),{mode:0o600});
 connector=spawn(folder+'/wormhole-connector',['-config','connector.json'],{cwd:folder,stdio:['ignore','ignore','ignore']});
 await wait(async()=>(await channels.list()).find(r=>r.id===String(id))?.status==='online');
 return cfg;
}
test('metadata remains editable with dependent queued and modeling tasks; connection edits are refused atomically',async()=>{
 const task=await tasks.create({goal:'http://127.0.0.1',queued:true,network_mode:'jump',network_channel_id:Number(c.id)});assert.ok(task.ok);
 const model=(await pool.query("INSERT INTO tasks(kind,name,goal,network_mode,network_channel_id,network_version) VALUES('modeling','fixture','fixture','jump',$1,1) RETURNING id",[c.id])).rows[0];
 const renamed=await channels.update(Number(a.id),{name:'parent-renamed',probe_url:targetURL,expected_version:1});
 assert.equal(renamed.version,1);assert.equal(renamed.requires_redeploy,false);assert.equal(renamed.dependent_tasks,2);
 const secret=await readFile(channels.dir+'/'+a.id+'/secret.json','utf8');
 await assert.rejects(channels.update(Number(a.id),{scopes:['localhost']}),/未结束任务/);
 assert.equal(await readFile(channels.dir+'/'+a.id+'/secret.json','utf8'),secret);
 await pool.query("UPDATE tasks SET status='done',queued=false WHERE id=ANY($1::bigint[])",[[task.task.id,model.id]]);
});
test('parent changes version and credentials for the subtree, preserve history and propagate the child entry port',async()=>{
 const before=new Map(await Promise.all([a,b,c,custom].map(async r=>[r.id,await readFile(channels.dir+'/'+r.id+'/secret.json','utf8')] as const)));
 const edited=await channels.update(Number(a.id),{relay_listen:'localhost:23891',expected_version:1});
 assert.equal(edited.version,2);assert.equal(edited.requires_redeploy,true);assert.equal(edited.affected_channels.length,4);
 const rows=await channels.list();assert.equal(rows.find(r=>r.id===b.id)?.entry_port,23891);assert.equal(rows.find(r=>r.id===c.id)?.entry_port,23882);
 assert.equal(rows.find(r=>r.id===b.id)?.server_host,'localhost');assert.equal(rows.find(r=>r.id===custom.id)?.server_host,'custom-relay.example.test');assert.equal(rows.find(r=>r.id===custom.id)?.entry_port,23891);
 for(const id of [a.id,b.id,c.id,custom.id]){assert.equal(rows.find(r=>r.id===id)?.version,2);assert.notEqual(await readFile(channels.dir+'/'+id+'/secret.json','utf8'),before.get(id));}
 const history=await channels.forTask(Number(c.id),1);assert.equal(history.historical,true);assert.equal(history.version,1);assert.equal(history.chain[0].name,'parent-renamed');assert.equal(history.current_version,2);
 assert.ok(!JSON.stringify(history).includes('"token"'));
 await assert.rejects(channels.update(Number(a.id),{name:'stale',expected_version:1}),/刷新/);
});
test('cyclic parent links and removing an in-use relay listener are rejected',async()=>{
 await assert.rejects(channels.update(Number(a.id),{parent_channel_id:Number(b.id)}),/循环/);
 await assert.rejects(channels.update(Number(a.id),{relay_listen:''}),/下级接入监听/);
 assert.equal((await channels.list()).find(r=>r.id===a.id)?.version,2);
});
let direct:any,initialCfg:any;
test('connection-only probe requires no target and sends no request to a configured target',async()=>{
 direct=await channels.create({name:'actual connector',server_host:'127.0.0.1',scopes:['127.0.0.1'],probe_url:targetURL});
 initialCfg=await startConnector(Number(direct.id));const before=targetHits;
 const result=await channels.probe(Number(direct.id),'',AbortSignal.timeout(5000));
 assert.equal(result.kind,'channel');assert.equal((result as any).ready,true);assert.equal(targetHits,before);
 const response=await channels.probe(Number(direct.id),targetURL,AbortSignal.timeout(5000));assert.equal((response as any).status,200);assert.equal(targetHits,before+1);
 await assert.rejects(channels.probe(Number(direct.id),'http://outside.test/',AbortSignal.timeout(5000)),/允许范围/);
});
test('new bundles reconnect after an edit; stale credentials cannot authenticate',async()=>{
 const edited=await channels.update(Number(direct.id),{scopes:['127.0.0.1','localhost'],expected_version:1});
 assert.equal(edited.version,2);assert.equal(edited.requires_redeploy,true);
 assert.equal((await channels.probe(Number(direct.id),'',AbortSignal.timeout(5000)) as any).ready,false);
 assert.equal(connector?.exitCode,null);await stopConnector();const newer=await startConnector(Number(direct.id));assert.notEqual(newer.token,initialCfg.token);
 assert.ok(newer.scopes.includes('localhost'));assert.equal(newer.version,2);
 assert.equal((await channels.probe(Number(direct.id),targetURL,AbortSignal.timeout(5000)) as any).status,200);
});
test('a raced task intake rejects a stale version instead of silently changing its route',async()=>{
 let unblock!:()=>void,entered!:()=>void;const parked=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>unblock=r);
 const proxy=Object.create(pool);proxy.query=async(sql:any,args:any)=>{if(typeof sql==='string'&&sql.includes('t AS (INSERT INTO tasks')){entered();await gate;}return pool.query(sql,args);};
 const service=new TaskService(proxy,dir+'/race.jsonl',()=>{});
 const pending=service.create({goal:targetURL,queued:true,network_mode:'jump',network_channel_id:Number(direct.id)});
 await parked;await channels.update(Number(direct.id),{full_network:true,expected_version:2});unblock();
 const result=await pending;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.status,409);
});
test('reparenting a subtree cannot exceed the depth limit, including disabled ancestors',async()=>{
 let parent:string|null=null;
 for(let i=0;i<8;i++){parent=String((await pool.query("INSERT INTO network_channels(name,server_host,control_port,socks_port,scopes,parent_channel_id,relay_listen,full_network,enabled,entry_port) VALUES($1,'127.0.0.1',$2,$3,'[\"127.0.0.1\"]',$4,'127.0.0.1:23900',false,$5,23900) RETURNING id",['depth-'+i,18000+i,18100+i,parent,i===7])).rows[0].id);}
 await assert.rejects(channels.update(Number(a.id),{parent_channel_id:Number(parent)}),/最多 8 级/);
});

test('a partial scope edit clears an obsolete saved target without permitting an out-of-scope probe',async()=>{
 const edited=await channels.update(Number(a.id),{scopes:['localhost']});
 assert.equal(edited.probe_url,'');
 await assert.rejects(channels.update(Number(a.id),{probe_url:targetURL}),/允许范围/);
});

test('editing works with a single DB connection without advisory-lock starvation',async()=>{
 const single=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema,max:1});
 const service=new NetworkChannels(single,traffic,dir,entryPort);
 try{
  const row=(await pool.query("SELECT id FROM network_channels WHERE name='depth-1'")).rows[0];
  const result=await service.update(Number(row.id),{name:'depth-one-edited'});
  assert.equal(result.name,'depth-one-edited');assert.equal(result.requires_redeploy,false);
 }finally{await service.close();await single.end();}
});
