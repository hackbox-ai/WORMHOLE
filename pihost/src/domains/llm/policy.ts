/** Typed zero defaults and bounded retry rules. */
export const globalLayers=['connect','empty','stream','breaker','intent'] as const;
export const profileLayers=['connect','empty','stream'] as const;
export interface RetryRule{attempts:number;interval_ms:number}
export type RetryPolicy=Record<string,RetryRule>;
export function retryRules(value:unknown,layers:readonly string[]=globalLayers):RetryPolicy{
 const out:RetryPolicy={};const input=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 for(const k of layers){const row=input[k];if(row!=null&&(typeof row!=='object'||Array.isArray(row)))throw new Error('bad json');const source=(row??{}) as Record<string,unknown>;const n=(field:string,min:number,max:number)=>{const v=source[field];if(v==null)return 0;if(!Number.isSafeInteger(v))throw new Error('bad json');return Math.max(min,Math.min(max,v as number));};out[k]={attempts:n('attempts',-1,20),interval_ms:n('interval_ms',0,3600000)};}
 return out;
}
/** Whole policy falls back to zero if persisted JSON cannot decode. */
export function storedRetryRules(value:unknown,layers:readonly string[]=globalLayers):RetryPolicy{
 try{return retryRules(typeof value==='string'?JSON.parse(value):value,layers);}catch{return retryRules({},layers);}
}
