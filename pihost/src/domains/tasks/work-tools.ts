import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import seeds from '../tools/business-tool-seeds.json' with {type:'json'};
export const WORK_CONTROLS=['kill_work','steer_work'];
export function registerWorkControls(pool:Pool,controls:{killWork(taskId:number,intentId:number):Promise<void>;steerWork(taskId:number,intentId:number,message:string):Promise<void>}){
 for(const key of WORK_CONTROLS){const seed=seeds.find(s=>s.Key===key)!;registerTool({key,description:seed.Desc,schema:seed.Schema,params:{},required:[],execute:async(p,ctx)=>{
  if(!ctx.taskId)throw new Error(key+" Task context (exploration graph) required: The current agent is not running in a task, the exploration graph of the task cannot be obtained, and the tool is unavailable. Please use this within a task, or use cross-task reading tools with task_id instead (get_task_node_detail / list_task_findings / get_task_graph etc.).");
  const id=Number(p.intent_id);if(!id)throw new Error("intent_id required");if(!(await pool.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent'",[id,ctx.taskId])).rowCount)throw new Error("intent_id must be the intent of this task (the associated task intent is read-only)");
  if(key==='kill_work'){await controls.killWork(ctx.taskId,id);return `Intent sent ${id} The work sends a termination signal`;}
  const message=String(p.message??'');if(!message.trim())throw new Error("message required");await controls.steerWork(ctx.taskId,id,message);return `Intent sent ${id} Work injection correction instructions (effective in the next step)`;
 }});}
}
