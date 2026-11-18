import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
const integer=(v:unknown,fallback=0)=>{if(v===null||v===undefined)return fallback;const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new Error("Invalid pagination or ID");return n;};
export async function routePocs(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 if(url.pathname!=='/api/pocs'&&!url.pathname.startsWith('/api/pocs/'))return false;
 const service=ctx.pocs;if(!service){json(res,503,{error:"PoC knowledge service not initialized"});return true;}
 const p=url.pathname.slice('/api/pocs'.length),q=url.searchParams;
 try{
  if(p===''&&req.method==='GET'){json(res,200,await service.sources());return true;}
  if(p==='/settings'&&req.method==='PUT'){const b=await readObject(req,4096);if(typeof b.enabled!=='boolean')throw new Error("enabled must be a Boolean value");await service.configure(b.enabled);json(res,200,{ok:true});return true;}
  if(p==='/import'&&req.method==='POST'){json(res,200,await service.import(await readObject(req,100*1024*1024)));return true;}
  if(p==='/library/import'&&req.method==='POST'){json(res,200,await service.importLibrary(await readObject(req,100*1024*1024)));return true;}
  if(p==='/library/export'&&req.method==='GET'){json(res,200,await service.exportLibrary());return true;}
  if(p==='/entries'&&req.method==='POST'){json(res,200,await service.add(await readObject(req,17*1024*1024)));return true;}
  if(p==='/entries'&&req.method==='GET'){json(res,200,await service.list(q.get('source')??'',q.get('q')??'',integer(q.get('offset'))));return true;}
  if(p==='/export'&&req.method==='GET'){json(res,200,await service.export(q.get('source')??''));return true;}
  if(p==='/aliases'&&req.method==='PUT'){const b=await readObject(req,4096);if(typeof b.alias!=='string'||typeof b.product!=='string')throw new Error("alias and product required");json(res,200,await service.alias(b.alias,b.product));return true;}
  if(p==='/aliases'&&req.method==='DELETE'){json(res,200,await service.removeAlias(q.get('alias')??''));return true;}
  const source=p.match(/^\/sources\/([a-z][a-z0-9-]{0,63})$/);
  if(source&&req.method==='GET'){json(res,200,{revisions:await service.revisions(source[1]!)});return true;}
  if(source&&req.method==='PATCH'){const b=await readObject(req,4096);if(b.enabled!==undefined&&typeof b.enabled!=='boolean')throw new Error("enabled must be a Boolean value");if(b.revision!==undefined&&(typeof b.revision!=='string'||!/^[a-f0-9]{64}$/.test(b.revision)))throw new Error("revision invalid");json(res,200,await service.updateSource(source[1]!,b));return true;}
  const entry=p.match(/^\/entries\/([a-f0-9]{64})$/);
  if(entry&&req.method==='GET'){json(res,200,await service.detail(entry[1]!,{taskId:integer(q.get('task_id'))||undefined,candidateId:integer(q.get('candidate_id'))||undefined,offset:integer(q.get('offset')),limit:integer(q.get('limit'),8000),includeProvenance:true}));return true;}
  if(entry&&req.method==='PATCH'){const b=await readObject(req,8192);json(res,200,await service.override(entry[1]!,b as never));return true;}
  if(p==='/candidates'&&req.method==='GET'){const taskId=integer(q.get('task_id'));if(!taskId)throw new Error("task_id required");const state=(await ctx.pool.query('SELECT snapshot_id,revision,planner_revision,gaps,settlement_outcome FROM task_poc_state WHERE task_id=$1',[taskId])).rows[0]??null;json(res,200,{state,...await service.candidates(taskId,{assetId:integer(q.get('asset_id'))||undefined,intentId:integer(q.get('intent_id'))||undefined,url:q.get('url')??undefined,offset:integer(q.get('offset')),q:q.get('q')??undefined})});return true;}
  json(res,404,{error:"PoC knowledge interface does not exist"});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:String(e)});}return true;
}
