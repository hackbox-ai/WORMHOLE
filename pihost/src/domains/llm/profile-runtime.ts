/** Profile snapshots compiled using Pi's public ModelRuntime API. */
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {Api,Model} from '@earendil-works/pi-ai';
import type {Pool} from 'pg';
import type {PihostConfig} from '../../config.ts';
import {TaskLLMChains} from './task-chain.ts';
import {normalizeRuntimeProfile} from './configuration.ts';
import {appliedGlobalProfile} from './global-state.ts';
export interface RuntimeProfile {id:number;name:string;format:string;model:string;api_key:string;base_url:string;proxy:string;context_window_k:number;max_tokens:number;max_tokens_field:string;thinking_type:string;reasoning_effort:string;streaming:boolean;session_header_key:string;retry:Record<string,any>;is_default:boolean;priority:number;pool_exclude:boolean;rate_per_second:number;rate_per_minute:number}
const profileRow=(p:RuntimeProfile|undefined)=>p?normalizeRuntimeProfile(p):undefined;
export const contextWindow=(k:number)=>Math.max(32,Math.min(1000,k>0?k:200))*1000;
export function profileProvider(p:RuntimeProfile){
 p=normalizeRuntimeProfile(p);
 const api:Api=p.format==='openai-responses'?'openai-responses':p.format.startsWith('openai')?'openai-completions':'anthropic-messages';
 return {baseUrl:p.base_url||(api.startsWith('openai')?process.env.OPENAI_BASE_URL||'https://api.openai.com/v1':process.env.ANTHROPIC_BASE_URL||'https://api.anthropic.com'),api,apiKey:p.api_key,models:[{id:p.model,name:p.name,reasoning:!!p.thinking_type||!!p.reasoning_effort,input:['text','image'] as ('text'|'image')[],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:contextWindow(Number(p.context_window_k)),maxTokens:Math.max(0,Number(p.max_tokens))||16384}]};
}
export function validProfile(p:RuntimeProfile|undefined):p is RuntimeProfile {
 if(!p||!['anthropic','openai','openai-responses'].includes(p.format))return false;p=normalizeRuntimeProfile(p);if(!p.api_key)return false;
 try{if(p.base_url&&!['http:','https:'].includes(new URL(p.base_url).protocol))return false;if(p.proxy&&!['http:','https:','socks5:'].includes(new URL(p.proxy).protocol))return false;}catch{return false;}
 return true;
}
export interface TaskModelSelection {model:Model<Api>;profile?:RuntimeProfile;source:string;revision:number;chainProfile:number}
export class TaskModelResolver {
 readonly chains:TaskLLMChains;
 constructor(readonly pool:Pool,readonly config:PihostConfig,readonly runtime:ModelRuntime,readonly taskId:number,readonly role:string){this.chains=new TaskLLMChains(pool);}
 async compile(p:RuntimeProfile){p=normalizeRuntimeProfile(p);const pid=`profile-${p.id}`;this.runtime.registerProvider(pid,profileProvider(p));await this.runtime.setRuntimeApiKey(pid,p.api_key);const model=this.runtime.getModel(pid,p.model);if(!model)throw new Error(`LLM profile #${p.id} is missing or invalid`);return model;}
 async current():Promise<TaskModelSelection>{
  const state=await this.chains.state(this.taskId),get=async(id:unknown)=>id?profileRow((await this.pool.query('SELECT * FROM llm_profiles WHERE id=$1',[id])).rows[0]):undefined;
  const agent=(await this.pool.query('SELECT llm_profile_id FROM agents WHERE key=$1',[this.role])).rows[0];const bound=await get(agent?.llm_profile_id);
  if(validProfile(bound))return {model:await this.compile(bound),profile:bound,source:'agent_binding',revision:state.llm_chain_revision,chainProfile:0};
  if(state.entries.length){
   if(!state.active_llm_profile_id)throw new Error(`task ${this.taskId} LLM profile chain exhausted: all selected profiles are quota exhausted`);
   const p=await get(state.active_llm_profile_id);if(!validProfile(p))throw new Error(`LLM profile #${state.active_llm_profile_id} is missing or invalid`);
   const model=await this.compile(p);return {model,profile:p,source:'task_chain',revision:state.llm_chain_revision,chainProfile:state.active_llm_profile_id};
  }
  const global=appliedGlobalProfile(this.pool)??profileRow((await this.pool.query('SELECT * FROM llm_profiles WHERE is_default=TRUE ORDER BY id LIMIT 1')).rows[0]);
  if(validProfile(global))return {model:await this.compile(global),profile:global,source:'global_profile',revision:state.llm_chain_revision,chainProfile:0};
  const model=this.runtime.getModel(this.config.pi.provider,this.config.pi.modelId);if(!model)throw new Error(`task ${this.taskId} has no available fallback LLM provider`);
  return {model,source:'environment',revision:state.llm_chain_revision,chainProfile:0};
 }
 async resolution(){
  // Resolve without constructing a provider. SQL errors must reach the API's
  // 500 handler, rather than being presented as ordinary unavailable models.
  const state=await this.chains.state(this.taskId);
  const get=async(id:unknown)=>id?profileRow((await this.pool.query('SELECT * FROM llm_profiles WHERE id=$1',[id])).rows[0]):undefined;
  const from=(p:RuntimeProfile|undefined,source:string)=>({
   ...(p?{profile_id:Number(p.id)}:{}),name:p?.name??'',format:p?.format??'',model:p?.model??'',source,
   available:validProfile(p),...(!p?{reason:"LLM configuration does not exist"}:!p.api_key?{reason:"LLM configuration does not set API Key"}:!validProfile(p)?{reason:"LLM configuration format or parameters are invalid"}:{}),
  });
  const agent=(await this.pool.query('SELECT llm_profile_id FROM agents WHERE key=$1',[this.role])).rows[0],bound=await get(agent?.llm_profile_id);
  if(validProfile(bound))return from(bound,'agent_binding');
  if(state.entries.length){if(!state.active_llm_profile_id)return {...from(undefined,'task_chain'),reason:"Task LLM configuration chain quota has been exhausted"};return from(await get(state.active_llm_profile_id),'task_chain');}
  const global=appliedGlobalProfile(this.pool)??profileRow((await this.pool.query('SELECT * FROM llm_profiles WHERE is_default=TRUE ORDER BY id LIMIT 1')).rows[0]);
  if(validProfile(global))return from(global,'global_profile');
  const model=this.runtime.getModel(this.config.pi.provider,this.config.pi.modelId);
  if(model)return {name:"Global configuration",format:model.api==='anthropic-messages'?'anthropic':model.api==='openai-responses'?'openai-responses':'openai',model:model.id,source:'environment',available:true};
  return {...from(undefined,'global'),reason:"No LLM configuration available"};
 }
}
