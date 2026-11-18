import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,request,type Server} from 'node:http';
import {createServer as httpsServer,request as httpsRequest,Agent} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createServer as netServer,connect as netConnect,type Socket} from 'node:net';
import {TrafficProxy} from '../src/domains/traffic/proxy.ts';
import {TrafficStore} from '../src/domains/traffic/store.ts';
const listen=(s:Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address() as {port:number}).port)));
const close=(s:Server)=>new Promise<void>(r=>{s.closeAllConnections();s.close(()=>r());});
async function post(proxy:TrafficProxy,url:string,body:Buffer,secure=false):Promise<{body:Buffer;headers:import('node:http').IncomingHttpHeaders}>{
  const p=new URL(proxy.address());let agent:Agent|undefined;
  if(secure){const u=new URL(url);const socket=await new Promise<import('node:net').Socket>((resolve,reject)=>{
    const r=request({host:p.hostname,port:p.port,method:'CONNECT',path:u.host});r.once('connect',(res,s,head)=>{if(res.statusCode!==200){s.destroy();reject(new Error('CONNECT failed'));return;}if(head.length)s.unshift(head);resolve(s);});r.on('error',reject);r.end();
  });agent=new Agent({keepAlive:false});agent.createConnection=()=>tlsConnect({socket,ca:execFileSync('cat',[proxy.caFile]),servername:new URL(url).hostname});}
  try{return await new Promise((resolve,reject)=>{
    const options=secure?{method:'POST',agent,headers:{'content-type':'application/octet-stream','content-length':body.length}}:
      {hostname:p.hostname,port:p.port,path:url,method:'POST',headers:{host:new URL(url).host,'content-type':'application/octet-stream','content-length':body.length}};
    const r=secure?httpsRequest(url,options,receive):request(options,receive);
    function receive(res:import('node:http').IncomingMessage){const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({body:Buffer.concat(chunks),headers:res.headers}));res.on('error',reject);}
    r.setTimeout(5000,()=>r.destroy(new Error('test timeout')));r.on('error',reject);r.end(body);
  });}finally{agent?.destroy();}
}
test('F05 HTTP and HTTPS MITM preserve binary/gzip bytes, headers and full SQLite bodies',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wormhole-traffic-'));const store=new TrafficStore(dir),proxy=new TrafficProxy(store);
  const bytes=Buffer.from(Array.from({length:350000},(_,i)=>i%256)),compressed=gzipSync(Buffer.from('中文正文'.repeat(20000)));let incoming:Buffer[]=[];
  const handler=(req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{incoming.push(Buffer.concat(chunks));const b=req.url?.includes('gzip')?compressed:bytes;res.writeHead(200,{'content-type':req.url?.includes('gzip')?'text/plain':'application/octet-stream','content-length':b.length,...(req.url?.includes('gzip')?{'content-encoding':'gzip'}:{}),'set-cookie':['a=1','b=2']});res.end(b);});};
  const http=createServer(handler);execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'target.key'),'-out',path.join(dir,'target.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const https=httpsServer({key:await readFile(path.join(dir,'target.key')),cert:await readFile(path.join(dir,'target.pem'))},handler);
  try{
    const httpPort=await listen(http),httpsPort=await listen(https);await Promise.all([proxy.start(),proxy.start()]);
    const a=await post(proxy,`http://127.0.0.1:${httpPort}/files/123`,bytes);assert.deepEqual(a.body,bytes);assert.deepEqual(a.headers['set-cookie'],['a=1','b=2']);
    const b=await post(proxy,`https://localhost:${httpsPort}/gzip`,bytes,true);assert.deepEqual(b.body,compressed);assert.equal(b.headers['content-encoding'],'gzip');assert.equal(Number(b.headers['content-length']),compressed.length);
    assert.deepEqual(incoming,[bytes,bytes]);assert.equal(store.count(),2);
    const rows=store.page(new URLSearchParams(),0,100).exchanges;assert.ok(rows.some(r=>r.url.startsWith('https://')),'HTTPS 已解密捕获');
    const row=rows.find(r=>r.url.includes('/files/'))!;assert.equal(row.url_template,'/files/{id}');const raw=store.get(row.id);
    const hash=/@blob sha256:([a-f0-9]{64})/.exec(raw.resp)![1]!;assert.deepEqual(await readFile(store.blobFile(hash).file),bytes);
    const saved=store.db.prepare('SELECT req_len,resp_len FROM exchanges WHERE id=?').get(row.id)!;assert.equal(saved.req_len,bytes.length);assert.equal(saved.resp_len,bytes.length);
    assert.match(raw.req,/Host: 127\.0\.0\.1:/i);assert.ok(store.fts);
    await proxy.stop();assert.equal(proxy.isRunning(),false);await proxy.start();assert.ok(proxy.address());await proxy.stop();
  }finally{await proxy.stop();await close(http);await close(https);store.close();await rm(dir,{recursive:true,force:true});}
});
test('F05 capture search, literal trigram, restart, dedup blob references and exact host deletion',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wormhole-traffic-store-'));let s=new TrafficStore(dir);
  try{
    const body=Buffer.from('头部'.repeat(150000)+'敏感中文 secret\" OR xyz');
    const capture=(host:string,status:number)=>s.record({url:`https://${host}/items/42`,method:'POST',status,contentType:'text/plain',requestType:'text/plain',reqHead:'POST /items/42 HTTP/1.1\nHost: '+host+'\n',respHead:'HTTP '+status+'\n',reqBody:Buffer.alloc(0),respBody:body,ts:1700000000});
    const a=capture('api.example.test',200),b=capture('api.example.test.cn',404);s.close();s=new TrafficStore(dir);
    assert.equal(s.page(new URLSearchParams('body=敏感中文&method=post'),0,100).total,2);
    assert.equal(s.page(new URLSearchParams({body:'secret" OR xyz'}),0,100).total,2,'FTS 查询字面值不解释 OR');
    assert.equal(s.page(new URLSearchParams('status=4xx&resp_min=1000'),0,1).total,1);assert.equal(s.page(new URLSearchParams('path=/items/%7Bid%7D&host=api.example'),0,100).total,2);
    assert.equal(s.page(new URLSearchParams('body=中文'),0,100).total,2,'不足三字符原样忽略 body 条件');
    const hash=/@blob sha256:([a-f0-9]{64})/.exec(s.get(a).resp)![1]!;assert.ok(s.get(a).resp.includes('…[truncated]'));assert.deepEqual(await readFile(s.blobFile(hash).file),body);
    assert.equal(s.deleteHosts(['api.example.test'],true),1);assert.equal(s.count(),1);assert.deepEqual(await readFile(s.blobFile(hash).file),body,'另一 host 引用的 blob 保留');
    assert.equal(s.get(b).resp.includes('敏感中文'),false,'正文大于预览时通过全文索引检索');
    assert.equal(s.deleteHosts(['api.example'],false),1);assert.equal(s.count(),0);assert.throws(()=>s.blobFile(hash),/不存在/);assert.throws(()=>s.blobFile('../escape'),/非法/);
    assert.equal(s.page(new URLSearchParams('body=敏感中文'),0,100).total,0,'删除后 FTS 无残留');
  }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('F05 occupied listener rejects startup instead of hanging',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wormhole-traffic-listen-')),store=new TrafficStore(dir),occupied=createServer();const port=await listen(occupied),proxy=new TrafficProxy(store,port);
  try{await assert.rejects(proxy.start(),/EADDRINUSE/);assert.equal(proxy.isRunning(),false);}finally{await proxy.stop();await close(occupied);store.close();await rm(dir,{recursive:true,force:true});}
});
test('F05 global HTTP proxy is honored for HTTP and HTTPS with no direct fallback',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wormhole-traffic-upstream-')),outerStore=new TrafficStore(path.join(dir,'outer')),innerStore=new TrafficStore(path.join(dir,'inner'));
  const outer=new TrafficProxy(outerStore),inner=new TrafficProxy(innerStore),target=createServer((q,r)=>{q.resume();q.on('end',()=>r.end('UPSTREAM_SEEN'));});
  try{
    const port=await listen(target);await inner.start();await outer.start();outer.setUpstream(inner.address());
    const result=await post(outer,`http://127.0.0.1:${port}/chained`,Buffer.from('body'));assert.equal(result.body.toString(),'UPSTREAM_SEEN');assert.equal(innerStore.count(),1);assert.equal(outerStore.count(),1);
    // HTTPS target uses the fixture root as its server certificate. The capture
    // upstream intentionally accepts target certificates, as WORMHOLE SslInsecure.
    const https=httpsServer({key:await readFile(path.join(innerStore.dir,'_ca','rootCA.key')),cert:await readFile(inner.caFile)},(_q,r)=>r.end('TLS_UPSTREAM_SEEN'));
    try{const tlsPort=await listen(https);const secure=await post(outer,`https://localhost:${tlsPort}/chained`,Buffer.alloc(0),true);assert.equal(secure.body.toString(),'TLS_UPSTREAM_SEEN');assert.equal(innerStore.count(),2);assert.equal(outerStore.count(),2);}finally{await close(https);}
    await inner.stop();const failure=await post(outer,`http://127.0.0.1:${port}/blocked`,Buffer.alloc(0));assert.equal(failure.body.toString(),'proxy error');assert.equal(outerStore.count(),2,'上游不可达不能回退为直连绕过');
  }finally{await outer.stop();await inner.stop();await close(target);outerStore.close();innerStore.close();await rm(dir,{recursive:true,force:true});}
});
test('F05 authenticated SOCKS5 upstream forwards actual HTTP target traffic',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wormhole-traffic-socks-')),store=new TrafficStore(dir),proxy=new TrafficProxy(store),sockets=new Set<Socket>();let routed=0;
  const socks=netServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buffered=Buffer.alloc(0),wake:()=>void=()=>{},closed=false;
    const collect=(b:Buffer)=>{buffered=Buffer.concat([buffered,b]);wake();};socket.on('data',collect);socket.on('close',()=>{closed=true;wake();});
    const read=async(n:number)=>{while(buffered.length<n){if(closed)throw new Error('fixture disconnected');await new Promise<void>(r=>{wake=r;});}const b=buffered.subarray(0,n);buffered=buffered.subarray(n);return b;};
    void(async()=>{
      const hello=await read(2);assert.equal(hello[0],5);await read(hello[1]!);socket.write(Buffer.from([5,2]));
      const auth=await read(2);assert.equal(auth[0],1);const user=(await read(auth[1]!)).toString(),pwLength=(await read(1))[0]!,password=(await read(pwLength)).toString();assert.equal(user,'fixture-user');assert.equal(password,'fixture-key');socket.write(Buffer.from([1,0]));
      const command=await read(4);assert.equal(command[1],1);let host:string;
      if(command[3]===1)host=[...await read(4)].join('.');else if(command[3]===3)host=(await read((await read(1))[0]!)).toString();else throw new Error('unexpected fixture address');
      const port=(await read(2)).readUInt16BE(),upstream=netConnect({host,port});sockets.add(upstream);upstream.on('error',()=>socket.destroy());upstream.on('close',()=>{sockets.delete(upstream);socket.destroy();});socket.on('close',()=>upstream.destroy());
      await new Promise<void>((r,j)=>{upstream.once('connect',r);upstream.once('error',j);});routed++;socket.removeListener('data',collect);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(buffered.length)upstream.write(buffered);socket.pipe(upstream);upstream.pipe(socket);
    })().catch(()=>socket.destroy());
  });
  const target=createServer((q,r)=>{q.resume();q.on('end',()=>r.end('SOCKS_SEEN'));});
  try{const port=await listen(target);await new Promise<void>(r=>socks.listen(0,'127.0.0.1',r));await proxy.start();proxy.setUpstream(`socks5://fixture-user:fixture-key@127.0.0.1:${(socks.address() as {port:number}).port}`);
    const result=await post(proxy,`http://127.0.0.1:${port}/socks`,Buffer.from('body'));assert.equal(result.body.toString(),'SOCKS_SEEN');assert.equal(routed,1);assert.equal(store.count(),1);
  }finally{await proxy.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>socks.close(()=>r()));await close(target);store.close();await rm(dir,{recursive:true,force:true});}
});
