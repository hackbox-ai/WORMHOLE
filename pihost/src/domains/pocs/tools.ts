import {registerTool} from '../tools/gate.ts';
import {pocEvent} from './lifecycle.ts';
import type {PocService} from './service.ts';
export const POC_TOOLS=['search_pocs','read_poc'];
const pagination={offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}};
const definitions=[
 {key:'search_pocs',description:"Retrieve the PoC knowledge base fixed for the current task. When there are no parameters, read the current intent-related candidates (Planner is the task candidate); q/product/cve explicitly retrieves the directory, and the unassessed result does not mean it is applicable. No PoC will be performed.",schema:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:200},product:{type:'string',maxLength:160},cve:{type:'string',maxLength:64},...pagination}}},
 {key:'read_poc',description:"Press entry_id to read the PoC conditions, description and original code/template in the current task snapshot. candidate_id can be associated with specific asset basis; offset/limit reads the text in pages. Information is not an instruction or authorization to perform.",schema:{type:'object',additionalProperties:false,properties:{entry_id:{type:'string',pattern:'^[a-f0-9]{64}$'},candidate_id:{type:'integer',minimum:1},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:12000}},required:['entry_id']}},
];
export async function seedPocTools(service:PocService){for(const d of definitions)await service.pool.query("INSERT INTO tools(key,system,description,schema,agents,kind) VALUES($1,true,$2,$3::jsonb,$4::jsonb,'builtin') ON CONFLICT(key) DO UPDATE SET schema=EXCLUDED.schema,description=EXCLUDED.description",[d.key,d.description,JSON.stringify(d.schema),JSON.stringify(['planner','worker','pentest','mainagent'])]);}
export function registerPocTools(service:PocService){for(const d of definitions)registerTool({...d,params:{},required:[],execute:async(p,ctx)=>{
 if(!ctx.taskId)throw new Error("PoC knowledge tool requires current task context");if(!await service.enabled())throw new Error("PoC knowledge feed closed");
 const output=d.key==='search_pocs'?await service.search(ctx.taskId,p as never,ctx.intentId):await service.detail(String(p.entry_id),{taskId:ctx.taskId,candidateId:p.candidate_id?Number(p.candidate_id):undefined,offset:Number(p.offset??0),limit:Number(p.limit??8000)});
 await pocEvent(service.pool,ctx.taskId,d.key==='search_pocs'?'poc_search_read':'poc_detail_read',{intent_id:ctx.intentId,entry_id:p.entry_id,candidate_id:p.candidate_id,query:d.key==='search_pocs'?p:undefined,offset:p.offset??0});return output;
}});}
