import type {IncomingMessage,ServerResponse} from 'node:http';
import path from 'node:path';
import type {AppContext} from './server.ts';
class BodyError extends Error{}
const stringifyType=(value:unknown)=>Array.isArray(value)?'array':typeof value;
async function decode(req:IncomingMessage,test=false,builtin=false):Promise<Record<string,any>>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const raw=Buffer.concat(chunks).toString('utf8');let body:any;
 try{body=raw.trim()?JSON.parse(raw):undefined;if(body===undefined)throw new BodyError('EOF');}catch(error){throw new BodyError(test?"Invalid request body":raw.trim()?'invalid JSON':'EOF');}
 if(body===null)return {};if(typeof body!=='object'||Array.isArray(body))throw new BodyError(test?"Invalid request body":'invalid JSON object');
 const label=builtin?'':test?'testToolReq':'customToolReq';
 for(const key of ['key','description','kind'])if(body[key]!=null&&typeof body[key]!=='string')throw new BodyError('json: cannot unmarshal '+stringifyType(body[key])+' into Go struct field '+label+'.'+key+' of type string');
 for(const key of ['enabled','deferred'])if(body[key]!=null&&typeof body[key]!=='boolean')throw new BodyError('json: cannot unmarshal '+stringifyType(body[key])+' into Go struct field '+label+'.'+key+' of type bool');
 if(body.agents!=null&&(!Array.isArray(body.agents)||body.agents.some((v:any)=>v!==null&&typeof v!=='string')))throw new BodyError('json: cannot unmarshal '+(Array.isArray(body.agents)?stringifyType(body.agents.find((v:any)=>v!==null&&typeof v!=='string')):stringifyType(body.agents))+' into Go struct field '+label+'.agents of type '+(Array.isArray(body.agents)?'string':'[]string'));
 if(test&&body.params!=null&&(typeof body.params!=='object'||Array.isArray(body.params)))throw new BodyError("Invalid request body");
 if(body.agents)body.agents=body.agents.map((v:any)=>v??'');return body;
}
export async function routeTools(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,value:unknown)=>void){
 if(!url.pathname.startsWith('/api/tools'))return false;
 const route=url.pathname,custom=/^\/api\/tools\/custom\/([^/]+)$/.exec(route),builtin=/^\/api\/tools\/([^/]+)(\/reset)?$/.exec(route);
 try{
  if(route==='/api/tools'&&req.method==='GET')json(res,200,{tools:await ctx.tools.list()});
  else if(route==='/api/tools/custom'&&req.method==='POST'){const r=await ctx.tools.createCustom(await decode(req));json(res,r.ok?200:r.status,r.ok?{key:r.tool.key}:{error:r.error});}
  else if(route==='/api/tools/custom/test'&&req.method==='POST'){
   let body;try{body=await decode(req,true);}catch{json(res,400,{error:"Invalid request body"});return true;}
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};req.once('aborted',cancel);res.once('close',cancel);
   try{const r=await ctx.tools.testSpec(body,{businessKind:'tools-test',businessId:'unsaved',agentKey:'auto',manualInvocation:true,cwd:ctx.workspace?.root??path.join(ctx.config.dataDir,'workspace'),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(600000)])});json(res,r.status,r.error?{error:r.error}:{output:r.output,is_error:r.is_error});}
   finally{req.off('aborted',cancel);res.off('close',cancel);}
  }
  else if(custom&&req.method==='PUT'){const r=await ctx.tools.updateCustom(decodeURIComponent(custom[1]!),await decode(req));json(res,r.status,r.ok?{ok:true}:{error:r.error});}
  else if(custom&&req.method==='DELETE'){const key=decodeURIComponent(custom[1]!);await ctx.tools.removeCustom(key);json(res,200,{deleted:key});}
  else if(builtin&&builtin[2]&&req.method==='POST'){const key=decodeURIComponent(builtin[1]!),ok=await ctx.tools.reset(key);json(res,ok?200:404,ok?{ok:true}:{error:"Non-built-in tool or does not exist: "+key});}
  else if(builtin&&!builtin[2]&&req.method==='PUT'){const r=await ctx.tools.updateBuiltin(decodeURIComponent(builtin[1]!),await decode(req,false,true));json(res,r.status,r.ok?{ok:true}:{error:r.error});}
  else return false;
 }catch(error){json(res,error instanceof BodyError?400:500,{error:error instanceof Error?error.message:String(error)});}
 return true;
}
