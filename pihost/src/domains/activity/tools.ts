import type {Pool} from 'pg';
import {registerTool,getTool} from '../tools/gate.ts';
import hostSeeds from '../tools/platform-tool-seeds.json' with {type:'json'};
import seeds from '../tools/business-tool-seeds.json' with {type:'json'};
import {ActivityService,inherited,traceStep} from './service.ts';
export const TRACE_TOOLS={planner:['get_worker_output','get_worker_trace','search_all_worker_traces'],worker:['get_worker_trace','search_all_worker_traces'],mainagent:['get_worker_output','get_worker_trace','search_all_worker_traces']};
export function registerTraceTools(pool:Pool):void {
 const service=new ActivityService(pool);
 for(const key of [...new Set([...Object.values(TRACE_TOOLS).flat(),'list_worker_traces'])]){const seed=seeds.find(s=>s.Key===key)??{Desc:"[Usually not recommended because most of the information has been given in the system] List the [work (intention) that has been run] index in this task: intent_id + one sentence direction (summary) + status. You (worker) cannot see the exploration graph, use it to find out which work is worth looking at - then use get_worker_trace(intent_id) to see its steps, and get_worker_trace(intent_id, step_ids=[...]) to get the details. Only the executed ones (running/done/exhausted/blocked/stopped) are listed, excluding open ones that have not yet been run. Note: The boundary of your task is still the intention you received. Looking at other work is only for reuse and observation/avoiding duplication of work.",Schema:{type:'object',properties:{q:{type:'string',description:"Filter by summary keyword (optional)"},limit:{type:'integer',description:"Return the upper limit, default 50 (optional)"}}}};registerTool({key,description:seed.Desc,schema:seed.Schema,params:{},required:[],execute:async(p,ctx)=>{
  if(!ctx.taskId)throw new Error(key+" Task context (exploration graph) required: The current agent is not running in a task, the exploration graph of the task cannot be obtained, and the tool is unavailable. Please use this within a task, or use cross-task reading tools with task_id instead (get_task_node_detail / list_task_findings / get_task_graph etc.).");
  const taskId=ctx.taskId;
  if(key==='list_worker_traces')return {works:await service.works(taskId,String(p.q??''),Number(p.limit)||50)};
  if(key==='search_all_worker_traces'){const q=String(p.q??'');if(!q.trim())throw new Error("q required");const rows=await service.trace(taskId,null,q,Number(p.limit)||100,ctx.intentId??0);return {query:q,hits:rows.map(a=>({intent_id:Number(a.node_id),worker:a.worker??'',...traceStep(a)}))};}
  const id=Number(p.intent_id);if(!id)throw new Error("intent_id required");const n=await service.intent(taskId,id);if(!n)throw new Error("intent_id does not belong to this task or its directly related tasks");
  if(key==='get_worker_output'){
   const rows=await service.outputRows(taskId,id);
   const chosen=rows.filter(a=>a.kind==='result').at(-1)??rows.filter(a=>a.kind==='text').at(-1);
   if(!chosen)return n.inherited?{intent_id:id,final_text:"(This work has no output yet)",...inherited(n)}:"(This work has no output yet)";
   return {intent_id:id,final_text:chosen.detail||chosen.summary||'',summary:chosen.summary??'',is_error:!!chosen.is_error,...inherited(n)};
  }
  if(Array.isArray(p.step_ids)&&p.step_ids.length){const all=[...new Set(p.step_ids.map(Number).filter(v=>Number.isSafeInteger(v)&&v>0))],ids=all.slice(0,5),omitted=all.slice(5);
   const rows=(await service.byIDs(taskId,ids)).filter(a=>Number(a.node_id)===id&&a.inherited===n.inherited&&(!a.inherited||String(a.owning_task)===String(n.owning_task)));
   return {intent_id:id,steps:rows.map(a=>({step_id:Number(a.id),kind:a.kind??'',tool:a.tool??'',is_error:!!a.is_error,detail:a.detail??'',...inherited(a)})),returned_step_ids:ids,
    ...(omitted.length?{omitted_step_ids:omitted,notice:`The complete content of up to 5 steps can be fetched each time. This time, the previous ${ids.length} ([${ids.join(' ')}]), not taken ${omitted.length} are [${omitted.join(' ')}]. If these contents are sufficiently positioned, there is no need to take the remaining steps; if you really need to continue, use these step_ids to call again.`}:{}),...inherited(n)};
  }
  return {intent_id:id,steps:(await service.trace(taskId,id,String(p.q??''),Number(p.limit)||0)).map(traceStep),...inherited(n)};
 }});}
 const aliases={get_task_worker_trace:'get_worker_trace',list_task_worker_traces:'list_worker_traces',search_task_worker_traces:'search_all_worker_traces'};
 for(const [key,inner] of Object.entries(aliases)){
  const seed=hostSeeds.find(s=>s.key===key)!;
  registerTool({key,description:seed.description,schema:seed.schema,params:{},required:[],execute:async(p,ctx)=>{
   const raw=String(p.task_id??'');if(!raw.trim())throw new Error("task_id is required");
   if(!/^[1-9][0-9]*$/.test(raw)||!await service.task(Number(raw)))throw new Error("task does not exist: "+raw);
   const {task_id,...params}=p;return getTool(inner)!.execute(params,{...ctx,taskId:Number(raw),intentId:undefined});
  }});
 }

}
