import type {Pool,PoolClient} from 'pg';
export class MeterQueryError extends Error{}
const sources=['all','task','modeling','conversation','other'];
function parse(query:URLSearchParams){
 const days=Number(query.get('days')??30),profile=query.get('profile')??'all',source=query.get('source')??'all',task=query.get('task')??'';
 const page=Number(query.get('page')??1),size=Number(query.get('page_size')??25);
 if(!Number.isInteger(days)||days<0||days>3650)throw new MeterQueryError("Time range must be 0–3650 days, 0 means all");
 if(profile.length>200||!sources.includes(source)||task.length>80)throw new MeterQueryError("Usage filter is invalid");
 if(!Number.isInteger(page)||page<1||!Number.isInteger(size)||size<1||size>100)throw new MeterQueryError("Invalid paging parameter");
 return {days,profile,source,task,page,size};
}
const meterSQL=`
WITH attributed AS (
 SELECT u.*,COALESCE(NULLIF(u.task_id,''),c.task_id::text) resolved_task_id
 FROM llm_usage u LEFT JOIN conversations c ON u.business_kind='chat' AND c.id::text=u.business_id
), meter AS (
 SELECT a.*,t.name task_name,
 CASE WHEN a.profile_id IS NOT NULL THEN 'profile:'||a.profile_id::text
      WHEN NULLIF(a.profile_name,'') IS NOT NULL THEN 'historical:'||a.profile_name ELSE 'unassigned' END profile_key,
 COALESCE(NULLIF(p.name,''),NULLIF(a.profile_name,''),CASE WHEN a.profile_id IS NOT NULL THEN 'Configuration #'||a.profile_id::text||' (deleted)' ELSE 'Unowned configuration' END) display_profile,
 CASE WHEN t.kind='modeling' OR a.worker='modeler' THEN 'modeling'
      WHEN NULLIF(a.resolved_task_id,'') IS NOT NULL THEN 'task'
      WHEN a.business_kind IN('chat','conversation','mainagent','auto') THEN 'conversation' ELSE 'other' END source
 FROM attributed a LEFT JOIN tasks t ON t.id::text=a.resolved_task_id
 LEFT JOIN llm_profiles p ON p.id=a.profile_id
), bounds AS (
 SELECT CASE WHEN $1::int=0 THEN COALESCE((SELECT min((ts AT TIME ZONE 'Asia/Shanghai')::date) FROM meter),(now() AT TIME ZONE 'Asia/Shanghai')::date)
 ELSE (now() AT TIME ZONE 'Asia/Shanghai')::date-($1::int-1) END start_day,
 (now() AT TIME ZONE 'Asia/Shanghai')::date end_day
), filtered AS (
 SELECT m.* FROM meter m CROSS JOIN bounds b
 WHERE m.ts >= (b.start_day::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND m.ts < ((b.end_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($2::text='all' OR m.profile_key=$2)
 AND ($3::text='all' OR m.source=$3)
 AND ($4::text='' OR m.resolved_task_id=$4)
)`;
const counts=`
 COALESCE(sum(input_tokens),0)::bigint input_tokens,
 COALESCE(sum(output_tokens),0)::bigint output_tokens,
 COALESCE(sum(cache_read),0)::bigint cache_read_tokens,
 COALESCE(sum(cache_write),0)::bigint cache_write_tokens,
 COALESCE(sum(input_tokens::bigint+output_tokens::bigint+cache_read::bigint+cache_write::bigint),0)::bigint total_tokens,
 count(*)::int calls,count(DISTINCT NULLIF(resolved_task_id,''))::int tasks,
 count(*) FILTER(WHERE status='error')::int failed_calls`;
const numeric=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','total_tokens','calls','tasks','failed_calls','profile_id','id'];
function dto(row:Record<string,any>){
 return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value!==null&&numeric.includes(key)?Number(value):value]));
}
/** Aggregates share a read-only repeatable-read snapshot and one filter. */
export class TokenMeter{
 constructor(private pool:Pool){}
 private async snapshot<T>(fn:(db:PoolClient)=>Promise<T>){
  const db=await this.pool.connect();
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const out=await fn(db);await db.query('COMMIT');return out;}
  catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async usage(query:URLSearchParams){
  const q=parse(query),args=[q.days,q.profile,q.source,q.task];
  return this.snapshot(async db=>{
   const summary=dto((await db.query(meterSQL+' SELECT '+counts+' FROM filtered',args)).rows[0]);
   const daily=(await db.query(meterSQL+`
    , days AS (SELECT generate_series(start_day::timestamp,end_day::timestamp,interval '1 day')::date AS bucket_day FROM bounds),
    totals AS (SELECT (ts AT TIME ZONE 'Asia/Shanghai')::date AS bucket_day,${counts} FROM filtered GROUP BY 1)
    SELECT to_char(d.bucket_day,'YYYY-MM-DD') date,COALESCE(t.input_tokens,0) input_tokens,
    COALESCE(t.output_tokens,0) output_tokens,COALESCE(t.cache_read_tokens,0) cache_read_tokens,
    COALESCE(t.cache_write_tokens,0) cache_write_tokens,COALESCE(t.total_tokens,0) total_tokens,COALESCE(t.calls,0) calls
    FROM days d LEFT JOIN totals t ON t.bucket_day=d.bucket_day ORDER BY d.bucket_day`,args)).rows.map(dto);
   const by_profile=(await db.query(meterSQL+' SELECT profile_key,max(display_profile) profile_name,max(profile_id) profile_id,'+counts+' FROM filtered GROUP BY profile_key ORDER BY total_tokens DESC',args)).rows.map(dto);
   const period=(await db.query(meterSQL+` SELECT to_char(start_day,'YYYY-MM-DD') start,to_char(end_day,'YYYY-MM-DD') end,
    (SELECT to_char(min(ts) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') FROM meter) available_since FROM bounds`,args)).rows[0];
   const profiles=(await db.query(meterSQL+` SELECT profile_key key,max(display_profile) name,max(profile_id) profile_id
    FROM meter GROUP BY profile_key UNION SELECT 'profile:'||p.id::text,p.name,p.id FROM llm_profiles p
    WHERE NOT EXISTS(SELECT 1 FROM meter m WHERE m.profile_id=p.id) ORDER BY name`,args)).rows.map(dto);
   const tasks=(await db.query(meterSQL+` SELECT resolved_task_id id,COALESCE(NULLIF(max(task_name),''),'Task #'||resolved_task_id) name
    FROM meter WHERE NULLIF(resolved_task_id,'') IS NOT NULL GROUP BY resolved_task_id ORDER BY max(ts) DESC`,args)).rows;
   const by_source=(await db.query(meterSQL+' SELECT source,'+counts+' FROM filtered GROUP BY source ORDER BY source',args)).rows.map(dto);
   return {summary,daily,by_profile,by_source,profiles,tasks,period:{...period,days:q.days,timezone:'Asia/Shanghai'},filters:q};
  });
 }
 async calls(query:URLSearchParams){
  const q=parse(query),args=[q.days,q.profile,q.source,q.task];
  return this.snapshot(async db=>{
   const total=Number((await db.query(meterSQL+' SELECT count(*)::bigint total FROM filtered',args)).rows[0].total);
   const rows=(await db.query(meterSQL+` SELECT id,ts,profile_id,profile_key,display_profile profile_name,model,source,
    resolved_task_id task_id,task_name,worker,status,input_tokens,output_tokens,cache_read cache_read_tokens,
    cache_write cache_write_tokens,(input_tokens::bigint+output_tokens::bigint+cache_read::bigint+cache_write::bigint)::bigint total_tokens
    FROM filtered ORDER BY ts DESC,id DESC LIMIT $5 OFFSET $6`,[...args,q.size,(q.page-1)*q.size])).rows.map(dto);
   return {items:rows,total,page:q.page,page_size:q.size};
  });
 }
}
