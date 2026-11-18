import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {CompaniesService,CompanyError} from '../domains/assets/companies.ts';
import {scopeInputs} from '../domains/assets/scope.ts';
async function body(req:IncomingMessage,optional=false):Promise<any>{const chunks:Buffer[]=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>2<<20)throw new CompanyError(413,"Request body is too large");chunks.push(c);}
 const raw=Buffer.concat(chunks).toString('utf8');if(!raw.trim()){if(optional)return {};throw new CompanyError(400,'invalid JSON: EOF');}
 try{const value=JSON.parse(raw);if(value!==null&&(typeof value!=='object'||Array.isArray(value)))throw new Error('object required');return value??{};}catch(e){throw new CompanyError(400,`invalid JSON: ${(e as Error).message}`);}
}
export async function routeCompanies(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,value:unknown)=>void){
 const path=url.pathname,match=path.match(/^\/api\/companies\/(\d+)(\/scope)?$/),store=new CompaniesService(ctx.pool);
 if(path!=='/api/companies'&&path!=='/api/companies/reattribute'&&!match)return false;
 try{
  if(path==='/api/companies'&&req.method==='GET'){json(res,200,await store.list());return true;}
  if(path==='/api/companies'&&req.method==='POST'){const b=await body(req);if(typeof(b.name??'')!=='string'||typeof(b.logo??'')!=='string')throw new CompanyError(400,'invalid JSON: name/logo must be strings');let inputs;try{inputs=scopeInputs(b.scope);}catch(e){throw new CompanyError(400,`invalid JSON: ${(e as Error).message}`);}json(res,201,await store.create(b.name??'',b.logo??'',inputs));return true;}
  if(path==='/api/companies/reattribute'&&req.method==='POST'){await store.reattribute();json(res,200,{ok:true});return true;}
  if(match){const id=Number(match[1]);if(!match[2]&&req.method==='GET'){const value=await store.get(id);json(res,value?200:404,value??{error:'company not found'});return true;}
   if(match[2]&&req.method==='POST'){const b=await body(req);if(typeof(b.reason??'')!=='string'||typeof(b.reset??false)!=='boolean')throw new CompanyError(400,'invalid JSON: reason/reset types');let inputs;try{inputs=scopeInputs(b.scope);}catch(e){throw new CompanyError(400,`invalid JSON: ${(e as Error).message}`);}const result=await store.updateScope(id,inputs,b.reason??'',b.reset??false);let warning='';try{warning=await store.malformedWarning();}catch{}json(res,200,{...result,...(warning?{warnings:[warning]}:{})});return true;}
   if(!match[2]&&req.method==='DELETE'){const b=await body(req,true);if(typeof(b.delete_assets??false)!=='boolean')throw new CompanyError(400,'invalid JSON: delete_assets must be boolean');json(res,200,await store.remove(id,b.delete_assets??false));return true;}
  }
 }catch(e){if(e instanceof CompanyError){json(res,e.status,{error:e.message});return true;}throw e;}
 return false;
}
