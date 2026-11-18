import {BlockList,isIP} from 'node:net';
export type ChannelKind='dingtalk'|'email'|'feishu'|'telegram'|'webhook'|'wecom';
export const CHANNELS:Record<ChannelKind,{default_rate_per_min:number;secret_keys:string[];destination_keys:string[]}>= {
  dingtalk:{default_rate_per_min:20,secret_keys:['webhook','secret'],destination_keys:['webhook']},
  email:{default_rate_per_min:60,secret_keys:['password'],destination_keys:['host','port','tls']},
  feishu:{default_rate_per_min:100,secret_keys:['webhook','secret'],destination_keys:['webhook']},
  telegram:{default_rate_per_min:20,secret_keys:['bot_token'],destination_keys:['base_url']},
  webhook:{default_rate_per_min:0,secret_keys:['url','headers'],destination_keys:['url']},
  wecom:{default_rate_per_min:20,secret_keys:['webhook'],destination_keys:['webhook']},
};
export const kinds=Object.keys(CHANNELS) as ChannelKind[];
export const validKind=(v:unknown):v is ChannelKind=>typeof v==='string'&&Object.hasOwn(CHANNELS,v);
export const cfgString=(c:Record<string,unknown>,k:string)=>typeof c[k]==='string'?(c[k] as string).trim():'';
export const cfgInt=(c:Record<string,unknown>,k:string)=>typeof c[k]==='number'?Math.trunc(c[k]):typeof c[k]==='string'&&/^[+-]?\d+$/.test((c[k] as string).trim())?Number((c[k] as string).trim()):0;
export const cfgBool=(c:Record<string,unknown>,k:string)=>typeof c[k]==='boolean'?c[k]:typeof c[k]==='string'?['true','1','yes'].includes((c[k] as string).trim().toLowerCase()):false;
export const cfgStrings=(c:Record<string,unknown>,k:string)=>Array.isArray(c[k])?(c[k] as unknown[]).filter((x):x is string=>typeof x==='string').map(x=>x.trim()).filter(Boolean):cfgString(c,k)?[cfgString(c,k)]:[];
export const MASKED_PREFIX='__masked__';
export const isMasked=(v:unknown):v is string=>typeof v==='string'&&v.startsWith(MASKED_PREFIX);
export function maskValue(s:string):string{const b=Buffer.from(s);return b.length<=6?MASKED_PREFIX:MASKED_PREFIX+':…'+b.subarray(b.length-6).toString();}
export function maskConfig(kind:string,c:Record<string,unknown>):Record<string,unknown>{if(!validKind(kind))return {};return Object.fromEntries(Object.entries(c).map(([k,v])=>[k,CHANNELS[kind].secret_keys.includes(k)?typeof v==='string'?maskValue(v):MASKED_PREFIX:v]));}
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const blank=(v:unknown)=>v==null||typeof v==='string'&&!v.trim();
export function mergeConfig(stored:Record<string,unknown>,incoming:Record<string,unknown>):Record<string,unknown>{const out={...stored};for(const [k,v] of Object.entries(incoming)){if(isMasked(v))continue;if(typeof v==='string'&&!v.trim())delete out[k];else out[k]=v;}return out;}
export function prepareConfigUpdate(kind:string,stored:Record<string,unknown>,incoming:Record<string,unknown>):Record<string,unknown>{
  if(!validKind(kind))throw new Error(`Channel type ${JSON.stringify(kind)} Not registered`);
  const {secret_keys,destination_keys}=CHANNELS[kind];
  for(const key of secret_keys){const v=incoming[key];if(typeof v!=='string'&&JSON.stringify(v)?.includes(MASKED_PREFIX))throw new Error(`field ${key} contains mask tag "${MASKED_PREFIX}": This field can only be left blank to indicate inheritance or a new value is submitted as a whole. Mask placeholders cannot be included inside the structure.`);}
  const changed=destination_keys.filter(k=>Object.hasOwn(incoming,k)&&!isMasked(incoming[k])&&!(blank(incoming[k])&&blank(stored[k]))&&canonical(incoming[k])!==canonical(stored[k]));
  if(changed.length){const missing=secret_keys.filter(k=>!Object.hasOwn(incoming,k)||isMasked(incoming[k]));if(missing.length)throw new Error(`Destination Address (${changed.join('、')}) has changed, please also refill the credential fields (${missing.join('、')}): Fill in a new value, or explicitly leave it blank to indicate that the credentials are no longer required. The original certificate is only valid for the old address, and continuing to use it is equivalent to handing it over to the new address.`);}
  return mergeConfig(stored,incoming);
}
const blocked=new BlockList();blocked.addSubnet('127.0.0.0',8,'ipv4');blocked.addSubnet('169.254.0.0',16,'ipv4');blocked.addSubnet('224.0.0.0',4,'ipv4');blocked.addAddress('0.0.0.0','ipv4');blocked.addAddress('::','ipv6');blocked.addAddress('::1','ipv6');blocked.addSubnet('fe80::',10,'ipv6');blocked.addSubnet('ff00::',8,'ipv6');
// WORMHOLE is the public configuration name; retain the old name only for existing deployments.
export const allowLocalTargets=()=>['1','true'].includes((process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL??'').trim().toLowerCase());
export function checkDialAddress(address:string):void{const type=isIP(address);if(!type||!allowLocalTargets()&&blocked.check(address,type===4?'ipv4':'ipv6'))throw new Error(`Rejection of delivery to this machine or link-local address:${address}`);}
export function validateHTTPURL(raw:string):void{
  const scheme=/^([a-zA-Z][\w+.-]*):/.exec(raw)?.[1]??'';
  if(scheme!=='http'&&scheme!=='https')throw new Error(`Only supports http/https, received ${JSON.stringify(scheme)}`);
  let u:URL;try{u=new URL(raw);}catch{if(/^https?:\/\/$/.test(raw)||/^https?:[^/]/.test(raw))throw new Error("Hostname missing");throw new Error("Address cannot be resolved ((Address cannot be resolved))");}
  if(!u.host)throw new Error("Hostname missing");const host=u.hostname.replace(/^\[|\]$/g,'');if(isIP(host))checkDialAddress(host);
}
/** Transport-independent channel configuration, matching notify/*.Validate.
 * Webhook template parsing is supplied by the actual template engine. */
export function validateConfig(kind:ChannelKind,c:Record<string,unknown>,parseTemplate?:(s:string)=>void):void{
  if(['dingtalk','feishu','wecom'].includes(kind)){const h=cfgString(c,'webhook');if(!h)throw new Error("Missing webhook address");try{validateHTTPURL(h);}catch(e){throw new Error("Invalid webhook address: "+(e as Error).message);}return;}
  if(kind==='telegram'){if(!cfgString(c,'bot_token'))throw new Error("Missing Bot Token");if(!cfgString(c,'chat_id'))throw new Error("Missing Chat ID");const base=cfgString(c,'base_url');if(base)try{validateHTTPURL(base);}catch(e){throw new Error("Invalid API address: "+(e as Error).message);}return;}
  if(kind==='email'){if(!cfgString(c,'host'))throw new Error("Missing SMTP server address");const port=cfgInt(c,'port');if(port<=0||port>65535)throw new Error("Invalid SMTP port (should be 1-65535)");if(!cfgString(c,'from'))throw new Error("Sender address missing");if(!cfgStrings(c,'to').length)throw new Error("At least one recipient address is required");return;}
  const url=cfgString(c,'url');if(!url)throw new Error("Destination URL missing");try{validateHTTPURL(url);}catch(e){throw new Error("Invalid target URL: "+(e as Error).message);}
  const method=cfgString(c,'method').toUpperCase();if(method&&!['GET','POST','PUT','PATCH'].includes(method))throw new Error(`Unsupported method ${method}(GET/POST/PUT/PATCH available)`);
  const template=cfgString(c,'body_template');if(template){if(!parseTemplate)throw new Error("The request body template engine has not been connected yet");parseTemplate(template);}
}
