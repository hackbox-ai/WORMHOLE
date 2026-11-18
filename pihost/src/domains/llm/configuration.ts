/** Normalize runtime configuration only; retain the saved profile form. */
export function connectionConfig(body:Record<string,any>){
 const format=body.provider?.trim()==='openai'?'openai':body.provider?.trim()==='openai-responses'?'openai-responses':'anthropic';
 let base=(body.base_url??'').trim().replace(/\/+$/,'');const suffix=format==='openai'?'/chat/completions':format==='openai-responses'?'/responses':'/v1/messages';if(base.endsWith(suffix))base=base.slice(0,-suffix.length).replace(/\/+$/,'');
 return {format,model:(body.model??'').trim()||(format==='openai'?'gpt-4o':format==='openai-responses'?'gpt-5':'claude-opus-4-8'),base_url:base,api_key:(body.api_key??'').trim(),proxy:(body.proxy??'').trim()};
}
export function normalizeRuntimeProfile<T extends {id:number;format:string;model:string;base_url:string;api_key:string;proxy:string;session_header_key?:string}>(p:T):T{
 return {...p,...connectionConfig({...p,provider:p.format}),id:Number(p.id),...(p.session_header_key!==undefined?{session_header_key:p.session_header_key.trim()}: {})};
}
