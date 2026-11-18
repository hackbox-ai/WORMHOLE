import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {AssetRules} from '../domains/assets/asset-rules.ts';
export async function routeAssetRules(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,data:unknown)=>void,read:(req:IncomingMessage)=>Promise<any>):Promise<boolean>{
 const g=url.pathname.match(/^\/api\/asset-intercept\/rules(?:\/([^/]+)(\/toggle)?)?$/),t=url.pathname.match(/^\/api\/tasks\/([^/]+)\/intercept-rules(?:\/([^/]+)(\/toggle)?)?$/);if(!g&&!t)return false;
 const rawTask=t?.[1],rawId=g?.[1]??t?.[2],toggle=g?.[2]??t?.[3];
 const integer=(v:string)=>/^[+-]?\d+$/.test(v)&&Number.isSafeInteger(Number(v));
 if(rawTask&&(!integer(rawTask)||Number(rawTask)<=0)){json(res,400,{error:'bad task id'});return true;}
 if(rawId&&(!integer(rawId)||(t&&Number(rawId)<=0))){json(res,400,{error:'bad rule id'});return true;}
 const task=rawTask===undefined?undefined:Number(rawTask),id=rawId===undefined?undefined:Number(rawId),store=new AssetRules(ctx.pool);
 if(id===undefined&&req.method==='GET'){json(res,200,{rules:await store.list(task)});return true;}
 if(id!==undefined&&!toggle&&req.method==='DELETE'){json(res,200,await store.remove(id,task));return true;}
 if((id===undefined&&req.method==='POST')||(id!==undefined&&!toggle&&req.method==='PUT')||(id!==undefined&&toggle&&req.method==='POST')){
  let input:Record<string,any>;try{input=(await read(req))??{};if(typeof input!=='object'||Array.isArray(input))throw new Error('invalid JSON: object required');
   for(const key of toggle?['enabled']:['enabled','kind','pattern','note',...(t?['action']:[])])if(input[key]!=null&&typeof input[key]!==(key==='enabled'?'boolean':'string')){const typ=Array.isArray(input[key])?'array':typeof input[key]==='object'?'object':typeof input[key];throw new Error('json: cannot unmarshal '+typ+' into Go struct field '+(toggle?'.':t?'taskInterceptRuleReq.':'assetInterceptRuleReq.')+key+' of type '+(key==='enabled'?'bool':'string'));}
  }catch(e){json(res,400,{error:(e as Error).message});return true;}
  if(toggle){json(res,200,await store.toggle(id!,input.enabled??false,task));return true;}
  try{const result=await store.save(input,task,id);json(res,result.status,result.json);}
  catch(e){const error=e as Error&{code?:string};json(res,500,{error:error.code?'ERROR: '+error.message+' (SQLSTATE '+error.code+')':error.message});}
  return true;
 }
 return false;
}
