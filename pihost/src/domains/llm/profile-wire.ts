/**
 * F07 wire capture：in fetch Layer Mirror Real Cable Bytes。
 * All top views（CompletionRequest/AgentMessage）They are all standardized reconstructions - tools
 * schema、tool_use Block AND SSE Frames are only true bytes on the wire. The request body only remembers the first try (retry
 * Resend the same byte); each time HTTP One round trip attempt，Streaming tee Preserve back pressure without breaking flow。
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {contextView,providerContext} from '../../pi/transcript.ts';
const plannerRecoveryScope=new AsyncLocalStorage<boolean>();
export function withPlannerRecovery<T>(enabled:boolean,call:()=>Promise<T>):Promise<T>{return plannerRecoveryScope.run(enabled,call);}
/** Consume WORMHOLE profile controls through Pi's public fetch/onPayload hooks. */
import type {SimpleStreamOptions,AssistantMessage,AssistantMessageEvent,Context} from '@earendil-works/pi-ai';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import type {Pool} from 'pg';
import type {RuntimeProfile} from './profile-runtime.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {proxyAgent} from '../traffic/network.ts';
import {CallPerformance} from '../observability/call-performance.ts';
class Bucket{
 private tokens:number;private last:number;
 constructor(readonly rate:number,readonly burst:number,readonly now=()=>performance.now()){this.tokens=burst;this.last=now();}
 reserve(){const now=this.now();this.tokens=Math.min(this.burst,this.tokens+(now-this.last)*this.rate/1000);this.last=now;this.tokens--;return this.tokens>=0?0:-this.tokens/this.rate*1000;}
}
const limiters=new WeakMap<Pool,Map<number,{signature:string;sec?:Bucket;min?:Bucket}>>();
export async function waitProfileRate(pool:Pool,p:RuntimeProfile,signal?:AbortSignal){
 const sec=Number(p.rate_per_second)||0,min=Number(p.rate_per_minute)||0;if(sec<=0&&min<=0){limiters.get(pool)?.delete(p.id);return;}
 let rows=limiters.get(pool);if(!rows){rows=new Map();limiters.set(pool,rows);}const signature=`${sec}:${min}`;let limiter=rows.get(p.id);
 if(limiter?.signature!==signature){limiter={signature,...(sec>0?{sec:new Bucket(sec,sec)}:{}),...(min>0?{min:new Bucket(min/60,min)}:{})};rows.set(p.id,limiter);}
 const wait=Math.max(limiter.sec?.reserve()??0,limiter.min?.reserve()??0);if(wait>0)await delay(wait,undefined,{signal});else if(signal?.aborted)throw signal.reason;
}
/** Model transport uses only its own profile proxy, not captured target traffic. */
export interface WireAttempt{status:number;chunks:string[]}
/** Primary logic LLM Cable capture called；attempt Cumulative mutual exclusivity is guaranteed by a single async tree order。 */
export class WireCapture{
 readonly performance=new CallPerformance();
 private request='';private attempts:WireAttempt[]=[];
 private context?:Context;private controls?:{maxTokens?:number;thinkingType?:string;reasoningEffort?:string};
 setContext(context:Context,controls?:{maxTokens?:number;thinkingType?:string;reasoningEffort?:string}){
  context=contextView(context);
  this.performance.context(context.messages.length,context.tools?.length??0,Buffer.byteLength(context.systemPrompt??''));
  // Tool objects may carry executable validators; only message content and names belong to this view.
  this.context={systemPrompt:context.systemPrompt,messages:context.messages.map(m=>({role:m.role,content:structuredClone(m.content),timestamp:m.timestamp,...(m.role==='toolResult'?{toolCallId:m.toolCallId,toolName:m.toolName,isError:m.isError}:{})})) as Context['messages'],tools:context.tools?.map(t=>({name:t.name,description:'',parameters:{}}))};this.controls={...controls};
 }
 requestBody(){return normalizedRequestBody(this.request,this.context,this.controls);}
 setRequest(body:string){if(!this.request&&body){this.request=body;this.performance.request(Buffer.byteLength(body));}}
 startAttempt(status:number){const a:WireAttempt={status,chunks:[]};this.attempts.push(a);return{
  push(chunk:string){a.chunks.push(chunk);},
 };}
 rawRequest(){return this.request}
 lastStatus(){return this.attempts.length?this.attempts[this.attempts.length-1]!.status:0}
 /** Many attempt Press llmrec Original format splicing; single attempt Keep original replayable bytes。 */
 rawResponse(){const n=this.attempts.length;if(n===0)return '';if(n===1)return this.attempts[0]!.chunks.join('');
  return this.attempts.map((a,i)=>{const body=a.chunks.join('');return '===== attempt '+(i+1)+'/'+n+' — HTTP '+a.status+' =====\n'+body+(body.endsWith('\n')?'':'\n');}).join('');}
}

const wireStorage=new AsyncLocalStorage<WireCapture>();
export interface WireCaptureHolder{capture?:WireCapture}
/** Mirror only bytes consumed by the provider, including partial/aborted streams. */
export function captureWireFetch(baseFetch:typeof fetch,capture:WireCapture):typeof fetch{return async(input,init)=>{
 const request=new Request(input,init);
 if(request.body)capture.setRequest(await request.clone().text());
 const receivedHeaders=capture.performance.httpStart();let response:Response;
 try{response=await baseFetch(request);}finally{receivedHeaders();}
 const sink=capture.startAttempt(response.status);
 if(!response.body)return response;
 const reader=response.body.getReader(),decoder=new TextDecoder();
 const pass=new ReadableStream<Uint8Array>({async pull(controller){try{const{done,value}=await reader.read();
  if(done){const tail=decoder.decode();if(tail)sink.push(tail);controller.close();return;}
  capture.performance.response(value.length);sink.push(decoder.decode(value,{stream:true}));controller.enqueue(value);
 }catch(error){const tail=decoder.decode();if(tail)sink.push(tail);controller.error(error);}},cancel(reason){return reader.cancel(reason);}});
 return new Response(pass,{status:response.status,statusText:response.statusText,headers:response.headers});
};}
/** Normalized Request View (Contrast llmrec.serializeRequest）：tools Leave only name, attached tools_count。 */
export function normalizedRequestBody(raw:string,context?:Context,controls?:{maxTokens?:number;thinkingType?:string;reasoningEffort?:string}):string{
 let b:Record<string,any>={};try{if(raw)b=JSON.parse(raw);}catch{if(!context)return '';}
 if(!raw&&!context)return '';
 const block=(c:any):Record<string,any>=>{
  if(c.type==='text')return {type:'text',...(c.text?{text:c.text}:{})};
  if(c.type==='thinking')return {type:'thinking',...(c.thinking?{thinking:c.thinking}:{}),...(c.thinkingSignature?{signature:c.thinkingSignature}:{})};
  if(c.type==='toolCall')return {type:'tool_use',...(c.id?{id:c.id}:{}),...(c.name?{name:c.name}:{}),input:c.arguments??{}};
  // The output DTO has no image block; retain unsupported content explicitly instead of silently losing it.
  return structuredClone(c);
 };
 const messages:Record<string,any>[]|undefined=context?[]:undefined;let priorTool=false;
 for(const m of context?.messages??[]){if(m.role==='toolResult'){
  const result={type:'tool_result',...(m.toolCallId?{tool_use_id:m.toolCallId}:{}),...(m.content.length?{content:m.content.map(block)}:{}),...(m.isError?{is_error:true}:{})};
  if(priorTool)messages!.at(-1)!.content.push(result);else messages!.push({role:'user',content:[result]});priorTool=true;
 }else{messages!.push({role:m.role,content:typeof m.content==='string'?[block({type:'text',text:m.content})]:m.content.map(block)});priorTool=false;}}
 const system=context?(context.systemPrompt?[context.systemPrompt]:null):Array.isArray(b.system)?b.system.map((s:any)=>typeof s==='string'?s:s.text):typeof b.system==='string'?[b.system]:null;
 const out:Record<string,any>={system,messages:messages??b.messages??null,max_tokens:b.max_tokens??b.max_completion_tokens??b.max_output_tokens??controls?.maxTokens??0};
 const type=b.thinking?.type??controls?.thinkingType??'',effort=b.output_config?.effort??b.reasoning_effort??b.reasoning?.effort??controls?.reasoningEffort??'';
 if(type||effort)out.thinking={type,effort};if(b.temperature!=null)out.temperature=b.temperature;if(Array.isArray(b.stop)&&b.stop.length)out.stop=b.stop;else if(typeof b.stop==='string'&&b.stop)out.stop=[b.stop];
 const names=context?.tools?.map(t=>t.name)??(Array.isArray(b.tools)?b.tools.map((t:any)=>t?.name??t?.function?.name).filter(Boolean):[]);
 if(names.length){out.tools=names;out.tools_count=names.length;}
 return JSON.stringify(out);
}
/** Normalize stop reasons; retain Anthropic stop_sequence and other native reasons. */
export function normalizedStopReason(reason:string,raw?:string):string{
 const value=raw??reason;return ({stop:'end_turn',toolUse:'tool_use',tool_calls:'tool_use',length:'max_tokens',error:'',aborted:''} as Record<string,string>)[value]??value;
}
export const fetchWithProfileProxy=(proxy:string):typeof fetch=>async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url),agent=proxyAgent(proxy,url.protocol==='https:');
 const body=request.body?Buffer.from(await request.arrayBuffer()):undefined,headers=Object.fromEntries(request.headers.entries());if(body)headers['content-length']=String(body.length);
 return new Promise<Response>((resolve,reject)=>{
  const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:request.method,headers,agent,signal:request.signal},res=>{
   const headers=new Headers();for(const [key,value] of Object.entries(res.headers))if(value!=null)for(const part of Array.isArray(value)?value:[String(value)])headers.append(key,part);
   let source:Readable=res;const encoding=res.headers['content-encoding'];if(encoding==='gzip')source=res.pipe(createGunzip());else if(encoding==='deflate')source=res.pipe(createInflate());else if(encoding==='br')source=res.pipe(createBrotliDecompress());
   if(source!==res){headers.delete('content-encoding');headers.delete('content-length');res.on('error',e=>source.destroy(e));}
   res.on('close',()=>agent.destroy());source.on('error',()=>agent.destroy());
   const status=res.statusCode??502;resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(source) as ReadableStream<Uint8Array>,{status,statusText:res.statusMessage,headers}));
  });req.on('error',e=>{agent.destroy();reject(e);});req.end(body);
 });
};
const event=(type:string,data:any)=>`event: ${type}\ndata: ${JSON.stringify({...data,type})}\n\n`;
export function completionAsSSE(format:string,value:any):string{
 if(value?.error){const error=typeof value.error==='string'?{message:value.error}:value.error;if(format==='openai')return `data: ${JSON.stringify({error})}\n\n`;if(format==='anthropic')return event('error',{error:{type:error.type??'api_error',message:error.message??JSON.stringify(error)}});return event('error',{code:error.code??'provider_error',message:error.message??JSON.stringify(error)});}
 if(format==='anthropic'){
  let out=event('message_start',{message:{...value,content:[],stop_reason:null,stop_sequence:null,usage:{...value.usage,output_tokens:0}}});
  for(const [index,block] of (value.content??[]).entries()){
   const initial={...block,...(block.type==='text'?{text:''}:block.type==='thinking'?{thinking:'',signature:''}:block.type==='tool_use'?{input:{}}:{})};out+=event('content_block_start',{index,content_block:initial});
   if(block.type==='text')out+=event('content_block_delta',{index,delta:{type:'text_delta',text:block.text??''}});
   if(block.type==='thinking'){out+=event('content_block_delta',{index,delta:{type:'thinking_delta',thinking:block.thinking??''}});if(block.signature)out+=event('content_block_delta',{index,delta:{type:'signature_delta',signature:block.signature}});}
   if(block.type==='tool_use')out+=event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input??{})}});
   out+=event('content_block_stop',{index});
  }return out+event('message_delta',{delta:{stop_reason:value.stop_reason,stop_sequence:value.stop_sequence??null},usage:value.usage??{}})+event('message_stop',{});
 }
 if(format==='openai'){
  const prefix={id:value.id,object:'chat.completion.chunk',created:value.created,model:value.model},first={...prefix,choices:(value.choices??[]).map((c:any)=>({index:c.index??0,delta:{...c.message,tool_calls:c.message?.tool_calls?.map((t:any,index:number)=>({...t,index}))},finish_reason:null}))};
  const end={...prefix,choices:(value.choices??[]).map((c:any)=>({index:c.index??0,delta:{},finish_reason:c.finish_reason})),usage:value.usage};return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`;
 }
 let out=event('response.created',{response:{...value,output:[],status:'in_progress'}});
 for(const [output_index,item] of (value.output??[]).entries()){
  out+=event('response.output_item.added',{output_index,item:{...item,...(item.type==='message'?{content:[]}:item.type==='reasoning'?{summary:[]}:item.type==='function_call'?{arguments:''}:{})}});
  if(item.type==='message')for(const [content_index,part] of (item.content??[]).entries())out+=event(part.type==='refusal'?'response.refusal.delta':'response.output_text.delta',{output_index,content_index,item_id:item.id,delta:part.type==='refusal'?part.refusal:part.text});
  if(item.type==='reasoning')for(const [summary_index,part] of (item.summary??item.content??[]).entries())out+=event('response.reasoning_summary_text.delta',{output_index,summary_index,item_id:item.id,delta:part.text??''});
  if(item.type==='function_call')out+=event('response.function_call_arguments.done',{output_index,item_id:item.id,arguments:item.arguments??'{}'});
  out+=event('response.output_item.done',{output_index,item});
 }return out+event(value.status==='incomplete'?'response.incomplete':value.status==='failed'?'response.failed':'response.completed',{response:value});
}
export function profileWireOptions(p:RuntimeProfile,options:SimpleStreamOptions|undefined):SimpleStreamOptions{
 const baseFetch=p.proxy?fetchWithProfileProxy(p.proxy):options?.fetch??globalThis.fetch;
 return {...options,fetch:async(input,init)=>{
  let request=new Request(input,init);
  // Pi uses Anthropic's beta client; legacy WORMHOLE suppliers use /v1/messages.
  if(p.format==='anthropic'){const url=new URL(request.url);if(url.searchParams.get('beta')==='true'){url.searchParams.delete('beta');request=new Request(url,request);}}
  const store=wireStorage.getStore();
  const transport=store?captureWireFetch(baseFetch,store):baseFetch;
  if(p.streaming!==false)return transport(request);
  let body:any;try{body=JSON.parse(await request.text());}catch{throw new Error('non-streaming provider request must be JSON');}
  body.stream=false;delete body.stream_options;const headers=new Headers(request.headers);headers.delete('content-length');
  const response=await transport(request.url,{method:request.method,headers,body:JSON.stringify(body),signal:request.signal});if(!response.ok)return response;
  let value:any;try{value=await response.json();}catch(e){value={error:{message:`${p.format}: decode response: ${(e as Error).message}`}};}
  if(p.format==='openai'&&!value?.error&&!value?.choices?.length)value={error:{message:'openai: empty response (no choices)'}};
  const result=completionAsSSE(p.format,value),outHeaders=new Headers(response.headers);outHeaders.delete('content-length');outHeaders.delete('content-encoding');outHeaders.set('content-type','text/event-stream');return new Response(result,{status:response.status,headers:outHeaders});
 },onPayload:async(payload,model)=>{
  const replacement=await options?.onPayload?.(payload,model),body=(replacement??payload) as Record<string,any>,cap=Number(p.max_tokens)||options?.maxTokens||0;
  delete body.max_tokens;delete body.max_completion_tokens;delete body.max_output_tokens;
  if(p.format==='anthropic'){body.max_tokens=cap||8192;if(p.thinking_type)body.thinking={type:p.thinking_type};else {delete body.thinking;for(const m of body.messages??[])if(Array.isArray(m.content))m.content=m.content.filter((c:any)=>!['thinking','redacted_thinking'].includes(c.type));}if(p.reasoning_effort)body.output_config={effort:p.reasoning_effort};else delete body.output_config;}
  else if(p.format==='openai'){if(cap>0)body[p.max_tokens_field==='max_completion_tokens'?'max_completion_tokens':'max_tokens']=cap;if(p.thinking_type)body.thinking={type:p.thinking_type};else delete body.thinking;if(p.reasoning_effort)body.reasoning_effort=p.reasoning_effort;else delete body.reasoning_effort;}
  else {if(cap>0)body.max_output_tokens=cap;if(p.reasoning_effort)body.reasoning={effort:p.reasoning_effort};else delete body.reasoning;}
  if(p.format==='anthropic'&&plannerRecoveryScope.getStore()){body.thinking={type:'disabled'};delete body.output_config;}
  return body;
 }};
}

type StreamFn=AgentSession['agent']['streamFunction'];
/** Environment models use the same public fetch hook, without profile overrides. */
export function capturedCall(native:StreamFn,model:Parameters<StreamFn>[0],context:Parameters<StreamFn>[1],options:Parameters<StreamFn>[2],holder:WireCaptureHolder={},record?:(message:AssistantMessage,latencyMs:number,capture:WireCapture)=>Promise<void>):ReturnType<StreamFn>{
 const out=createAssistantMessageEventStream(),capture=new WireCapture(),start=Date.now();holder.capture=capture;
 capture.setContext(context,{maxTokens:options?.maxTokens});
 void(async()=>{try{const stream=await native(model,providerContext(context),{...options,fetch:captureWireFetch(options?.fetch??globalThis.fetch,capture)}),terminal:AssistantMessageEvent[]=[];
  for await(const event of stream){capture.performance.observe(event);if(record&&(event.type==='done'||event.type==='error'))terminal.push(event);else out.push(event);}const message=await stream.result();capture.performance.finish();await record?.(message,Date.now()-start,capture);for(const event of terminal)out.push(event);out.end(message);
 }catch(e){capture.performance.finish();const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:options?.signal?.aborted?'aborted':'error',errorMessage:(e as Error).message??String(e),timestamp:Date.now()};out.push({type:'error',reason:message.stopReason==='aborted'?'aborted':'error',error:message});await record?.(message,Date.now()-start,capture);out.end(message);}})();return out;
}
/** OpenAI completed empty turns are retried inside one rate-limited request.
 * Pi's synthetic start event is buffered until real content on this protocol. */
export function profileCall(native:StreamFn,pool:Pool,p:RuntimeProfile,model:Parameters<StreamFn>[0],context:Parameters<StreamFn>[1],options:Parameters<StreamFn>[2],policyOverride?:Record<string,any>,captureOut?:WireCaptureHolder):ReturnType<StreamFn>{
 const out=createAssistantMessageEventStream();
 const capture=new WireCapture();if(captureOut)captureOut.capture=capture;
 capture.setContext(context,{maxTokens:options?.maxTokens,thinkingType:p.thinking_type,reasoningEffort:p.reasoning_effort});
 wireStorage.run(capture,()=>{void(async()=>{
  try{const gateStarted=performance.now();try{await waitProfileRate(pool,p,options?.signal);}finally{capture.performance.addRateWait(performance.now()-gateStarted);}let policy:Record<string,any>=policyOverride??{};if(policyOverride===undefined){const raw=(await pool.query("SELECT value FROM app_settings WHERE key='llm.retry_policy'")).rows[0]?.value;try{policy=JSON.parse(raw??'{}');}catch{}}
   const retries=Math.max(0,p.retry?.empty?.attempts||policy.empty?.attempts||2),interval=p.retry?.empty?.interval_ms||policy.empty?.interval_ms||0;
   for(let attempt=0;;attempt++){
    const stream=await native(model,providerContext(context),profileWireOptions(p,options));let committed=p.format!=='openai',pending:AssistantMessageEvent[]=[];
    for await(const e of stream){
     capture.performance.observe(e);
     const real=e.type==='toolcall_start'||(e.type==='text_delta'||e.type==='thinking_delta'||e.type==='toolcall_delta')&&!!e.delta;
     if(!committed&&!real){pending.push(e);continue;}if(!committed){for(const prior of pending)out.push(prior);pending=[];committed=true;}out.push(e);
    }
    const result=await stream.result();
    if(p.format==='openai'&&!committed&&result.stopReason==='stop'&&!result.content.length&&attempt<retries&&!options?.signal?.aborted){const retryStarted=performance.now();try{await delay(interval||Math.min(500*2**attempt,8000),undefined,{signal:options?.signal});}finally{capture.performance.addRetryWait(performance.now()-retryStarted);}continue;}
    // A synthetic start is not an emitted supplier event on an OpenAI error.
    for(const e of pending)if(result.stopReason!=='error'&&result.stopReason!=='aborted'||e.type==='error')out.push(e);capture.performance.finish();out.end(result);return;
   }
  }catch(e){capture.performance.finish();const error:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:options?.signal?.aborted?'aborted':'error',errorMessage:(e as Error).message??String(e),timestamp:Date.now()};out.push({type:'error',reason:error.stopReason==='aborted'?'aborted':'error',error});out.end(error);}
 })();});return out;
}
