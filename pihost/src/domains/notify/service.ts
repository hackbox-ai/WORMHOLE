import type {Pool} from 'pg';
import {NotificationStore,type NotificationChannel,type NotificationDelivery} from './store.ts';
import {NotificationDispatcher,type NotificationSettings,type NotificationSender} from './dispatcher.ts';
import {CHANNELS,kinds,validKind,maskConfig,prepareConfigUpdate,validateConfig} from './config.ts';
import {parseFilter,validateFilter,snapshot} from './filter.ts';
import {validateWebhook,sendWebhook} from './webhook.ts';
import {sendIM} from './im.ts';
import {sendEmail} from './email.ts';

export class NotificationRequestError extends Error {constructor(readonly status:number,message:string){super(message);}}
function fail(message:string):never {throw new NotificationRequestError(400,message);}
const object=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
async function validate(kind:string,config:Record<string,unknown>){if(!validKind(kind))fail(`Invalid channel type, optional:${kinds.join(' / ')}`);if(kind==='webhook')await validateWebhook(config);else validateConfig(kind,config);}
export const notificationSender:NotificationSender=async(kind,config,message,signal)=>{
  if(kind==='email')return sendEmail(config,message,signal);if(kind==='webhook')return sendWebhook(config,message,signal);
  if(kind==='dingtalk'||kind==='feishu'||kind==='wecom'||kind==='telegram')return sendIM(kind,config,message,signal);
  throw new Error(`Channel type ${JSON.stringify(kind)} Not registered`);
};
function request(body:Record<string,unknown>):void {
  const typeError=(field:string,value:unknown,type:string)=>{const received=Array.isArray(value)?'array':typeof value==='object'?'object':typeof value==='boolean'?'bool':typeof value==='number'?'number'+(type==='int'||type==='int64'?' '+String(value):''):'string';fail(`The request body is not a valid JSON: json: cannot unmarshal ${received} into Go struct field ${field.startsWith('filter.')?'Filter':'notifyChannelRequest'}.${field} of type ${type}`);};
  for(const key of ['name','kind','mode'])if(body[key]!=null&&typeof body[key]!=='string')typeError(key,body[key],'string');
  if(body.enabled!=null&&typeof body.enabled!=='boolean')typeError('enabled',body.enabled,'bool');
  if(body.rate_per_min!=null&&(typeof body.rate_per_min!=='number'||!Number.isSafeInteger(body.rate_per_min)))typeError('rate_per_min',body.rate_per_min,'int');
  if(body.config!=null&&(typeof body.config!=='object'||Array.isArray(body.config)))typeError('config',body.config,'map[string]interface {}');
  if(body.filter!=null){if(typeof body.filter!=='object'||Array.isArray(body.filter))typeError('filter',body.filter,'notify.Filter');const f=body.filter as Record<string,unknown>;if(f.min_severity!=null&&typeof f.min_severity!=='string')typeError('filter.min_severity',f.min_severity,'string');if(f.on_status_change!=null&&typeof f.on_status_change!=='boolean')typeError('filter.on_status_change',f.on_status_change,'bool');for(const key of ['task_ids','asset_ids','vulnclass_include','vulnclass_exclude'])if(f[key]!=null){const type=key.endsWith('_ids')?'int64':'string';if(!Array.isArray(f[key]))typeError('filter.'+key,f[key],'[]'+type);for(const v of f[key] as unknown[])if(v!=null&&(type==='int64'?typeof v!=='number'||!Number.isSafeInteger(v):typeof v!=='string'))typeError('filter.'+key,v,type);}}
}
export function channelDTO(c:NotificationChannel){return {...c,config:maskConfig(c.kind,c.config),filter:parseFilter(c.filter),secret_keys:validKind(c.kind)?CHANNELS[c.kind].secret_keys:[]};}
// Normalize old display text while retaining the original stored failure.
export function channelErrorText(message:string):string{return message.replace(/（如确需投递到本机服务，设置 [A-Z0-9_]+_NOTIFY_ALLOW_LOCAL=1）/g,'').replaceAll("Delivery to local/link-local address refused ","Rejection of delivery to this machine or link-local address:");}
export function deliveryDTO(d:NotificationDelivery){const s=snapshot(d.snapshot);return {id:d.id,finding_id:d.finding_id,event_kind:d.event_kind,channel_id:d.channel_id,channel_name:d.channel.name,channel_kind:d.channel.kind,state:d.state,attempts:d.attempts,last_error:channelErrorText(d.last_error),...(d.batch_id===null?{}:{batch_id:d.batch_id}),created_at:d.created_at,...(d.sent_at===null?{}:{sent_at:d.sent_at}),next_attempt_at:d.next_attempt_at,title:s.name||s.vulnclass,severity:s.severity};}
const services=new WeakMap<Pool,NotificationService>();
export function notificationService(pool:Pool):NotificationService {let service=services.get(pool);if(!service){service=new NotificationService(pool);services.set(pool,service);}return service;}
export class NotificationService {
  readonly store:NotificationStore;readonly dispatcher:NotificationDispatcher;
  constructor(readonly pool:Pool,sender:NotificationSender=notificationSender){this.store=new NotificationStore(pool);this.dispatcher=new NotificationDispatcher(this.store,sender,()=>this.settings());}
  async emailAlerts(){
    const cfg=await this.settings();
    const row=(await this.pool.query("SELECT c.* FROM notification_channels c JOIN app_settings s ON s.key='settings.email_alert_channel_id' AND s.value=c.id::text WHERE c.kind='email'")).rows[0];
    return {channel:row?channelDTO({...row,id:Number(row.id)}):null,global_enabled:cfg.enabled,public_base_url:cfg.public_base_url};
  }
  async saveEmailAlerts(body:Record<string,unknown>){
    request(body);
    if(body.public_base_url!==undefined){
      if(typeof body.public_base_url!=='string')throw new NotificationRequestError(400,"The access address must be a string");
      if(body.public_base_url.trim()){let u:URL;try{u=new URL(body.public_base_url.trim());}catch{throw new NotificationRequestError(400,"Invalid access address");}
        if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new NotificationRequestError(400,"Access address only supports HTTP/HTTPS and cannot contain credentials");}
    }
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('wormhole.email-alert-config'))");
      const row=(await c.query("SELECT c.* FROM notification_channels c JOIN app_settings s ON s.key='settings.email_alert_channel_id' AND s.value=c.id::text WHERE c.kind='email' FOR UPDATE OF c")).rows[0];
      const config=prepareConfigUpdate('email',row?.config??{},object(body.config));
      await validate('email',config);
      const enabled=body.enabled??row?.enabled??false;
      const values=["High-risk email alert",enabled,JSON.stringify(config),JSON.stringify({min_severity:'high',on_status_change:false})];
      const result=row?await c.query("UPDATE notification_channels SET name=$1,enabled=$2,config=$3::jsonb,filter=$4::jsonb,mode='realtime' WHERE id=$5 RETURNING id",[...values,row.id]):
        await c.query("INSERT INTO notification_channels(name,kind,enabled,config,filter,mode,rate_per_min) VALUES($1,'email',$2,$3::jsonb,$4::jsonb,'realtime',10) RETURNING id",values);
      const id=Number(result.rows[0].id);
      await c.query("INSERT INTO app_settings(key,value) VALUES('settings.email_alert_channel_id',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[String(id)]);
      if(!row||enabled&&!row.enabled)await c.query("INSERT INTO app_settings(key,value) VALUES('settings.email_alert_since',clock_timestamp()::text) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
      if(!enabled)await c.query("UPDATE notification_deliveries SET state='skipped',last_error='Email alert has been closed' WHERE channel_id=$1 AND state IN('pending','sending')",[id]);
      if(body.public_base_url!==undefined)await c.query("INSERT INTO app_settings(key,value) VALUES('settings.notify_public_base_url',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[String(body.public_base_url).trim().replace(/\/+$/,'')]);
      await c.query('COMMIT');
      return await this.emailAlerts();
    }catch(e){await c.query('ROLLBACK');if(e instanceof NotificationRequestError)throw e;throw new NotificationRequestError(400,(e as Error).message);}
    finally{c.release();}
  }
  async settings():Promise<NotificationSettings>{const rows=(await this.pool.query("SELECT key,value FROM app_settings WHERE key=ANY($1::text[])",[['settings.notify_enabled','settings.notify_public_base_url','settings.notify_digest_interval_min']])).rows;const map=new Map(rows.map(r=>[r.key,String(r.value)])),enabled=map.get('settings.notify_enabled'),raw=map.get('settings.notify_digest_interval_min')??'',minutes=/^[+-]?\d+$/.test(raw)?Number(raw):0;return {enabled:enabled==null?true:enabled==='true'||enabled==='1',public_base_url:map.get('settings.notify_public_base_url')??'',digest_interval_min:Number.isSafeInteger(minutes)&&minutes>0?minutes:30};}
  async meta(){const cfg=await this.settings(),raw=(await this.pool.query("SELECT value FROM app_settings WHERE key='settings.notify_digest_interval_min'")).rows[0]?.value??'';return {kinds:kinds.map(kind=>({kind,default_rate_per_min:CHANNELS[kind].default_rate_per_min,secret_keys:CHANNELS[kind].secret_keys})),enabled:cfg.enabled,public_base_url:cfg.public_base_url,digest_interval_min:String(raw),defaults:{digest_interval_min:30},stats:await this.store.stats()};}
  async create(body:Record<string,unknown>):Promise<number>{request(body);if(!validKind(body.kind))fail(`Invalid channel type, optional:${kinds.join(' / ')}`);const kind=body.kind,name=String(body.name??'').trim();if(!name)fail("Channel name missing");const config=object(body.config);try{await validate(kind,config);}catch(e){throw new NotificationRequestError(400,(e as Error).message);}
    const mode=body.mode??'realtime';if(mode!=='realtime'&&mode!=='digest')fail("Push mode is invalid, optional: realtime/digest");const rate=body.rate_per_min??CHANNELS[kind].default_rate_per_min;if(Number(rate)<0)fail("Current limit value cannot be negative");let filter:unknown={};if(body.filter!=null){filter=parseFilter(body.filter);try{validateFilter(filter as ReturnType<typeof parseFilter>);}catch(e){fail((e as Error).message);}}
    return this.store.saveChannel({name,kind,config,mode:String(mode),enabled:body.enabled==null?true:body.enabled as boolean,filter,rate_per_min:Number(rate)});
  }
  async update(id:number,body:Record<string,unknown>):Promise<number>{const current=await this.store.getChannel(id);request(body);const kind=body.kind??current.kind;if(!validKind(kind))fail(`Invalid channel type, optional:${kinds.join(' / ')}`);let config:Record<string,unknown>;try{config=prepareConfigUpdate(kind,kind===current.kind?current.config:{},object(body.config));await validate(kind,config);}catch(e){fail((e as Error).message);}
    const next={...current,kind,config:config!,name:body.name==null?current.name:String(body.name).trim(),mode:body.mode==null?current.mode:String(body.mode),rate_per_min:body.rate_per_min==null?current.rate_per_min:Number(body.rate_per_min),filter:body.filter==null?current.filter:parseFilter(body.filter)};if(!next.name)fail("Channel name cannot be empty");if(!['realtime','digest'].includes(next.mode))fail("Push mode is invalid, optional: realtime/digest");if(next.rate_per_min<0)fail("Current limit value cannot be negative");if(body.filter!=null)try{validateFilter(parseFilter(body.filter));}catch(e){fail((e as Error).message);}
    await this.store.saveChannel(next);if(body.enabled!=null&&body.enabled!==current.enabled)await this.store.setEnabled(id,body.enabled as boolean);return id;
  }
  async test(id:number,signal:AbortSignal):Promise<{ok:true;latency_ms:number}>{const c=await this.store.getChannel(id);if(!validKind(c.kind))fail(`Channel type ${JSON.stringify(c.kind)} Not registered`);try{await validate(c.kind,c.config);}catch(e){fail((e as Error).message);}const cfg=await this.settings(),base=cfg.public_base_url.replace(/\/+$/,''),start=Date.now();try{await notificationSender(c.kind,c.config,{items:[{finding_id:0,name:"Test message · Channel configuration is normal",vulnclass:"Connectivity Test",severity:'low',summary:"This is a test message for the WORMHOLE notification channel.",assets:['wormhole.example.com'],detail_url:base}],batch:false,window_minutes:0,home_url:base},signal);}catch(e){throw new NotificationRequestError(502,(e as Error).message);}return {ok:true,latency_ms:Date.now()-start};}
}
