/** one persisted cursor shared by every task role. */
import type {Pool,PoolClient} from 'pg';
import {goLocalTime} from '../findings/reads.ts';
export interface TaskLLMTransition {previous_profile_id:number;next_profile_id:number|null;chain_exhausted:boolean;advanced:boolean;stale:boolean}
export interface TaskLLMEntry {profile_id:number;position:number;status:string;last_error?:string;exhausted_at?:string}
const numberOrNull=(v:unknown)=>v==null?null:Number(v);
export function isQuotaExhausted(message:string):boolean {
 const s=message.toLowerCase();
 if(/(?:status(?:\s+code)?|http(?:\s+status)?)\s*[=:]?\s*(?:401|403|5\d\d)\b/.test(s))return false;
 if(/\b(?:rpm|tpm|rpd|qps)\b|quota[_\s-]*metric|rate[_\s-]*limit|too many requests|(?:requests?|tokens?)\s+(?:per|\/)\s*(?:second|minute)|(?:per|\/)\s*(?:second|minute)\s*(?:requests?|tokens?)|generate[_\s-]*requests[_\s-]*per[_\s-]*(?:minute|second)|tokens?[_\s-]*per[_\s-]*(?:minute|second)/.test(s))return false;
 return ['insufficient_quota','quota_exceeded','quota exceeded','quota exhausted','exceeded your current quota','billing_hard_limit_reached','billing hard limit','billing_not_active','credit balance','insufficient credit','insufficient balance','balance is too low','payment required','status 402',"Insufficient balance","Insufficient quota","The quota has been exhausted","Arrears"].some(m=>s.includes(m))||s.includes('resource_exhausted');
}
export function truncateBytes(s:string,limit:number):string {let out='',n=0;for(const ch of s){const next=Buffer.byteLength(ch);if(n+next>limit)break;out+=ch;n+=next;}return out;}
export class TaskLLMChains {
 constructor(readonly pool:Pool){}
 async transaction<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await this.pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async state(id:number,c:Pool|PoolClient=this.pool){
  const task=(await c.query('SELECT active_llm_profile_id,llm_profile_id,llm_chain_revision FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];if(!task)throw new Error(`task ${id} not found`);
  const rows=(await c.query(`SELECT profile_id,position,status,COALESCE(last_error,'') last_error,exhausted_at,to_char(exhausted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') exhausted_iso FROM task_llm_profiles WHERE task_id=$1 ORDER BY position`,[id])).rows;
  const entries:TaskLLMEntry[]=rows.map(r=>({profile_id:Number(r.profile_id),position:r.position,status:r.status,...(r.last_error?{last_error:r.last_error}:{}),...(r.exhausted_at?{exhausted_at:goLocalTime(r.exhausted_iso)}: {})}));
  const active=numberOrNull(task.active_llm_profile_id),latest=rows.filter(r=>r.exhausted_at).sort((a,b)=>String(b.exhausted_iso).localeCompare(String(a.exhausted_iso)))[0];
  return {id:String(id),llm_profile_id:numberOrNull(task.llm_profile_id),llm_profile_ids:entries.map(e=>e.profile_id),active_llm_profile_id:active,llm_chain_revision:Number(task.llm_chain_revision),llm_failover_state:entries.length?(entries.some(e=>e.profile_id===active&&e.status==='ready')?'ready':'chain_exhausted'):'default',llm_failover_reason:latest?.last_error??'',entries};
 }
 async replace(id:number,ids:number[],active=0){
  if(ids.some((n,i)=>!Number.isSafeInteger(n)||n<=0||ids.indexOf(n)!==i))throw new Error("LLM configuration id is invalid or duplicate");
  return this.transaction(async c=>{
   if(!(await c.query('SELECT id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rowCount)throw new Error(`task ${id} not found`);
   for(const n of ids){const p=(await c.query('SELECT api_key FROM llm_profiles WHERE id=$1',[n])).rows[0];if(!p?.api_key)throw new Error(`LLM Configuration #${n} API Key does not exist or is not set`);}
   const next=ids.length?(active||ids[0]!):0;if(next&&!ids.includes(next))throw new Error(`active LLM profile ${next} is not in the task chain`);
   await c.query('DELETE FROM task_llm_profiles WHERE task_id=$1',[id]);for(const [position,p] of ids.entries())await c.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,$3)',[id,p,position]);
   await c.query('UPDATE tasks SET active_llm_profile_id=$2,llm_profile_id=$2,llm_chain_revision=llm_chain_revision+1 WHERE id=$1',[id,next||null]);
   const reopened=await c.query("UPDATE exploration_nodes SET state='open',blocked_reason=NULL,completed_at=NULL WHERE task_id=$1 AND kind='intent' AND state='blocked' AND blocked_reason='llm_quota_exhausted' RETURNING id",[id]);
   return {...await this.state(id,c),reopened_intents:reopened.rowCount??0};
  });
 }
 async exhaust(id:number,profile:number,revision:number,reason:string):Promise<TaskLLMTransition>{
  return this.transaction(async c=>{
   const task=(await c.query('SELECT active_llm_profile_id,llm_chain_revision,exploration_id FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!task)throw new Error(`task ${id} not found`);
   const out:TaskLLMTransition={previous_profile_id:profile,next_profile_id:null,chain_exhausted:false,advanced:false,stale:false};
   if(Number(task.llm_chain_revision)!==revision){out.stale=true;return out;}
   const entry=(await c.query('SELECT position,status FROM task_llm_profiles WHERE task_id=$1 AND profile_id=$2',[id,profile])).rows[0];if(!entry)return out;
   if(task.active_llm_profile_id==null){out.chain_exhausted=true;return out;}
   if(entry.status!=='quota_exhausted')await c.query("UPDATE task_llm_profiles SET status='quota_exhausted',last_error=$3,exhausted_at=now(),updated_at=now() WHERE task_id=$1 AND profile_id=$2",[id,profile,truncateBytes(reason.trim(),1000)]);
   if(Number(task.active_llm_profile_id)!==profile){out.next_profile_id=Number(task.active_llm_profile_id);return out;}
   const next=(await c.query("SELECT profile_id FROM task_llm_profiles WHERE task_id=$1 AND position>$2 AND status='ready' ORDER BY position LIMIT 1",[id,entry.position])).rows[0];
   out.advanced=true;out.next_profile_id=next?Number(next.profile_id):null;out.chain_exhausted=!next;
   await c.query('UPDATE tasks SET active_llm_profile_id=$2,llm_profile_id=$2,llm_chain_revision=llm_chain_revision+1 WHERE id=$1',[id,out.next_profile_id]);
   // Commit cursor and transition activity together, so concurrent errors emit once.
   const previous=await this.auditProfile(c,profile),following=out.next_profile_id?await this.auditProfile(c,out.next_profile_id):null;
   const summary=profileLabel(previous)+" Insufficient quota"+(following?", subsequent calls switch to "+profileLabel(following):", configuration chain exhausted");
   await c.query(`INSERT INTO activity(exploration_id,worker,kind,is_error,summary,detail,metadata) VALUES($1,'system',$2,$3,$4,$5,$6)`,[task.exploration_id,next?'llm_switch':'llm_failover',!next,summary,reason,JSON.stringify({llm_transition:{mode:next?'automatic':'exhausted',reason,previous,...(following?{next:following}:{})}})]);
   return out;
  });
 }
 async auditProfile(c:Pool|PoolClient,id:number){const p=(await c.query('SELECT id,name,format,model FROM llm_profiles WHERE id=$1',[id])).rows[0];return p?{...p,id:Number(p.id)}:{id,name:`Configuration #${id}`,format:'',model:''};}
}
export function profileLabel(p:{name:string;format?:string;model?:string}|null){if(!p)return "Default configuration";const d=[p.format,p.model].filter(Boolean);return p.name+(d.length?'（'+d.join(' / ')+'）':'');}
