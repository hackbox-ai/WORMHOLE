/** Profile pool routing around Pi's public provider stream. */
import type {AgentSession,ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {AssistantMessage,Context,AssistantMessageEvent} from '@earendil-works/pi-ai';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import type {Pool} from 'pg';
import {healthRegistry,type HealthRegistry} from './health.ts';
import {profileProvider,validProfile,contextWindow,type RuntimeProfile} from './profile-runtime.ts';
import {canonicalProviderError} from './task-stream.ts';
import {truncateBytes} from './task-chain.ts';
import {profileCall} from './profile-wire.ts';
import {normalizeRuntimeProfile} from './configuration.ts';
import {contextView} from '../../pi/transcript.ts';
type StreamFn=AgentSession['agent']['streamFunction'];
export type ProfileAttemptRecorder=(profile:RuntimeProfile,message:AssistantMessage,context:Context,latencyMs:number,capture?:import('./profile-wire.ts').WireCapture)=>Promise<void>;
export const poolStatusCode=(message:string)=>Number(/status (\d{3})/.exec(canonicalProviderError(message))?.[1]??0);
export function poolShouldFailover(message:string,signal?:AbortSignal){if(signal?.aborted||/\b(?:context canceled|context deadline exceeded)\b/.test(message))return false;const s=poolStatusCode(message);return s===0||[401,402,403,404,408,429].includes(s)||s>=500;}
export const poolHardFailure=(message:string)=>[401,402,403,404].includes(poolStatusCode(message));
export const trimPoolError=(message:string)=>{const flat=message.replace(/\n/g,' ').trim();return Buffer.byteLength(flat)>300?truncateBytes(flat,300)+'…':flat;};
const bytes=(s:unknown)=>Buffer.byteLength(typeof s==='string'?s:'');
function blocksLength(value:unknown):number{
 if(typeof value==='string')return bytes(value);if(!Array.isArray(value))return 0;
 return value.reduce((n,c)=>n+bytes(c.text)+bytes(c.thinking)+bytes(c.name)+(c.type==='toolCall'?Buffer.byteLength(JSON.stringify(c.arguments??{})):bytes(c.input))+blocksLength(c.content),0);
}
export function estimatePoolTokens(input:Context){const context=contextView(input);let n=bytes(context.systemPrompt);for(const m of context.messages)n+=blocksLength(m.content);for(const t of context.tools??[])n+=bytes(t.name)+bytes(t.description)+Object.keys(t.parameters??{}).length*120;return Math.floor(n*2/7);}
export interface PoolMember {profile:RuntimeProfile;rank:number}
export function orderPoolMembers(members:PoolMember[],health:HealthRegistry,tokens:number,rotation:number){
 const eligible=members.filter(m=>!health.open(m.profile.id)&&tokens<=contextWindow(Number(m.profile.context_window_k)));if(!eligible.length)return members.slice(0,1);
 const out:PoolMember[]=[];for(let i=0;i<eligible.length;){let j=i+1;while(j<eligible.length&&eligible[j]!.rank===eligible[i]!.rank)j++;const group=eligible.slice(i,j),offset=rotation%group.length;out.push(...group.slice(offset),...group.slice(0,offset));i=j;}return out;
}
const rotations=new WeakMap<Pool,Map<string,number>>();
function nextRotation(pool:Pool,members:PoolMember[]){let values=rotations.get(pool);if(!values){values=new Map();rotations.set(pool,values);}const key=members.map(m=>`${m.profile.id}:${m.rank}`).join(','),n=values.get(key)??0;values.set(key,n+1);return n;}
export async function compileRuntimeProfile(runtime:ModelRuntime,p:RuntimeProfile){p=normalizeRuntimeProfile(p);const provider=`profile-${p.id}`;runtime.registerProvider(provider,profileProvider(p));await runtime.setRuntimeApiKey(provider,p.api_key);const model=runtime.getModel(provider,p.model);if(!model)throw new Error(`LLM profile #${p.id} is missing or invalid`);return model;}
export async function poolMembers(pool:Pool,head:RuntimeProfile,binding:boolean){
 const settings=(await pool.query("SELECT key,value FROM app_settings WHERE key IN ('settings.llm_pool_enabled','settings.llm_pool_bind_fallback')")).rows,enabled=settings.find(r=>r.key==='settings.llm_pool_enabled')?.value==='true',fallback=settings.find(r=>r.key==='settings.llm_pool_bind_fallback')?.value==='true';
 if(!enabled||binding&&!fallback)return [];
 const profiles=(await pool.query('SELECT * FROM llm_profiles WHERE pool_exclude=FALSE ORDER BY is_default DESC,priority DESC,id')).rows.map(p=>normalizeRuntimeProfile(p));
 const members:PoolMember[]=[{profile:head,rank:Number.MAX_SAFE_INTEGER}];for(const p of profiles)if(p.id!==head.id&&validProfile(p))members.push({profile:p,rank:p.is_default?Number.MAX_SAFE_INTEGER-1:Number(p.priority)});
 return members.length>=2?members:[];
}
/** Each request keeps immutable profile/key snapshots. Global health is shared;
 * a task's explicit quota chain deliberately bypasses this separate pool. */
export function profileStream(native:StreamFn,pool:Pool,runtime:ModelRuntime,head:()=>Promise<{profile?:RuntimeProfile;binding:boolean;allowPool:boolean}>,record?:ProfileAttemptRecorder):StreamFn{
 return (initial,context,options)=>{const out=createAssistantMessageEventStream();void(async()=>{
  let model=initial,last:AssistantMessage|undefined;
  try{
   const selected=await head(),p=selected.profile?normalizeRuntimeProfile(selected.profile):undefined;if(!p){const stream=await native(model,context,options);for await(const e of stream)out.push(e);out.end(await stream.result());return;}
   const members=selected.allowPool?await poolMembers(pool,p,selected.binding):[],health=members.length?await healthRegistry(pool):undefined;
   const policyRow=(await pool.query("SELECT value FROM app_settings WHERE key='llm.retry_policy'")).rows[0];let policy:Record<string,any>={};try{policy=JSON.parse(policyRow?.value??'{}');}catch{}
   health?.setPolicy(Number(policy.breaker?.attempts)||0,Number(policy.breaker?.interval_ms)||0);
   const order=health?orderPoolMembers(members,health,estimatePoolTokens(context),nextRotation(pool,members)):[{profile:p,rank:0}];
   for(const member of order){const profile=member.profile;model=await compileRuntimeProfile(runtime,profile);const start=Date.now();let emitted=false,error:AssistantMessage|undefined;const wire:import('./profile-wire.ts').WireCaptureHolder={};
    const retries=Math.max(0,profile.retry?.connect?.attempts||policy.connect?.attempts||3);
    const stream=await profileCall(native,pool,profile,model,context,{...options,apiKey:profile.api_key,maxTokens:profile.max_tokens||options?.maxTokens,maxRetries:options?.maxRetries===0?0:retries,
     headers:{...options?.headers,...(profile.session_header_key?{[profile.session_header_key]:options?.sessionId??''}:{})}},undefined,wire);
    const terminal:AssistantMessageEvent[]=[];
    for await(const e of stream){if(e.type==='error'){error=e.error;break;}emitted=true;if(e.type==='done')terminal.push(e);else out.push(e);}
    last=error??await stream.result();await record?.(profile,last,context,Date.now()-start,wire.capture);
    if(!error){health?.pass(profile.id);for(const e of terminal)out.push(e);out.end(last);return;}
    const eligible=health&&!emitted&&poolShouldFailover(error.errorMessage??'',options?.signal);
    if(!eligible){if(!emitted)health?.pass(profile.id);out.push({type:'error',reason:error.stopReason==='aborted'?'aborted':'error',error});out.end(error);return;}
    health!.trip(profile.id,trimPoolError(error.errorMessage??''),poolHardFailure(error.errorMessage??''));
   }
   last={...last!,errorMessage:"LLM Polling: All configurations are unavailable:"+(last?.errorMessage??"LLM Polling: All configurations are unavailable")};out.push({type:'error',reason:'error',error:last});out.end(last);
  }catch(e){const error:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:options?.signal?.aborted?'aborted':'error',errorMessage:(e as Error).message??String(e),timestamp:Date.now()};out.push({type:'error',reason:error.stopReason==='aborted'?'aborted':'error',error});out.end(error);}
 })();return out;};
}
