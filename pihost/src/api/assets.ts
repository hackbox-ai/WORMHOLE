import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {SourceAssetReads} from '../domains/assets/source-reads.ts';
import type {SourceAssetInput} from '../domains/assets/source-writes.ts';
import {compileAssetDSL} from '../domains/assets/dsl.ts';
const integer=(raw:string|null)=>raw!==null&&/^[+-]?\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):0;
async function body(req:IncomingMessage):Promise<any>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
 const raw=Buffer.concat(chunks).toString('utf8');if(!raw.trim())throw new Error('invalid JSON: EOF');
 let value:any;try{value=JSON.parse(raw);}catch(e){throw new Error(`invalid JSON: ${(e as Error).message}`);}
 if(value!==null&&(typeof value!=='object'||Array.isArray(value)))throw new Error('invalid JSON: object required');return value??{};
}
function validate(b:any){
 if(b.task_id!=null&&!Number.isSafeInteger(b.task_id))throw new Error('invalid JSON: task_id must be an integer');
 if(b.assets!=null&&!Array.isArray(b.assets))throw new Error('invalid JSON: assets must be an array');
 const strings=['type','domain','icp','record_type','ip','app_name','bundle_id','category','description','app_icp','url','page_title','favicon_mmh3','service_ip','service_name','method'];
 for(const raw of b.assets??[]){const a=raw??{};if(typeof a!=='object'||Array.isArray(a))throw new Error('invalid JSON: asset must be an object');
  for(const key of strings)if(a[key]!=null&&typeof a[key]!=='string')throw new Error(`invalid JSON: ${key} must be a string`);
  for(const key of ['port','status_code','content_length'])if(a[key]!=null&&!Number.isSafeInteger(a[key]))throw new Error(`invalid JSON: ${key} must be an integer`);
  for(const key of ['bound_domains','record_value','technologies'])if(a[key]!=null&&(!Array.isArray(a[key])||!a[key].every((v:unknown)=>v===null||typeof v==='string')))throw new Error(`invalid JSON: ${key} must be a string array`);
  for(const key of ['auth','params','open_ports'])if(a[key]!=null&&(!Array.isArray(a[key])||!a[key].every((v:unknown)=>v===null||(typeof v==='object'&&!Array.isArray(v)))))throw new Error(`invalid JSON: ${key} must be an object array`);
  for(const p of a.open_ports??[])if(p&&((p.port!=null&&!Number.isSafeInteger(p.port))||(p.service!=null&&typeof p.service!=='string')))throw new Error('invalid JSON: open_ports port/service types');
 }
}
export async function routeAssets(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,data:unknown)=>void,read:(req:IncomingMessage)=>Promise<any>):Promise<boolean>{
 const path=url.pathname;if(path!=='/api/assets'&&path!=='/api/assets/counts')return false;
 const store=new SourceAssetReads(ctx.pool),q=url.searchParams;
 if(path==='/api/assets/counts'){if(req.method!=='GET')return false;json(res,200,await store.counts(integer(q.get('task_id'))));return true;}
 if(req.method==='GET'){
  const dsl=q.get('dsl')??'';try{compileAssetDSL(dsl);}catch(e){json(res,400,{error:(e as Error).message});return true;}
  json(res,200,await store.page({type:q.get('type')??'',dsl,company_id:integer(q.get('company_id')),task_id:integer(q.get('task_id')),limit:integer(q.get('limit')),offset:integer(q.get('offset'))}));return true;
 }
 if(req.method==='POST'){
  let b:any;try{b=await body(req);validate(b);}catch(e){json(res,400,{error:(e as Error).message});return true;}
  const results:{index:number;id:number;type:string}[]=[],errors:{index:number;error:string}[]=[];
  for(const [index,raw] of ((b.assets??[]) as SourceAssetInput[]).entries()){
   const item=raw??{type:''};
   // Authenticated manual API never uses the agent write gate. Parent request
   // owns task_id; app company_id is not part of this original HTTP contract.
   const input={...item,type:item.type??'',task_id:Number(b.task_id)||null,company_id:undefined,owner_node_id:undefined,source:'api'};
   const r=await ctx.assets.upsertSource(input);
   if(r.ok){const id=Number(r.asset!.id);results.push({index,id,type:input.type});if(input.task_id)await ctx.pool.query("UPDATE task_asset_links SET source='api',source_summary='Register via Asset API',updated_at=now() WHERE task_id=$1 AND asset_id=$2",[input.task_id,id]);}
   else errors.push({index,error:r.error??'asset insert failed'});
  }
  json(res,200,{results:results.length?results:null,errors:errors.length?errors:null});return true;
 }
 if(req.method==='DELETE'){let b:any;try{b=await body(req);}catch(e){json(res,400,{error:(e as Error).message});return true;}if(!Array.isArray(b.ids)||!b.ids.length){json(res,400,{error:'ids required'});return true;}if(!b.ids.every((n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n))){json(res,400,{error:'invalid JSON: ids must be integers'});return true;}json(res,200,{deleted:await store.remove(b.ids)});return true;}
 return false;
}
