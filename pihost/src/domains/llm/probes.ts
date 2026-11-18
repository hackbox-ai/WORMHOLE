/** Model probes and model listing through public Pi provider adapters. */
import type {Pool} from 'pg';
import type {Api,Model} from '@earendil-works/pi-ai';
import {normalizeContext} from '@earendil-works/pi-ai';
import {randomUUID} from 'node:crypto';
import {profileProvider,type RuntimeProfile} from './profile-runtime.ts';
import {profileCall,fetchWithProfileProxy} from './profile-wire.ts';
import {connectionConfig} from './configuration.ts';
import {globalKey} from './global-state.ts';
export {connectionConfig} from './configuration.ts';
const nativeStream:Parameters<typeof profileCall>[0]=async(model,context,options)=>{
 if(model.api==='openai-completions')return (await import('@earendil-works/pi-ai/api/openai-completions')).streamSimple(model as Model<'openai-completions'>,context,options);
 if(model.api==='openai-responses')return (await import('@earendil-works/pi-ai/api/openai-responses')).streamSimple(model as Model<'openai-responses'>,context,options);
 return (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple(model as Model<'anthropic-messages'>,context,options);
};
export async function testConnection(pool:Pool,body:Record<string,any>,signal?:AbortSignal){
 const cfg=connectionConfig(body);let header=body.session_header_key??'';
 if(body.profile_id!=null&&(!cfg.api_key||!header)){const p=(await pool.query('SELECT api_key,session_header_key FROM llm_profiles WHERE id=$1',[body.profile_id])).rows[0];if(p){if(!cfg.api_key)cfg.api_key=p.api_key??'';if(!header)header=p.session_header_key??'';}}
 if(!cfg.api_key)cfg.api_key=await globalKey(pool);
 if(!cfg.api_key)return {ok:false,error:"API Key not provided"};
 const start=Date.now();try{
  const p={...cfg,id:0,name:'connection-test',thinking_type:body.thinking_type??'',reasoning_effort:body.reasoning_effort??'',streaming:body.streaming??true,max_tokens:8192,max_tokens_field:'',context_window_k:0,session_header_key:header,retry:{},rate_per_second:0,rate_per_minute:0,is_default:false,priority:0,pool_exclude:true} as RuntimeProfile;
  const provider=profileProvider(p),model={...provider.models[0],provider:'conntest',api:provider.api,baseUrl:provider.baseUrl} as Model<Api>;
  const sessionId='conntest-'+randomUUID(),context={systemPrompt:"You are on a connection test. Just output the two characters OK without thinking, explaining, or anything else.",messages:[{role:'user' as const,content:'ping',timestamp:Date.now()}]};
  // No pool, intent/stream retries, profile rate or configured retry ladder in the probe.
  const s=await profileCall(nativeStream,pool,p,model,normalizeContext(context),{apiKey:cfg.api_key,maxTokens:8192,maxRetries:3,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),sessionId,headers:header?{[header]:sessionId}:{}},{});
  const message=await s.result();if(message.stopReason==='error'||message.stopReason==='aborted')return {ok:false,error:message.errorMessage??"Model request failed"};
  const reply=message.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();if(!reply)return {ok:false,error:"The model has no reply content (the request was passed, but no text was returned)"};
  const runes=Array.from(reply);return {ok:true,latency_ms:Date.now()-start,model:cfg.model,reply:runes.length>200?runes.slice(0,200).join('')+'…':reply};
 }catch(e){return {ok:false,error:(e as Error).message};}
}
async function limitedBody(response:Response){const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const parts:Buffer[]=[];let n=0;try{while(n<4*1024*1024){const chunk=await reader.read();if(chunk.done)break;const b=Buffer.from(chunk.value).subarray(0,4*1024*1024-n);parts.push(b);n+=b.length;}}finally{await reader.cancel();}return Buffer.concat(parts);}
export async function listModels(pool:Pool,body:Record<string,any>,signal?:AbortSignal){
 let key=(body.api_key??'').trim();if(!key&&body.profile_id!=null)key=(await pool.query('SELECT api_key FROM llm_profiles WHERE id=$1',[body.profile_id])).rows[0]?.api_key??'';
 if(!key)return {ok:false,error:"API Key not provided"};
 const format=(body.provider??'').trim(),raw=(body.base_url??'').trim().replace(/\/+$/,''),candidates:{url:string;headers:Record<string,string>}[]=[],bearer={authorization:`Bearer ${key}`};
 if(format==='openai'||format==='openai-responses'){let b=raw||'https://api.openai.com/v1';for(const suffix of ['/chat/completions','/responses'])if(b.endsWith(suffix))b=b.slice(0,-suffix.length);candidates.push({url:b.replace(/\/+$/,'')+'/models',headers:bearer});}
 else{let b=raw||'https://api.anthropic.com';if(b.endsWith('/v1/messages'))b=b.slice(0,-12);b=b.replace(/\/+$/,'');candidates.push({url:b+'/v1/models',headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}});if(b.endsWith('/anthropic')){const root=b.slice(0,-10).replace(/\/+$/,'');candidates.push({url:root+'/models',headers:bearer},{url:root+'/v1/models',headers:bearer});}}
 let error='',empty=false;const proxy=(body.proxy??'').trim(),transport=proxy?fetchWithProfileProxy(proxy):fetch;
 for(const c of candidates){try{const r=await transport(c.url,{headers:c.headers,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)}),b=await limitedBody(r);
  if(r.status!==200){error=`API return ${r.status}: ${b.subarray(0,512).toString()}`;continue;}
  let parsed:any;try{parsed=JSON.parse(b.toString());if(parsed!=null&&(typeof parsed!=='object'||Array.isArray(parsed))||parsed?.data!=null&&!Array.isArray(parsed.data))throw new Error('invalid data');if(parsed?.data?.some((d:any)=>d!=null&&(typeof d!=='object'||Array.isArray(d)||d.id!=null&&typeof d.id!=='string')))throw new Error('invalid model id');}catch(e){error="Failed to parse response: "+(e as Error).message;continue;}
  const models=(parsed?.data??[]).map((m:any)=>m?.id??'').filter((s:string)=>s!=='');if(models.length)return {ok:true,models};empty=true;
 }catch(e){error="Request failed: "+(e as Error).message;}}
 return empty?{ok:true,models:[]}:{ok:false,error:error||"Model list not obtained"};
}
