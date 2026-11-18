import {extensionIsBound,extensionAvailable} from '../extensions/availability.ts';
import type {Pool,PoolClient} from 'pg';
type DB=Pick<Pool,'query'>|PoolClient;
export async function pocEvent(db:DB,taskId:number,event:string,payload:unknown){
 await db.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,$2,$3)",[String(taskId),event,JSON.stringify(payload)]);
}
export async function pocNeedsReview(db:DB,taskId:number){return !!(await db.query(`SELECT 1 FROM task_poc_state s
 WHERE task_id=$1 AND settlement_outcome<>'timed_out' AND COALESCE((SELECT value FROM app_settings WHERE key='poc_enabled'),'true')<>'false'
 AND (revision>planner_revision OR fingerprint_revision<>COALESCE((SELECT revision FROM task_fingerprint_state WHERE task_id=$1),0))`,[taskId])).rowCount;}
export async function pocMayComplete(db:DB,taskId:number,force=false){
 if(extensionIsBound('pocs')&&!await extensionAvailable('pocs',taskId))return true;
 if(!await pocNeedsReview(db,taskId))return true;
 const row=(await db.query("UPDATE task_poc_state SET settlement_deadline_at=COALESCE(settlement_deadline_at,now()+interval '15 seconds') WHERE task_id=$1 RETURNING *",[taskId])).rows[0];
 if(!force&&new Date(row.settlement_deadline_at).getTime()>Date.now())return false;
 await db.query("UPDATE task_poc_state SET settlement_outcome='timed_out',gaps=gaps||$2::jsonb WHERE task_id=$1",[taskId,JSON.stringify({settlement:{reason:force?'task_deadline':'poc_review_budget',revision:row.revision,planner_revision:row.planner_revision}})]);
 await pocEvent(db,taskId,'poc_settlement_gap',{revision:row.revision,planner_revision:row.planner_revision});return true;
}
export async function pocDelivery(db:DB,taskId:number,recipient:string,revision:number,candidateIds:number[],intentId?:number){
 const result=await db.query('INSERT INTO poc_deliveries(task_id,intent_id,recipient,revision,candidate_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[taskId,intentId??null,recipient,revision,candidateIds]);
 if(result.rowCount)await pocEvent(db,taskId,'poc_context_delivered',{recipient,intent_id:intentId,revision,candidate_ids:candidateIds});
}
export async function pocReviewed(db:DB,taskId:number,revision:number){
 const result=await db.query('UPDATE task_poc_state SET planner_revision=GREATEST(planner_revision,$2) WHERE task_id=$1 AND planner_revision<$2 RETURNING task_id',[taskId,revision]);
 if(result.rowCount)await pocEvent(db,taskId,'poc_context_reviewed',{revision});
}
export async function validatePocReferences(db:DB,taskId:number,raw:unknown,active=false){
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>20||raw.some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error("PoC candidate references must be up to 20 positive integers");
 const ids=[...new Set(raw)] as number[];if(!ids.length)return ids;
 const found=await db.query(`SELECT id FROM poc_candidates WHERE task_id=$1 AND id=ANY($2::bigint[])${active?" AND active AND applicability<>'excluded'":''}`,[taskId,ids]);
 if(found.rowCount!==ids.length)throw new Error(active?"PoC candidates must belong to the current task and still be applicable; please search again":"PoC candidate references must belong to the current task");return ids;
}
