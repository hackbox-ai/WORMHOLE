import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {AssetContextService} from '../domains/assets/context.ts';
export async function routeAssetContext(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,value:unknown)=>void,read:(req:IncomingMessage)=>Promise<Record<string,unknown>|null>){
 const match=url.pathname.match(/^\/api\/tasks\/(\d+)\/(coverage|coverage-graph|asset-refs|scope)(?:\/(\d+))?$/);if(!match)return false;
 const taskId=Number(match[1]),kind=match[2],scopeId=Number(match[3]);if(!(await ctx.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rowCount){json(res,404,{error:'task not found'});return true;}
 const store=new AssetContextService(ctx.pool);
 if(req.method==='GET'&&!scopeId){switch(kind){case 'coverage':json(res,200,await store.coverage(taskId));break;case 'coverage-graph':json(res,200,await store.graph(taskId));break;case 'scope':json(res,200,{scope:await store.scopes(taskId)});break;case 'asset-refs':{const raw=url.searchParams.get('asset_id')??'',assetId=/^[+-]?\d+$/.test(raw)?Number(raw):0;if(assetId<=0){json(res,400,{error:"asset_id required"});break;}json(res,200,await store.refs(taskId,assetId));break;}}return true;}
 if(kind==='scope'&&req.method==='POST'&&!scopeId){const b=await read(req);if(!b||['kind','value','reason'].some(k=>b[k]!=null&&typeof b[k]!=='string')){json(res,400,{error:'invalid JSON'});return true;}
  try{const value=await store.addScope(taskId,String(b.kind??''),String(b.value??''),String(b.reason??''),'manual');json(res,200,{id:0,task_id:taskId,kind:value.kind,source:'manual',...(value.company_id?{company_id:value.company_id}:{}),...(value.domain?{domain:value.domain}:{}),...(value.net?{net:value.net}:{}),...(value.value?{value:value.value}:{}),...(b.reason?{reason:b.reason}:{})});}catch(e){json(res,400,{error:(e as Error).message});}return true;
 }
 if(kind==='scope'&&req.method==='DELETE'&&scopeId){const removed=await ctx.pool.query('DELETE FROM task_scope WHERE task_id=$1 AND id=$2',[taskId,scopeId]);json(res,removed.rowCount?200:404,removed.rowCount?{ok:true}:{error:'scope row not found'});return true;}
 return false;
}
