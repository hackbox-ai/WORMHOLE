import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {trafficSummary,conflict,archiveConflict} from '../domains/findings/evidence.ts';
import {readObject} from './json-body.ts';
export async function routeFindingEvidence(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void,readJson:(r:IncomingMessage)=>Promise<any>):Promise<boolean>{
 const m=/^\/api\/exploration\/findings\/([^/]+)\/traffic(?:\/([^/]+)(\/body)?)?$/.exec(url.pathname);if(!m)return false;
 const store=ctx.findings?.evidenceStore;if(!store){json(res,503,{error:"Traffic evidence storage is unavailable"});return true;}
 const id=Number(m[1]),suffix=m[2],bodyRoute=!!m[3];if(!/^[+]?[0-9]+$/.test(m[1]!)||!Number.isSafeInteger(id)||id<=0){json(res,400,{error:'invalid finding id'});return true;}
 const write=req.method!=='GET',rawContext=url.searchParams.get('context_task');
 const access=await store.access(id,rawContext?Number(rawContext):undefined,write);if(access){json(res,access.startsWith("Inheritance")?403:404,{error:access});return true;}
 const bid=Number(suffix);if(suffix&&!(suffix==='order'&&req.method==='PUT')&&(!/^[+]?[0-9]+$/.test(suffix)||!Number.isSafeInteger(bid)||bid<=0)){json(res,400,{error:'invalid binding id'});return true;}
 try{
  if(!suffix&&req.method==='GET'){json(res,200,trafficSummary(await store.list(id)));return true;}
  if(!suffix&&req.method==='POST'){let body:any;try{body=await readObject(req);}catch{json(res,400,{error:'invalid body'});return true;}if(!Array.isArray(body?.traffic_refs)){json(res,400,{error:body?.traffic_refs==null?"Please select flow rate":'invalid body'});return true;}if(body.traffic_refs.some((r:any)=>r&&(['traffic_id','role','note'].some(k=>r[k]!=null&&typeof r[k]!=='string')))){json(res,400,{error:'invalid body'});return true;}if(!body.traffic_refs.length){json(res,400,{error:"Please select flow rate"});return true;}json(res,200,trafficSummary(await store.bind(id,body.traffic_refs)));return true;}
  if(suffix&&!bodyRoute&&(req.method==='PATCH'||req.method==='DELETE'||req.method==='PUT'&&suffix==='order')){
   let b:any;try{b=await readObject(req);}catch{json(res,400,{error:"version and valid request body are required"});return true;}
   if(!Number.isSafeInteger(b?.version)||b?.role!=null&&typeof b.role!=='string'||b?.note!=null&&typeof b.note!=='string'){json(res,400,{error:"version and valid request body are required"});return true;}
   if(suffix==='order'){if(b.binding_ids==null){json(res,400,{error:"binding_ids required"});return true;}if(!Array.isArray(b.binding_ids)||b.binding_ids.some((v:unknown)=>typeof v!=='string'||!/^[+]?[0-9]+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<=0)){json(res,400,{error:'invalid binding id'});return true;}b.binding_ids=b.binding_ids.map((v:string)=>String(Number(v)));}
   json(res,200,trafficSummary(await store.edit(id,bid,b.version,{role:b.role??undefined,note:b.note??undefined,remove:req.method==='DELETE',order:suffix==='order'?b.binding_ids:undefined})));return true;
  }
  if(suffix&&suffix!=='order'&&req.method==='GET'){
   const binding=await store.binding(id,bid);
   if(!bodyRoute){json(res,200,{binding,request:store.preview(binding.snapshot,'request'),response:store.preview(binding.snapshot,'response')});return true;}
   const side=url.searchParams.get('side')??'';
   if(url.searchParams.get('download')==='1'){const bytes=store.body(binding.snapshot,side);res.writeHead(200,{'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="evidence-${bid}-${side}.bin"`,'Content-Length':bytes.length});res.end(bytes);return true;}
   const parse=(k:string,d:number)=>{const v=url.searchParams.get(k);if(v===null||v==='')return d;if(!/^[+-]?\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw new Error('invalid '+k);return Number(v);};json(res,200,store.preview(binding.snapshot,side,parse('offset',0),parse('length',8192)));return true;
  }
  json(res,405,{error:'method not allowed'});
 }catch(e){const error=(e as Error).message;json(res,error===conflict||error===archiveConflict?409:error==="The vulnerability does not exist"||error==="Traffic evidence does not exist"?404:422,{error});}return true;
}
