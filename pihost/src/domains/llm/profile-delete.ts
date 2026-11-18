/** Profile deletion uses child-first lock ordering and preserves task cursors. */
import type {Pool,PoolClient} from 'pg';
export class ProfileDeleteError extends Error{constructor(readonly status:number,message:string){super(message);}}
const tasksSQL=`SELECT t.id FROM tasks t WHERE t.llm_profile_id=$1 OR t.active_llm_profile_id=$1 OR EXISTS(SELECT 1 FROM task_llm_profiles x WHERE x.task_id=t.id AND x.profile_id=$1) ORDER BY t.id FOR UPDATE OF t`;
const refsSQL=`SELECT ref_kind,ref_id FROM (SELECT 'task' ref_kind,t.id ref_id FROM tasks t WHERE t.llm_profile_id=$1 OR t.active_llm_profile_id=$1 OR EXISTS(SELECT 1 FROM task_llm_profiles x WHERE x.task_id=t.id AND x.profile_id=$1) UNION ALL SELECT 'agent',id FROM agents WHERE llm_profile_id=$1 UNION ALL SELECT 'conversation',id FROM conversations WHERE llm_profile_id=$1) refs ORDER BY ref_kind,ref_id`;
async function attempt(c:PoolClient,id:number):Promise<number[]|null>{
 const locked=new Map<string,Set<number>>();
 for(const [kind,sql] of [['task',tasksSQL],['agent','SELECT id FROM agents WHERE llm_profile_id=$1 ORDER BY id FOR UPDATE'],['conversation','SELECT id FROM conversations WHERE llm_profile_id=$1 ORDER BY id FOR UPDATE']])locked.set(kind!,new Set((await c.query(sql!,[id])).rows.map(r=>Number(r.id))));
 const p=(await c.query('SELECT is_default FROM llm_profiles WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!p)throw new ProfileDeleteError(404,'LLM profile not found');if(p.is_default)throw new ProfileDeleteError(409,"The currently activated LLM configuration cannot be deleted, please activate other configurations first");
 for(const r of (await c.query(refsSQL,[id])).rows)if(!locked.get(r.ref_kind)?.has(Number(r.ref_id)))return null;
 const affected=(await c.query('SELECT x.task_id,x.position,COALESCE(t.active_llm_profile_id=$1,false) was_active FROM task_llm_profiles x JOIN tasks t ON t.id=x.task_id WHERE x.profile_id=$1 ORDER BY x.task_id',[id])).rows;
 await c.query('DELETE FROM llm_profiles WHERE id=$1',[id]);
 for(const t of affected){if(!t.was_active){await c.query('UPDATE tasks SET llm_chain_revision=llm_chain_revision+1 WHERE id=$1',[t.task_id]);continue;}
  const next=(await c.query("SELECT profile_id FROM task_llm_profiles WHERE task_id=$1 AND position>$2 AND status='ready' ORDER BY position LIMIT 1",[t.task_id,t.position])).rows[0];
  if(!next)await c.query('DELETE FROM task_llm_profiles WHERE task_id=$1',[t.task_id]);
  await c.query('UPDATE tasks SET active_llm_profile_id=$2,llm_profile_id=$2,llm_chain_revision=llm_chain_revision+1 WHERE id=$1',[t.task_id,next?.profile_id??null]);
 }
 return [...locked.get('task')!];
}
export async function deleteBoundProfile(pool:Pool,id:number){
 const deadline=Date.now()+15000;
 for(let n=0;n<8;n++){
  const c=await pool.connect();try{await c.query('BEGIN');const remaining=deadline-Date.now();if(remaining<=0)throw new ProfileDeleteError(409,"Timeout waiting for LLM configuration reference release, please try again");await c.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);
   const ids=await attempt(c,id);if(ids===null){await c.query('ROLLBACK');continue;}await c.query('COMMIT');return ids;
  }catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='57014')throw new ProfileDeleteError(409,"Timeout waiting for LLM configuration reference release, please try again");throw e;}finally{c.release();}
 }
 throw new ProfileDeleteError(409,"LLM configuration is being modified by a task or session, please try again");
}
