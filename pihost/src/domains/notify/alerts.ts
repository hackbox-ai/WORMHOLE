import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
type Cursor={s:string;u?:string;last?:string};
/** Snapshot cursors include late commits even if their sequence IDs are smaller. */
export class FindingAlerts {
 constructor(private pool:Pool,private key:Buffer){}
 private encode(c:Cursor){const data=Buffer.from(JSON.stringify(c)).toString('base64url');return data+'.'+createHmac('sha256',this.key).update('finding-alerts:'+data).digest('base64url');}
 private decode(raw:string):Cursor|null{
  try{
   if(raw.length>12000)return null;const [data,signature]=raw.split('.');if(!data||!signature)return null;
   const want=createHmac('sha256',this.key).update('finding-alerts:'+data).digest(),got=Buffer.from(signature,'base64url');if(want.length!==got.length||!timingSafeEqual(want,got))return null;
   const c=JSON.parse(Buffer.from(data,'base64url').toString());
   if(typeof c.s!=='string'||!/^[0-9]+:[0-9]+:([0-9]+(,[0-9]+)*)?$/.test(c.s)||c.u!==undefined&&(typeof c.u!=='string'||!/^[0-9]+:[0-9]+:([0-9]+(,[0-9]+)*)?$/.test(c.u))||c.last!==undefined&&!/^[0-9]{1,19}$/.test(c.last))return null;
   return c;
  }catch{return null;}
 }
 async feed(raw?:string){
  const current=String((await this.pool.query('SELECT pg_current_snapshot()::text snapshot')).rows[0].snapshot),old=raw?this.decode(raw):null;
  if(!old)return {cursor:this.encode({s:current}),items:[],more:false,reset:!!raw};
  const upper=old.u??current;
  const rows=(await this.pool.query(`SELECT a.id::text,a.finding_id::text,a.task_id::text,a.name,a.severity,a.created_at,COALESCE(NULLIF(t.name,''),'task #'||a.task_id::text) task_name
   FROM finding_alerts a LEFT JOIN tasks t ON t.id=a.task_id
   WHERE a.insert_xid>=pg_snapshot_xmin($1::pg_snapshot)
    AND NOT pg_visible_in_snapshot(a.insert_xid,$1::pg_snapshot)
    AND pg_visible_in_snapshot(a.insert_xid,$2::pg_snapshot) AND a.id>$3::bigint
   ORDER BY a.id LIMIT 51`,[old.s,upper,old.last??'0'])).rows;
  const more=rows.length>50,items=rows.slice(0,50);
  return {cursor:this.encode(more?{s:old.s,u:upper,last:items.at(-1)!.id}:{s:upper}),items,more,reset:false};
 }
}
