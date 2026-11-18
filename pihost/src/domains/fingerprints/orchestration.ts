
import type {Pool} from 'pg';
import type {GateResult} from '../tools/gate.ts';
import {AssetContextService} from '../assets/context.ts';
import type {FingerprintService} from './service.ts';
import {explicitFingerprintURLs,fingerprintEvent} from './lifecycle.ts';
/** Bounded entrance acquisition; all traffic goes through the existing tool gate. */
export async function bootstrapFingerprints(pool:Pool,service:FingerprintService,taskId:number,signal:AbortSignal,execute:(url:string,signal:AbortSignal)=>Promise<GateResult>){
 if(!await service.enabled()||signal.aborted)return;
 await service.pin(taskId);
 const state=(await pool.query('SELECT bootstrap_finished_at FROM task_fingerprint_state WHERE task_id=$1',[taskId])).rows[0];if(state?.bootstrap_finished_at)return;
 const task=(await pool.query('SELECT goal,description,modeling_targets FROM tasks WHERE id=$1',[taskId])).rows[0];
 const scope=await new AssetContextService(pool).list(taskId,{dsl:'url="http"',type:'service',limit:20});
 const explicit=explicitFingerprintURLs(String(task.goal)+'\n'+String(task.description));
 const declared=Array.isArray(task.modeling_targets)?task.modeling_targets.flatMap((v:unknown)=>typeof v==='string'?explicitFingerprintURLs(v):[]):[];
 const urls=[...new Set([...explicit,...declared,...(scope.assets??[]).flatMap(a=>typeof a.url==='string'?explicitFingerprintURLs(a.url):[])])].slice(0,3);
 const started=(await pool.query("UPDATE task_fingerprint_state SET bootstrap_started_at=COALESCE(bootstrap_started_at,now()),bootstrap_state='running' WHERE task_id=$1 RETURNING bootstrap_started_at",[taskId])).rows[0];
 const deadline=new Date(started.bootstrap_started_at).getTime()+20000;
 const denied=(await pool.query("SELECT text FROM task_constraints WHERE task_id=$1 AND kind='deny'",[taskId])).rows.map(r=>String(r.text));
 await fingerprintEvent(pool,taskId,'fingerprint_bootstrap_started',{urls,budget_ms:20000,max_requests:3},"Fingerprint entry collection starts: up to 3 declared or scoped Web service entries");
 for(const url of urls){
  if(signal.aborted)return;if(!await service.enabled())break;
  await pool.query('INSERT INTO fingerprint_task_entries(task_id,url) VALUES($1,$2) ON CONFLICT DO NOTHING',[taskId,url]);
  const entry=(await pool.query('SELECT state FROM fingerprint_task_entries WHERE task_id=$1 AND url=$2',[taskId,url])).rows[0];if(['done','blocked','failed','skipped'].includes(entry.state))continue;
  const left=deadline-Date.now();const passiveOnly=denied.some(text=>/(?:仅|只)(?:能|允许|进行|做|限)?(?:进行|做)?(?:被动|离线)|(?:禁止|不得|不要)\s*(?:发送|发起)?\s*(?:任何)?\s*(?:主动)?\s*(?:HTTP|网络|目标)?\s*请求|(?:禁止|不得)联网|passive[- ]only|offline[- ]only|(?:do not|never|no|prohibit(?:ed)?|forbid(?:den)?)[ \t]+(?:send(?:ing)?|make|issue|initiate)?[ \t]*(?:(?:any|active|outbound|HTTP|network|target)[ \t]+)*(?:requests?|network access|internet access)/i.test(text));const deniedTarget=passiveOnly||denied.some(text=>text.includes(url)||text.includes(new URL(url).hostname));
  if(left<=0||deniedTarget){await pool.query("UPDATE fingerprint_task_entries SET state=$3,error=$4,updated_at=now() WHERE task_id=$1 AND url=$2",[taskId,url,deniedTarget?'blocked':'skipped',deniedTarget?"Goals or active requests overlap with explicit prohibition constraints, leaving it to the planner’s judgment":"The total budget for entrance collection has arrived"]);continue;}
  await pool.query("UPDATE fingerprint_task_entries SET state='running',updated_at=now() WHERE task_id=$1 AND url=$2",[taskId,url]);
  const context=AbortSignal.any([signal,AbortSignal.timeout(Math.min(left,8000))]);
  try{const result=await execute(url,context);const output=result.output as {status?:number}|undefined;await pool.query('UPDATE fingerprint_task_entries SET state=$3,http_status=$4,tool_call_id=$5,error=$6,updated_at=now() WHERE task_id=$1 AND url=$2',[taskId,url,result.status==='executed'?'done':'blocked',output?.status??null,result.toolCallId??null,result.error?.slice(0,400)??'']);}
  catch(e){await pool.query("UPDATE fingerprint_task_entries SET state='failed',error=$3,updated_at=now() WHERE task_id=$1 AND url=$2",[taskId,url,String(e).slice(0,400)]);}
 }
 if(signal.aborted)return;
 const pending=await service.waitForIdle(taskId,{budgetMs:Math.max(0,Math.min(6000,deadline-Date.now())),signal});
 const entries=(await pool.query('SELECT url,state,http_status,error FROM fingerprint_task_entries WHERE task_id=$1 ORDER BY created_at,url',[taskId])).rows;
 const gaps={entries:entries.filter(e=>e.state!=='done'),pending,reason:urls.length?'':"There is no clear Web URL or service entry within the scope, which will be supplemented by normal asset discovery."};
 await pool.query("UPDATE task_fingerprint_state SET bootstrap_finished_at=now(),bootstrap_state=$2,gaps=gaps||$3::jsonb WHERE task_id=$1",[taskId,gaps.entries.length||pending?'partial':'done',JSON.stringify({bootstrap:gaps})]);
 await fingerprintEvent(pool,taskId,'fingerprint_bootstrap_done',{entries,pending},urls.length?"Fingerprint entrance collection is completed, and the identification results and gaps will enter the first round of planning":"There is currently no web portal that can be collected. Normal planning continues.");
}
