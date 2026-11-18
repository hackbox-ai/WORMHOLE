import type {Pool,PoolClient} from 'pg';
import {matches,parseFilter,snapshot,truncateError,type NotificationSnapshot} from './filter.ts';

export interface NotificationChannel {
  id:number;name:string;kind:string;enabled:boolean;config:Record<string,unknown>;
  mode:string;filter:unknown;rate_per_min:number;created_at:Date;updated_at:Date;
}
export interface NotificationDelivery {
  id:number;event_id:number;channel_id:number;state:string;attempts:number;
  next_attempt_at:Date;last_error:string;batch_id:number|null;created_at:Date;sent_at:Date|null;
  snapshot:unknown;event_kind:string;finding_id:string;channel:NotificationChannel;
}
const joined=`SELECT d.*,e.snapshot,e.kind AS event_kind,e.finding_id,row_to_json(c) AS channel
 FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id JOIN notification_channels c ON c.id=d.channel_id`;
const channel=(r:any):NotificationChannel=>({...r,id:Number(r.id)});
const delivery=(r:any):NotificationDelivery=>({...r,id:Number(r.id),event_id:Number(r.event_id),channel_id:Number(r.channel_id),batch_id:r.batch_id===null?null:Number(r.batch_id),finding_id:String(r.finding_id),channel:channel(r.channel)});
export const MAX_NOTIFY_ATTEMPTS=3,MAX_DIGEST_BATCH_SIZE=500;

/** One INSERT under a savepoint, no channel/filter reads in the finding tx. */
export async function recordNotificationEvent(c:PoolClient,s:NotificationSnapshot):Promise<boolean> {
  await c.query('SAVEPOINT notification_event');
  try{await c.query('INSERT INTO notification_events(kind,finding_id,snapshot) VALUES($1,$2,$3::jsonb)',[s.kind,s.finding_id,JSON.stringify(s)]);await c.query('RELEASE SAVEPOINT notification_event');return true;}
  catch(e){await c.query('ROLLBACK TO SAVEPOINT notification_event');await c.query('RELEASE SAVEPOINT notification_event');console.error('[notify] finding transaction retained; outbox insert failed',s.finding_id,(e as Error).message);return false;}
}

export class NotificationStore {
  constructor(readonly pool:Pool){}
  async transaction<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await this.pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  async channels():Promise<NotificationChannel[]>{return (await this.pool.query('SELECT * FROM notification_channels ORDER BY enabled DESC,id')).rows.map(channel);}
  async getChannel(id:number):Promise<NotificationChannel>{const r=(await this.pool.query('SELECT * FROM notification_channels WHERE id=$1',[id])).rows[0];if(!r)throw new Error("Notification channel does not exist");return channel(r);}
  async saveChannel(input:Partial<NotificationChannel>&{name:string;kind:string}):Promise<number>{
    if((input.rate_per_min??0)<0)throw new Error("Current limit value cannot be negative");
    const args=[input.name,input.kind,input.enabled??true,JSON.stringify(input.config??{}),input.mode||'realtime',JSON.stringify(input.filter??{}),input.rate_per_min??0];
    if(!input.id)return Number((await this.pool.query('INSERT INTO notification_channels(name,kind,enabled,config,mode,filter,rate_per_min) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7) RETURNING id',args)).rows[0].id);
    const r=await this.pool.query('UPDATE notification_channels SET name=$1,kind=$2,enabled=$3,config=$4::jsonb,mode=$5,filter=$6::jsonb,rate_per_min=$7 WHERE id=$8',[...args,input.id]);if(!r.rowCount)throw new Error("Notification channel does not exist");return input.id;
  }
  async setEnabled(id:number,enabled:boolean):Promise<void>{await this.transaction(async c=>{if(!(await c.query('UPDATE notification_channels SET enabled=$2 WHERE id=$1',[id,enabled])).rowCount)throw new Error("Notification channel does not exist");if(!enabled)await c.query("UPDATE notification_deliveries SET state='skipped',last_error='Channel deactivated' WHERE channel_id=$1 AND state IN ('pending','sending')",[id]);});}
  async removeChannel(id:number):Promise<void>{if(!(await this.pool.query('DELETE FROM notification_channels WHERE id=$1',[id])).rowCount)throw new Error("Notification channel does not exist");}
  async addEvent(s:NotificationSnapshot):Promise<number>{return Number((await this.pool.query('INSERT INTO notification_events(kind,finding_id,snapshot) VALUES($1,$2,$3::jsonb) RETURNING id',[s.kind,s.finding_id,JSON.stringify(s)])).rows[0].id);}
  async fanOut(limit=200):Promise<{events:number;deliveries:number}>{return this.transaction(async c=>{
    const channels=(await c.query('SELECT * FROM notification_channels WHERE enabled ORDER BY enabled DESC,id')).rows.map(channel);
    const events=(await c.query('SELECT * FROM notification_events WHERE NOT fanned_out ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',[limit>0?limit:200])).rows;
    const emailSettings=(await c.query("SELECT key,value FROM app_settings WHERE key IN('settings.email_alert_channel_id','settings.email_alert_since')")).rows;
    const emailId=Number(emailSettings.find(r=>r.key==='settings.email_alert_channel_id')?.value??0);
    const since=emailSettings.find(r=>r.key==='settings.email_alert_since')?.value;
    let count=0;for(const e of events){const s=snapshot(e.snapshot);s.kind=e.kind;for(const ch of channels)if(matches(parseFilter(ch.filter),s)){
      if(ch.id===emailId){
        if(!['finding_created','finding_severity_escalated'].includes(s.kind)||!['high','critical'].includes(s.severity)||since&&new Date(e.created_at)<new Date(since))continue;
        const current=(await c.query('SELECT status,severity FROM findings WHERE id=$1',[s.finding_id])).rows[0];
        if(!current||!['high','critical'].includes(current.severity)||['false_positive','duplicate','ignored','fixed','resolved','risk_accepted'].includes(current.status))continue;
        const receipt=await c.query('INSERT INTO email_alert_receipts(channel_id,finding_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING finding_id',[ch.id,s.finding_id]);
        if(!receipt.rowCount)continue;
      }
      await c.query('INSERT INTO notification_deliveries(event_id,channel_id) VALUES($1,$2)',[e.id,ch.id]);count++;
    }await c.query('UPDATE notification_events SET fanned_out=true WHERE id=$1',[e.id]);}
    return {events:events.length,deliveries:count};
  });}
  async digestDue(id:number,minAgeSeconds:number):Promise<boolean>{return (await this.pool.query("SELECT EXISTS(SELECT 1 FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.channel_id=$1 AND d.state IN ('pending','sending') AND c.enabled GROUP BY d.channel_id HAVING min(d.created_at)<=now()-make_interval(secs=>$2)) AS due",[id,Math.trunc(minAgeSeconds)])).rows[0].due;}
  async claim(id:number,limit:number,leaseSeconds=180,digest=false):Promise<NotificationDelivery[]>{
    if(limit<=0)return [];if(digest)limit=Math.min(limit,MAX_DIGEST_BATCH_SIZE);
    return this.transaction(async c=>{
      const emailId=Number((await c.query("SELECT value FROM app_settings WHERE key='settings.email_alert_channel_id'")).rows[0]?.value??0);
      if(id===emailId)await c.query("UPDATE notification_deliveries d SET state='skipped',last_error='The vulnerability has been closed or is no longer high risk' FROM notification_events e WHERE d.event_id=e.id AND d.channel_id=$1 AND d.state IN('pending','sending') AND NOT EXISTS(SELECT 1 FROM findings f WHERE f.id=e.finding_id AND f.severity IN('high','critical') AND f.status NOT IN('false_positive','duplicate','ignored','fixed','resolved','risk_accepted'))",[id]);
      const rows=(await c.query(`SELECT d.id FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.channel_id=$1 AND d.state IN ('pending','sending') AND d.next_attempt_at<=now() AND c.enabled ${digest?'':"AND c.mode='realtime'"} ORDER BY ${digest?'d.id':'d.next_attempt_at,d.id'} LIMIT $2 FOR UPDATE OF d SKIP LOCKED`,[id,limit])).rows;
      if(!rows.length)return [];
      const ids=rows.map(r=>r.id);
      await c.query("UPDATE notification_deliveries SET state='sending',attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>$2) WHERE id=ANY($1::bigint[])",[ids,leaseSeconds]);
      if(digest)await c.query('UPDATE notification_deliveries SET batch_id=COALESCE(batch_id,$2) WHERE id=ANY($1::bigint[])',[ids,ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b)]);
      return (await c.query(joined+' WHERE d.id=ANY($1::bigint[]) ORDER BY d.id',[ids])).rows.map(delivery);
    });
  }
  async sent(ids:number[]):Promise<void>{if(ids.length)await this.pool.query("UPDATE notification_deliveries SET state='sent',sent_at=now(),last_error='' WHERE id=ANY($1::bigint[])",[ids]);}
  async reschedule(ids:number[],delay:number,error:string):Promise<void>{if(ids.length)await this.pool.query("UPDATE notification_deliveries SET state='pending',next_attempt_at=now()+make_interval(secs=>$2),last_error=$3 WHERE id=ANY($1::bigint[])",[ids,delay,truncateError(error)]);}
  async defer(ids:number[],reason:string):Promise<void>{if(ids.length)await this.pool.query("UPDATE notification_deliveries SET state='pending',attempts=GREATEST(attempts-1,0),next_attempt_at=now(),last_error=$2 WHERE id=ANY($1::bigint[])",[ids,truncateError(reason)]);}
  async fail(ids:number[],error:string):Promise<void>{if(ids.length)await this.pool.query("UPDATE notification_deliveries SET state='failed',last_error=$2 WHERE id=ANY($1::bigint[])",[ids,truncateError(error)]);}
  async retry(id:number):Promise<void>{if(!(await this.pool.query("UPDATE notification_deliveries SET state='pending',attempts=0,next_attempt_at=now(),last_error='' WHERE id=$1 AND state IN ('failed','skipped')",[id])).rowCount)throw new Error(`Delivery ${id} Does not exist or current status does not allow retransmission`);}
  async list(filter:{channel_id?:number;state?:string;event_kind?:string}={},page=1,pageSize=50):Promise<{deliveries:NotificationDelivery[];total:number}>{
    page=page<1?1:page;pageSize=pageSize<=0||pageSize>200?50:pageSize;
    const terms:string[]=[],args:unknown[]=[];for(const [expr,v] of [['d.channel_id',filter.channel_id&&filter.channel_id>0?filter.channel_id:undefined],['d.state',filter.state],['e.kind',filter.event_kind]] as const)if(v){args.push(v);terms.push(`${expr}=$${args.length}`);}
    const where=terms.length?' WHERE '+terms.join(' AND '):'';
    const total=Number((await this.pool.query('SELECT count(*) FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id'+where,args)).rows[0].count);
    return {total,deliveries:(await this.pool.query(joined+where+` ORDER BY d.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,pageSize,(page-1)*pageSize])).rows.map(delivery)};
  }
  async stats():Promise<Record<string,number>>{const r=(await this.pool.query(`SELECT
    (SELECT count(*) FROM notification_channels) AS channels,(SELECT count(*) FROM notification_channels WHERE enabled) AS channels_on,
    (SELECT count(*) FROM notification_deliveries WHERE state IN ('pending','sending')) AS pending,(SELECT count(*) FROM notification_deliveries WHERE state='failed') AS failed,
    (SELECT count(*) FROM notification_deliveries WHERE state='sent' AND sent_at>=date_trunc('day',now())) AS sent_today,
    COALESCE((SELECT EXTRACT(EPOCH FROM(now()-min(created_at)))*1000 FROM notification_deliveries WHERE state='pending'),0)::bigint AS backlog_age_ms`)).rows[0];return Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Number(v)]));}
}
