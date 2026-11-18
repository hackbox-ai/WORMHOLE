/** Server-owned applied global config; invalid hot edits retain the last provider. */
import type {Pool} from 'pg';
import type {RuntimeProfile} from './profile-runtime.ts';
import {normalizeRuntimeProfile} from './configuration.ts';
const snapshots=new WeakMap<Pool,RuntimeProfile|undefined>();
export function validateModelProxy(proxy:string){
 if(!proxy)return;const scheme=/^([A-Za-z][A-Za-z0-9+.-]*):/.exec(proxy)?.[1];
 if(!scheme)throw new Error(`llm: proxy "${proxy}" missing scheme (use http://, https:// or socks5://)`);
 if(!['http','https','socks5'].includes(scheme))throw new Error(`llm: unsupported proxy scheme "${scheme}" (use http, https or socks5)`);
 try{new URL(proxy);}catch{throw new Error(`llm: invalid proxy "${proxy}": invalid URL`);}
}
function environment():RuntimeProfile|undefined{
 let format=process.env.WORMHOLE_LLM_PROVIDER??'';if(!format)format=process.env.ANTHROPIC_API_KEY?'anthropic':process.env.OPENAI_API_KEY?'openai':'';if(!format)return;
 const api_key=format==='openai'||format==='openai-responses'?process.env.OPENAI_API_KEY:process.env.ANTHROPIC_API_KEY;if(!api_key)return;
 return {id:0,name:'',format:['openai','openai-responses'].includes(format)?format:'anthropic',api_key,model:process.env.WORMHOLE_LLM_MODEL||(format==='openai'?'gpt-4o':format==='openai-responses'?'gpt-5':'claude-opus-4-8'),base_url:process.env.WORMHOLE_LLM_BASE_URL??'',proxy:(process.env.WORMHOLE_LLM_PROXY??'').trim(),context_window_k:0,max_tokens:0,max_tokens_field:'',thinking_type:'',reasoning_effort:'',session_header_key:'',streaming:!['0','false','off','no'].includes((process.env.WORMHOLE_LLM_STREAM??'').toLowerCase()),retry:{},rate_per_second:0,rate_per_minute:0,is_default:true,priority:0,pool_exclude:false};
}
export async function refreshGlobalState(pool:Pool,explicit?:RuntimeProfile){
 const initial=!snapshots.has(pool),raw=explicit??(await pool.query('SELECT * FROM llm_profiles WHERE is_default ORDER BY id LIMIT 1')).rows[0];
 let p:RuntimeProfile|undefined=raw?normalizeRuntimeProfile(raw):undefined;
 if(!p?.api_key){if(!initial)return;p=environment();}
 if(p)try{validateModelProxy(p.proxy);}catch{p=undefined;}
 if(p||initial)snapshots.set(pool,p);
}
/** Undefined means callers may retain their existing environment/SDK fallback. */
export function appliedGlobalProfile(pool:Pool){const p=snapshots.get(pool);return p&&p.id>0?{...p,retry:{...p.retry}}:undefined;}
export async function globalPayload(pool:Pool){if(!snapshots.has(pool))await refreshGlobalState(pool);const p=snapshots.get(pool);return {configured:!!p,provider:p?.format??'anthropic',model:p?.model??'',base_url:p?.base_url??'',proxy:p?.proxy??'',key_set:!!p?.api_key,rate_per_second:Number(p?.rate_per_second??0),rate_per_minute:Number(p?.rate_per_minute??0),context_window_k:Number(p?.context_window_k??0),thinking_type:p?.thinking_type??'',reasoning_effort:p?.reasoning_effort??''};}
export async function globalKey(pool:Pool){if(!snapshots.has(pool))await refreshGlobalState(pool);return snapshots.get(pool)?.api_key??'';}
