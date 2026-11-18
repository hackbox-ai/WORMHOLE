import {createHmac} from 'node:crypto';
import {cfgString,validateConfig} from './config.ts';
import {notificationHTTP} from './http.ts';
import {PermanentNotificationError} from './dispatcher.ts';
import {markdownBody,messageTitle,feishuCard,telegramHTML,oneLine,type NotificationMessage} from './render.ts';
export function dingTalkSignedURL(hook:string,secret:string,time=Date.now()):string{if(!secret)return hook;const ts=String(time),u=new URL(hook);u.searchParams.set('timestamp',ts);u.searchParams.set('sign',createHmac('sha256',secret).update(ts+'\n'+secret).digest('base64'));return u.toString();}
export function feishuSign(timestamp:string,secret:string):string{return createHmac('sha256',timestamp+'\n'+secret).digest('base64');}
export function imPayload(kind:'dingtalk'|'feishu'|'wecom'|'telegram',config:Record<string,unknown>,m:NotificationMessage,now=Date.now()):{url:string;payload:unknown;kept:number}{
  if(kind==='dingtalk'){const {text,kept}=markdownBody(m,20000),title=messageTitle(m);return {url:dingTalkSignedURL(cfgString(config,'webhook'),cfgString(config,'secret'),now),kept,payload:!m.batch&&m.items.length===1&&m.items[0]!.detail_url?{msgtype:'actionCard',actionCard:{title,text,btnOrientation:'0',singleTitle:"View details",singleURL:m.items[0]!.detail_url}}:{msgtype:'markdown',markdown:{title,text}}};}
  if(kind==='wecom'){const {text,kept}=markdownBody(m,4096);return {url:cfgString(config,'webhook'),kept,payload:{msgtype:'markdown',markdown:{content:text}}};}
  if(kind==='feishu'){const {card,kept}=feishuCard(m),payload:Record<string,unknown>={msg_type:'interactive',card};const secret=cfgString(config,'secret');if(secret){const ts=String(Math.floor(now/1000));payload.timestamp=ts;payload.sign=feishuSign(ts,secret);}return {url:cfgString(config,'webhook'),kept,payload};}
  const base=cfgString(config,'base_url')||'https://api.telegram.org',{text,kept}=telegramHTML(m);return {url:base.replace(/\/$/,'')+'/bot'+cfgString(config,'bot_token')+'/sendMessage',kept,payload:{chat_id:cfgString(config,'chat_id'),text,parse_mode:'HTML',disable_web_page_preview:false}};
}
export async function sendIM(kind:'dingtalk'|'feishu'|'wecom'|'telegram',config:Record<string,unknown>,m:NotificationMessage,signal:AbortSignal):Promise<number>{
  try{validateConfig(kind,config);}catch(e){throw new PermanentNotificationError((e as Error).message);}
  const request=imPayload(kind,config,m),raw=await notificationHTTP('POST',request.url,{},Buffer.from(JSON.stringify(request.payload)),signal);let r:Record<string,unknown>;
  const label={dingtalk:"DingTalk",feishu:"Feishu",wecom:"Enterprise WeChat",telegram:'Telegram'}[kind];
  try{r=JSON.parse(raw.toString());if(r===null)r={};if(typeof r!=='object'||Array.isArray(r))throw new Error("JSON response type mismatch");for(const key of kind==='feishu'?['code','StatusCode']:kind==='telegram'?['error_code']:['errcode'])if(r[key]!=null&&(typeof r[key]!=='number'||!Number.isSafeInteger(r[key])))throw new Error(`${key} Type mismatch`);for(const key of kind==='feishu'?['msg','StatusMessage']:kind==='telegram'?['description']:['errmsg'])if(r[key]!=null&&typeof r[key]!=='string')throw new Error(`${key} Type mismatch`);if(kind==='telegram'&&r.ok!=null&&typeof r.ok!=='boolean')throw new Error("ok type mismatch");}catch(e){throw new Error(`Analysis${label}${kind==='telegram'?' ':''}Response failed: ${(e as Error).message} (${oneLine(raw.toString(),200)})`);}
  if(kind==='telegram'){if(r.ok===true)return request.kept;const error=`Telegram returns error ${r.error_code??0}: ${r.description??''}`;if(r.error_code===429)throw new Error(`Telegram current limit: ${r.description??''}`);throw new PermanentNotificationError(error);}
  if(kind==='feishu'){if(r.code)throw new PermanentNotificationError(`Feishu returns error ${r.code}: ${r.msg??''}`);if(r.StatusCode)throw new PermanentNotificationError(`Feishu returns error ${r.StatusCode}: ${r.StatusMessage??''}`);return request.kept;}
  if(r.errcode){if(kind==='wecom'&&r.errcode===45009)throw new Error(`Enterprise WeChat current limit ${r.errcode}: ${r.errmsg??''}`);throw new PermanentNotificationError(`${label}Return error ${r.errcode}: ${r.errmsg??''}`);}return request.kept;
}
