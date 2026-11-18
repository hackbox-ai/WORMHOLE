import {saveTaskReport} from './report.ts';
import type {Pool,PoolClient} from 'pg';
import {pocMayComplete} from '../pocs/lifecycle.ts';
import {fingerprintMayComplete} from '../fingerprints/lifecycle.ts';

/** Only explicit human follow-ups reopen an achieved graph. Never revive a terminal task implicitly. */
export async function reopenExploration(pool:Pool,taskId:number):Promise<void>{
 await pool.query('UPDATE tasks SET discovery_finish_request=NULL WHERE id=$1',[taskId]);
 await pool.query("UPDATE task_poc_state SET settlement_deadline_at=NULL,settlement_outcome='',completion_requested=false WHERE task_id=$1",[taskId]);
 await pool.query("UPDATE task_fingerprint_state SET settlement_deadline_at=NULL,settlement_outcome='',completion_requested=false WHERE task_id=$1",[taskId]);
 await pool.query(`UPDATE explorations e SET status='open',updated_at=now() FROM tasks t
   WHERE t.id=$1 AND t.exploration_id=e.id AND t.deleted_at IS NULL
   AND t.status IN('created','running') AND e.status IN('achieved','exhausted')`,[taskId]);
}

/** Called under the task row lock, in the same transaction as goal proof. */
export async function finishAchievedTask(c:PoolClient,taskId:number):Promise<boolean>{
 if((await c.query('SELECT execution_mode FROM tasks WHERE id=$1',[taskId])).rows[0]?.execution_mode==='continuous')return false;
 if(!await fingerprintMayComplete(c,taskId)||!await pocMayComplete(c,taskId))return false;
 await saveTaskReport(c,taskId,'final',"Mission goal achieved");
 const changed=await c.query(`UPDATE tasks SET status='done',paused=FALSE,queued=FALSE,queued_at=NULL,
   completed_at=COALESCE(completed_at,now()),updated_at=now()
   WHERE id=$1 AND deleted_at IS NULL AND status IN('created','running','paused') RETURNING id`,[taskId]);
 if(!changed.rowCount)return false;
 await c.query(`UPDATE exploration_nodes SET state='stopped',claimed_by=NULL,claimed_at=NULL,
   completed_at=now(),updated_at=now(),last_error='Task goal has been achieved'
   WHERE task_id=$1 AND kind='intent' AND state IN('open','running','paused','blocked')`,[taskId]);
 await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'task_done',$2)",[String(taskId),JSON.stringify({reason:'goals_achieved'})]);
 return true;
}
export async function completeAchievedTask(pool:Pool,taskId:number):Promise<boolean>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const t=(await c.query('SELECT exploration_id,execution_mode FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId])).rows[0];if(!t)throw new Error('task not found');
  if(t.execution_mode==='continuous'){await c.query('COMMIT');return false;}
  const completed=await finishAchievedTask(c,taskId);await c.query('UPDATE task_fingerprint_state SET completion_requested=$2 WHERE task_id=$1',[taskId,!completed]);await c.query('UPDATE task_poc_state SET completion_requested=$2 WHERE task_id=$1',[taskId,!completed]);if(completed)await c.query("UPDATE explorations SET status='achieved',updated_at=now() WHERE id=$1",[t.exploration_id]);await c.query('COMMIT');return completed;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
