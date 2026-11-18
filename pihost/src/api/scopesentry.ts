import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {SyncError,syncQueryInt} from '../domains/sync/service.ts';
async function body(req:IncomingMessage,optional=false){const chunks=[];for await(const c of req)chunks.push(Buffer.from(c));const raw=Buffer.concat(chunks).toString('utf8');if(!raw.trim()){if(optional)return {};throw new SyncError(400,'invalid JSON: EOF');}try{const b=JSON.parse(raw);if(b===null)return {};if(typeof b!=='object'||Array.isArray(b))throw new Error('object required');return b;}catch(e){if(optional)return {};throw new SyncError(400,'invalid JSON: '+(e as Error).message);}}
export async function routeScopeSentry(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 const prefix='/api/sync/scopesentry/',path=url.pathname;if(!path.startsWith(prefix))return false;const name=path.slice(prefix.length);
 if(!(['status','projects','tasks'].includes(name)&&req.method==='GET'||['datasource','sync'].includes(name)&&req.method==='POST'))return false;
 const controller=new AbortController(),closed=()=>{if(!res.writableFinished)controller.abort();};res.once('close',closed);
 try{let result;if(name==='status')result=await ctx.sync.status(controller.signal);else if(name==='datasource')result=await ctx.sync.datasource(await body(req,true),controller.signal);
  else if(name==='projects'||name==='tasks')result=await ctx.sync[name](syncQueryInt(url.searchParams.get('page'),1),syncQueryInt(url.searchParams.get('size'),50),url.searchParams.get('search')??'',controller.signal);
  else{const b=await body(req);if(b.dimension!=null&&typeof b.dimension!=='string'||b.create_company!=null&&typeof b.create_company!=='boolean'||b.page_size!=null&&!Number.isSafeInteger(b.page_size)||['targets','asset_types'].some(k=>b[k]!=null&&(!Array.isArray(b[k])||b[k].some((v:unknown)=>v!=null&&typeof v!=='string'))))throw new SyncError(400,'invalid JSON: sync field types');for(const k of ['targets','asset_types'])if(b[k])b[k]=b[k].map((v:string|null)=>v??'');result=await ctx.sync.sync(b,controller.signal);}
  json(res,200,result);
 }catch(e){json(res,e instanceof SyncError?e.status:500,{error:(e as Error).message});}finally{res.off('close',closed);}return true;
}
