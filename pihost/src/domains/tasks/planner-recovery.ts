import type {Pool} from 'pg';

export type PlannerOutcome='progress'|'waiting'|'idle'|'length'|'error'|undefined;
export type PlannerStrategy='normal'|'compact'|'single_gap'|'alternate'|'evidence';
export interface PlannerPlan {strategy:PlannerStrategy;failures:number;history:{strategy:string;outcome:string;at:string}[]}
export function plannerStrategy(failures:number):PlannerStrategy {
 return failures===0?'normal':failures===1?'compact':(['single_gap','alternate','evidence'] as const)[(failures-2)%3]!;
}
export function plannerRetryDelay(failures:number):number{return Math.min(300000,30000*2**Math.min(4,Math.max(0,failures-1)));}
export const plannerMessages:Record<PlannerStrategy,string>={normal:"The next round of inspections is being planned, and existing inspections will continue to be executed.",compact:"The context is being streamlined to continue planning, and existing checks continue to be executed.",single_gap:"Planning next steps around an unvalidated gap",alternate:"Looking for alternative inspection directions based on existing failure evidence",evidence:"Checking evidence gaps and execution conditions, preparing for next step of verification"};

export const plannerModelRevisionSQL=`md5(COALESCE((SELECT jsonb_agg(jsonb_build_array(id,updated_at) ORDER BY id)::text FROM llm_profiles),'[]') ||
      COALESCE((SELECT jsonb_agg(jsonb_build_array(profile_id,position) ORDER BY position)::text FROM task_llm_profiles WHERE task_id=$1),'[]'))`;

/** Meaningful graph changes wake a delayed planner; tool heartbeats and usage do not. */
export async function plannerRevisions(pool:Pool,taskId:number):Promise<{model:string;work:string;progress:string}>{
 const r=(await pool.query(`SELECT
  ${plannerModelRevisionSQL} AS model,
  md5(COALESCE((SELECT jsonb_agg(jsonb_build_array(id,kind,state,content_version,payload) ORDER BY id)::text FROM exploration_nodes
       WHERE task_id=$1 OR task_id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1)),'[]') ||
      COALESCE((SELECT jsonb_agg(jsonb_build_array(kind,text) ORDER BY id)::text FROM task_constraints WHERE task_id=$1),'[]') ||
      COALESCE((SELECT jsonb_build_array(goal,description,agent_key)::text FROM tasks WHERE id=$1),'[]')) AS work,
  md5(COALESCE((SELECT jsonb_agg(jsonb_build_array(id,kind,state,content_version,payload) ORDER BY id)::text FROM exploration_nodes WHERE task_id=$1 AND kind IN('goal','intent','fact','finding')),'[]')) AS progress`,[taskId])).rows[0];
 return {model:r.model,work:r.work,progress:r.progress};
}

/** At most two rounds per tick: initial truncation + changed-strategy recovery.
 * Subsequent attempts remain scheduled with durable capped backoff. */
export async function runPlannerRound(pool:Pool,taskId:number,attempt:(plan:PlannerPlan)=>Promise<PlannerOutcome>,admitted:()=>Promise<boolean>,clock:()=>number=Date.now):Promise<void>{
 if(!await admitted())return;
 let revisions=await plannerRevisions(pool,taskId);
 await pool.query(`INSERT INTO task_planner_recovery(task_id,model_revision,work_revision,next_attempt_at) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING`,[taskId,revisions.model,revisions.work,new Date(clock())]);
 const state=(await pool.query('SELECT * FROM task_planner_recovery WHERE task_id=$1',[taskId])).rows[0];
 const modelChanged=state.model_revision!==revisions.model,workChanged=state.work_revision!==revisions.work;
 if(!modelChanged&&!workChanged&&clock()<new Date(state.next_attempt_at).getTime())return;
 let failures=modelChanged?0:Number(state.failures),history:PlannerPlan['history']=state.history??[];
 for(let round=0;round<2;round++){
  if(!await admitted())return;
  const strategy=plannerStrategy(failures),plan={strategy,failures,history};
  // Reserve the eligible time before calling, so crashes retain the delay.
  await pool.query(`UPDATE task_planner_recovery SET model_revision=$2,work_revision=$3,blocked=FALSE,attempts=0,
   strategy=$4,message=$5,next_attempt_at=$6,last_outcome='planning',updated_at=now() WHERE task_id=$1`,
   [taskId,revisions.model,revisions.work,strategy,plannerMessages[strategy],new Date(clock()+plannerRetryDelay(failures))]);
  if(strategy!=='normal')await event(pool,taskId,'planner_recovering',{strategy,failures});
  const outcome=await attempt(plan);
  if(!await admitted()||!outcome)return;
  if(outcome==='progress'){await pool.query('DELETE FROM task_planner_recovery WHERE task_id=$1',[taskId]);return;}
  history=[...history,{strategy,outcome,at:new Date(clock()).toISOString()}].slice(-8);
  if(outcome!=='waiting')failures=Math.min(1000000,failures+1);
  const delay=outcome==='waiting'?60000:plannerRetryDelay(failures);
  const message=outcome==='waiting'?"There is already a check being executed, waiting for the results and reviewing the independent direction regularly":
   `${outcome==='length'?"Planning output truncated":outcome==='error'?"This round of planning call is not completed":"No new valid actions have been generated this round"}, approx. ${delay/1000} The switching planning strategy will continue after seconds; new evidence can wake up in advance`;
  await pool.query(`UPDATE task_planner_recovery SET failures=$2,history=$3,last_outcome=$4,message=$5,next_attempt_at=$6,updated_at=now() WHERE task_id=$1`,
   [taskId,failures,JSON.stringify(history),outcome,message,new Date(clock()+delay)]);
  await event(pool,taskId,outcome==='length'?'planner_truncated':'planner_review_scheduled',{strategy,outcome,failures,next_attempt_at:new Date(clock()+delay).toISOString()});
  if(outcome!=='length'||strategy!=='normal')return;
  revisions=await plannerRevisions(pool,taskId);
 }
}
async function event(pool:Pool,id:number,type:string,payload:Record<string,unknown>){
 await pool.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,$2,$3)",[String(id),type,JSON.stringify(payload)]);
}

/** Bound nested summaries including wide objects. Full constraints stay separate. */
export function compactPlannerContext(value:unknown,failures=1):unknown{
 let remaining=failures>=2?10000:18000;
 const textLimit=failures>=2?240:600,listLimit=failures>=2?4:8;
 function visit(v:unknown,depth=0):unknown{
  if(remaining<=0||depth>7)return {omitted:true};
  if(typeof v==='string'){const size=Math.min(textLimit,remaining),text=v.slice(0,size);remaining-=text.length;return v.length>size?text+"…(query details by ID)":text;}
  if(Array.isArray(v)){const out:unknown[]=[];for(const item of v.slice(0,listLimit)){if(remaining<100)break;out.push(visit(item,depth+1));}if(out.length<v.length)out.push({omitted:v.length-out.length});return out;}
  if(v&&typeof v==='object'){
   const entries=Object.entries(v),out:Record<string,unknown>={};let used=0;
   for(const [k,item] of entries){if(remaining<100||used>=24)break;remaining-=k.length+8;out[k]=visit(item,depth+1);used++;}
   if(used<entries.length)out._omitted_fields=entries.length-used;return out;
  }
  remaining-=16;return v;
 }
 return visit(value);
}
export function plannerRecoveryContext(overview:Record<string,any>,plan:PlannerPlan):unknown{
 if(plan.strategy==='normal')return overview;
 const goals=(overview.goals??[]).filter((g:any)=>g.state!=='met'&&!g.resolution);
 const focus=goals.length?goals[Math.max(0,plan.failures-2)%goals.length]:undefined;
 return compactPlannerContext({...overview,...(plan.failures>=2?{goals:focus?[focus]:overview.goals,other_goal_ids:goals.filter((g:any)=>g!==focus).map((g:any)=>g.id)}:{}),planning_memory:plan.history},plan.failures);
}
export function plannerRecoveryPrompt(plan:PlannerPlan):string{
 const common="All existing tool actions have been persisted. Check the current open/running and completed intentions and their results first to avoid repeated dispatch. The new intent should provide a stable test_key, hypothesis to be verified, stop_condition, and referenced facts/findings; retrying the completed direction must have new evidence. Don’t create findings out of thin air or repeat inspections to keep yourself busy. Dispatching feasible evidence supplementary checks when execution conditions are missing; existing Workers are waiting for the results and looking for independent directions when verifying the same problem.";
 const actions:Record<PlannerStrategy,string>={normal:"Incorporate the latest evidence to advance unmet goals.",compact:"The previous round was not completed or there were no valid actions. Streamline planning and give priority to submitting up to two unexecuted checks through the tool.",single_gap:"Only one selected unverified gap will be processed in this round, and a minimum executable check will be submitted through the tool as soon as possible.",alternate:"The previous planning method has not been advanced. Depending on the fact that the check has completed/failed, choose a different approach or independent direction to explain how the new check differs from the old check.",evidence:"Review the gap between the target and the evidence, prioritizing the dispatch of minimum checks that verify the premise, negative controls, or missing evidence. Use tools to solve goals when supported by facts; missing conditions should be clearly documented and do not declare success."};
 return `[Continuous planning:${plan.strategy}】${actions[plan.strategy]}\n${common}
Recent planning memory:${JSON.stringify(plan.history)}`;
}
