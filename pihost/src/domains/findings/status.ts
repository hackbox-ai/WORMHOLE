import type {PoolClient} from 'pg';
import {recordNotificationEvent} from '../notify/store.ts';
export const FINDING_STATUSES=['pending','in_progress','confirmed','resolved','fixed','false_positive','ignored','duplicate','risk_accepted'];
/** Original SetFindingStatusTx: mutation succeeds even if notification fails. */
export async function setFindingStatus(c:PoolClient,id:number,status:string):Promise<{found:boolean;changed:boolean}>{
 const f=(await c.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!f)return {found:false,changed:false};if(f.status===status)return {found:true,changed:false};
 await c.query('UPDATE findings SET status=$2 WHERE id=$1',[id,status]);
 await recordNotificationEvent(c,{kind:'finding_status_changed',finding_id:id,task_id:Number(f.task_id??0),vulnclass:f.vulnclass,name:f.name,severity:f.severity,summary:f.summary,asset_ids:f.asset_ids,from_status:f.status,to_status:status});
 return {found:true,changed:true};
}
