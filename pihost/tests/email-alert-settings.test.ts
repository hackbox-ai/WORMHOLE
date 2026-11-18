import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer as smtpServer,type Socket} from 'node:net';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AuthService} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';
import {notificationService} from '../src/domains/notify/service.ts';
import {FindingsService} from '../src/domains/findings/service.ts';

test('configuration HTTP API -> finding outbox -> real SMTP; thresholds, history, escalation, dedupe and retry',async()=>{
 const cfg=loadConfig(),schema='email_alert_'+process.pid+'_'+Date.now(),admin=new Pool({connectionString:cfg.database.dsn});
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:cfg.database.dsn,options:'-c search_path='+schema});
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-email-alert-')),old=process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;
 process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL='1';
 const mails:string[]=[],sockets=new Set<Socket>();let reject=false;
 const smtp=smtpServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  socket.setEncoding('utf8');socket.write('220 smtp-fixture\r\n');let buffer='',data=false,body='';
  socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\r\n')){
   const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);
   if(data){if(line==='.'){data=false;mails.push(body);body='';socket.write('250 queued\r\n');}else body+=line+'\r\n';continue;}
   if(line.startsWith('EHLO'))socket.write('250 fixture\r\n');
   else if(line.startsWith('MAIL'))socket.write(reject?'450 retry\r\n':'250 OK\r\n');
   else if(line.startsWith('RCPT'))socket.write('250 OK\r\n');
   else if(line==='DATA'){data=true;socket.write('354 continue\r\n');}
   else if(line==='QUIT')socket.end('221 bye\r\n');
  }});
 });
 await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));
 let web:ReturnType<typeof createServer>|undefined;
 const service=notificationService(pool);
 try{
  await runMigrations(pool);
  const auth=new AuthService(pool,path.join(dir,'jwt.key')),ctx={pool,config:cfg,auth} as any;
  web=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(resolve=>web!.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(web.address() as {port:number}).port,token=(await auth.init('email-fixture-only-123')).token!;
  const call=async(method:string,p:string,body?:unknown)=>{
   const res=await fetch(base+'/api/notify/'+p,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:res.status,body:await res.json() as any};
  };
  const findings=new FindingsService(pool,path.join(dir,'dlq'));
  const create=async(severity:string,name:string)=>{const result=await findings.create({name,severity});assert.ok(result.ok);return Number(result.finding!.id);};
  await create('high','historical finding');
  assert.equal((await call('GET','email-alerts')).body.channel,null);
  const config={host:'127.0.0.1',port:(smtp.address() as {port:number}).port,from:'sender@example.test',to:['one@example.test','two@example.test'],tls:false,username:'',password:''};
  const saved=await call('PUT','email-alerts',{enabled:true,config,public_base_url:'https://wormhole.example.test/'});
  assert.equal(saved.status,200);const id=saved.body.channel.id;
  await pool.query('UPDATE notification_channels SET rate_per_min=0 WHERE id=$1',[id]);
  assert.equal(saved.body.channel.filter.min_severity,'high');
  await service.dispatcher.step();assert.equal(mails.length,0,'history is not sent');
  await create('medium','medium excluded');const high=await create('high','new high');
  await service.dispatcher.step();assert.equal(mails.length,1);
  assert.match(mails[0]!,/To: one@example.test, two@example.test/);
  const html=Buffer.from(mails[0]!.split('\r\n\r\n')[1]!.replace(/\r\n/g,''),'base64').toString();
  assert.match(html,/new high/);assert.match(html,/https:\/\/wormhole.example.test\/function\/findings\/detail/);assert.match(html,/待处理/);
  await findings.setColumn(high,'name','edited title');await findings.setColumn(high,'severity','medium');await findings.setColumn(high,'severity','high');
  await service.dispatcher.step();assert.equal(mails.length,1,'same finding is not sent twice');
  const upgraded=await create('low','upgraded');await service.dispatcher.step();
  await findings.setColumn(upgraded,'severity','critical');await service.dispatcher.step();assert.equal(mails.length,2);
  const invalid=await create('low','false positive');await findings.changeStatus(invalid,'false_positive');await findings.setColumn(invalid,'severity','high');await service.dispatcher.step();assert.equal(mails.length,2);
  reject=true;await create('critical','retry me');await service.dispatcher.step();assert.equal(mails.length,2);
  assert.equal((await service.store.list({state:'pending'})).total,1);
  reject=false;await pool.query("UPDATE notification_deliveries SET next_attempt_at=now() WHERE state='pending'");await service.dispatcher.step();assert.equal(mails.length,3);
  assert.equal((await service.store.list({state:'sent'})).total,3);
  const again=await call('PUT','email-alerts',{enabled:false,config,public_base_url:'https://wormhole.example.test'});assert.equal(again.body.channel.id,id);
  await create('high','disabled excluded');await service.dispatcher.step();assert.equal(mails.length,3);
  assert.equal((await call('POST','channels/'+id+'/test')).status,200);assert.equal(mails.length,4);
  const secret=await call('PUT','email-alerts',{enabled:false,config:{...config,password:'fixture-secret'},public_base_url:''});
  assert.match(secret.body.channel.config.password,/^__masked__/);assert.ok(!JSON.stringify(secret.body).includes('fixture-secret'));
  const retained=await call('PUT','email-alerts',{enabled:false,config:{...config,password:secret.body.channel.config.password},public_base_url:''});assert.equal(retained.status,200);
  assert.equal((await pool.query('SELECT config FROM notification_channels WHERE id=$1',[id])).rows[0].config.password,'fixture-secret');
  assert.equal((await call('PUT','email-alerts',{enabled:true,config:{...config,to:[]}})).status,400);
 }finally{
  await service.dispatcher.stop();web?.closeAllConnections();if(web)await new Promise<void>(r=>web!.close(()=>r()));
  for(const socket of sockets)socket.destroy();await new Promise<void>(r=>smtp.close(()=>r()));
  if(old===undefined)delete process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;else process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL=old;
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});
 }
});
