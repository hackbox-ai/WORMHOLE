import {AsyncLocalStorage} from 'node:async_hooks';
import {packetGateway} from './packets.ts';
import {spawn,type ChildProcess} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import {createServer,connect,BlockList,isIP} from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';
import {mkdir,readFile,writeFile,chmod,rm,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {zipSync,strToU8} from 'fflate';
import {TrafficProxy} from '../traffic/proxy.ts';
import type {TrafficRuntime} from '../traffic/runtime.ts';
import type {NetworkScope} from './context.ts';
export class ChannelError extends Error{constructor(message:string,public status=400){super(message);}}
export interface Channel{ id:string;name:string;server_host:string;control_port:number;socks_port:number;version:number;scopes:string[];enabled:boolean;parent_channel_id?:string|null;entry_port?:number|null;relay_listen:string;full_network:boolean;packet_port?:number|null;probe_url?:string; }
interface Secret{token:string;relay:string;user:string;password:string;}
const quote=(s:string)=>JSON.stringify(s);
const frpRoot=()=>process.env.WORMHOLE_FRP_DIR??'/opt/wormhole/network/frp-0.72.0';
export function channelAllows(scopes:string[],url:URL){
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 return scopes.some(raw=>{
  const value=raw.toLowerCase();
  if(value.includes('/')){const [ip,prefix]=value.split('/');const family=isIP(ip!);if(!family||!/^\d+$/.test(prefix??''))return false;try{const list=new BlockList();list.addSubnet(ip!,Number(prefix),family===6?'ipv6':'ipv4');return !!isIP(host)&&list.check(host,isIP(host)===6?'ipv6':'ipv4');}catch{return false;}}
  return value.startsWith('*.')?host.endsWith(value.slice(1))&&host!==value.slice(2):host===value;
 });
}
function scopesOf(value:unknown){if(!Array.isArray(value)||!value.length||value.length>100||value.some(v=>typeof v!=='string'||v.length>253))throw new ChannelError("Please fill in 1-100 domain names, IPs or network segments");
 const scopes=[...new Set(value.map(v=>String(v).trim().toLowerCase()))];for(const v of scopes){if(v.includes('/')){const [ip,p]=v.split('/');if(v.split('/').length!==2||!isIP(ip!)||!/^\d+$/.test(p??'')||Number(p)>(isIP(ip!)===6?128:32))throw new ChannelError("Invalid network segment:"+v);}else if(!isIP(v)&&!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v))throw new ChannelError("Invalid domain name or IP:"+v);}return scopes;}
async function freePort(){const s=createServer();await new Promise<void>((r,j)=>s.once('error',j).listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
export class NetworkChannels{
 private children=new Map<string,ChildProcess>();private gateways=new Map<number,Promise<{proxy:TrafficProxy;scope:NetworkScope}>>();
 private timer:ReturnType<typeof setInterval>|undefined;private stopping=false;
 private starting=new Map<string,Promise<void>>();private restarts=new Map<string,ReturnType<typeof setTimeout>>();private revisions=new Map<string,number>();
 private relaySockets=new Set<Socket>();private packets=new Map<number,Awaited<ReturnType<typeof packetGateway>>>();
 private configurationContext=new AsyncLocalStorage<{client:PoolClient;active:boolean}>();
 private get db(){const context=this.configurationContext.getStore();return context?.active?context.client:this.pool;}
 private mutationTail:Promise<void>=Promise.resolve();
 private async configurationOperation<T>(fn:()=>Promise<T>):Promise<T>{
  const previous=this.mutationTail;let release!:()=>void;
  this.mutationTail=new Promise<void>(resolve=>{release=resolve;});
  await previous;let client:PoolClient|undefined,context:{client:PoolClient;active:boolean}|undefined;
  try{client=await this.pool.connect();await client.query("SELECT pg_advisory_lock(hashtext('wormhole-network-config'))");context={client,active:true};return await this.configurationContext.run(context,fn);}
  finally{if(context)context.active=false;try{if(client){try{await client.query("SELECT pg_advisory_unlock(hashtext('wormhole-network-config'))");}finally{client.release();}}}finally{release();}}
 }
 private probeAddress(value:unknown,scopes:string[]){
  const raw=String(value??'').trim();if(!raw)return '';
  let url:URL;try{url=new URL(raw);}catch{throw new ChannelError("The test address must be a complete HTTP/HTTPS URL");}
  if(raw.length>2048||!['http:','https:'].includes(url.protocol)||url.username||url.password||!channelAllows(scopes,url))throw new ChannelError("The test address must be within the allowed range and does not contain the account password.");
  url.hash='';if(url.href.length>2048)throw new ChannelError("Test address is too long");return url.href;
 }
 private graphChain(row:Channel,rows:Channel[]):Channel[]{
  const map=new Map(rows.map(r=>[String(r.id),r])),chain=[row],seen=new Set([String(row.id)]);
  while(chain[0]!.parent_channel_id){
   const id=String(chain[0]!.parent_channel_id),parent=map.get(id);
   if(!parent||seen.has(id))throw new ChannelError("The superior relationship cannot form a cycle");
   if(!parent.relay_listen)throw new ChannelError("The upper-level channel needs to set up lower-level access monitoring");
   seen.add(id);chain.unshift(parent);if(chain.length>8)throw new ChannelError("Up to 8 levels of springboard");
  }
  return chain;
 }
 private async writeSecret(id:string,value:Secret){
  const file=path.join(this.folder(id),'secret.json'),temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  try{await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);}
  finally{await rm(temp,{force:true});}
 }
 readonly dir:string;
 constructor(readonly pool:Pool,private traffic:TrafficRuntime,dataDir:string,private readonly entryPort=18887){this.dir=path.join(dataDir,'network-channels');}
 async start(){await mkdir(this.dir,{recursive:true,mode:0o700});for(const row of (await this.db.query('SELECT * FROM network_channels WHERE enabled')).rows)await this.startChannel(row).catch(()=>console.warn("[network] channel "+row.id+" Startup failed"));
  this.timer=setInterval(()=>void this.sweep().catch(()=>{}),5000);this.timer.unref();}
 private folder(id:string){if(!/^\d+$/.test(id))throw new ChannelError("Invalid channel");return path.join(this.dir,id);}
 private async secret(id:string):Promise<Secret>{return JSON.parse(await readFile(path.join(this.folder(id),'secret.json'),'utf8'));}
 private async row(id:number|string):Promise<Channel>{const row=(await this.db.query('SELECT * FROM network_channels WHERE id=$1',[id])).rows[0];if(!row)throw new ChannelError("Channel does not exist",404);return {...row,id:String(row.id)};}
 private async event(id:string,type:string){await this.db.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('network_channel',$1,$2,'{}')",[id,type]);}
 async create(input:Record<string,unknown>){return this.configurationOperation(()=>this.createChannel(input));}
 private async createChannel(input:Record<string,unknown>){
  const name=String(input.name??'').trim(),host=String(input.server_host??'').trim();
  if(!name||name.length>100)throw new ChannelError("Channel name needs to be 1–100 characters");
  if((!isIP(host)&&host.split('.').some(part=>!/^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)$/.test(part)))||!host||host.includes('/')||host.includes('@')||/[\s:#]/.test(host)||host.length>253)throw new ChannelError("Fill in the server IPv4 or domain name accessible to the on-site machine, excluding protocol and port");
  const parentId=input.parent_channel_id==null?null:Number(input.parent_channel_id);
  if(parentId!==null&&(!Number.isSafeInteger(parentId)||parentId<=0))throw new ChannelError("Invalid superior channel");
  const parent=parentId?await this.row(parentId):undefined;
  if(parent&&(!parent.enabled||!parent.relay_listen))throw new ChannelError("The upper channel needs to enable relay monitoring");
  if(parent&&(await this.chain(parent)).length>=8)throw new ChannelError("Up to 8 levels of springboard");
  const relay=String(input.relay_listen??'').trim();
  if(relay&&!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{4,5}$/.test(relay))throw new ChannelError("Relay listening uses IP:port format");
  if(relay&&(Number(relay.split(':').at(-1))<1024||Number(relay.split(':').at(-1))>65535))throw new ChannelError("The trunk port range is 1024–65535");
  if(input.full_network!==undefined&&typeof input.full_network!=='boolean')throw new ChannelError("Full network switch should be boolean");
  const entryPort=parent?Number(parent.relay_listen.split(':').at(-1)):this.entryPort;
  const scopes=scopesOf(input.scopes),probeURL=this.probeAddress(input.probe_url,scopes);if(!existsSync(path.join(frpRoot(),'frps')))throw new ChannelError("The springboard connection assembly has not been installed yet",503);
  if(Number((await this.db.query('SELECT count(*)::int n FROM network_channels WHERE enabled')).rows[0].n)>=8)throw new ChannelError("Enable up to 8 springboard channels");
  const [control,socks,packet]=await Promise.all([freePort(),freePort(),freePort()]);if(new Set([control,socks,packet]).size!==3)throw new ChannelError("Port allocation conflict, please try again",503);
  const row=(await this.db.query('INSERT INTO network_channels(name,server_host,control_port,socks_port,scopes,parent_channel_id,entry_port,relay_listen,full_network,packet_port,probe_url) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *',[name,host,control,socks,JSON.stringify(scopes),parentId,entryPort,relay,input.full_network===true,packet,probeURL])).rows[0];
  const id=String(row.id),folder=this.folder(id);await mkdir(folder,{mode:0o700});
  try{
   const secret:Secret={token:randomBytes(32).toString('hex'),relay:randomBytes(32).toString('hex'),user:'wormhole-'+id,password:randomBytes(24).toString('hex')};
   await writeFile(path.join(folder,'secret.json'),JSON.stringify(secret),{mode:0o600});
   execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout',path.join(folder,'server.key'),'-out',path.join(folder,'ca.pem'),'-subj','/CN=wormhole-network-channel','-addext','subjectAltName=DNS:wormhole-network-channel','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
   await chmod(path.join(folder,'server.key'),0o600);await this.startChannel(row);await this.event(id,'channel_created');
   return this.describe(await this.row(id));
  }catch(e){await this.db.query('UPDATE network_channels SET enabled=false WHERE id=$1',[id]);throw e;}
 }
 private scheduleRestart(id:string){
  if(this.stopping||this.restarts.has(id))return;
  const revision=this.revisions.get(id)??0;
  const timer=setTimeout(()=>{this.restarts.delete(id);void (async()=>{
   const row=await this.row(id);
   if(this.stopping||!row.enabled||(this.revisions.get(id)??0)!==revision)return;
   await this.startChannel(row);
  })().catch(()=>{if(!this.stopping&&(this.revisions.get(id)??0)===revision)this.scheduleRestart(id);});},2000);
  timer.unref();this.restarts.set(id,timer);
 }
 private async startChannel(row:Channel){
  if(this.stopping||!row.enabled)return;
  const id=String(row.id),pending=this.starting.get(id);if(pending)return pending;
  if(this.children.get(id)?.exitCode===null)return;
  const revision=this.revisions.get(id)??0;
  const work=this.openChannel(row,revision);this.starting.set(id,work);
  try{await work;}finally{if(this.starting.get(id)===work)this.starting.delete(id);}
 }
 private async openChannel(row:Channel,revision:number){
  const id=String(row.id);
  const folder=this.folder(id),secret=await this.secret(id);
  const config=`bindAddr = "127.0.0.1"
bindPort = ${row.control_port}
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = ${row.socks_port} }${row.packet_port?', { single = '+row.packet_port+' }':''}]
maxPortsPerClient = 2
auth.method = "token"
auth.token = ${quote(secret.token)}
transport.tls.force = true
transport.tls.certFile = ${quote(path.join(folder,'ca.pem'))}
transport.tls.keyFile = ${quote(path.join(folder,'server.key'))}
log.to = "console"
log.level = "error"
`;
  await writeFile(path.join(folder,'frps.toml'),config,{mode:0o600});
  if(this.stopping||(this.revisions.get(id)??0)!==revision)return;
  const child=spawn(path.join(frpRoot(),'frps'),['-c',path.join(folder,'frps.toml')],{stdio:['ignore','ignore','pipe']});
  child.stderr?.resume();const lost=()=>{if(this.children.get(id)!==child)return;this.children.delete(id);this.scheduleRestart(id);};child.on('error',lost);child.on('exit',lost);this.children.set(id,child);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,300);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new ChannelError("Springboard access port startup failed",503));});});
 }
 private async online(row:Channel){if(!row.enabled||!this.children.has(String(row.id)))return false;
  const secret=await this.secret(String(row.id));
  return new Promise<boolean>(resolve=>{const socket=connect(row.socks_port,'127.0.0.1');let stage=0,buf=Buffer.alloc(0),done=false;
   const deadline=setTimeout(()=>finish(false),1800);const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(deadline);socket.destroy();resolve(ok);};socket.on('end',()=>finish(false));socket.on('close',()=>finish(false));socket.setTimeout(1500,()=>finish(false));socket.on('error',()=>finish(false));
   socket.on('connect',()=>socket.write(Buffer.from([5,1,2])));
   socket.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);if(buf.length<2)return;if(stage===0){if(buf[0]!==5||buf[1]!==2)return finish(false);stage=1;buf=buf.subarray(2);const u=Buffer.from(secret.user),p=Buffer.from(secret.password);socket.write(Buffer.concat([Buffer.from([1,u.length]),u,Buffer.from([p.length]),p]));}else finish(buf[0]===1&&buf[1]===0);});
  });
 }
 async chain(row:Channel):Promise<Channel[]>{const rows=[row],seen=new Set([String(row.id)]);while(rows[0]!.parent_channel_id){const parent=await this.row(rows[0]!.parent_channel_id!);if(seen.has(String(parent.id))||rows.length>=8)throw new ChannelError("Springboard chain configuration is invalid",409);seen.add(String(parent.id));rows.unshift(parent);}return rows;}
 private async fullReady(row:Channel){if(!row.full_network||!row.enabled||!row.packet_port)return false;const secret=await this.secret(String(row.id));
  return new Promise<boolean>(resolve=>{const socket=connect(row.packet_port!,'127.0.0.1');let data='',done=false;const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok);};const timer=setTimeout(()=>finish(false),1500);
   socket.on('connect',()=>socket.write(JSON.stringify({op:'status',token:secret.token})+'\n'));socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));socket.on('data',b=>{data+=b;if(data.length>8192)return finish(false);if(data.includes('\n')){try{const r=JSON.parse(data.split('\n')[0]!);finish(r.ok===true&&r.full_network===true);}catch{finish(false);}}});
  });
 }
 async describe(row:Channel){
  const chain=await this.chain(row);
  const suggested=(await this.db.query("SELECT web_targets FROM tasks WHERE network_channel_id=$1 AND deleted_at IS NULL AND jsonb_array_length(web_targets)>0 ORDER BY id DESC LIMIT 20",[row.id])).rows.flatMap(r=>r.web_targets as string[]);
  const suggestedProbe=suggested.find(target=>{try{return channelAllows(row.scopes,new URL(target));}catch{return false;}})??'';
  const dependent=Number((await this.db.query("WITH RECURSIVE affected AS (SELECT id FROM network_channels WHERE id=$1 UNION ALL SELECT c.id FROM network_channels c JOIN affected a ON c.parent_channel_id=a.id) SELECT count(*)::int n FROM tasks WHERE network_channel_id IN(SELECT id FROM affected) AND status IN('created','running','paused') AND deleted_at IS NULL",[row.id])).rows[0].n);
  return {...row,probe_url:row.probe_url??'',suggested_probe_url:row.probe_url||suggestedProbe,
   full_network_ready:await this.fullReady(row),entry_port:row.entry_port??this.entryPort,
   chain:chain.map(c=>({id:String(c.id),name:c.name})),status:!row.enabled?'disabled':(await Promise.all(chain.map(c=>this.online(c)))).every(Boolean)?'online':'offline',
   last_checked_at:new Date().toISOString(),dependent_tasks:dependent,
   active_tasks:Number((await this.db.query("SELECT count(*)::int n FROM tasks WHERE network_channel_id=$1 AND kind='pentest' AND NOT archived AND status IN ('created','running','paused') AND deleted_at IS NULL",[row.id])).rows[0].n)};
 }
 async list(){const rows=(await this.db.query('SELECT * FROM network_channels ORDER BY id DESC')).rows;return Promise.all(rows.map(r=>this.describe({...r,id:String(r.id)})));}
 async forTask(id:number,version:number){
  const row=await this.row(id);if(Number(row.version)===Number(version))return this.describe(row);
  const record=(await this.db.query('SELECT config FROM network_channel_versions WHERE channel_id=$1 AND version=$2',[id,version])).rows[0];
  if(!record)throw new ChannelError("History channel configuration does not exist",404);
  return {...record.config,historical:true,current_version:row.version,status:'offline',full_network_ready:false,active_tasks:0};
 }
 async update(id:number,patch:Record<string,unknown>){return this.configurationOperation(()=>this.updateChannel(id,patch));}
 private async updateChannel(id:number,patch:Record<string,unknown>){
  const allowed=['name','enabled','server_host','parent_channel_id','relay_listen','full_network','scopes','probe_url','expected_version'];
  if(Object.keys(patch).some(k=>!allowed.includes(k)))throw new ChannelError("Unsupported channel setting item");
  const row=await this.row(id);
  if(patch.expected_version!==undefined&&Number(patch.expected_version)!==Number(row.version))throw new ChannelError("The channel has been updated, please refresh and edit again.",409);
  if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw new ChannelError("Enabled status should be a Boolean value");
  if(patch.full_network!==undefined&&typeof patch.full_network!=='boolean')throw new ChannelError("Full network switch should be boolean");
  if(patch.name!==undefined&&typeof patch.name!=='string')throw new ChannelError("Name expected to be a string");
  const name=patch.name===undefined?row.name:String(patch.name).trim(),host=patch.server_host===undefined?row.server_host:String(patch.server_host).trim();
  if(!name||name.length>100)throw new ChannelError("Name needs to be 1–100 characters");
  if((!isIP(host)&&host.split('.').some(part=>!/^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)$/.test(part)))||!host||host.includes('/')||host.includes('@')||/[\s:#]/.test(host)||host.length>253)throw new ChannelError("Enter IPv4 or domain name for the access address, excluding protocol and port.");
  const parentId=patch.parent_channel_id===undefined?(row.parent_channel_id==null?null:Number(row.parent_channel_id)):patch.parent_channel_id==null?null:Number(patch.parent_channel_id);
  if(parentId!==null&&(!Number.isSafeInteger(parentId)||parentId<=0))throw new ChannelError("Invalid superior channel");
  const relay=patch.relay_listen===undefined?row.relay_listen:String(patch.relay_listen).trim();
  if(relay&&(!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{4,5}$/.test(relay)||Number(relay.split(':').at(-1))<1024||Number(relay.split(':').at(-1))>65535))throw new ChannelError("Fill in IP: port for lower-level monitoring, port range 1024–65535");
  const scopes=patch.scopes===undefined?row.scopes:scopesOf(patch.scopes),enabled=patch.enabled===undefined?row.enabled:Boolean(patch.enabled);
  const all=(await this.db.query('SELECT * FROM network_channels ORDER BY id')).rows.map(r=>({...r,id:String(r.id)})) as Channel[];
  const parent=parentId===null?undefined:all.find(c=>Number(c.id)===parentId);
  if(parentId!==null&&!parent)throw new ChannelError("The upper channel does not exist",404);
  if(parentId!==null&&parentId!==Number(row.parent_channel_id)&&!parent?.enabled)throw new ChannelError("Please select an enabled upper-level channel");
  if(enabled&&!row.enabled&&all.filter(c=>c.enabled).length>=8)throw new ChannelError("Enable up to 8 springboard channels");
  const next:Channel={...row,name,server_host:host,parent_channel_id:parentId==null?null:String(parentId),relay_listen:relay,scopes,enabled,
   entry_port:parent?Number(parent.relay_listen.split(':').at(-1)):this.entryPort,
   full_network:patch.full_network===undefined?row.full_network:Boolean(patch.full_network),
   probe_url:String(patch.probe_url===undefined?row.probe_url??'':patch.probe_url??'')};
  const configFields=['server_host','parent_channel_id','relay_listen','full_network','entry_port'] as const;
  const changed=configFields.some(key=>String(next[key]??'')!==String((key==='entry_port'?row.entry_port??this.entryPort:row[key])??''))||
   JSON.stringify([...scopes].sort())!==JSON.stringify([...row.scopes].sort());
  const proposed=all.map(c=>c.id===String(id)?next:c);
  for(const candidate of proposed)this.graphChain(candidate,proposed);
  const affected=all.filter(c=>this.graphChain(c,all).some(p=>p.id===String(id)));
  if(changed){
   const active=(await this.db.query("SELECT id FROM tasks WHERE network_channel_id=ANY($1::bigint[]) AND status IN('created','running','paused') AND deleted_at IS NULL ORDER BY id LIMIT 10",[affected.map(c=>c.id)])).rows;
   if(active.length)throw new ChannelError("There are still unfinished tasks associated with the channel or subordinates:"+active.map(t=>'#'+t.id).join('、')+"; The connection configuration can be modified after the task is completed, and the name and test address can be modified directly",409);
  }
  if(patch.probe_url===undefined){try{next.probe_url=this.probeAddress(next.probe_url,scopes);}catch{next.probe_url='';}}
  else next.probe_url=this.probeAddress(patch.probe_url,scopes);
  const backups=new Map<string,Secret>();const client=this.configurationContext.getStore()!.client;let committed=false;
  try{
   await client.query('BEGIN');
   if(changed){
    for(const old of affected){
     const snapshot={...old,chain:this.graphChain(old,all).map(c=>({id:c.id,name:c.name,version:c.version}))};
     await client.query('INSERT INTO network_channel_versions(channel_id,version,config) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[old.id,old.version,JSON.stringify(snapshot)]);
    }
    for(const old of [...affected].reverse())await this.stopChannel(old.id);
    for(const [task,pending]of this.gateways){const gateway=await pending.catch(()=>undefined);if(gateway&&affected.some(c=>Number(c.id)===gateway.scope.channelId))await this.stopTask(task);}
    for(const old of affected){
     backups.set(old.id,await this.secret(old.id));
     await this.writeSecret(old.id,{token:randomBytes(32).toString('hex'),relay:randomBytes(32).toString('hex'),user:'wormhole-'+old.id,password:randomBytes(24).toString('hex')});
    }
   }
   await client.query("UPDATE network_channels SET name=$2,server_host=$3,parent_channel_id=$4,entry_port=$5,relay_listen=$6,full_network=$7,scopes=$8::jsonb,enabled=$9,probe_url=$10,version=version+$11,updated_at=now() WHERE id=$1",
    [id,next.name,next.server_host,parentId,next.entry_port,next.relay_listen,next.full_network,JSON.stringify(next.scopes),next.enabled,next.probe_url,changed?1:0]);
   if(changed)for(const child of affected.filter(c=>c.id!==String(id))){
    const immediate=Number(child.parent_channel_id)===id;
    const entry=immediate?Number(relay.split(':').at(-1)):child.entry_port;
    const relayHost=(address:string)=>{const host=address.slice(0,address.lastIndexOf(':'));return host.startsWith('[')&&host.endsWith(']')?host.slice(1,-1):host;};
    const oldHost=relayHost(row.relay_listen),newHost=relayHost(relay);
    // Preserve customer NAT/DNS addresses. Only follow an address that exactly
    // matched the old listener; wildcard listeners never become dial addresses.
    const host=immediate&&child.server_host===oldHost&&newHost&&!newHost.includes(':')&&newHost!=='0.0.0.0'?newHost:child.server_host;
    await client.query('UPDATE network_channels SET entry_port=$2,server_host=$3,version=version+1,updated_at=now() WHERE id=$1',[child.id,entry,host]);
   }
   await client.query('COMMIT');committed=true;
  }catch(error){
   await client.query('ROLLBACK');
   for(const [channel,secret]of backups)await this.writeSecret(channel,secret);
   throw error;
  }finally{
   if(changed)for(const current of committed?(await this.db.query('SELECT * FROM network_channels WHERE id=ANY($1::bigint[])',[affected.map(c=>c.id)])).rows:affected)
    if(current.enabled)await this.startChannel(current).catch(()=>console.warn("[network] channel "+current.id+" Waiting for recovery"));
  }
  if(!changed){if(next.enabled)await this.startChannel(next);else{
   await this.stopChannel(String(id));
   for(const [task,pending]of this.gateways){const gateway=await pending.catch(()=>undefined);if(gateway&&(await this.chain(await this.row(gateway.scope.channelId!))).some(c=>Number(c.id)===id))await this.stopTask(task);}
  }}
  await this.event(String(id),changed?'channel_reconfigured':patch.enabled!==undefined?(enabled?'channel_enabled':'channel_disabled'):'channel_updated');
  return {...await this.describe(await this.row(id)),requires_redeploy:changed,affected_channels:changed?affected.map(c=>({id:c.id,name:c.id===String(id)?name:c.name})):[]};
 }

 async connector(id:number,platform:string){return this.configurationOperation(()=>this.connectorBundle(id,platform));}
 private async connectorBundle(id:number,platform:string){
  const row=await this.row(id);if(!row.enabled)throw new ChannelError("Channel deactivated");
  if(!['linux_amd64','windows_amd64'].includes(platform))throw new ChannelError("Please select Linux or Windows x64");
  const folder=this.folder(String(id)),secret=await this.secret(String(id)),windows=platform.startsWith('windows'),binary=path.join(frpRoot(),windows?'frpc.exe':'frpc');
  if(!existsSync(binary))throw new ChannelError("The corresponding platform connection program has not been installed yet",503);
  const config=`serverAddr = "127.0.0.1"
serverPort = ${row.control_port}
loginFailExit = false
transport.proxyURL = ${quote(`http://wormhole-${id}:${secret.relay}@${row.server_host}:${row.entry_port??this.entryPort}`)}
auth.method = "token"
auth.token = ${quote(secret.token)}
transport.tls.enable = true
transport.tls.trustedCaFile = "ca.pem"
transport.tls.serverName = "wormhole-network-channel"
transport.heartbeatInterval = 5
transport.heartbeatTimeout = 15
log.to = "console"
log.level = "error"
[[proxies]]
name = "wormhole-channel-${id}"
type = "tcp"
remotePort = ${row.socks_port}
[proxies.plugin]
type = "socks5"
username = ${quote(secret.user)}
password = ${quote(secret.password)}
`;
  const packetConfig={version:row.version,listen:'127.0.0.1:'+row.packet_port,token:secret.token,scopes:row.scopes,full_network:row.full_network,relay_listen:row.relay_listen,entry:row.server_host+':'+(row.entry_port??this.entryPort),frpc:windows?'frpc.exe':'frpc'};
  const extra:Record<string,Uint8Array>=row.packet_port?{'connector.json':strToU8(JSON.stringify(packetConfig,null,2)),[windows?'wormhole-connector.exe':'wormhole-connector']:new Uint8Array(await readFile(path.join(frpRoot(),windows?'wormhole-connector.exe':'wormhole-connector')))}:{};
  const packetProxy=row.packet_port?'\n[[proxies]]\nname = "wormhole-packets-'+id+'"\ntype = "tcp"\nremotePort = '+row.packet_port+'\nlocalIP = "127.0.0.1"\nlocalPort = '+row.packet_port+'\n':'';
  if(row.packet_port)extra['THIRD-PARTY-NOTICES.txt']=new Uint8Array(await readFile(path.join(frpRoot(),'THIRD-PARTY-NOTICES.txt')));
  if(windows&&row.full_network){extra['wintun.dll']=new Uint8Array(await readFile(path.join(frpRoot(),'wintun.dll')));extra['WINTUN-LICENSE.txt']=new Uint8Array(await readFile(path.join(frpRoot(),'WINTUN-LICENSE.txt')));}
  const launch=row.packet_port?'Linux: chmod 600 connector.json frpc.toml && chmod +x frpc wormhole-connector && '+(row.full_network?'sudo ':'')+'./wormhole-connector -config connector.json\nWindows'+(row.full_network?" (Administrator)":'')+': .\\\\wormhole-connector.exe -config connector.json':'Linux: chmod 600 frpc.toml && chmod +x frpc && ./frpc -c frpc.toml\nWindows: .\\\\frpc.exe -c frpc.toml';
  await this.event(String(id),'connector_downloaded');
  return zipSync({...extra,[windows?'frpc.exe':'frpc']:new Uint8Array(await readFile(binary)),'frpc.toml':strToU8(config+packetProxy),'ca.pem':new Uint8Array(await readFile(path.join(folder,'ca.pem'))),'README.txt':strToU8("Channel:"+row.name+" · Configuration version v"+row.version+"\nThis configuration contains connection credentials, please keep them properly. Only operate the machine at the designated site.\n"+launch+"\nClosing the program disconnects the channel. A complete network requires administrator rights, TUN and NAT; the relay only accepts lower-level connections at the filled-in listening address.\n"),'LICENSE':new Uint8Array(await readFile(path.join(frpRoot(),'LICENSE')))});
 }
 async handleConnect(req:IncomingMessage,socket:Socket,head:Buffer){
  try{
   if(this.stopping||this.relaySockets.size>=128){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
   const raw=req.headers['proxy-authorization'];
   const decoded=typeof raw==='string'&&raw.startsWith('Basic ')?Buffer.from(raw.slice(6),'base64').toString():'';
   const match=decoded.match(/^wormhole-(\d+):([a-f0-9]{64})$/);
   if(!match){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="WORMHOLE channel"\r\nConnection: close\r\n\r\n');return;}
   const row=await this.row(match[1]!),secret=await this.secret(String(row.id));
   const provided=Buffer.from(match[2]!),expected=Buffer.from(secret.relay);
   if(!(await this.chain(row)).every(c=>c.enabled)||provided.length!==expected.length||!timingSafeEqual(provided,expected)||req.url!=='127.0.0.1:'+row.control_port){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   const upstream=connect(row.control_port,'127.0.0.1');for(const peer of [socket,upstream]){this.relaySockets.add(peer);peer.on('close',()=>{this.relaySockets.delete(peer);socket.destroy();upstream.destroy();});peer.on('error',()=>{socket.destroy();upstream.destroy();});}
   upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 }
 private async inheritedStopped(taskId:number){
  return !!(await this.db.query("SELECT 1 FROM business_model_runs r WHERE r.task_id=$1 AND r.trigger_kind IN ('initial','discovery') AND EXISTS(SELECT 1 FROM task_business_models m WHERE m.modeling_task_id=r.task_id) AND NOT EXISTS(SELECT 1 FROM task_business_models m JOIN tasks p ON p.id=m.task_id WHERE m.modeling_task_id=r.task_id AND p.status IN ('created','running','paused') AND NOT p.paused AND p.deleted_at IS NULL)",[taskId])).rowCount;
 }
 private async authorize(taskId:number,url:URL,humanBrowser=false){
  const t=(await this.db.query('SELECT network_channel_id,network_version,status,paused,deleted_at FROM tasks WHERE id=$1',[taskId])).rows[0];
  if(!t||t.deleted_at||await this.inheritedStopped(taskId)||(!humanBrowser&&(t.status!=='running'||t.paused))||(humanBrowser&&!['created','running'].includes(t.status)))throw new ChannelError("Task paused or ended",409);
  const row=await this.row(t.network_channel_id);if(!(await this.chain(row)).every(c=>c.enabled)||Number(t.network_version)!==row.version)throw new ChannelError("Task bound springboard channel is not available",503);
  if(!channelAllows(row.scopes,url))throw new ChannelError("The target is not within the allowed range of the springboard channel",403);
  if(!(await Promise.all((await this.chain(row)).map(c=>this.online(c)))).every(Boolean))throw new ChannelError("Springboard chain is offline, target access has been suspended",503);
 }
 async scope(taskId?:number,humanBrowser=false):Promise<NetworkScope>{
  if(this.stopping)throw new ChannelError("Network channel is closing",503);
  if(!taskId){const mode=(await this.db.query("SELECT value FROM app_settings WHERE key='settings.network_mode'")).rows[0]?.value;return {mode:mode==='jump'?'jump':'standard'};}
  const t=(await this.db.query('SELECT network_mode,network_channel_id,network_version,status,paused,kind FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];
  if(!t)throw new ChannelError("The task does not exist or has been deleted",404);
  if(t.network_mode!=='jump')return {taskId,mode:'standard'};
  if(humanBrowser){
    if(!['created','running'].includes(t.status)||(t.kind==='modeling'&&await this.inheritedStopped(taskId)))throw new ChannelError("Task has ended",409);
    const row=await this.row(t.network_channel_id),secret=await this.secret(String(row.id));
    return {taskId,mode:'jump',channelId:Number(row.id),upstream:'socks5h://'+secret.user+':'+secret.password+'@127.0.0.1:'+row.socks_port,
      authorize:async(url:URL)=>this.authorize(taskId,url,true)};
  }
  if(t.status!=='running'||t.paused||(t.kind==='modeling'&&await this.inheritedStopped(taskId)))return {taskId,mode:'jump',channelId:Number(t.network_channel_id)};
  let pending=this.gateways.get(taskId);
  if(!pending){pending=this.gateway(taskId,t);this.gateways.set(taskId,pending);pending.catch(()=>{if(this.gateways.get(taskId)===pending)this.gateways.delete(taskId);});}
  const scope=(await pending).scope;if(scope.route)scope.route.capture=this.traffic.enabled()?this.traffic.store:undefined;return scope;
 }
 private async gateway(taskId:number,t:any){
  const row=await this.row(t.network_channel_id),secret=await this.secret(String(row.id));
  const upstream=`socks5h://${secret.user}:${secret.password}@127.0.0.1:${row.socks_port}`;
  const proxy=new TrafficProxy(this.traffic.store,0,{authorize:async(url)=>{await this.authorize(taskId,url);return true;},context:{taskId},capture:()=>this.traffic.enabled(),strictTLS:true,credential:randomBytes(24).toString('hex')});
  proxy.setUpstream(upstream);await proxy.start();
  const unixSocket=path.join(this.folder(String(row.id)),`task-${taskId}.sock`);try{await proxy.startUnix(unixSocket);}catch(e){await proxy.stop();throw e;}
  const workdir=path.join(this.dir,'..','workspace','tasks',String(taskId));await mkdir(workdir,{recursive:true,mode:0o700});
  let packetSocket:string|undefined;
  if(row.full_network&&row.packet_port){packetSocket=path.join(this.folder(String(row.id)),'task-'+taskId+'-packets.sock');
   const active=async()=>{const task=(await this.db.query('SELECT status,paused,deleted_at FROM tasks WHERE id=$1',[taskId])).rows[0];const fresh=await this.row(row.id);if(!task||task.status!=='running'||task.paused||task.deleted_at||await this.inheritedStopped(taskId)||!(await this.chain(fresh)).every(c=>c.enabled)||fresh.version!==Number(t.network_version))throw new ChannelError("Task or channel stopped",409);};
   try{this.packets.set(taskId,await packetGateway(packetSocket,row,secret.token,active));}catch(e){await proxy.stop();throw e;}
  }
  const scope:NetworkScope={taskId,mode:'jump',channelId:Number(row.id),name:row.name,unixSocket,packetSocket,workdir,caFile:proxy.caFile,
   upstream,authorize:async(url:URL)=>this.authorize(taskId,url),
   route:{proxy:proxy.authenticatedAddress(),caFile:proxy.caFile,capture:this.traffic.enabled()?this.traffic.store:undefined}};
  return {proxy,scope};
 }
 async probe(id:number,target:string,signal:AbortSignal){
  const row=await this.row(id),chain=await this.chain(row);
  if(!target.trim()){
   const checks=await Promise.all(chain.map(async c=>({id:c.id,name:c.name,status:!c.enabled?'disabled':await this.online(c)?'online':'offline'})));
   const proxyReady=checks.every(c=>c.status==='online'),fullReady=proxyReady&&row.full_network?await this.fullReady(row):false;
   return {kind:'channel',ready:proxyReady&&(!row.full_network||fullReady),proxy_ready:proxyReady,full_network:row.full_network,full_network_ready:fullReady,chain:checks};
  }
  const address=this.probeAddress(target,row.scopes);
  if(!(await Promise.all(chain.map(c=>this.online(c)))).every(Boolean))throw new ChannelError("Springboard chain offline",503);
  const secret=await this.secret(String(id));const {targetRequest}=await import('../traffic/network.ts');
  const response=await targetRequest(address,'GET',undefined,signal,undefined,undefined,{}, {proxy:'socks5h://'+secret.user+':'+secret.password+'@127.0.0.1:'+row.socks_port,caFile:''});
  await this.event(String(id),'connectivity_checked');return {kind:'target',reachable:true,status:response.status,target:address};
 }

 async stopTask(taskId:number,cascade=true){
  const p=this.gateways.get(taskId);this.gateways.delete(taskId);
  const g=p?await p.catch(()=>undefined):undefined;
  const packet=this.packets.get(taskId);this.packets.delete(taskId);await packet?.close();
  await g?.proxy.stop();if(g?.scope.unixSocket)await rm(g.scope.unixSocket,{force:true});
  if(cascade){const rows=(await this.db.query("SELECT m.modeling_task_id FROM task_business_models m JOIN business_model_runs r ON r.task_id=m.modeling_task_id WHERE m.task_id=$1 AND r.trigger_kind IN ('initial','discovery') AND NOT EXISTS(SELECT 1 FROM task_business_models l JOIN tasks owner ON owner.id=l.task_id WHERE l.modeling_task_id=m.modeling_task_id AND owner.status IN ('created','running','paused') AND NOT owner.paused AND owner.deleted_at IS NULL)",[taskId])).rows;await Promise.all(rows.map(r=>this.stopTask(Number(r.modeling_task_id),false)));}
 }
 private async stopChannel(id:string){this.revisions.set(id,(this.revisions.get(id)??0)+1);clearTimeout(this.restarts.get(id));this.restarts.delete(id);await this.starting.get(id)?.catch(()=>{});const child=this.children.get(id);this.children.delete(id);if(!child)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
 private async sweep(){if(this.stopping)return;for(const task of this.gateways.keys()){const row=(await this.db.query('SELECT status,paused,deleted_at FROM tasks WHERE id=$1',[task])).rows[0];if(!row||row.status!=='running'||row.paused||row.deleted_at)await this.stopTask(task);}}
 async close(){this.stopping=true;for(const timer of this.restarts.values())clearTimeout(timer);this.restarts.clear();await Promise.allSettled([...this.starting.values()]);for(const socket of this.relaySockets)socket.destroy();if(this.timer)clearInterval(this.timer);await Promise.allSettled([...new Set([...this.gateways.keys(),...this.packets.keys()])].map(id=>this.stopTask(id)));await Promise.allSettled([...this.children.keys()].map(id=>this.stopChannel(id)));}
}
