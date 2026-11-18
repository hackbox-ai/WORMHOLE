import {cfgString,validateConfig} from './config.ts';
import {validateWebhookTemplate,renderWebhookRequest} from './template.ts';
import {notificationHTTP} from './http.ts';
import {PermanentNotificationError} from './dispatcher.ts';
import type {NotificationMessage} from './render.ts';
export async function validateWebhook(config:Record<string,unknown>,signal?:AbortSignal):Promise<void>{let template='';validateConfig('webhook',config,s=>{template=s;});if(template)await validateWebhookTemplate(template,signal);}
export async function sendWebhook(config:Record<string,unknown>,message:NotificationMessage,signal:AbortSignal):Promise<number>{
  let body:Buffer|undefined;
  const method=cfgString(config,'method').toUpperCase()||'POST';
  try{let template='';validateConfig('webhook',config,s=>{template=s;});if(method!=='GET')body=Buffer.from(await renderWebhookRequest(template,message,signal));else if(template)await validateWebhookTemplate(template,signal);}catch(e){throw new PermanentNotificationError((e as Error).message);}
  const headers:Record<string,string>={};const supplied=config.headers;if(supplied&&typeof supplied==='object'&&!Array.isArray(supplied))for(const [k,v] of Object.entries(supplied))if(k.trim()&&typeof v==='string')headers[k.trim()]=v;
  const contentType=cfgString(config,'content_type');if(contentType){for(const k of Object.keys(headers))if(k.toLowerCase()==='content-type')delete headers[k];headers['Content-Type']=contentType;}
  await notificationHTTP(method,cfgString(config,'url'),headers,body,signal);return message.items.length;
}
