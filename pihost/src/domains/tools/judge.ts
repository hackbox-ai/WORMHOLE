/** Tool review inputs are evaluated through an isolated Pi session. */
import type {Pool} from 'pg';
import type {PihostConfig} from '../../config.ts';
import type {ToolContext} from './gate.ts';
import {randomUUID} from 'node:crypto';
import {createHostedSession,type HostedSession} from '../../pi/session-host.ts';
import {DEFAULT_JUDGE_PROMPT,effectiveJudgePrompt,parseVerdict} from './judge-prompt.ts';
export interface JudgeConfig {enabled:boolean;profile_id:number;prompt:string;timeout_seconds:number;fail_action:'allow'|'deny'|'ask';ask_timeout_seconds:number;ask_timeout_action:'deny'|'allow'}
export const DEFAULT_JUDGE_CONFIG:JudgeConfig={enabled:false,profile_id:0,prompt:'',timeout_seconds:15,fail_action:'allow',ask_timeout_seconds:300,ask_timeout_action:'deny'};
export const JUDGE_SETTING_KEYS:Record<keyof JudgeConfig,string>={enabled:'llm_judge_enabled',profile_id:'llm_judge_profile_id',prompt:'llm_judge_prompt',timeout_seconds:'llm_judge_timeout_seconds',fail_action:'llm_judge_fail_action',ask_timeout_seconds:'llm_judge_ask_timeout_seconds',ask_timeout_action:'llm_judge_ask_timeout_action'};
export async function judgeConfig(pool:Pool):Promise<JudgeConfig>{
 const r=await pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'");let raw:Partial<JudgeConfig>={};try{raw=JSON.parse(String(r.rows[0]?.value??'{}'));}catch{}
 const cfg={...DEFAULT_JUDGE_CONFIG,...raw};
 const settings=(await pool.query('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])',[Object.values(JUDGE_SETTING_KEYS)])).rows;
 for(const row of settings){const field=Object.keys(JUDGE_SETTING_KEYS).find(k=>JUDGE_SETTING_KEYS[k as keyof JudgeConfig]===row.key) as keyof JudgeConfig;const value=String(row.value);
  if(field==='enabled')cfg.enabled=['1','t','T','TRUE','true','True'].includes(value);
  else if(['profile_id','timeout_seconds','ask_timeout_seconds'].includes(field)){if(/^[+-]?\d+$/.test(value)&&Number.isSafeInteger(Number(value)))(cfg as any)[field]=Number(value);}
  else (cfg as any)[field]=value;
 }
 if(!cfg.prompt.trim())cfg.prompt=DEFAULT_JUDGE_PROMPT;
 if(!['allow','ask','deny'].includes(cfg.fail_action))cfg.fail_action=DEFAULT_JUDGE_CONFIG.fail_action;
 if(!['allow','deny'].includes(cfg.ask_timeout_action))cfg.ask_timeout_action=DEFAULT_JUDGE_CONFIG.ask_timeout_action;
 if(!(Number(cfg.timeout_seconds)>0))cfg.timeout_seconds=15;
 if(!(Number(cfg.ask_timeout_seconds)>0))cfg.ask_timeout_seconds=300;
 return cfg;
}
export interface JudgeOutcome {action:'allow'|'deny'|'ask';comment:string;modelFallback:boolean;timeoutSeconds?:number;timeoutAction?:'allow'|'deny';modelInput?:unknown;profileId?:number}
export function buildReviewInput(tool:string,params:Record<string,unknown>,context?:Pick<ToolContext,'cwd'|'reviewBackground'>){
 const raw=JSON.stringify(params);if(!raw)throw new Error("Tool parameter is not valid JSON");
 const input:any={version:4};if(context?.cwd)input.working_directory=context.cwd;
 const background=context?.reviewBackground;
 if(background?.source==='user_message'&&background.text.trim()){
  const bytes=Buffer.from(background.text);let end=Math.min(bytes.length,4000);while(end<bytes.length&&end>0&&(bytes[end]!&0xc0)===0x80)end--;
  input.background={source:'user_message',text:bytes.subarray(0,end).toString(),...(background.truncated||end<bytes.length?{truncated:true}:{})};
 }
 input.tool_name=tool;input.arguments=JSON.parse(raw);return input;
}
export async function runJudge(opts:{pool:Pool;config:PihostConfig;tool:string;params:Record<string,unknown>;context?:ToolContext}):Promise<JudgeOutcome|null>{
 const cfg=await judgeConfig(opts.pool);if(!cfg.enabled)return null;
 let reviewInput:unknown;
 const finish=(action:JudgeOutcome['action'],comment:string,modelFallback:boolean):JudgeOutcome=>({action,comment:comment.startsWith("[Model]")?comment:"[Model] "+(comment||({allow:"Release",ask:"Transfer to manual approval",deny:"Interception"}[action])),modelFallback,modelInput:reviewInput,profileId:cfg.profile_id,...(action==='ask'?{timeoutSeconds:cfg.ask_timeout_seconds,timeoutAction:cfg.ask_timeout_action}:{})});
 let input:string;try{reviewInput=buildReviewInput(opts.tool,opts.params,opts.context);input=JSON.stringify(reviewInput);}catch(error){return finish('ask',"The review context is incomplete and requires manual confirmation:"+(error as Error).message,true);}
 let host:HostedSession|undefined,timer:ReturnType<typeof setTimeout>|undefined,aborted=false;
 let rejectAbort!:(error:Error)=>void;const interruption=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
 const abort=()=>{aborted=true;void host?.session.abort().catch(()=>{});rejectAbort(new Error(opts.context?.signal?.aborted?'judge canceled':'judge timeout'));};
 opts.context?.signal?.addEventListener('abort',abort,{once:true});
 const work=(async()=>{
  host=await createHostedSession(opts.pool,opts.config,{kind:'judge',businessId:'judge-'+randomUUID(),systemPrompt:effectiveJudgePrompt(cfg.prompt.trim()?cfg.prompt:DEFAULT_JUDGE_PROMPT),provider:cfg.profile_id?`profile-${cfg.profile_id}`:undefined,profileBinding:!!cfg.profile_id,freshContext:true,...(opts.context?.taskId?{activity:{taskId:opts.context.taskId,worker:'judge'}}:{})});
  if(aborted||opts.context?.signal?.aborted)throw new Error('judge canceled');
  await host.session.prompt(input);await host.flushEvents();if(host.modelFailure)throw new Error(host.modelFailure);
  const last=host.session.messages.filter(m=>m.role==='assistant').at(-1);
  return (last?.content??[]).filter(b=>b.type==='text').map(b=>'text' in b?b.text:'').join('');
 })();
 try{
  timer=setTimeout(abort,Number(cfg.timeout_seconds)*1000);if(opts.context?.signal?.aborted)abort();
  const text=await Promise.race([work,interruption]),verdict=parseVerdict(text);
  return verdict.action?finish(verdict.action,verdict.reason,false):finish(cfg.fail_action,"The model output cannot be parsed and will be processed according to the failure strategy.",true);
 }catch(error){return finish(cfg.fail_action,"Model approval failed, handle according to failure policy: "+(error as Error).message,true);}
 finally{if(timer)clearTimeout(timer);opts.context?.signal?.removeEventListener('abort',abort);if(aborted)await host?.session.abort().catch(()=>{});await work.catch(()=>{});await host?.dispose().catch(()=>{});}
}
