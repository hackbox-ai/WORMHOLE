import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {TaskLLMChains,profileLabel} from '../domains/llm/task-chain.ts';
import {TaskModelResolver} from '../domains/llm/profile-runtime.ts';
import {getPiRuntime} from '../pi/session-host.ts';
import {activityDTO} from '../domains/activity/service.ts';
export async function routeTaskLLM(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
 const m=/^\/api\/tasks\/(\d+)\/llm(\/resolution)?$/.exec(url.pathname);if(!m||m[2]&&req.method!=='GET'||!m[2]&&req.method!=='PUT')return false;
 const id=Number(m[1]),chains=new TaskLLMChains(ctx.pool),t=(await ctx.pool.query('SELECT id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];if(!t){json(res,404,{error:'task not found'});return true;}
 if(m[2]){const runtime=await getPiRuntime(ctx.config),out:Record<string,unknown>={};for(const role of ['mainagent','planner','worker'])out[role]=await new TaskModelResolver(ctx.pool,ctx.config,runtime,id,role).resolution();json(res,200,out);return true;}
 let body:Record<string,any>;try{body=await readObject(req,Number.MAX_SAFE_INTEGER,true);if(body.llm_profile_ids!=null&&!Array.isArray(body.llm_profile_ids)||body.active_llm_profile_id!=null&&!Number.isSafeInteger(body.active_llm_profile_id))throw new Error('invalid task LLM fields');}catch(e){json(res,400,{error:'bad json: '+(e as Error).message});return true;}
 try{const before=await chains.state(id),after=await chains.replace(id,body.llm_profile_ids??[],body.active_llm_profile_id??0),out:Record<string,unknown>={id:String(id),llm_profile_ids:after.llm_profile_ids,active_llm_profile_id:after.active_llm_profile_id,llm_failover_state:after.llm_failover_state,reopened_intents:after.reopened_intents};
  if(before.active_llm_profile_id!==after.active_llm_profile_id){const previous=before.active_llm_profile_id?await chains.auditProfile(ctx.pool,before.active_llm_profile_id):null,next=after.active_llm_profile_id?await chains.auditProfile(ctx.pool,after.active_llm_profile_id):null,reason="User manually switches tasks LLM",summary=`User manually moved task LLM from ${profileLabel(previous)} Switch to ${profileLabel(next)}`;
   const event=(await ctx.pool.query(`INSERT INTO activity(exploration_id,worker,kind,summary,detail,metadata) VALUES($1,'system','llm_switch',$2,$2,$3) RETURNING *`,[t.exploration_id,summary,JSON.stringify({llm_transition:{mode:'manual',reason,...(previous?{previous}:{}),...(next?{next}:{})}})])).rows[0];out.switch_event=activityDTO(event);
  }
  ctx.taskEngine?.notify(id);json(res,200,out);
 }catch(e){json(res,400,{error:(e as Error).message});}return true;
}
