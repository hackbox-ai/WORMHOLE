import type {Pool} from 'pg';
import {registerTool,type ToolContext} from '../tools/gate.ts';
import {FindingReads} from './reads.ts';
const absent=(id:number)=>`Exploration node not found ${id}. If you want to check assets, please use list_assets / asset_neighbors (assets and exploration nodes are in different id spaces, and asset ids cannot be passed to node_detail).`;
export function registerFindingReadTools(pool:Pool):void{
 const service=new FindingReads(pool);
 const task=async(p:Record<string,unknown>)=>{const raw=String(p.task_id??'');if(!raw.trim())throw new Error("task_id is required");if(!/^[0-9]+$/.test(raw)||!await service.exists(Number(raw)))throw new Error("task does not exist: "+raw);return Number(raw);};
 const readTask=(ctx:ToolContext)=>{if(!ctx.taskId)throw new Error("list_findings requires task context (exploration graph): the current agent is not running in a task, the exploration graph of the task cannot be obtained, and the tool is unavailable. Please use this within a task, or use cross-task reading tools with task_id instead (get_task_node_detail / list_task_findings / get_task_graph etc.).");return ctx.taskId;};
 registerTool({key:'list_findings',description:"List the confirmed vulnerabilities of this task and directly related tasks. The related tasks are read-only; id is the exploration node, and finding_id is the independent vulnerability number.",schema:{type:'object',properties:{}},params:{},required:[],execute:(_p,c)=>service.list(readTask(c))});
 registerTool({key:'list_task_findings',description:"Confirmation vulnerability in reading specified tasks and their directly related tasks, same as list_findings.",schema:{type:'object',properties:{task_id:{type:'string'}},required:['task_id']},params:{},required:[],execute:async p=>service.list(await task(p))});
 registerTool({key:'get_task_node_detail',description:"Read the complete content and clear vulnerability number of the exploration node of the specified task or directly related task.",schema:{type:'object',properties:{task_id:{type:'string'},id:{type:'integer'}},required:['task_id','id']},params:{},required:[],execute:async p=>{if(Number(p.id)<=0)throw new Error("id required");const node=await service.node(await task(p),Number(p.id));if(!node)throw new Error(absent(Number(p.id)));return node;}});
}
