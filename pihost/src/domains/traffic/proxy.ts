import {getCACertificates} from 'node:tls';
/** HTTP/HTTPS capture. Native streams preserve compressed and binary wire bytes. */
import {createServer,request as httpRequest,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {createServer as httpsServer,request as httpsRequest} from 'node:https';
import {type Socket,isIP} from 'node:net';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync,unlinkSync,openSync,writeSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import path from 'node:path';
import {CONTEXT_HEADER,consumeCapture,type CaptureContext} from './context.ts';
import {TrafficStore} from './store.ts';
import {proxyAgent} from './network.ts';
const hop=new Set([CONTEXT_HEADER,'connection','proxy-connection','proxy-authorization','proxy-authenticate','keep-alive','transfer-encoding','te','trailer','upgrade']);
function rawHeaders(req:IncomingMessage):string[]{
  const excluded=new Set([...hop,...String(req.headers.connection??'').split(',').map(s=>s.trim().toLowerCase())]);
  const out:string[]=[];for(let n=0;n<req.rawHeaders.length;n+=2)if(!excluded.has(req.rawHeaders[n]!.toLowerCase()))out.push(req.rawHeaders[n]!,req.rawHeaders[n+1]!);return out;
}
const lines=(raw:string[])=>raw.reduce((s,v,n)=>n%2?s+v+'\n':s+v+': ','');
function outgoingHeaders(req:IncomingMessage):Record<string,string|string[]>{
  const raw=rawHeaders(req),headers:Record<string,string|string[]>={};
  for(let n=0;n<raw.length;n+=2){const key=raw[n]!.toLowerCase(),value=raw[n+1]!,old=headers[key];headers[key]=old===undefined?value:Array.isArray(old)?[...old,value]:[old,value];}
  return headers;
}
export interface ScopedTrafficPolicy {
  authorize(url: URL, method: string, connect: boolean): Promise<boolean>;
  context: Pick<CaptureContext, "taskId" | "intentId" | "browserEnvironmentId">;
  capture(): boolean;
  credential?:string;
  strictTLS?:boolean;
}

export class TrafficProxy {
  private server:Server|null=null;private running=false;private sockets=new Set<Socket>();private upstream=new Set<import('node:http').ClientRequest>();
  private leaves=new Map<string,ReturnType<typeof httpsServer>>();private ca:{cert:string;key:string};
  private starting:Promise<void>|null=null;private stopping:Promise<void>|null=null;
  private upstreamProxy='';private unixServer:Server|null=null;
  constructor(readonly store:TrafficStore,private readonly port=0, private readonly scoped?: ScopedTrafficPolicy){
    const dir=path.join(store.dir,'_ca');mkdirSync(dir,{recursive:true,mode:0o700});
    const cert=path.join(dir,'rootCA.pem'),key=path.join(dir,'rootCA.key');
    if(!existsSync(cert)||!existsSync(key))execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','3650','-keyout',key,'-out',cert,'-subj','/CN=WORMHOLE pihost Traffic CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],{stdio:'ignore'});
    chmodSync(key,0o600);this.ca={cert:readFileSync(cert,'utf8'),key:readFileSync(key,'utf8')};new X509Certificate(this.ca.cert);
  }
  get caFile(){return path.join(this.store.dir,'_ca','rootCA.pem');}
  address():string{const a=this.server?.address();return a&&typeof a==='object'?`http://127.0.0.1:${a.port}`:'';}
  isRunning(){return this.running;}
  authenticatedAddress(){const u=new URL(this.address());if(this.scoped?.credential){u.username='wormhole';u.password=this.scoped.credential;}return u.href;}
  private authenticated(req:IncomingMessage,authority?:string){
    if(!this.scoped?.credential||authority)return true;
    return req.headers['proxy-authorization']==='Basic '+Buffer.from('wormhole:'+this.scoped.credential).toString('base64');
  }
  async startUnix(file:string){
    if(existsSync(file))unlinkSync(file);
    const server=createServer((req,res)=>void this.forward(req,res));this.unixServer=server;
    server.on('connection',s=>{this.sockets.add(s);s.on('close',()=>this.sockets.delete(s));s.on('error',()=>{});});
    server.on('connect',(req,socket,head)=>void this.connect(req,socket as Socket,head));
    server.on('clientError',(_e,s)=>s.destroy());
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
    chmodSync(file,0o600);
  }
  setUpstream(proxy:string){if(proxy){const u=new URL(proxy);if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol))throw new Error('unsupported upstream proxy protocol');}this.upstreamProxy=proxy;}
  async start():Promise<void>{
    if(this.stopping)await this.stopping;if(this.running)return;if(this.starting)return this.starting;
    this.starting=(async()=>{
      const server=createServer((req,res)=>void this.forward(req,res));this.server=server;
      server.on('connection',socket=>{this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});});
      server.on('connect',(req,socket,head)=>void this.connect(req,socket as Socket,head));server.on('clientError',(_e,socket)=>socket.destroy());
      try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});this.running=true;}
      catch(e){server.close();this.server=null;throw e;}
      server.on('error',e=>console.error('[traffic] listener:',String(e)));
    })();try{await this.starting;}finally{this.starting=null;}
  }
  async stop():Promise<void>{
    if(this.stopping)return this.stopping;
    this.stopping=(async()=>{
      if(this.starting)await this.starting.catch(()=>{});this.running=false;
      for(const req of this.upstream)req.destroy(new Error('traffic proxy stopped'));
      for(const socket of this.sockets)socket.destroy();this.sockets.clear();
      const server=this.server,unix=this.unixServer;this.server=null;this.unixServer=null;if(server)await new Promise<void>(r=>server.close(()=>r()));if(unix)await new Promise<void>(r=>unix.close(()=>r()));this.leaves.clear();
    })();try{await this.stopping;}finally{this.stopping=null;}
  }
  private leaf(host:string,authority:string){
    const keyId=createHash('sha256').update(this.ca.cert+'\n'+authority).digest('hex');const old=this.leaves.get(keyId);if(old)return old;
    if(!isIP(host)&&!/^[a-zA-Z0-9._-]+$/.test(host))throw new Error('invalid CONNECT host');
    const dir=path.join(this.store.dir,'_ca','leaves');mkdirSync(dir,{recursive:true,mode:0o700});
    const key=path.join(dir,keyId+'.key'),cert=path.join(dir,keyId+'.pem'),csr=path.join(dir,keyId+'.csr'),ext=path.join(dir,keyId+'.ext');
    let fresh=false;try{fresh=Date.parse(new X509Certificate(readFileSync(cert)).validTo)>Date.now()+86400_000;}catch{}
    if(!fresh||!existsSync(key)){
      writeFileSync(ext,`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIP(host)?'IP':'DNS'}:${host}\n`,{mode:0o600});
      execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN='+host],{stdio:'ignore'});chmodSync(key,0o600);
      execFileSync('openssl',['x509','-req','-in',csr,'-CA',this.caFile,'-CAkey',path.join(this.store.dir,'_ca','rootCA.key'),'-set_serial','0x'+randomBytes(16).toString('hex'),'-out',cert,'-days','365','-sha256','-extfile',ext],{stdio:'ignore'});
    }
    const server=httpsServer({key:readFileSync(key),cert:readFileSync(cert),ALPNProtocols:['http/1.1']},(req,res)=>void this.forward(req,res,authority));
    server.on('tlsClientError',(_error,socket)=>socket.destroy());server.on('clientError',(_error,socket)=>socket.destroy());
    if(this.leaves.size>=256)this.leaves.delete(this.leaves.keys().next().value!);this.leaves.set(keyId,server);return server;
  }
  private async connect(req:IncomingMessage,socket:Socket,head:Buffer){
    try{
      if(!this.authenticated(req)){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');return;}
      const u=new URL('https://'+req.url);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('invalid CONNECT authority');
      if (this.scoped && !await this.scoped.authorize(u, "CONNECT", true)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const host=u.hostname.replace(/^\[|\]$/g,''),server=this.leaf(host,u.host);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n',()=>{if(head.length)socket.unshift(head);server.emit('connection',socket);});
    }catch(e){console.warn('[traffic] CONNECT:',String(e));socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');}
  }
  private async forward(req:IncomingMessage,res:ServerResponse,authority?:string){
    if(!this.authenticated(req,authority)){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="WORMHOLE task"'});res.end();return;}
    let target:URL;try{
      target=authority?new URL(req.url??'/',`https://${authority}`):new URL(req.url??'/',`http://${req.headers.host??''}`);
      if(authority&&(target.protocol!=='https:'||target.host!==authority))throw new Error('CONNECT authority mismatch');
      if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('invalid target URL');
    }catch{res.writeHead(400);res.end('invalid target URL');return;}
    req.pause();
    if (this.scoped) {
      let allowed=false;
      try{allowed=await this.scoped.authorize(target,req.method??'GET',false);}
      catch(error){if(!res.destroyed){res.writeHead(503,{'x-wormhole-network-error':encodeURIComponent("The springboard channel is unavailable or the task has stopped")});res.end('network unavailable');}return;}
      if(res.destroyed)return;
      if(!allowed){res.writeHead(403,{'x-wormhole-network-error':encodeURIComponent("Target is not within mission network range")});res.end('outside task scope');return;}
    }
    const capture = !this.scoped || this.scoped.capture();
    const supplied=consumeCapture(req.headers[CONTEXT_HEADER]);
    const context:CaptureContext|undefined=this.scoped
      ? {...(supplied?.taskId===this.scoped.context.taskId?supplied:{}),...this.scoped.context,requestId:supplied?.taskId===this.scoped.context.taskId?supplied!.requestId:randomUUID(),view:'wire'}
      : supplied;
    const requestChunks:Buffer[]=[],responseChunks:Buffer[]=[];
    const tls=this.scoped?.strictTLS?{rejectUnauthorized:true,ca:[...getCACertificates('default'),this.ca.cert]}:{rejectUnauthorized:false};
    const agent=this.upstreamProxy?proxyAgent(this.upstreamProxy,target.protocol==='https:',tls):false;
    let responseFile='',responseFd:number|undefined,responseSize=0,previewSize=0;
    const digest=createHash('sha256');
    const write=(chunk:Buffer)=>{let offset=0;while(offset<chunk.length){const n=writeSync(responseFd!,chunk,offset,chunk.length-offset);if(!n)throw new Error('capture write failed');offset+=n;}};
    const cleanup=()=>{if(responseFd!==undefined){try{closeSync(responseFd);}catch{}responseFd=undefined;}if(responseFile){try{unlinkSync(responseFile);}catch{}responseFile='';}};
    const outgoing=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:req.method,headers:outgoingHeaders(req),...tls,agent},response=>{
      const headers=rawHeaders(response);res.writeHead(response.statusCode??502,headers);
      if(capture)response.on('data',(chunk:Buffer)=>{
       try{
        responseSize+=chunk.length;digest.update(chunk);
        if(responseSize>512*1024&&responseFd===undefined){const dir=path.join(this.store.dir,'_capture-tmp');mkdirSync(dir,{recursive:true,mode:0o700});responseFile=path.join(dir,randomUUID());responseFd=openSync(responseFile,'wx',0o600);for(const prefix of responseChunks)write(prefix);}
        if(responseFd!==undefined)write(chunk);
        const room=Math.max(0,4*1024*1024-previewSize);if(room){const prefix=Buffer.from(chunk.subarray(0,room));responseChunks.push(prefix);previewSize+=prefix.length;}
       }catch(e){cleanup();response.destroy(e as Error);outgoing.destroy(e as Error);}
      });
      response.on('error',e=>{cleanup();res.destroy(e);});response.pipe(res,{end:false});
      response.on('end',()=>{
        try{if(responseFd!==undefined){closeSync(responseFd);responseFd=undefined;}
         if(capture)this.store.record({...(responseFile?{respStream:{file:responseFile,hash:digest.digest('hex'),length:responseSize}}:{}),url:target.href,method:req.method??'GET',status:response.statusCode??0,
          contentType:String(response.headers['content-type']??''),requestType:String(req.headers['content-type']??''),
          reqHead:`${req.method} ${target.pathname+target.search} HTTP/${req.httpVersion}\n${lines(rawHeaders(req))}`,
          respHead:`HTTP ${response.statusCode}\n${lines(response.rawHeaders)}`,reqBody:Buffer.concat(requestChunks),respBody:Buffer.concat(responseChunks),context});
        }catch(e){console.error('[traffic] capture failed:',String(e));}finally{cleanup();}res.end();
      });
    });
    this.upstream.add(outgoing);outgoing.on('close',()=>{this.upstream.delete(outgoing);if(!res.writableEnded)cleanup();if(agent)agent.destroy();});outgoing.setTimeout(30_000,()=>outgoing.destroy(new Error('upstream timeout')));
    outgoing.on('error',e=>{console.warn('[traffic] upstream:',e.message.replace(/\/\/[^\s/@]+@/g,'//***@'));if(!res.headersSent){res.writeHead(502,this.scoped?{'x-wormhole-network-error':encodeURIComponent("Target connection failed or springboard unavailable")}:{});res.end('proxy error');}else res.destroy(e);});
    req.on('aborted',()=>outgoing.destroy());req.on('error',()=>outgoing.destroy());
    res.on('close',()=>{if(!res.writableEnded)outgoing.destroy();});
    // Proxy agent connects asynchronously and rewrites the HTTP request line.
    // Do not stream headers/body until its socket is assigned: otherwise a
    // later header rewrite can duplicate the queued header during streaming.
    outgoing.once('socket',()=>{if(capture)req.on('data',(chunk:Buffer)=>requestChunks.push(Buffer.from(chunk)));req.pipe(outgoing);});
  }
}
