/** Real PostgreSQL, real child process, real encrypted HTTP: no fixtures of the
 * proxy itself. The proxy under test is written to disk like a worker would. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {connect} from 'node:net';
import {mkdir,mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {ReverseProxies} from '../src/domains/reverse/proxy.ts';
import {registerReverseTools,seedReverseProxyTools} from '../src/domains/reverse/tools.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {registerBusinessTools} from '../src/domains/tools/business.ts';
import type {ToolContext} from '../src/domains/tools/gate.ts';

const KEY = '11'.repeat(32), IV = '22'.repeat(16), SIGN = 'fixture-hmac';

function seal(value: unknown): string {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), Buffer.from(IV, 'hex'));
  return JSON.stringify({data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64')});
}
function open(text: string): unknown {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), Buffer.from(IV, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(JSON.parse(text).data, 'base64')), decipher.final()]).toString('utf8'));
}

function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

const PROXY_SCRIPT = `
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
const port=Number(process.env.WORMHOLE_REVERSE_PROXY_PORT);
const scope=JSON.parse(process.env.WORMHOLE_REVERSE_PROXY_SCOPE||'{}');
const key=Buffer.from('${KEY}','hex'),iv=Buffer.from('${IV}','hex'),signKey='${SIGN}';
function inScope(req){
  let target;try{target=new URL(req.url);}catch{target=new URL(req.url,scope.origin);}
  if(target.origin!==scope.origin||req.method!==scope.method)return false;
  const a=scope.path.split('/'),b=target.pathname.split('/');
  return a.length===b.length&&a.every((part,i)=>part.startsWith(':')?!!b[i]:part===b[i]);
}
function encrypt(plain){
  const cipher=createCipheriv('aes-256-cbc',key,iv);
  const body=JSON.stringify({data:Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final()]).toString('base64')});
  return {body,signature:createHmac('sha256',signKey).update(body).digest('hex')};
}
function decrypt(bytes){
  const decipher=createDecipheriv('aes-256-cbc',key,iv);
  const envelope=JSON.parse(bytes.toString('utf8'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
}
http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const matched=inScope(req);
  const target=new URL(req.url);
  const headers={...req.headers};
  delete headers['proxy-connection'];delete headers.host;
  let body=Buffer.concat(chunks);
  if(matched){const sealed=encrypt(JSON.parse(body.toString('utf8')||'{}'));body=Buffer.from(sealed.body);headers['content-type']='application/json';headers['x-signature']=sealed.signature;}
  headers['content-length']=String(body.length);
  const upstream=(target.protocol==='https:'?https:http).request({...(target.protocol==='https:'?{ca:fs.readFileSync('fixture-ca.pem')} : {}),host:target.hostname,port:target.port||(target.protocol==='https:'?443:80),path:target.pathname+target.search,method:req.method,headers},response=>{
    const out=[];response.on('data',chunk=>out.push(chunk));
    response.on('end',()=>{
      const received=Buffer.concat(out);
      let result=received;
      if(matched){try{result=Buffer.from(JSON.stringify(decrypt(received)));}catch{}}
      res.writeHead(response.statusCode||502,{...response.headers,'content-length':String(result.length)});
      res.end(result);
    });
  });
  upstream.on('error',error=>{res.writeHead(502);res.end(String(error));});
  upstream.end(body);
}).listen(port,'127.0.0.1',()=>console.log('reverse proxy listening on',port));
`;

test('reverse proxy: real encryption round trip, registry and terminal cleanup', async () => {
  const config = loadConfig(), schema = 'codex_reverse_proxy_' + process.pid + '_' + Date.now();
  const admin = new Pool({connectionString: config.database.dsn});
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({connectionString: config.database.dsn, options: '-c search_path=' + schema});
  const dir = await mkdtemp(path.join(tmpdir(), 'wormhole-reverse-proxy-'));
  const seen: {ok: boolean; plain: unknown}[] = [];
  const target = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ok = req.headers['x-signature'] === createHmac('sha256', SIGN).update(raw).digest('hex');
    seen.push({ok, plain: ok ? open(raw) : null});
    if (!ok) { res.writeHead(400); res.end('bad signature'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(seal({ok: true, echo: open(raw)}));
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (target.address() as {port: number}).port;
  const url = origin + '/api/secure';
  let proxies: ReverseProxies | undefined;
  try {
    await runMigrations(pool);
    // The abandoned capability-v1 registry must not survive this migration.
    const legacy = (await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename IN('target_capabilities','capability_invocations','reverse_jobs','reverse_targets','capability_validations','capability_dependencies')`, [schema])).rowCount;
    assert.equal(legacy, 0, 'capability-v1 tables are dropped');
    assert.equal((await pool.query("SELECT key FROM tools WHERE key='capability_http_request'")).rowCount, 0, 'capability-v1 tools are not seeded');

    await seedReverseProxyTools(pool);
    await seedReverseProxyTools(pool); // idempotent
    proxies = new ReverseProxies(pool, dir);
    registerReverseTools(proxies);

    const task = Number((await pool.query(
      `WITH e AS(INSERT INTO explorations(goal) VALUES('fixture') RETURNING id)
       INSERT INTO tasks(name,goal,status,exploration_id) SELECT 'reverse proxy fixture','fixture','running',e.id FROM e RETURNING id`)).rows[0].id);
    const intent = Number((await pool.query(
      `INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,state)
       SELECT $1,exploration_id,'intent','reverse analysis','running' FROM tasks WHERE id=$1 RETURNING id`, [task])).rows[0].id);
    const cwd = path.join(dir, 'workspace', 'tasks', String(task), 'i' + intent);
    await mkdir(cwd, {recursive: true});
    await writeFile(path.join(cwd, 'proxy.mjs'), PROXY_SCRIPT);
    const ctx: ToolContext = {businessKind: 'worker', businessId: 'task-' + task, agentKey: 'worker', taskId: task, intentId: intent, cwd};

    const started = await proxies.start(ctx, {mode:'legacy',script_path: 'proxy.mjs', url, method: 'POST', usage: '明文 JSON，自动 AES+HMAC'});
    const proxyUrl = String(started.proxy_url);
    const port = Number(new URL(proxyUrl).port);
    assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(started.scope, {origin, method: 'POST', path: '/api/secure'});
    assert.equal(await portClosed(port), false, 'proxy is listening');
    const listed = await proxies.list(task);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, 'running');
    assert.equal(listed[0]!.proxy_url, proxyUrl);

    // A second worker doing the same reverse must reuse the live proxy, not stack one.
    const reused = await proxies.start(ctx, {mode:'legacy',script_path: 'proxy.mjs', url, method: 'POST', usage: 'dup'});
    assert.equal(reused.reused, true, 'duplicate reverse work reuses the existing proxy');
    assert.equal(reused.proxy_url, proxyUrl);
    assert.equal(reused.usage, '明文 JSON，自动 AES+HMAC');
    assert.equal((await pool.query('SELECT count(*)::int n FROM reverse_proxies WHERE task_id=$1', [task])).rows[0].n, 1, 'reuse starts no second process');
    // Only loopback proxies are accepted by the ordinary tool.
    registerBusinessTools({reverseProxies:proxies,assets: {upsertSource: async () => ({ok: true, status: 200})}, findings: {record: async () => ({})}});
    const calls = await assembleTools(pool, ['http_request'], ctx, {});
    assert.equal(calls.length, 1, 'http_request is assembled for the worker');
    await assert.rejects(
      () => calls[0]!.execute('t-relay', {url, method: 'POST', body: '{"id":1}', proxy: 'http://10.10.10.163:8080'}),
      /回环/);

    const result = await calls[0]!.execute('t-plain', {url, method: 'POST', body: '{"id":7,"q":"中文"}', proxy: proxyUrl});
    const output = JSON.parse((result.content[0] as {text: string}).text);
    assert.equal(output.status, 200);
    assert.deepEqual(JSON.parse(output.body), {ok: true, echo: {id: 7, q: '中文'}});
    assert.equal(seen.length, 1, 'exactly one wire request');
    assert.equal(seen[0]!.ok, true, 'the target saw a valid signature');
    assert.deepEqual(seen[0]!.plain, {id: 7, q: '中文'}, 'the target received the decrypted plaintext');
    assert.equal(output.body.includes('data'), false, 'the worker received plaintext, not the envelope');

    // HTTPS must reach the crypto script as an absolute URI, not an opaque CONNECT tunnel.
    const cert=path.join(cwd,'fixture-ca.pem'),key=path.join(cwd,'fixture-key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const secure=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
      const chunks=[];for await(const c of req)chunks.push(c);
      const raw=Buffer.concat(chunks).toString();
      if(req.headers['x-signature']!==createHmac('sha256',SIGN).update(raw).digest('hex')){res.writeHead(400);res.end('bad signature');return;}
      res.end(seal({secure:true,echo:open(raw)}));
    });
    await new Promise<void>(r=>secure.listen(0,'127.0.0.1',r));
    try{
      const secureUrl='https://127.0.0.1:'+(secure.address() as {port:number}).port+'/api/secure';
      const secureProxy=await proxies.start(ctx,{mode:'legacy',script_path:'proxy.mjs',url:secureUrl,method:'POST',usage:'HTTPS AES+HMAC'});
      const secureReply=await calls[0]!.execute('https-plain',{url:secureUrl,method:'POST',body:'{"id":8}',proxy:secureProxy.proxy_url});
      const secureBody=JSON.parse((secureReply.content[0] as {text:string}).text);
      assert.equal(secureBody.status,200);assert.deepEqual(JSON.parse(secureBody.body),{secure:true,echo:{id:8}});
      await proxies.stop(task,String(secureProxy.proxy_id));
    }finally{secure.closeAllConnections();await new Promise<void>(r=>secure.close(()=>r()));}

    // A proxy the worker proved unusable must be replaceable, not a dead end.
    const replaced = await proxies.start(ctx, {mode:'legacy',script_path: 'proxy.mjs', url, method: 'POST', usage: 'fixed'}, true);
    const replacedPort = Number(new URL(String(replaced.proxy_url)).port);
    assert.notEqual(replaced.proxy_url, proxyUrl);
    assert.equal(await portClosed(port), true, 'replace stops the previous listener');
    assert.equal(await portClosed(replacedPort), false, 'the replacement is listening');

    // Boot recovery must never leave a previous host's process running.
    await proxies.recover();
    assert.equal(await portClosed(replacedPort), true, 'recover kills a live proxy');
    assert.equal((await pool.query('SELECT status FROM reverse_proxies WHERE id=$1', [started.proxy_id])).rows[0].status, 'stopped');

    const second = await proxies.start(ctx, {mode:'legacy',script_path: 'proxy.mjs', url, method: 'POST', usage: 'again'});
    const secondPort = Number(new URL(String(second.proxy_url)).port);
    await pool.query("UPDATE tasks SET status='paused',paused=TRUE WHERE id=$1", [task]);
    await proxies.stopTaskIfTerminal(task);
    assert.equal(await portClosed(secondPort), false, 'terminal cleanup does not classify pause as completion');
    await proxies.stopTask(task);
    assert.equal(await portClosed(secondPort), true, 'pause control closes the proxy');
    await pool.query("UPDATE tasks SET status='running',paused=FALSE WHERE id=$1",[task]);
    const third=await proxies.start(ctx,{mode:'legacy',script_path:'proxy.mjs',url,method:'POST',usage:'resumed'});
    const thirdPort=Number(new URL(String(third.proxy_url)).port);
    await pool.query("UPDATE tasks SET status='done',paused=FALSE WHERE id=$1", [task]);
    await proxies.stopTaskIfTerminal(task);
    assert.equal(await portClosed(thirdPort), true, 'a finished task loses its proxy');
    assert.equal((await pool.query('SELECT status FROM reverse_proxies WHERE id=$1', [second.proxy_id])).rows[0].status, 'stopped');

    // Parallel workers must share one process, including before registry insertion.
    await pool.query("UPDATE tasks SET status='running',paused=FALSE WHERE id=$1",[task]);
    const parallel=await Promise.all(Array.from({length:6},()=>proxies!.start(ctx,{mode:'legacy',script_path:'proxy.mjs',url,method:'POST',usage:'parallel'})));
    assert.equal(new Set(parallel.map(p=>p.proxy_url)).size,1,'six concurrent starts share one listener');
    assert.equal(parallel.filter(p=>!p.reused).length,1);
    const shared=String(parallel[0]!.proxy_url);
    await proxies.authorize(task,shared,url,'POST');
    for(const [owner,proxy,target,verb] of [[task+100,shared,url,'POST'],[task,origin,url,'POST'],[task,shared,url+'/other','POST'],[task,shared,url,'GET']] as const){
      await assert.rejects(()=>proxies!.authorize(owner,proxy,target,verb),/登记|范围/);
    }
    await assert.rejects(()=>calls[0]!.execute('wrong-path',{url:url+'/other',method:'POST',body:'{}',proxy:shared}),/范围/);
    assert.equal(seen.length,1,'invalid proxy scopes make no wire requests');
    await proxies.stopTask(task);
    for(const status of ['failed','timeout']){
      const p=await proxies.start(ctx,{mode:'legacy',script_path:'proxy.mjs',url,method:'POST',usage:status});
      await pool.query('UPDATE tasks SET status=$2 WHERE id=$1',[task,status]);
      await proxies.stopTaskIfTerminal(task);
      assert.equal(await portClosed(Number(new URL(String(p.proxy_url)).port)),true,status+' closes listener');
      assert.equal((await pool.query('SELECT status FROM reverse_proxies WHERE id=$1',[p.proxy_id])).rows[0].status,'stopped');
      await pool.query("UPDATE tasks SET status='running' WHERE id=$1",[task]);
    }

    // Activation failure after listening must not leak the child process; registration is now early.
    await writeFile(path.join(cwd,'reject.mjs'),PROXY_SCRIPT.replace('http.createServer',"fs.writeFileSync('reject-child.json',JSON.stringify({pid:process.pid,port}));http.createServer"));
    await pool.query("CREATE FUNCTION reject_proxy_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registry fixture failure'; END $$");
    await pool.query("CREATE TRIGGER reject_proxy_fixture BEFORE UPDATE ON reverse_proxies FOR EACH ROW WHEN (NEW.status='running') EXECUTE FUNCTION reject_proxy_fixture()");
    try{
      await assert.rejects(()=>proxies!.start(ctx,{mode:'legacy',script_path:'reject.mjs',url,method:'POST',usage:'reject'}),/registry fixture failure/);
      const rejectedChild=JSON.parse(await readFile(path.join(cwd,'reject-child.json'),'utf8'));
      assert.equal(await portClosed(rejectedChild.port),true,'registry error closes the listening process');
      await assert.rejects(()=>stat('/proc/'+rejectedChild.pid),/ENOENT/);
    }finally{await pool.query('DROP TRIGGER reject_proxy_fixture ON reverse_proxies');await pool.query('DROP FUNCTION reject_proxy_fixture()');}

    // A process that has not opened its port must still be cancellable and drained.
    const marker=path.join(cwd,'child.json');
    const readChild=async()=>{for(let i=0;i<100;i++){try{return JSON.parse(await readFile(marker,'utf8'));}catch{}await new Promise(r=>setTimeout(r,20));}throw new Error('child not started');};
    await writeFile(path.join(cwd,'slow.mjs'),`import fs from 'node:fs';import http from 'node:http';fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,port:Number(process.env.WORMHOLE_REVERSE_PROXY_PORT)}));setTimeout(()=>http.createServer((q,s)=>s.end('ok')).listen(Number(process.env.WORMHOLE_REVERSE_PROXY_PORT),'127.0.0.1'),1000);`);
    for(const mode of ['abort','pause','delete']){
      await rm(marker,{force:true});
      const controller=new AbortController();
      const pending=proxies.start({...ctx,signal:controller.signal},{mode:'legacy',script_path:'slow.mjs',url,method:'POST',usage:mode});
      const rejected=assert.rejects(()=>pending,/取消|abort|停止/i);
      const child=await readChild();
      if(mode==='abort')controller.abort();
      else if(mode==='pause'){await pool.query('UPDATE tasks SET paused=true WHERE id=$1',[task]);await proxies.stopTask(task);}
      else{await pool.query('DELETE FROM tasks WHERE id=$1',[task]);await proxies.stopTask(task);}
      await rejected;
      assert.equal(await portClosed(child.port),true,mode+' during startup leaves no listener');
      await assert.rejects(()=>stat('/proc/'+child.pid),/ENOENT/);
      if(mode!=='delete')await pool.query('UPDATE tasks SET paused=false WHERE id=$1',[task]);
    }

  } finally {
    await proxies?.stopAll().catch(() => {});
    target.closeAllConnections();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
    await rm(dir, {recursive: true, force: true});
  }
});
