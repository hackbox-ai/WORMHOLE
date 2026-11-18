import {saveTaskReport} from './report.ts';
import type {Pool} from 'pg';
import {EfficiencySupervisor} from './efficiency.ts';
import {fingerprintMayComplete} from '../fingerprints/lifecycle.ts';
import {pocMayComplete} from '../pocs/lifecycle.ts';

export function continuousGuidance(task:{execution_mode?:string;deadline_at?:Date|string|null}):string{
 if(task.execution_mode!=='continuous')return '';
 return `
[Continuous Mining Execution Rules] There is no threshold for the number of vulnerabilities. prove_goal only completes a single phase, goal_met does not end the task. Continuously check the uncovered directions with evidence, combine fingerprints and PoC applicable conditions, and record real negative, blocked and unverified clues; merge the same root cause, and do not repeat the test if there is no new evidence. Review the coverage gap when you are free. After confirming that there is no execution direction, quote the actual facts/findings of this task and use finish_discovery to submit the coverage review and termination reason. It should not end just because a discovery has been made or the original goal has been achieved.${task.deadline_at?"Absolute deadline:"+new Date(task.deadline_at).toISOString()+";Current time:"+new Date().toISOString()+'。':''}Stop adding new tests after the deadline, and only save existing evidence and summary.
`;
}
export async function requestDiscoveryFinish(pool:Pool,taskId:number,reason:string,evidenceIds:number[],coverage:unknown):Promise<void>{
 const c=await pool.connect();
 try{await c.query('BEGIN');
  const task=(await c.query("SELECT execution_mode FROM tasks WHERE id=$1 AND status='running' AND NOT paused AND NOT queued AND (deadline_at IS NULL OR deadline_at>now()) AND deleted_at IS NULL FOR UPDATE",[taskId])).rows[0];
  if(task?.execution_mode!=='continuous')throw new Error("Only continuous mining tasks can apply for coverage closure");
  if(reason.trim().length<20||!Array.isArray(coverage)||!coverage.length||coverage.length>50||coverage.some(v=>!v||typeof v!=='object'||typeof v.area!=='string'||!v.area.trim()||!['tested','blocked','not_applicable'].includes(v.outcome)||typeof v.reason!=='string'||!v.reason.trim()))throw new Error("Please explain the reason why there is no executable direction, and submit the coverage, results and basis item by item");
  const ids=[...new Set(evidenceIds)];if(!ids.length||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error("It is necessary to cite the actual facts or findings of this task");
  const evidence=await c.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND id=ANY($2::bigint[]) AND kind IN('fact','finding') AND state<>'origin'",[taskId,ids]);
  if(evidence.rowCount!==ids.length)throw new Error("The basis must be the existing facts or findings of this task");
  if((await c.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN('open','running','paused') LIMIT 1",[taskId])).rowCount)throw new Error("Directions that are still pending or running, please complete coverage review first");
  const revision=(await new EfficiencySupervisor(pool).sample(taskId,c)).revision;
  await c.query('UPDATE tasks SET discovery_finish_request=$2,updated_at=now() WHERE id=$1',[taskId,JSON.stringify({reason:reason.trim(),evidence_ids:ids,coverage,revision})]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
/** Completion is a host decision after the planning round acknowledged both libraries. */
export async function finishDiscoveryIfReady(pool:Pool,taskId:number):Promise<boolean>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const task=(await c.query("SELECT exploration_id,discovery_finish_request AS request FROM tasks WHERE id=$1 AND execution_mode='continuous' AND status='running' AND NOT paused AND NOT queued AND (deadline_at IS NULL OR deadline_at>now()) AND deleted_at IS NULL FOR UPDATE",[taskId])).rows[0];
  if(!task?.request){await c.query('ROLLBACK');return false;}
  const sample=await new EfficiencySupervisor(pool).sample(taskId,c);
  if(sample.revision!==task.request.revision){await c.query('UPDATE tasks SET discovery_finish_request=NULL WHERE id=$1',[taskId]);await c.query('COMMIT');return false;}
  if(sample.active||sample.approvals||!await fingerprintMayComplete(c,taskId)||!await pocMayComplete(c,taskId)){await c.query('COMMIT');return false;}
  await saveTaskReport(c,taskId,'final',"Coverage review completed");
  await c.query("UPDATE tasks SET status='done',completed_at=now(),stopped_reason='coverage_reviewed',queued=false,queued_at=NULL WHERE id=$1",[taskId]);
  await c.query("UPDATE explorations SET status='exhausted',updated_at=now() WHERE id=$1",[task.exploration_id]);
  await c.query("INSERT INTO activity(exploration_id,worker,kind,summary,detail) VALUES($1,'system','text','Coverage review completed, task has been completed',$2)",[task.exploration_id,JSON.stringify(task.request)]);
  await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'task_done',$2)",[String(taskId),JSON.stringify(task.request)]);
  await c.query('COMMIT');return true;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
