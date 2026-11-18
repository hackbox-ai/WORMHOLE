import {networkBinding} from '../network/binding.ts';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {domainToASCII} from 'node:url';
import type {Pool} from 'pg';
import {TaskService} from './service.ts';
import {readEfficiencyOptions} from './efficiency-settings.ts';
import {SettingsService} from '../settings/service.ts';

export interface BatchTarget {line:number;input:string;target:string;host:string;kind:'domain'|'ip'|'url'}
export function parseBatchTargets(text:unknown){
 if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw new Error("Please enter target, maximum 1 MiB");
 const lines=text.split(/\r?\n/);if(lines.filter(s=>s.trim()).length>500)throw new Error("Maximum of 500 targets per batch");
 const items:BatchTarget[]=[],errors:{line:number;input:string;error:string}[]=[],duplicates:{line:number;input:string}[]=[],seen=new Set<string>();
 for(const [i,raw] of lines.entries()){
  const input=raw.trim();if(!input)continue;
  try{
   if(input.length>2048||/\s|[\\\u0000-\u001f]/.test(input))throw new Error("Address cannot contain spaces or backslashes");
   let kind:BatchTarget['kind']='domain',target='',host='';
   if(/^https?:\/\//i.test(input)||(!isIP(input)&&/[:/]/.test(input))){
    const url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input)?input:'http://'+input);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)throw new Error("Only HTTP/HTTPS URLs without embedded credentials are supported");
    url.hash='';host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();target=url.href;kind='url';
   }else if(isIP(input)){host=input.toLowerCase();target=isIP(input)===6?new URL('http://['+input+']/').hostname.slice(1,-1):input;host=target;kind='ip';}
   else{host=domainToASCII(input.replace(/\.$/,'')).toLowerCase();target=host;}
   if(/^\d+(?:\.\d+){3}$/.test(host)&&!isIP(host))throw new Error("Invalid IP");
   if(!isIP(host)&&(!host||host.length>253||host.split('.').some(label=>!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))))throw new Error("Invalid domain name or IP");
   const key=kind+':'+target;if(seen.has(key)){duplicates.push({line:i+1,input});continue;}seen.add(key);items.push({line:i+1,input,target,host,kind});
  }catch(e){errors.push({line:i+1,input,error:e instanceof Error?e.message:"Invalid address"});}
 }
 return {items,errors,duplicates};
}
export const discoveryGoal=(t:BatchTarget,requirements:string,seconds:number)=>`Test target:${t.target}
Execution time limit: after actual startup ${seconds} seconds, controlled by host deadline.

Continuously discover, analyze and verify security issues within the scope and time limit of this task authorization, improve effective coverage as much as possible, and discover more independent vulnerabilities with real evidence. There is no minimum or maximum number of vulnerabilities, and it does not end with the discovery of one or a few vulnerabilities. After a certain direction is completed, continue to advance in a direction that has not yet been covered and has evidence. Check applicable conditions with actual responses, fingerprints, and PoC knowledge. Each discovery retains recurrence evidence, impact, and discovery path; affected locations with the same root cause are merged, and repeated counting is not performed. Distinguish between unverified leads, insufficient conditions, and true negatives. Reuse existing results and do not repeat closed directions without new evidence. When there is no new direction to execute, the planner calls finish_discovery to request convergence citing actual evidence; prove_goal or goal_met must not be used to terminate the entire continuous mining task in advance. After receiving the deadline notice, stop adding new tests, save the evidence, unfinished directions and blocking conditions and summarize them.
Only the targets stated in this task will be processed and will not be automatically extended to other targets in the same batch.

${requirements?"Additional requirements:\n"+requirements:''}`;

type Snapshots=()=>Promise<{fingerprint?:string;poc?:string}>;
export class TaskBatches {
 constructor(private pool:Pool,private tasks:TaskService,private snapshots:Snapshots=async()=>({})){}
 async options(){const efficiency=await readEfficiencyOptions(this.pool);const row=(await this.pool.query("SELECT value FROM app_settings WHERE key='settings.batch_task_timeout_seconds'")).rows[0];return {timeout_seconds:Math.max(60,Math.min(86400,efficiency.maxActiveSeconds||Number(row?.value)||1800)),concurrency:3,workers:Number((await new SettingsService(this.pool,'').payload()).workers),max_targets:500};}
 async create(body:Record<string,unknown>){
  const parsed=parseBatchTargets(body.targets);if(parsed.errors.length||!parsed.items.length)throw new Error(parsed.errors.length?`No. ${parsed.errors[0]!.line} Line:${parsed.errors[0]!.error}`:"Fill in at least one valid goal");
  const id=String(body.idempotency_key??'');if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))throw new Error("Missing valid commit number");
  const seconds=Number(body.timeout_seconds);if(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400)throw new Error("Single task timeout needs to be 1–1440 minutes");
  const requirements=String(body.requirements??'').trim();if(requirements.length>8000)throw new Error("Supplementary requirements must be up to 8000 words");
  const profiles=body.llm_profile_ids??[];if(!Array.isArray(profiles)||profiles.some((v,i)=>!Number.isSafeInteger(v)||v<=0||profiles.indexOf(v)!==i))throw new Error("Invalid model configuration");
  const hash=createHash('sha256').update(JSON.stringify({targets:parsed.items.map(t=>t.target),requirements,seconds,profiles,network_mode:body.network_mode,network_channel_id:body.network_channel_id})).digest('hex');
  const snapshot=await this.snapshots(),c=await this.pool.connect();
  try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);const prior=(await c.query('SELECT id,request_hash FROM task_batches WHERE id=$1',[id])).rows[0];
   if(prior){if(prior.request_hash!==hash)throw new Error("Commit number is already used for something else");await c.query('COMMIT');return {id,duplicate:true,total:parsed.items.length};}
   const network=await networkBinding(c,body);
   await c.query('INSERT INTO task_batches(id,request_hash,name,total,timeout_seconds,fingerprint_snapshot,poc_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,hash,"Batch task "+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),parsed.items.length,seconds,snapshot.fingerprint??null,snapshot.poc??null]);
   for(const [position,t] of parsed.items.entries()){
    const result=await this.tasks.create({name:t.target,goal:discoveryGoal(t,requirements,seconds),description:`Batch target ${position+1}：${t.target}`,queued:true,network_mode:network.mode as 'standard'|'jump',network_channel_id:network.channelId,timeout_seconds:seconds,llm_profile_ids:profiles,plan_heartbeat_seconds:600},c);
    if(!result.ok)throw new Error(result.error);const task=Number(result.task.id),eid=result.task.exploration_id;
    await c.query("UPDATE tasks SET batch_id=$2,batch_position=$3,target_input=$4,execution_mode='continuous',worker_limit=NULL,queue_mode='bootstrap' WHERE id=$1",[task,id,position+1,t.target]);
    await c.query("INSERT INTO task_constraints(task_id,exploration_id,kind,text,origin) VALUES($1,$2,'deny','It is prohibited to exceed the declared test range of the current task, and requests for other batch task targets are not allowed.','human')",[task,eid]);
    if(isIP(t.host))await c.query("INSERT INTO task_scope(task_id,kind,net,source,reason) VALUES($1,'ip',$2::inet::cidr,'manual','Batch submission target')",[task,t.host+'/'+(isIP(t.host)===4?32:128)]);
    else await c.query("INSERT INTO task_scope(task_id,kind,domain,source,reason) VALUES($1,'subdomain',$2,'manual','Batch submission target')",[task,t.host]);
    if(snapshot.fingerprint)await c.query('INSERT INTO task_fingerprint_state(task_id,snapshot_id) VALUES($1,$2)',[task,snapshot.fingerprint]);
    if(snapshot.poc)await c.query('INSERT INTO task_poc_state(task_id,snapshot_id) VALUES($1,$2)',[task,snapshot.poc]);
   }
   await c.query('COMMIT');return {id,duplicate:false,total:parsed.items.length};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async list(){return (await this.pool.query(`SELECT b.*,count(t.id) FILTER(WHERE t.queued AND NOT t.paused)::int waiting,count(t.id) FILTER(WHERE t.status='running' AND NOT t.queued AND NOT t.paused)::int running,count(t.id) FILTER(WHERE t.paused AND t.status NOT IN('done','failed','timeout'))::int paused_tasks,count(t.id) FILTER(WHERE t.status='done')::int done,count(t.id) FILTER(WHERE t.status IN('failed','timeout'))::int failed FROM task_batches b LEFT JOIN tasks t ON t.batch_id=b.id AND t.deleted_at IS NULL GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`)).rows;}
 async detail(id:string){const batch=(await this.pool.query('SELECT * FROM task_batches WHERE id=$1',[id])).rows[0];if(!batch)return null;const tasks=(await this.pool.query(`SELECT t.id,t.name,t.target_input,t.batch_position,t.status,t.paused,t.queued,t.first_run_at,t.deadline_at,t.stopped_reason,(SELECT count(*)::int FROM findings f WHERE f.task_id=t.id) findings FROM tasks t WHERE t.batch_id=$1 AND t.deleted_at IS NULL ORDER BY t.batch_position`,[id])).rows;return {batch,tasks};}
}
