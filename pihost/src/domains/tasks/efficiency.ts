import {saveTaskReport} from './report.ts';
import type {Pool,PoolClient} from 'pg';
import {pocMayComplete} from '../pocs/lifecycle.ts';
import {fingerprintMayComplete} from '../fingerprints/lifecycle.ts';
import {readEfficiencyOptions} from './efficiency-settings.ts';
export interface EfficiencyOptions {
  enabled:boolean;maxActiveSeconds:number;maxModelCalls:number;maxOutputTokens:number;maxTotalTokens:number;
  idleSeconds:number;emptyRounds:number;plannerMaxTurns:number;plannerRunSeconds:number;reviewSeconds:number;
}
export const efficiencyDefaults:EfficiencyOptions={enabled:true,maxActiveSeconds:0,maxModelCalls:0,
  maxOutputTokens:0,maxTotalTokens:0,idleSeconds:900,emptyRounds:3,plannerMaxTurns:0,plannerRunSeconds:0,reviewSeconds:1800};
export function efficiencyOptions(input:Partial<EfficiencyOptions>={}):EfficiencyOptions{
  const result={...efficiencyDefaults};
  for(const key of Object.keys(result) as (keyof EfficiencyOptions)[]){
    if(key==='enabled'){if(typeof input.enabled==='boolean')result.enabled=input.enabled;}
    else {const value=input[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)result[key]=Math.floor(value);}
  }
  return result;
}
export interface ProgressSample {
  progress:string;revision:string;active:number;approvals:number;calls:number;output:number;total?:number;
}
export interface EfficiencyState {
  progress_signature:string;plan_signature:string;round_progress:string;empty_rounds:number;
  last_progress_at:Date|string;last_tick_at:Date|string;active_seconds:number;
  base_calls:number;base_output:number;base_total?:number;paused_reason:string|null;
}
/** Idle is evaluated only with an empty frontier, never during a tool/approval.
 * Hard budgets suspend rather than falsely declare a successful task. */
export function efficiencyDecision(state:EfficiencyState,sample:ProgressSample,options:EfficiencyOptions,now:number):string|null{
  if(sample.approvals)return null;
  if(options.maxActiveSeconds&&state.active_seconds>=options.maxActiveSeconds)return 'active_time_budget';
  if(options.maxModelCalls&&sample.calls-state.base_calls>=options.maxModelCalls)return 'model_call_budget';
  if(options.maxOutputTokens&&sample.output-state.base_output>=options.maxOutputTokens)return 'output_token_budget';
  if(options.maxTotalTokens&&(sample.total??0)-(state.base_total??0)>=options.maxTotalTokens)return 'total_token_budget';
  if(options.enabled&&!sample.active&&options.idleSeconds&&options.emptyRounds&&state.empty_rounds>=options.emptyRounds&&
    now-new Date(state.last_progress_at).getTime()>=options.idleSeconds*1000)return 'no_new_evidence';
  return null;
}
export class EfficiencySupervisor {
  options:EfficiencyOptions;
  constructor(private pool:Pool,private fallback?:Partial<EfficiencyOptions>){this.options=efficiencyOptions(fallback);}
  async refresh():Promise<void>{this.options=await readEfficiencyOptions(this.pool,this.fallback);}
  async sample(taskId:number,database:Pick<Pool,'query'>=this.pool):Promise<ProgressSample>{
    const row=(await database.query(`SELECT
      jsonb_build_array((SELECT jsonb_build_array(count(*) FILTER(WHERE kind IN('fact','finding') AND state<>'origin'),
        count(*) FILTER(WHERE kind='goal' AND (state='met' OR payload ? 'resolution')),
        max(id) FILTER(WHERE kind='hint')) FROM exploration_nodes WHERE task_id=$1 OR task_id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1)),
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM task_constraints c WHERE task_id=$1),
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM task_scope s WHERE task_id=$1),
        (SELECT jsonb_build_array(goal,description,llm_chain_revision,active_llm_profile_id) FROM tasks WHERE id=$1))::text AS progress,
      (SELECT jsonb_agg(jsonb_build_array(id,state,content_version,payload->'resolution') ORDER BY id)::text
        FROM exploration_nodes WHERE (task_id=$1 OR task_id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1)) AND kind IN('intent','goal','hint','fact','finding')) AS revision,
      (SELECT count(*)::int FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN('open','running','paused')) AS active,
      (SELECT count(*)::int FROM tool_approvals a JOIN tool_calls c ON c.id=a.tool_call_id WHERE a.status='pending'
        AND (c.run_id='task-'||$1::text OR c.business_id='task-'||$1::text OR c.business_id LIKE 'task-'||$1::text||'-%'
          OR EXISTS(SELECT 1 FROM conversations owner WHERE owner.task_id=$1 AND c.business_id='conv-'||owner.id::text))) AS approvals,
      (SELECT count(*)::int FROM llm_usage WHERE task_id=$1::text) AS calls,
      (SELECT COALESCE(sum(output_tokens),0)::bigint FROM llm_usage WHERE task_id=$1::text) AS output,
      (SELECT COALESCE(sum(input_tokens+output_tokens+cache_read+cache_write),0) FROM llm_usage WHERE task_id=$1::text) AS total`,[taskId])).rows[0];
    const traffic=JSON.stringify((await database.query('SELECT id,revision FROM task_traffic_endpoints WHERE task_id=$1 ORDER BY id',[taskId])).rows);
    const modeling=JSON.stringify((await database.query('SELECT m.system_id,m.version_id,t.status FROM task_business_models m LEFT JOIN tasks t ON t.id=m.modeling_task_id WHERE m.task_id=$1 ORDER BY m.system_id',[taskId])).rows);
    const fingerprint=String((await database.query('SELECT revision FROM task_fingerprint_state WHERE task_id=$1',[taskId])).rows[0]?.revision??'0');
    return {...row,progress:row.progress??'',revision:JSON.stringify([row.revision??'',row.progress??'',modeling,fingerprint,traffic,String((await database.query('SELECT revision FROM task_poc_state WHERE task_id=$1',[taskId])).rows[0]?.revision??'0')]),output:Number(row.output),total:Number(row.total)};
  }
  async observe(taskId:number,sample:ProgressSample):Promise<EfficiencyState>{
    return (await this.pool.query(`INSERT INTO task_efficiency_state(task_id,progress_signature,base_calls,base_output,base_total,review_signature)
      VALUES($1,$2,$3,$4,$6,$2) ON CONFLICT(task_id) DO UPDATE SET
        active_seconds=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN 0 ELSE task_efficiency_state.active_seconds+
          CASE WHEN $5 THEN 0 ELSE LEAST(45,GREATEST(0,extract(epoch FROM now()-task_efficiency_state.last_tick_at))) END END,
        base_calls=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN $3 ELSE task_efficiency_state.base_calls END,
        base_output=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN $4 ELSE task_efficiency_state.base_output END,
        base_total=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN $6 ELSE task_efficiency_state.base_total END,
        empty_rounds=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL OR task_efficiency_state.progress_signature<>$2 THEN 0 ELSE task_efficiency_state.empty_rounds END,
        last_progress_at=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL OR task_efficiency_state.progress_signature<>$2 THEN now() ELSE task_efficiency_state.last_progress_at END,
        plan_signature=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN '' ELSE task_efficiency_state.plan_signature END,
        review_active_seconds=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN 0 ELSE task_efficiency_state.review_active_seconds END,
        review_count=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN 0 ELSE task_efficiency_state.review_count END,
        review_signature=CASE WHEN task_efficiency_state.paused_reason IS NOT NULL THEN $2 ELSE task_efficiency_state.review_signature END,
        progress_signature=$2,last_tick_at=now(),paused_reason=NULL RETURNING *`,[taskId,sample.progress,sample.calls,sample.output,sample.approvals>0,sample.total??0])).rows[0];
  }
  async recordRound(taskId:number,sample:ProgressSample,plannedRevision=sample.revision):Promise<void>{
    await this.pool.query(`UPDATE task_efficiency_state SET plan_signature=$2,
      empty_rounds=CASE WHEN round_progress=$3 THEN empty_rounds+1 ELSE 0 END,round_progress=$3 WHERE task_id=$1`,[taskId,plannedRevision,sample.progress]);
  }
  /** A review is a renewable checkpoint, never a deadline for productive work.
   * CAS + audit commit together; a process restart cannot renew the same window twice. */
  async review(taskId:number,sample:ProgressSample):Promise<boolean>{
    if(!this.options.enabled||!this.options.reviewSeconds||sample.approvals)return false;
    const c=await this.pool.connect();
    try{await c.query('BEGIN');
      const before=(await c.query('SELECT review_signature FROM task_efficiency_state WHERE task_id=$1 FOR UPDATE',[taskId])).rows[0];
      const progressChanged=before?.review_signature!==sample.progress;
      const s=(await c.query(`UPDATE task_efficiency_state SET review_active_seconds=active_seconds,
        review_signature=$2,review_count=review_count+1
        WHERE task_id=$1 AND active_seconds-review_active_seconds >= $3
        AND EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND status='running' AND NOT paused AND NOT queued)
        RETURNING review_count`,[taskId,sample.progress,this.options.reviewSeconds])).rows[0];
      if(!s){await c.query('ROLLBACK');return false;}
      await c.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload)
        VALUES('task',$1,'task_efficiency_review',$2)`,[String(taskId),JSON.stringify({review:s.review_count,
          active:sample.active,calls:sample.calls,output:sample.output,total:sample.total??0,
          action:'continue',progressChanged,reason:progressChanged?'new_progress':sample.active?'work_in_flight':'awaiting_convergence'})]);
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async recordFailure(taskId:number):Promise<void>{
    await this.pool.query('UPDATE task_efficiency_state SET empty_rounds=empty_rounds+1 WHERE task_id=$1',[taskId]);
  }
  async resetIfSuspended(taskId:number):Promise<void>{
    await this.pool.query(`UPDATE task_efficiency_state SET active_seconds=0,empty_rounds=0,plan_signature='',
      last_tick_at=now(),last_progress_at=now(),paused_reason=NULL,
      base_calls=(SELECT count(*) FROM llm_usage WHERE task_id=$1::text),
      base_output=(SELECT COALESCE(sum(output_tokens),0) FROM llm_usage WHERE task_id=$1::text),
      base_total=(SELECT COALESCE(sum(input_tokens+output_tokens+cache_read+cache_write),0) FROM llm_usage WHERE task_id=$1::text),
      review_active_seconds=0,review_signature=progress_signature,review_count=0
      WHERE task_id=$1 AND paused_reason IS NOT NULL`,[taskId]);
    await this.pool.query("UPDATE tasks SET stopped_reason='' WHERE id=$1 AND NOT paused AND stopped_reason LIKE 'efficiency:%'",[taskId]);
    await this.pool.query('UPDATE task_efficiency_state SET last_tick_at=now() WHERE task_id=$1',[taskId]);
  }
  async pause(taskId:number,reason:string,sample:ProgressSample):Promise<boolean>{
    const c=await this.pool.connect();
    try{await c.query('BEGIN');
      const locked=(await c.query("SELECT id FROM tasks WHERE id=$1 AND status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL FOR UPDATE",[taskId])).rowCount;
      if(!locked){await c.query('ROLLBACK');return false;}
      const fresh=await this.sample(taskId,c),continuous=(await c.query('SELECT execution_mode FROM tasks WHERE id=$1',[taskId])).rows[0]?.execution_mode==='continuous',options=continuous?{...this.options,maxActiveSeconds:0}:this.options,state=(await c.query('SELECT * FROM task_efficiency_state WHERE task_id=$1',[taskId])).rows[0];
      if(!state||efficiencyDecision(state,fresh,options,Date.now())!==reason||reason==='no_new_evidence'&&fresh.progress!==sample.progress){await c.query('ROLLBACK');return false;}
      const t=(await c.query(`UPDATE tasks SET paused=TRUE,stopped_reason=$2,updated_at=now()
        WHERE id=$1 AND status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL RETURNING exploration_id`,[taskId,'efficiency:'+reason])).rows[0];
      if(!t){await c.query('ROLLBACK');return false;}
      await c.query('UPDATE task_efficiency_state SET paused_reason=$2 WHERE task_id=$1',[taskId,reason]);
      await this.summary(c,taskId,Number(t.exploration_id),'task_efficiency_paused',reason,fresh);
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async finishCovered(taskId:number):Promise<boolean>{
    const c=await this.pool.connect();
    try{await c.query('BEGIN');
      const t=(await c.query("SELECT exploration_id FROM tasks WHERE id=$1 AND execution_mode<>'continuous' AND status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL FOR UPDATE",[taskId])).rows[0];
      if(!t){await c.query('ROLLBACK');return false;}
      const goals=(await c.query("SELECT state,payload->'resolution' AS resolution FROM exploration_nodes WHERE task_id=$1 AND kind='goal'",[taskId])).rows;
      const active=(await c.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN('open','running','paused') LIMIT 1",[taskId])).rowCount;
      if(active||!goals.length||goals.some(g=>g.state!=='met'&&!['tested_negative','blocked'].includes(g.resolution?.outcome))){await c.query('ROLLBACK');return false;}
      if(!await fingerprintMayComplete(c,taskId)||!await pocMayComplete(c,taskId)){await c.query('COMMIT');return false;}
      const reason=goals.some(g=>g.resolution?.outcome==='blocked')?'conditions_missing':'coverage_complete';
      await saveTaskReport(c,taskId,'final',reason==='conditions_missing'?"Insufficient conditions, save existing results":"Appointment check completed");
      await c.query("UPDATE tasks SET status='done',completed_at=now(),stopped_reason=$2,updated_at=now() WHERE id=$1",[taskId,reason]);
      await c.query("UPDATE explorations SET status=CASE WHEN $2 THEN 'achieved' ELSE 'exhausted' END,updated_at=now() WHERE id=$1",[t.exploration_id,goals.every(g=>g.state==='met')]);
      await this.summary(c,taskId,Number(t.exploration_id),'task_done',reason,{goals});
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  private async summary(c:PoolClient,taskId:number,explorationId:number,event:string,reason:string,details:unknown):Promise<void>{
    const labels:Record<string,string>={active_time_budget:"The upper limit of running time of this round has been reached",model_call_budget:"The upper limit of model calling in this round has been reached.",output_token_budget:"Reached output budget for this round",total_token_budget:"Reached the total Token budget of this round",no_new_evidence:"No new evidence added in multiple rounds",conditions_missing:"Missing necessary test conditions",coverage_complete:"Appointment check completed"};
    const message=event==='task_efficiency_paused'?`Execution paused:${labels[reason]??reason}. The findings and evidence have been saved and can be continued after adding conditions or adjusting the budget.`
      :`The task has been completed:${labels[reason]??reason}. Tested undiscovered and insufficient conditions are recorded separately, which does not mean that all vulnerability targets have been confirmed.`;
    await c.query("INSERT INTO activity(exploration_id,worker,kind,summary,detail) VALUES($1,'system','text',$2,$3)",[explorationId,message,JSON.stringify({reason,details})]);
    await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,$2,$3)",[String(taskId),event,JSON.stringify({reason,details})]);
  }
}
