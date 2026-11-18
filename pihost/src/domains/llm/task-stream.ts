/** Task-safe replay around Pi's native provider stream. */
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {AssistantMessage,AssistantMessageEvent} from '@earendil-works/pi-ai';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {setTimeout as delay} from 'node:timers/promises';
import {isQuotaExhausted} from './task-chain.ts';
import type {TaskModelResolver,TaskModelSelection} from './profile-runtime.ts';
import {profileCall,capturedCall} from './profile-wire.ts';
type StreamFn=AgentSession['agent']['streamFunction'];
export interface RouterFailure {routerHandled:boolean;chainExhausted:boolean}
export function canonicalProviderError(error:string){return error.replace(/^(\d{3})\b/,'status $1');}
export function retryableStream(error:string){const s=canonicalProviderError(error).toLowerCase();return !isQuotaExhausted(s)&&!['too long','context length','context_length','maximum context','status 413'].some(x=>s.includes(x))&&!/status (400|401|403|404|422)\b/.test(s);}
function commits(ev:AssistantMessageEvent){switch(ev.type){case'text_delta':case'thinking_delta':case'toolcall_delta':return !!ev.delta;case'toolcall_start':case'done':return true;default:return false;}}
function emptyError(model:Parameters<StreamFn>[0],error:string,aborted=false):AssistantMessage{return {role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?'aborted':'error',errorMessage:error,timestamp:Date.now()};}
export function taskStream(native:StreamFn,resolver:TaskModelResolver,reportFailure:(v:RouterFailure|undefined)=>void,onAttempt?:(s:TaskModelSelection,m:AssistantMessage,context:Parameters<StreamFn>[1],latencyMs:number,capture?:import('./profile-wire.ts').WireCapture)=>Promise<void>,invoke?:(s:TaskModelSelection,model:Parameters<StreamFn>[0],context:Parameters<StreamFn>[1],options:Parameters<StreamFn>[2])=>ReturnType<StreamFn>):StreamFn {
 return (initial,context,options)=>{
  const out=createAssistantMessageEventStream();
  reportFailure(undefined);
  void(async()=>{let model=initial,hasCommittedOutput=false;
   try{for(;;){if(options?.signal?.aborted)throw options.signal.reason??new Error('aborted');const selected=await resolver.current();model=selected.model;
    const p=selected.profile,policyRaw=(await resolver.pool.query("SELECT value FROM app_settings WHERE key='llm.retry_policy'")).rows[0]?.value;
    let policy:Record<string,any>={};try{policy=JSON.parse(policyRaw??'{}');}catch{}
    const override=p?.retry??{},streamCount=override.stream?.attempts||policy.stream?.attempts||2,interval=override.stream?.interval_ms||policy.stream?.interval_ms||0;
    const connect=override.connect?.attempts||policy.connect?.attempts||3;
    let committed=false,pending:AssistantMessageEvent[]=[],failure:AssistantMessage|undefined,connectAttempt=0,streamAttempt=0;
    for(;;){
     committed=false;pending=[];failure=undefined;const start=Date.now();const wire:import('./profile-wire.ts').WireCaptureHolder={};
     // API key belongs to this immutable selection; parallel profile edits cannot
     // make an already selected request borrow another profile's credentials.
     const direct=!invoke||selected.source==='task_chain'||!p;
     const requestOptions=direct&&p?{...options,apiKey:p.api_key,maxTokens:p.max_tokens||options?.maxTokens,maxRetries:0,
      headers:{...options?.headers,...(p.session_header_key?{[p.session_header_key]:options?.sessionId??''}:{})}}:{...options,maxRetries:0};
     const stream=await (direct&&p?profileCall(native,resolver.pool,p,model,context,requestOptions,undefined,wire):!p?capturedCall(native,model,context,requestOptions,wire):invoke?invoke(selected,model,context,requestOptions):native(model,context,requestOptions));
     const terminal:AssistantMessageEvent[]=[];
     for await(const event of stream){
      if(event.type==='error'){failure=event.error;break;}
      if(!committed&&!commits(event)){pending.push(event);continue;}
      if(!committed){for(const prior of pending)out.push(prior);pending=[];committed=true;hasCommittedOutput=true;}
      if(event.type==='done')terminal.push(event);else out.push(event);
     }
     const result=failure??await stream.result();await onAttempt?.(selected,result,context,Date.now()-start,wire.capture);
     if(!failure){for(const prior of pending)out.push(prior);for(const event of terminal)out.push(event);out.end(result);return;}
     // SDK connect retry is suppressed so explicit quota 429 cannot consume the
     // backup's budget in the first SDK before the router sees its body.
     if(!committed&&!options?.signal?.aborted&&retryableStream(failure.errorMessage??'')){
      const connecting=pending.length===0,connectInterval=override.connect?.interval_ms||policy.connect?.interval_ms||0;
      if(connecting&&connectAttempt<Math.max(0,connect)){const wait=connectInterval||Math.min(500*2**connectAttempt,4000);connectAttempt++;await delay(wait,undefined,{signal:options?.signal});continue;}
      if(streamAttempt<Math.max(0,streamCount)){const wait=interval||Math.min(500*2**streamAttempt,4000);streamAttempt++;connectAttempt=0;await delay(wait,undefined,{signal:options?.signal});continue;}
     }break;
    }
    const reason=failure?.errorMessage??'provider stream failed';
    if(!options?.signal?.aborted&&selected.chainProfile&&isQuotaExhausted(canonicalProviderError(reason))){
     const transition=await resolver.chains.exhaust(resolver.taskId,selected.chainProfile,selected.revision,reason);
     if(!committed&&(transition.stale||transition.next_profile_id))continue;
     reportFailure({routerHandled:true,chainExhausted:transition.chain_exhausted});
     const err={...failure!,errorMessage:transition.chain_exhausted?`task ${resolver.taskId} LLM profile chain exhausted: ${reason}`:reason};for(const prior of pending)out.push(prior);out.push({type:'error',reason:err.stopReason==='aborted'?'aborted':'error',error:err});out.end(err);return;
    }
    for(const prior of pending)out.push(prior);out.push({type:'error',reason:failure!.stopReason==='aborted'?'aborted':'error',error:failure!});out.end(failure);return;
   }}catch(e){const error=emptyError(model,(e as Error).message||String(e),!!options?.signal?.aborted);if(hasCommittedOutput||error.errorMessage?.includes('LLM profile chain exhausted'))reportFailure({routerHandled:true,chainExhausted:!!error.errorMessage?.includes('LLM profile chain exhausted')});out.push({type:'error',reason:error.stopReason==='aborted'?'aborted':'error',error});out.end(error);}
  })();return out;
 };
}
