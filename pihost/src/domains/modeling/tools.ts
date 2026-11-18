import {registerTool,type ToolContext} from '../tools/gate.ts';
import {ModelingService} from './service.ts';
export const MODELING_READ_TOOLS=['list_business_models','api_model_read'];
export const MODELING_REQUEST_TOOLS=['request_business_model',...MODELING_READ_TOOLS];
export const MODELER_TOOLS=['api_model_submit','api_model_done'];
export const MODELING_GUIDANCE="\nBusiness modeling is a parallel information supplement, not a test precondition. You can request_business_model when a new independent system is discovered; continue the current test after returning without waiting, ending or blocking the current intent. When the model is not ready or fails, the check is advanced based on the target's true response, fingerprints, and existing evidence. After the background results are updated, the scheduler will be notified and can be read on demand through list_business_models and api_model_read; business_system_id is only associated with the context and does not establish waiting dependencies.";
export const CHAT_MODELING_GUIDANCE="\nTask dispatch and business modeling are executed asynchronously. After creating a test task, immediately inform the task number, current status and task entry, and briefly explain that it has been started or queued; do not wait for the task to be completed through sleep or repeated queries. Progress is continuously displayed by the task module. Status is only checked when the user explicitly asks to wait or query. Business modeling supplements information in the background and does not affect the main task testing; the model cannot be claimed to be ready before it is completed. When users explicitly require business modeling, interface or entity sorting, they can initiate independent modeling, and the current task dialogue is fixedly associated with the current task.";
export function registerModelingTools(service:ModelingService){
  const string={type:'string'},integer={type:'integer',minimum:1};
  const task=(ctx:ToolContext)=>{if(!ctx.taskId)throw new Error("This reading tool requires a task context");return ctx.taskId;};
  const selectedTask=(p:Record<string,unknown>,ctx:ToolContext)=>{
    const requested=p.task_id===undefined?undefined:Number(p.task_id);
    if(ctx.taskId&&requested&&requested!==ctx.taskId)throw new Error("Task dialogue can only operate the business model of the current task");
    if(!ctx.taskId&&requested&&!['auto','mainagent','pentest'].includes(ctx.agentKey))throw new Error("The current role cannot be assigned other tasks");
    return ctx.taskId??requested;
  };
  const taskField={...integer,description:"Optional, associate existing test tasks explicitly specified by the user in the independent dialog; the task dialog uses the current task fixedly"};
  registerTool({key:'request_business_model',description:"Create or add a business modeling task for the target system. Used when new systems are discovered during testing. Continue testing after returning, and the scheduler will be notified of the background results. Independent conversations can also be initiated.",params:{},required:[],
    schema:{type:'object',properties:{target:string,name:string,reason:string,environment:string,auth_context:{type:'string',description:"Identity tag, credentials must not be filled in"},asset_id:integer,task_id:taskField},required:['target','reason']},
    execute:async(p,ctx)=>{
      if(ctx.agentKey==='modeler')throw new Error("Modeling Agent must not recursively create modeling tasks");
      const taskId=selectedTask(p,ctx);
      const result=await service.request({target:String(p.target),name:p.name as string|undefined,reason:String(p.reason),environment:p.environment as string|undefined,auth_context:p.auth_context as string|undefined,
        asset_id:p.asset_id as number|undefined,task_id:taskId,intent_id:ctx.intentId,conversation_id:ctx.conversationId,trigger:ctx.intentId?'discovery':'manual'});
      return {...result,message:result.ready?"There is already an available model, use api_model_read to read and continue":"The background modeling has been registered and the current test continues to be executed; it will be automatically notified when the results are ready"};
    }});
  registerTool({key:'list_business_models',description:"Query the business model associated with the current task, or the modeling task and progress initiated by the current independent dialogue. The independent Auto dialogue can pass task_id to query the specified test task.",params:{},required:[],schema:{type:'object',properties:{task_id:taskField}},
    execute:(p,ctx)=>{const id=selectedTask(p,ctx);if(id)return service.catalog(id);if(ctx.conversationId)return service.conversationCatalog(ctx.conversationId);throw new Error("Requires task or conversation context");}});
  registerTool({key:'api_model_read',description:"Read the business model associated with the current test task. First pass system_id to get the interface directory, and then pass path to read detailed parameters and responses as needed.",params:{},required:[],
    schema:{type:'object',properties:{system_id:integer,path:string,task_id:taskField},required:['system_id']},execute:(p,ctx)=>{const id=selectedTask(p,ctx);if(id)return service.readForTask(id,Number(p.system_id),p.path as string|undefined);if(ctx.conversationId)return service.readForConversation(ctx.conversationId,Number(p.system_id),p.path as string|undefined);throw new Error("Requires task or conversation context");}});
  registerTool({key:'api_model_submit',description:"Save the OpenAPI 3.0 draft and business entities of the current modeling task in batches. Supports openapi entire document or paths/components shards. Same paths are merged by HTTP method.",params:{},required:[],
    schema:{type:'object',properties:{openapi:{type:'object',additionalProperties:true},paths:{type:'object',additionalProperties:true},components:{type:'object',additionalProperties:true},entities:{type:'array',items:{type:'object',additionalProperties:true}},note:string}},
    execute:(p,ctx)=>{if(ctx.agentKey!=='modeler')throw new Error("Only modeling tasks can write to the model");return service.submit(task(ctx),p);}});
  registerTool({key:'api_model_done',description:"To submit this modeling delivery, the interface must be saved first. summary describes the covered modules, uncovered content and inferred parts. The version is released after the current run ends successfully.",params:{},required:[],
    schema:{type:'object',properties:{summary:string},required:['summary']},execute:(p,ctx)=>{if(ctx.agentKey!=='modeler')throw new Error("Only modeling tasks can be declared complete");return service.requestFinish(task(ctx),String(p.summary));}});
}
