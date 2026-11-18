import type {Pool} from 'pg';
import {normalizedRequestBody} from '../llm/profile-wire.ts';
import {packRecordBodies,expandRecordBodies} from '../../storage/record-body.ts';
import type {ModelCallPerformance} from './call-performance.ts';
export interface LlmCallEntry{
 model:string;profileId:number|null;profileName:string;sessionId:string;taskId:string;worker:string;explorationId:number|null;
 input:number;output:number;cacheRead:number;cacheWrite:number;latencyMs:number;status:'ok'|'error';error:string;stopReason:string;
 text:string;thinking:string;rawRequest:string;rawResponse:string;requestBody?:string;performance?:ModelCallPerformance;
}
const summary=['id','ts','model','profile_name','session_id','task_id','worker','latency_ms','input_tokens','output_tokens','cache_read','cache_write','status','error'];
const bodies=['request_body','response_body','raw_request','raw_response'];
function dto(row:Record<string,any>,detail=false):Record<string,unknown>{const out:Record<string,unknown>={};for(const key of summary){if(key==='error'&&!row[key])continue;out[key]=key==='id'?Number(row[key]):key==='ts'?row[key]:['latency_ms','input_tokens','output_tokens','cache_read','cache_write'].includes(key)?Number(row[key]??0):row[key]??'';}if(detail&&row.workspace_cleaned_at)out.workspace_cleaned_at=row.workspace_cleaned_at;if(detail)for(const key of bodies)if(row[key])out[key]=row[key];return out;}
export class LlmRecords {
 constructor(readonly pool:Pool){}
 /** F07 Write path (compare llmrec.record/recordUsage）：usage Hengji (empty model and all zeros skipped）；bodies Accept recordingEnabled Gating。 */
 async recordCall(e:LlmCallEntry,recordingEnabled:boolean,businessKind='chat'):Promise<void>{
  const empty=!e.model&&e.input===0&&e.output===0&&e.cacheRead===0&&e.cacheWrite===0;
  if(!empty)await this.pool.query(
   `INSERT INTO llm_usage (model,profile_id,business_kind,business_id,input_tokens,output_tokens,cache_read,cache_write,task_id,exploration_id,worker,profile_name,latency_ms,status,performance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,NULLIF($11,''),NULLIF($12,''),$13,$14,$15)`,
   [e.model,e.profileId,businessKind,e.sessionId,e.input,e.output,e.cacheRead,e.cacheWrite,e.taskId,e.explorationId,e.worker,e.profileName,e.latencyMs,e.status,e.performance?JSON.stringify(e.performance):null]);
  if(!recordingEnabled)return;
  const requestBody=e.requestBody??normalizedRequestBody(e.rawRequest);
  const responseBody=JSON.stringify({text:e.text,stop_reason:e.stopReason,usage:{input_tokens:e.input,output_tokens:e.output,cache_read_tokens:e.cacheRead,cache_write_tokens:e.cacheWrite},...(e.thinking?{thinking:e.thinking}:{})});
  let packed:Awaited<ReturnType<typeof packRecordBodies>>|undefined;
  try{packed=await packRecordBodies({request_body:requestBody||null,response_body:responseBody||null,raw_request:e.rawRequest||null,raw_response:e.rawResponse||null});}
  catch{console.warn('[storage] recording compression failed; retaining original text bodies');}
  const bodyColumns=packed?['body_storage','body_codec','body_raw_bytes','body_sha256']:['request_body','response_body','raw_request','raw_response'];
  const bodyValues=packed?[packed.bytes,packed.codec,packed.rawBytes,packed.hash]:[requestBody||null,responseBody||null,e.rawRequest||null,e.rawResponse||null];
  await this.pool.query(
   `INSERT INTO llm_records (model,profile_id,business_kind,business_id,request_text,response_text,input_tokens,output_tokens,is_error,error_text,
     profile_name,session_id,task_id,worker,latency_ms,cache_read,cache_write,status,error,${bodyColumns.join(',')})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),$12,NULLIF($13,''),NULLIF($14,''),$15,$16,$17,$18,NULLIF($19,''),$20,$21,$22,$23)`,
   [e.model,e.profileId,businessKind,e.sessionId,packed?'':requestBody??'',packed?'':responseBody??'',e.input,e.output,e.status==='error',e.error??'',
    e.profileName,e.sessionId,e.taskId,e.worker,e.latencyMs,e.cacheRead,e.cacheWrite,e.status,e.error||null,
    ...bodyValues]);
 }
 async list(filter:{model?:string;session?:string;task?:string},page=0,size=50){if(size<=0)size=50;if(page<0)page=0;const terms=['true'],args:unknown[]=[];
  if(filter.model){args.push(filter.model);terms.push(`model=$${args.length}`);}if(filter.session){args.push('%'+filter.session+'%');terms.push(`session_id ILIKE $${args.length}`);}if(filter.task){args.push(filter.task);terms.push(`COALESCE(task_id,'')=$${args.length}`);}const where=' WHERE '+terms.join(' AND '),total=Number((await this.pool.query('SELECT count(*) FROM llm_records'+where,args)).rows[0].count);
  const rows=(await this.pool.query('SELECT '+summary.join(',')+' FROM llm_records'+where+` ORDER BY id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,size,page*size])).rows;return {records:rows.map(r=>dto(r)),total};
 }
 async detail(id:number|string){const row=(await this.pool.query('SELECT '+[...summary,...bodies,'body_storage','body_codec','body_raw_bytes','body_sha256','workspace_cleaned_at'].join(',')+' FROM llm_records WHERE id=$1',[id])).rows[0];return row?dto(await expandRecordBodies(row),true):null;}
 async tasks():Promise<{task_id:string;count:number}[]|null>{const rows=(await this.pool.query("SELECT task_id,count(*) AS count FROM llm_records WHERE COALESCE(task_id,'')<>'' GROUP BY task_id ORDER BY max(id) DESC")).rows;return rows.length?rows.map(r=>({task_id:r.task_id,count:Number(r.count)})):null;}
 async remove(task:string):Promise<number>{return (await this.pool.query("DELETE FROM llm_records WHERE COALESCE(task_id,'')=$1",[task])).rowCount??0;}
 async models(task:string){return (await this.pool.query("SELECT COALESCE(NULLIF(model,''),'(unknown)') AS model,count(*)::int AS calls,COALESCE(sum(input_tokens),0)::bigint AS input_tokens,COALESCE(sum(output_tokens),0)::bigint AS output_tokens,COALESCE(sum(cache_read),0)::bigint AS cache_read_tokens,COALESCE(sum(cache_write),0)::bigint AS cache_write_tokens FROM llm_usage WHERE COALESCE(task_id,'')=$1 GROUP BY model ORDER BY sum(input_tokens)+sum(output_tokens) DESC,model",[task])).rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='model'?v:Number(v)])));}
}
