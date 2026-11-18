import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {getPiRuntime,resetPiRuntime} from '../pi/session-host.ts';
import {TaskModelResolver} from '../domains/llm/profile-runtime.ts';
import {ProfileDeleteError} from '../domains/llm/profile-delete.ts';
import {healthRegistry} from '../domains/llm/health.ts';
import {retryRules} from '../domains/llm/policy.ts';
import {testConnection,listModels} from '../domains/llm/probes.ts';
import {connectionConfig,normalizeRuntimeProfile} from '../domains/llm/configuration.ts';
import {refreshGlobalState,globalPayload,globalKey,validateModelProxy} from '../domains/llm/global-state.ts';
const strings=['name','format','base_url','proxy','model','api_key','api_key_hint','thinking_type','reasoning_effort','max_tokens_field','session_header_key'];
const ints=['id','context_window_k','priority','max_tokens'];
function profileBody(b:Record<string,any>){
 for(const k of strings)if(b[k]!=null&&typeof b[k]!=='string')throw new Error('bad json');
 for(const k of ints)if(b[k]!=null&&!Number.isSafeInteger(b[k]))throw new Error('bad json');
 for(const k of ['rate_per_second','rate_per_minute'])if(b[k]!=null&&(typeof b[k]!=='number'||!Number.isFinite(b[k])))throw new Error('bad json');
 for(const k of ['streaming','pool_exclude','is_default'])if(b[k]!=null&&typeof b[k]!=='boolean')throw new Error('bad json');
 retryRules(b.retry,['connect','empty','stream']);return b;
}
async function reload(ctx:AppContext){await ctx.llm.compileToPiRuntime();resetPiRuntime();await refreshGlobalState(ctx.pool);}
async function restore(ctx:AppContext){
 const tasks=(await ctx.pool.query("SELECT id FROM tasks WHERE deleted_at IS NULL AND status NOT IN ('done','failed','cancelled','canceled','stopped','error') ORDER BY id")).rows;
 const runtime=await getPiRuntime(ctx.config);
 for(const t of tasks){const id=Number(t.id);const roles=await Promise.all(['planner','worker'].map(role=>new TaskModelResolver(ctx.pool,ctx.config,runtime,id,role).resolution()));
  if(roles.every(r=>r.available))await ctx.pool.query("UPDATE exploration_nodes SET state='open',blocked_reason=NULL,completed_at=NULL WHERE task_id=$1 AND kind='intent' AND state='blocked' AND blocked_reason='llm_quota_exhausted'",[id]);
  ctx.taskEngine?.notify(id);
 }
}
export async function routeLlmManagement(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 const path=url.pathname,del=/^\/api\/llm\/profiles\/(\d+)$/.exec(path);
 if(path==='/api/llm'&&req.method==='GET'){json(res,200,await globalPayload(ctx.pool));return true;}
 if(path==='/api/llm'&&req.method==='POST'){
  let body;try{body=await readObject(req,Number.MAX_SAFE_INTEGER,true);for(const k of ['provider','model','base_url','proxy','api_key','thinking_type','reasoning_effort'])if(body[k]!=null&&typeof body[k]!=='string')throw new Error('bad json');for(const k of ['rate_per_second','rate_per_minute'])if(body[k]!=null&&(typeof body[k]!=='number'||!Number.isFinite(body[k])))throw new Error('bad json');if(body.context_window_k!=null&&!Number.isSafeInteger(body.context_window_k))throw new Error('bad json');}catch{json(res,400,{error:'bad json'});return true;}
  const cfg={...connectionConfig(body),rate_per_second:body.rate_per_second??0,rate_per_minute:body.rate_per_minute??0,context_window_k:body.context_window_k>0?Math.min(1000,body.context_window_k):0,thinking_type:body.thinking_type??'',reasoning_effort:body.reasoning_effort??''};if(!cfg.api_key)cfg.api_key=await globalKey(ctx.pool);if(!cfg.api_key){json(res,400,{error:'api_key required'});return true;}
  try{validateModelProxy(cfg.proxy);}catch(e){json(res,400,{error:'provider init failed: '+(e as Error).message});return true;}
  try{const stored=await ctx.llm.saveGlobalConfiguration(cfg);await ctx.llm.compileToPiRuntime();resetPiRuntime();await refreshGlobalState(ctx.pool,normalizeRuntimeProfile({...stored,...cfg,id:Number(stored.id),streaming:true,max_tokens:0,max_tokens_field:'',session_header_key:'',retry:{}} as any));json(res,200,await globalPayload(ctx.pool));}catch(e){json(res,500,{error:'persist provider failed: '+(e as Error).message});}return true;
 }
 if((path==='/api/llm/test'||path==='/api/llm/models')&&req.method==='POST'){
  let body;try{body=profileBody(await readObject(req,Number.MAX_SAFE_INTEGER,true));if(body.provider!=null&&typeof body.provider!=='string'||body.profile_id!=null&&!Number.isSafeInteger(body.profile_id))throw new Error('bad json');}catch{json(res,400,{error:'bad json'});return true;}
  const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};req.once('aborted',cancel);res.once('close',cancel);
  try{json(res,200,path==='/api/llm/test'?await testConnection(ctx.pool,body,abort.signal):await listModels(ctx.pool,body,abort.signal));}finally{req.off('aborted',cancel);res.off('close',cancel);}return true;
 }
 if(path==='/api/llm/profiles'&&req.method==='GET'){json(res,200,{profiles:await ctx.llm.listProfiles()});return true;}
 if(path==='/api/llm/profiles'&&req.method==='POST'){
  let body;try{body=profileBody(await readObject(req,Number.MAX_SAFE_INTEGER,true));}catch{json(res,400,{error:'bad json'});return true;}
  try{const id=await ctx.llm.saveProfile(body);await reload(ctx);json(res,200,{id});}catch(e){json(res,500,{error:(e as Error).message});}return true;
 }
 if(path==='/api/llm/profiles/active'&&req.method==='POST'){
  let body;try{body=await readObject(req,Number.MAX_SAFE_INTEGER,true);if(body.id!=null&&!Number.isSafeInteger(body.id))throw new Error('bad json');}catch{json(res,400,{error:'bad json'});return true;}
  try{const r=await ctx.llm.activate(Number(body.id??0));if(!r.ok){json(res,500,{error:r.error});return true;}await reload(ctx);json(res,200,{ok:true});}catch(e){json(res,500,{error:(e as Error).message});}return true;
 }
 if(del&&req.method==='DELETE'){
  try{const id=Number(del[1]);await ctx.llm.deleteProfile(id);await reload(ctx);try{await restore(ctx);}catch(e){console.warn('[llm-profile] task wake failed',e);}json(res,200,{deleted:id});}
  catch(e){json(res,e instanceof ProfileDeleteError?e.status:500,{error:(e as Error).message});}return true;
 }
 if(path==='/api/llm/retry-policy'&&(req.method==='GET'||req.method==='POST')){
  if(req.method==='POST'){let value;try{value=retryRules(await readObject(req,Number.MAX_SAFE_INTEGER,true));}catch{json(res,400,{error:'bad json'});return true;}
   await ctx.llm.setRetryPolicy(value);const health=await healthRegistry(ctx.pool);health.setPolicy(value.breaker!.attempts,value.breaker!.interval_ms);await reload(ctx);
  }
  json(res,200,await ctx.llm.retryPolicy());return true;
 }
 return false;
}
