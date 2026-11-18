import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allowLocalTargets,checkDialAddress,validateHTTPURL} from '../src/domains/notify/config.ts';
import {channelErrorText,NotificationService} from '../src/domains/notify/service.ts';

test('local target errors remain blocked and contain only concise product text',()=>{
 const current=process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;
 try{
  delete process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;
  for(const address of ['127.0.0.1','::1','169.254.1.1'])assert.throws(()=>checkDialAddress(address),error=>{
   assert.equal((error as Error).message,`拒绝投递到本机或链路本地地址：${address}`);
   assert.doesNotMatch((error as Error).message,/allow_local/i);return true;
  });
  assert.throws(()=>validateHTTPURL('http://127.0.0.1/hook'),/拒绝投递/);
  process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL='0';assert.equal(allowLocalTargets(),false);assert.throws(()=>checkDialAddress('127.0.0.1'));
  process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL='true';assert.equal(allowLocalTargets(),true);assert.doesNotThrow(()=>checkDialAddress('127.0.0.1'));
 }finally{
  if(current===undefined)delete process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;else process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL=current;
 }
});
test('real channel test sends WORMHOLE content through a loopback webhook',async()=>{
 const pool={query:async()=>({rows:[]})},service=new NotificationService(pool as any);
  const channel={id:1,kind:'webhook',config:{url:'https://wormhole.example.com/hook'}};
  service.store.getChannel=async()=>channel as any;
  const {createServer}=await import('node:http');
  let received='';const server=createServer((req,res)=>{req.on('data',b=>received+=b);req.on('end',()=>res.end('{}'));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const old=process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL='1';
  try{channel.config={url:`http://127.0.0.1:${(server.address() as any).port}/hook`};await service.test(1,AbortSignal.timeout(10000));assert.match(received,/WORMHOLE/);assert.match(received,/wormhole\.example\.com/);assert.doesNotMatch(received,/allow_local/i);}finally{if(old===undefined)delete process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL;else process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL=old;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('historical local delivery errors display current wording without changing unrelated errors',()=>{
 const old='发送失败：拒绝投递到本机/链路本地地址 127.0.0.1（如确需投递到本机服务，设置 PREVIOUS_NOTIFY_ALLOW_LOCAL=1）';
 assert.equal(channelErrorText(old),'发送失败：拒绝投递到本机或链路本地地址：127.0.0.1');
 assert.equal(channelErrorText('SMTP 认证失败: invalid password'),'SMTP 认证失败: invalid password');
});
