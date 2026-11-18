import type {ConversationsService} from '../conversations/service.ts';
import type {AgentsService} from './service.ts';
import type {TriggerRun} from '../tasks/scheduler.ts';

/** Trigger runs use the ordinary durable conversation runtime and tool policy.
 * This makes runs visible in the UI, cancellable by its API and drained at exit. */
export async function runTriggeredConversation(conversations:ConversationsService,agents:AgentsService,agentKey:string,message:string,run?:TriggerRun,signal?:AbortSignal):Promise<number> {
 signal?.throwIfAborted();
 const agent=await agents.get(agentKey);if(!agent)throw new Error("agent does not exist");
 const created=await conversations.create(agentKey,run?.title??"Trigger session",null);
 if(!created.ok)throw new Error(created.error);
 const id=Number(created.conv.id);
 signal?.throwIfAborted();
 const cancel=()=>{void conversations.stop(id).catch(e=>console.error('[trigger] cancellation failed',id,e));};
 signal?.addEventListener('abort',cancel,{once:true});
 try{
 const result=await conversations.send(id,message,[],{
  timeoutMs:Number(agent.run_seconds)>0?Number(agent.run_seconds)*1000:undefined,
  start:async()=>true,
  finish:async(status,reason)=>{if(status==='failed')console.error('[trigger] conversation failed',id,reason);},
 });
 if(result.status!==202)throw new Error(result.error??"Trigger session start failed");
 if(signal?.aborted)cancel();
 while(conversations.isRunning(id))await new Promise(r=>setTimeout(r,25));
 return id;
 }finally{signal?.removeEventListener('abort',cancel);}
}
