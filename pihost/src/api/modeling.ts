import type {IncomingMessage,ServerResponse} from 'node:http';
import {stringify as yaml} from 'yaml';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {ModelingError,type ModelingRequest} from '../domains/modeling/service.ts';
const positive=(raw:unknown)=>{const n=Number(raw);if(!Number.isSafeInteger(n)||n<=0)throw new ModelingError("Invalid id");return n;};
export async function routeModeling(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
  const root=url.pathname==='/api/business-models',match=url.pathname.match(/^\/api\/business-models\/(\d+)(?:\/(run|pause|resume|stop|retry|export))?$/),version=url.pathname.match(/^\/api\/business-model-versions\/(\d+)$/);
  if(!root&&!match&&!version)return false;
  const service=ctx.taskEngine.modeling;
  try{
    if(version&&req.method==='GET'){json(res,200,await service.version(positive(version[1])));return true;}
    if(root&&req.method==='GET'){json(res,200,{models:await service.list(url.searchParams.has('task_id')?positive(url.searchParams.get('task_id')):undefined)});return true;}
    if(root&&req.method==='POST'){
      let body:Record<string,unknown>;try{body=await readObject(req,64*1024);}catch{throw new ModelingError("Invalid JSON object or body too large");}
      if(typeof body.target!=='string'||!body.target.trim())throw new ModelingError("Destination address cannot be empty");
      for(const key of ['name','reason','environment','auth_context'])if(body[key]!==undefined&&typeof body[key]!=='string')throw new ModelingError(`${key} Must be a string`);
      const input:ModelingRequest={target:body.target,trigger:'manual'};
      for(const key of ['name','reason','environment','auth_context'] as const)if(typeof body[key]==='string')input[key]=body[key];
      for(const key of ['task_id','asset_id'] as const)if(body[key]!==undefined&&body[key]!==null&&body[key]!=='')input[key]=positive(body[key]);
      const result=await service.request(input);json(res,result.created?201:200,result);return true;
    }
    if(match){
      const id=positive(match[1]),action=match[2];
      const record=await service.get(id);
      if(!action&&req.method==='GET'){json(res,200,record);return true;}
      if(action==='export'&&req.method==='GET'){
        const format=url.searchParams.get('format')==='yaml'?'yaml':'json';
        const version=url.searchParams.has('version_id')?await service.version(positive(url.searchParams.get('version_id'))):undefined;
        if(version&&(String(version.system_id)!==String(record.system_id)||version.scope_key!==record.scope_key))throw new ModelingError("The version does not belong to the current system and modeling scope");
        const document=version?.document??record.document;
        res.writeHead(200,{'Content-Type':format==='yaml'?'application/yaml; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="business-model-${id}.${format}"`});
        res.end(format==='yaml'?yaml(document):JSON.stringify(document,null,2));return true;
      }
      if(action==='retry'&&req.method==='POST'){
        let body:Record<string,unknown>;try{body=await readObject(req,4096,true);}catch{body={};}
        const result=await service.retry(id,body.task_id!==undefined?positive(body.task_id):undefined);
        json(res,result.created?201:200,result);return true;
      }
      if(action&&req.method==='POST'){
        if(['done','failed','timeout'].includes(record.status))throw new ModelingError("Modeling has ended, please initiate a new incremental modeling",409);
        if(action==='stop')ctx.taskEngine.abort(id);
        const result=await ctx.tasks.control(id,action);json(res,result.ok?200:result.status,result.ok?{ok:true}:{error:result.error});return true;
      }
    }
    json(res,405,{error:"Unsupported operation"});
  }catch(e){json(res,e instanceof ModelingError?e.status:500,{error:e instanceof Error?e.message:String(e)});}
  return true;
}
