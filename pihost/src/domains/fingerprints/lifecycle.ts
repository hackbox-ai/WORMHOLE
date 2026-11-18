import {extensionIsBound,extensionAvailable} from '../extensions/availability.ts';

import type {Pool,PoolClient} from 'pg';
type DB=Pick<Pool,'query'>|PoolClient;
export async function fingerprintEvent(db:DB,taskId:number,event:string,payload:unknown,summary?:string){
 await db.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,$2,$3)",[String(taskId),event,JSON.stringify(payload)]);
 if(summary)await db.query("INSERT INTO activity(exploration_id,worker,kind,summary,detail) SELECT exploration_id,'system','text',$2,$3 FROM tasks WHERE id=$1",[taskId,summary,JSON.stringify(payload)]);
}
export async function fingerprintNeedsReview(db:DB,taskId:number){return !!(await db.query("SELECT 1 FROM task_fingerprint_state WHERE task_id=$1 AND revision>planner_revision AND settlement_outcome<>'timed_out' AND COALESCE((SELECT value FROM app_settings WHERE key='fingerprint_enabled'),'true')<>'false'",[taskId])).rowCount;}
/** Call under the task row lock at every ordinary completion path. No network, no model calls. */
export async function fingerprintMayComplete(db:DB,taskId:number,force=false):Promise<boolean>{
 if(extensionIsBound('fingerprints')&&!await extensionAvailable('fingerprints',taskId))return true;
 const row=(await db.query(`SELECT s.*,
  (SELECT count(*)::int FROM fingerprint_jobs j JOIN fingerprint_materials m ON m.id=j.material_id WHERE m.task_id=$1 AND j.state IN('pending','running')) pending,
  COALESCE((SELECT value FROM app_settings WHERE key='fingerprint_enabled'),'true') enabled
  FROM task_fingerprint_state s WHERE task_id=$1`,[taskId])).rows[0];
 if(!row||row.enabled==='false'||row.settlement_outcome==='timed_out')return true;
 const unread=Number(row.revision)>Number(row.planner_revision);
 if(!row.pending&&!unread){if(row.settlement_outcome!=='timed_out')await db.query("UPDATE task_fingerprint_state SET settlement_outcome='drained' WHERE task_id=$1",[taskId]);return true;}
 const state=(await db.query("UPDATE task_fingerprint_state SET settlement_deadline_at=COALESCE(settlement_deadline_at,now()+interval '15 seconds') WHERE task_id=$1 RETURNING settlement_deadline_at,settlement_outcome",[taskId])).rows[0];
 if(!force&&new Date(state.settlement_deadline_at).getTime()>Date.now())return false;
 if(state.settlement_outcome!=='timed_out'){
  const gap={pending:row.pending,unreviewed_revision:unread?String(row.revision):null,reason:force?'task_deadline':'fingerprint_settlement_budget'};
  await db.query("UPDATE task_fingerprint_state SET settlement_outcome='timed_out',gaps=gaps||$2::jsonb WHERE task_id=$1",[taskId,JSON.stringify({settlement:gap})]);
  await fingerprintEvent(db,taskId,'fingerprint_settlement_gap',gap,"Fingerprint closing wait reaches the upper limit: retain unprocessed materials and unreviewed results, and do not claim that the identification has been completed based on this");
 }
 return true;
}
export async function recordFingerprintDelivery(db:DB,taskId:number,recipient:string,revision:number,observationIds:number[],intentId?:number){
 const result=await db.query('INSERT INTO fingerprint_deliveries(task_id,intent_id,recipient,revision,observation_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[taskId,intentId??null,recipient,revision,observationIds]);
 if(result.rowCount)await fingerprintEvent(db,taskId,'fingerprint_context_delivered',{recipient,intent_id:intentId,revision,observation_ids:observationIds},observationIds.length?`Fingerprint evidence has been handed over ${recipient}${intentId?" Intent #"+intentId:''}：${observationIds.length} association basis`:undefined);
}
export function explicitFingerprintURLs(text:string):string[]{return [...new Set((text.match(/https?:\/\/[^\s<>"'`，。；、）)\]}]+/gi)??[]).flatMap(raw=>{try{const u=new URL(raw.replace(/[.,;]+$/,''));if(u.username||u.password)return [];u.hash='';u.search='';return [u.href]}catch{return []}}))];}
export function relatedFingerprintURL(a:string,b:string){try{const x=new URL(a),y=new URL(b);if(x.origin!==y.origin)return false;const left=x.pathname.replace(/\/$/,''),right=y.pathname.replace(/\/$/,'');return left===right||left.startsWith(right+'/')||right.startsWith(left+'/')}catch{return false}}

/** Successful model round acknowledgement is distinct from merely delivering a prompt. */
export async function acknowledgeFingerprintReview(db:DB,taskId:number,revision:number){
 const result=await db.query('UPDATE task_fingerprint_state SET planner_revision=$2 WHERE task_id=$1 AND planner_revision<$2 RETURNING task_id',[taskId,revision]);
 if(result.rowCount)await fingerprintEvent(db,taskId,'fingerprint_context_reviewed',{revision},"Planning round has completed fingerprint basis review and revision "+revision);
}
