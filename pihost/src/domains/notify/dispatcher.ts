import {NotificationStore,MAX_NOTIFY_ATTEMPTS,MAX_DIGEST_BATCH_SIZE,type NotificationDelivery} from './store.ts';
import {snapshot,type NotificationSnapshot} from './filter.ts';
import {validKind} from './config.ts';
import type {NotificationMessage,NotificationItem} from './render.ts';
export class PermanentNotificationError extends Error {}
export type NotificationSender=(kind:string,config:Record<string,unknown>,message:NotificationMessage,signal:AbortSignal)=>Promise<number>;
export interface NotificationSettings {enabled:boolean;public_base_url:string;digest_interval_min:number;}

/** Source settings remain separate from stored facts. One sequential tick and
 * one stop/drain barrier prevent overlapping dispatchers within a host. */
export class NotificationDispatcher {
  private buckets=new Map<number,{tokens:number;last:number}>();
  private active:Promise<void>|undefined;private timer:NodeJS.Timeout|undefined;
  private controller=new AbortController();
  constructor(readonly store:NotificationStore,readonly sender:NotificationSender,readonly settings:()=>Promise<NotificationSettings>){}
  takeTokens(id:number,rate:number,want:number,now=Date.now()):number {
    if(want<=0)return 0;if(rate<=0)return Math.min(want,50);
    let b=this.buckets.get(id);if(!b){b={tokens:rate,last:now};this.buckets.set(id,b);}
    const elapsed=(now-b.last)/1000;if(elapsed>0){b.tokens=Math.min(rate,b.tokens+elapsed*rate/60);b.last=now;}
    const take=Math.min(Math.floor(b.tokens+1e-9),want);if(take<=0)return 0;b.tokens-=take;return take;
  }
  start():void{if(this.timer)return;this.timer=setInterval(()=>void this.step().catch(e=>console.error('[notify] tick failed',(e as Error).message)),3000);this.timer.unref();}
  async stop():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=undefined;this.controller.abort();await this.active;}
  step():Promise<void>{if(this.active)return this.active;if(this.controller.signal.aborted)return Promise.resolve();const p=this.tick().finally(()=>{this.active=undefined;});this.active=p;return p;}
  private async tick():Promise<void>{
    const cfg=await this.settings();if(!cfg.enabled)return;
    await this.store.fanOut(200);
    const base=cfg.public_base_url.replace(/\/+$/,''),minutes=Number.isInteger(cfg.digest_interval_min)&&cfg.digest_interval_min>0?cfg.digest_interval_min:30;
    for(const ch of await this.store.channels()){
      if(this.controller.signal.aborted)return;if(!ch.enabled)continue;
      try{
        const digest=ch.mode==='digest',allow=this.takeTokens(ch.id,ch.rate_per_min,digest?1:5);if(allow<=0)continue;
        if(digest&&!await this.store.digestDue(ch.id,minutes*60))continue;
        const rows=await this.store.claim(ch.id,digest?MAX_DIGEST_BATCH_SIZE:allow,180,digest);if(!rows.length)continue;
        if(!validKind(ch.kind)){await this.store.fail(rows.map(r=>r.id),`Channel type ${JSON.stringify(ch.kind)} Not registered`);continue;}
        if(!digest){for(const row of rows){try{const item=await this.item(row,base);await this.send({items:[item],batch:false,window_minutes:0,home_url:base},[row],ch.kind,ch.config);}catch(e){await this.store.fail([row.id],(e as Error).message);}}}
        else{
          const included:NotificationDelivery[]=[],items:NotificationItem[]=[],bad:number[]=[];
          for(const row of rows){try{items.push(await this.item(row,base));included.push(row);}catch{bad.push(row.id);}}
          if(!included.length){await this.store.fail(rows.map(r=>r.id),`Summarize batches ${rows.length} All submissions cannot be parsed`);continue;}
          if(bad.length)await this.store.fail(bad,"The event snapshot cannot be parsed and this vulnerability cannot be rendered into a message.");
          await this.send({items,batch:true,window_minutes:minutes,home_url:base},included,ch.kind,ch.config);
        }
      }catch(e){console.error('[notify] channel tick failed',ch.id,(e as Error).message);}
    }
  }
  async send(message:NotificationMessage,rows:NotificationDelivery[],kind:string,config:Record<string,unknown>):Promise<void>{
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(30000)]);let error:Error|undefined,delivered=0;
    try{delivered=await this.sender(kind,config,message,signal);}catch(e){error=e instanceof Error?e:new Error(String(e));}
    // Original canceled ctx cannot update the DB; keep the lease for recovery.
    if(this.controller.signal.aborted)return;
    if(!error&&delivered>0){delivered=Math.min(Math.trunc(delivered),rows.length);await this.persist(()=>this.store.sent(rows.slice(0,delivered).map(r=>r.id)));if(rows.length>delivered)await this.persist(()=>this.store.defer(rows.slice(delivered).map(r=>r.id),`This message has reached the upper limit of channel length and will only be delivered before ${delivered} items, the rest are reserved for the next batch`));return;}
    error??=new Error(`The channel did not report the number of delivered items (delivered=${delivered}）`);
    const permanent=error instanceof PermanentNotificationError,fail:number[]=[],exhausted:number[]=[],byDelay=new Map<number,number[]>();
    for(const row of rows){if(permanent)fail.push(row.id);else if(row.attempts>=MAX_NOTIFY_ATTEMPTS)exhausted.push(row.id);else{const delay=[1,5,30][Math.min(row.attempts,2)]!;const ids=byDelay.get(delay)??[];ids.push(row.id);byDelay.set(delay,ids);}}
    await this.persist(()=>this.store.fail(fail,error!.message));await this.persist(()=>this.store.fail(exhausted,`Try again ${MAX_NOTIFY_ATTEMPTS} Still failed after times: ${error!.message}`));
    for(const [delay,ids] of byDelay)await this.persist(()=>this.store.reschedule(ids,delay,error!.message));
  }
  private async persist(write:()=>Promise<void>):Promise<void>{try{await write();}catch(e){console.error('[notify] delivery state write failed; lease retained',(e as Error).message);}}
  private parse(row:NotificationDelivery):NotificationSnapshot {
    const raw=row.snapshot;if(raw===null)return snapshot(raw);
    if(typeof raw!=='object'||Array.isArray(raw))throw new Error(`Parse delivery
Event snapshot failed for ${row.id} Event snapshot failed for`);
    const f=raw as Record<string,unknown>;
    for(const k of ['kind','vulnclass','name','severity','summary','from_status','to_status'])if(f[k]!=null&&typeof f[k]!=='string')throw new Error(`Parse delivery
Event snapshot failed for ${row.id} : ${k} Type mismatch`);
    for(const k of ['finding_id','task_id'])if(f[k]!=null&&(typeof f[k]!=='number'||!Number.isSafeInteger(f[k])))throw new Error(`Parse delivery
Event snapshot failed for ${row.id} : ${k} Type mismatch`);
    if(f.asset_ids!=null&&(!Array.isArray(f.asset_ids)||f.asset_ids.some(v=>v!==null&&(typeof v!=='number'||!Number.isSafeInteger(v)))))throw new Error(`Parse delivery
Event snapshot failed for ${row.id} Event snapshot failed: asset_ids type mismatch`);
    const s=snapshot(raw);if(!s.kind)s.kind=row.event_kind;return s;
  }
  async item(row:NotificationDelivery,base:string):Promise<NotificationItem>{
    const s=this.parse(row);let assets:string[]=[];
    try{if(s.asset_ids?.length){const result=(await this.store.pool.query('SELECT id,type,domain,ip,url,app_name,bundle_id FROM assets WHERE id=ANY($1::bigint[])',[s.asset_ids])).rows;
      const pick=(...vals:(string|null)[])=>vals.find(v=>v?.trim())??'',names=new Map(result.map(r=>[Number(r.id),r.type==='root_domain'||r.type==='subdomain'?r.domain:r.type==='ip'?r.ip:r.type==='app'?pick(r.app_name,r.bundle_id):r.type==='service'||r.type==='endpoint'?pick(r.url,r.domain,r.ip):pick(r.domain,r.ip,r.url,r.app_name)]));
      assets=[...new Set(s.asset_ids)].map(id=>names.get(id)).filter((v):v is string=>typeof v==='string'&&!!v);}}
    catch(e){console.error('[notify] asset names unavailable',s.finding_id,(e as Error).message);}
    const email=Number((await this.store.pool.query("SELECT value FROM app_settings WHERE key='settings.email_alert_channel_id'")).rows[0]?.value??0);
    let mailContext:Partial<NotificationItem>={};
    if(row.channel_id===email){
      const current=(await this.store.pool.query("SELECT f.status,t.name task_name FROM findings f LEFT JOIN tasks t ON t.id=f.task_id WHERE f.id=$1",[s.finding_id])).rows[0];
      mailContext={task_name:current?.task_name||(s.task_id?"Task #"+s.task_id:"Independent discovery"),current_status:current?.status};
    }
    return {...mailContext,finding_id:s.finding_id,name:s.name,vulnclass:s.vulnclass,severity:s.severity,summary:s.summary,assets,detail_url:base?`${base}/function/findings/detail?id=${s.finding_id}`:'',from_status:s.from_status,to_status:s.to_status};
  }
}
