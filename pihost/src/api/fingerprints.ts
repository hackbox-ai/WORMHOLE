import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {familyValue} from '../domains/fingerprints/rules.ts';
export async function routeFingerprints(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 if(!url.pathname.startsWith('/api/fingerprints'))return false;
 const service=ctx.fingerprints;if(!service){json(res,503,{error:"Fingerprint service not initialized"});return true}
 const p=url.pathname.slice('/api/fingerprints'.length),q=url.searchParams;
 try{
  if(p===''&&req.method==='GET'){json(res,200,await service.libraries());return true}
  if(p==='/settings'&&req.method==='PUT'){const b=await readObject(req,4096);if(typeof b.enabled!=='boolean')throw new Error("enabled must be a Boolean value");await service.configure(b.enabled);json(res,200,{ok:true});return true}
  if(p==='/compile'&&req.method==='POST'){json(res,200,{snapshot:await service.snapshot()});return true}
  if(p==='/rules'&&req.method==='GET'){json(res,200,await service.list(familyValue(q.get('family')),q.get('q')??'',q.get('status')??'',Math.max(0,Number(q.get('offset'))||0)));return true}
  if(p==='/import'&&req.method==='POST'){const b=await readObject(req,12*1024*1024);json(res,200,await service.import(familyValue(b.family),b.document));return true}
  if(p==='/export'&&req.method==='GET'){const family=familyValue(q.get('family'));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${family}.wormhole-fingerprints.json"`});res.end(JSON.stringify({format:'wormhole-fingerprint-rules-v1',family,rules:await service.all(family)},null,2));return true}
  const rule=p.match(/^\/rules\/([a-f0-9]{64})$/);if(rule){if(req.method==='PATCH'){const b=await readObject(req,1024*1024);if(b.enabled!==undefined&&typeof b.enabled!=='boolean')throw new Error("enabled must be a Boolean value");json(res,200,await service.update(rule[1]!,b));return true}if(req.method==='DELETE'){json(res,200,await service.remove(rule[1]!));return true}}
  if(p==='/sample'&&req.method==='POST'){const b=await readObject(req,3*1024*1024);const status=Number(b.status??200);if(!Number.isInteger(status)||status<100||status>599)throw new Error("Invalid response status code");const body=String(b.body??''),headers=String(b.headers??'').replaceAll('\r\n','\n').split('\n').filter(s=>s.includes(':')&&!/^(content-length|content-encoding|transfer-encoding):/i.test(s)).join('\r\n');const raw=`HTTP/1.1 ${status} Sample\r\n${headers}${headers?'\r\n':''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;json(res,200,await service.sample(familyValue(b.family),b.document,{url:String(b.url??'https://sample.invalid/'),method:String(b.method??'GET'),response_base64:Buffer.from(raw).toString('base64'),favicon_base64:typeof b.favicon_base64==='string'?b.favicon_base64:undefined}));return true}
  if(p==='/evidence'&&req.method==='GET'){const task=Number(q.get('task_id'));if(!Number.isSafeInteger(task)||task<=0)throw new Error("Valid task_id required");json(res,200,await service.evidence(task,q.get('material_id')??''));return true}
  if(p==='/observations'&&req.method==='GET'){const task=Number(q.get('task_id'));if(!Number.isSafeInteger(task)||task<=0)throw new Error("Valid task_id required");json(res,200,await service.read(task,q.has('asset_id')?Number(q.get('asset_id')):undefined));return true}
  json(res,404,{error:"Fingerprint interface does not exist"});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:String(e)})}return true;
}
