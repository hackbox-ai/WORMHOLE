import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {pendingReviews,reviewDetail,historyReviews} from '../domains/intercept/reviews.ts';
import {activityDTO} from '../domains/activity/service.ts';
import {judgeConfig,JUDGE_SETTING_KEYS,type JudgeConfig} from '../domains/tools/judge.ts';
export const DEFAULT_INTERCEPT_TOOLS=['Bash','WebFetch','web_search','shell_open','shell_send','Write','Edit','MultiEdit'];
const unavailable="Uniquely associated original tool call not found; record may have been deleted, or old approval does not have associated ID saved";
export async function routeInterceptReviews(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,data:unknown)=>void):Promise<boolean>{
 const path=url.pathname,method=req.method;
 if(!path.startsWith('/api/intercept/'))return false;
 try{
  if(path==='/api/intercept/tool-config'&&method==='GET'){
   const row=(await ctx.pool.query("SELECT value FROM app_settings WHERE key='intercept_enabled_tools'")).rows[0];let tools:unknown=DEFAULT_INTERCEPT_TOOLS;
   if(row)try{tools=JSON.parse(row.value);}catch{tools=[];}
   json(res,200,{enabled_tools:tools});return true;
  }
  if(path==='/api/intercept/tool-config'&&method==='PUT'){
   const body=await readObject(req,1024*1024,true),value=body.enabled_tools??[];
   if(!Array.isArray(value)||value.some(v=>v!==null&&typeof v!=='string')){json(res,400,{error:`json: cannot unmarshal ${Array.isArray(value)?typeof value.find(v=>v!==null&&typeof v!=='string'):typeof value} into Go struct field .enabled_tools of type ${Array.isArray(value)?'string':'[]string'}`});return true;}
   await ctx.pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(value.map(v=>v??''))]);json(res,200,{ok:true});return true;
  }
  if(path==='/api/intercept/judge'&&method==='GET'){json(res,200,await judgeConfig(ctx.pool));return true;}
  if(path==='/api/intercept/judge'&&method==='PUT'){
   const body=await readObject(req,1024*1024,true);
   if(!['allow','ask','deny'].includes(body.fail_action)){json(res,400,{error:"fail_action must be allow, ask, or deny"});return true;}
   if(!['allow','deny'].includes(body.ask_timeout_action)){json(res,400,{error:"ask_timeout_action must be allow or deny"});return true;}
   const input:JudgeConfig={enabled:body.enabled??false,profile_id:body.profile_id??0,prompt:body.prompt??'',timeout_seconds:body.timeout_seconds??0,fail_action:body.fail_action,ask_timeout_seconds:body.ask_timeout_seconds??0,ask_timeout_action:body.ask_timeout_action};
   for(const [key,value] of Object.entries(input)){const kind=key==='enabled'?'boolean':['profile_id','timeout_seconds','ask_timeout_seconds'].includes(key)?'number':'string';if(typeof value!==kind||kind==='number'&&!Number.isSafeInteger(value)){json(res,400,{error:`json: cannot unmarshal ${typeof value} into Go struct field JudgeConfig.${key} of type ${kind==='number'?(key==='profile_id'?'int64':'int'):kind==='boolean'?'bool':kind}`});return true;}}
   const db=await ctx.pool.connect();try{await db.query('BEGIN');for(const [field,key] of Object.entries(JUDGE_SETTING_KEYS))await db.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[key,String(input[field as keyof JudgeConfig])]);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   json(res,200,{ok:true});return true;
  }
  if(path==='/api/intercept/judge/usage'&&method==='GET'){
   const n=Number(url.searchParams.get('days')??30),days=Number.isSafeInteger(n)&&n>0?n:30;
   const numeric=(r:any)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='date'?v:Number(v)]));
   const total=(await ctx.pool.query("SELECT COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cache_read),0) AS cache_read_tokens,COALESCE(SUM(cache_write),0) AS cache_write_tokens FROM llm_usage WHERE worker='judge'")).rows[0];
   const daily=(await ctx.pool.query("SELECT to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens FROM llm_usage WHERE worker='judge' AND ts>=now()-($1*interval '1 day') GROUP BY date ORDER BY date",[days])).rows.map(numeric);
   json(res,200,{...numeric(total),daily});return true;
  }
  if(path==='/api/intercept/pending'&&method==='GET'){json(res,200,{pending:await pendingReviews(ctx.pool)});return true;}
  const task=/^\/api\/intercept\/task\/([^/]+)$/.exec(path);
  if((path==='/api/intercept/history'||task)&&method==='GET'){json(res,200,await historyReviews(ctx.pool,url.searchParams,task?.[1]??''));return true;}
  const item=/^\/api\/intercept\/(pending|history)\/([+-]?\d+)(?:\/(decide|execution))?$/.exec(path);
  if(!item)return false;const id=Number(item[2]);
  if(!Number.isSafeInteger(id)||item[1]==='history'&&id<=0){json(res,400,{error:item[1]==='history'?'bad approval id':'bad pending id'});return true;}
  if(item[3]==='decide'&&item[1]==='pending'&&method==='POST'){
   const input=await readObject(req,1024*1024,true);if(input.decision!=='allowed'&&input.decision!=='denied'){json(res,400,{error:"decision must be allowed or denied"});return true;}
   const r=await ctx.intercept.decideReview(id,input.decision==='allowed'?'approved':'denied');json(res,r.status,r.ok?{ok:true}:{error:"The approval has been processed or does not exist, please refresh the record"});return true;
  }
  if(method!=='GET')return false;
  const detail=await reviewDetail(ctx.pool,id,item[1]==='history'||item[3]==='execution');
  if(item[3]!=='execution'){json(res,detail?200:404,detail??{error:'not found'});return true;}
  if(!detail){const conversation=Number(url.searchParams.get('conversation'));if(conversation>0&&!(await ctx.pool.query('SELECT 1 FROM conversations WHERE id=$1',[conversation])).rowCount){json(res,410,{error:"Conversation has been deleted"});return true;}json(res,404,{error:"The approval record has been deleted or does not exist"});return true;}
  const audit=detail.audit;if(!audit||audit.correlation!=='exact'||!audit.tool_use_id){json(res,409,{error:unavailable});return true;}
  let scope:unknown,query:string;
  if(detail.conversation_id!==null){scope=detail.conversation_id;query='SELECT id,NULL::bigint AS node_id,worker,kind,tool,tool_use_id,is_error,summary,created_at,NULL::integer AS main_seg FROM conversation_activities WHERE conversation_id=$1';}
  else if(detail.task_id!==null){scope=Number(detail.task_id);if(!Number.isSafeInteger(scope)||Number(scope)<=0){json(res,409,{error:unavailable});return true;}
   if(!(await ctx.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL AND archived_at IS NULL',[scope])).rowCount){json(res,410,{error:"Task has been deleted or archived"});return true;}
   query='SELECT id,node_id,worker,kind,tool,tool_use_id,is_error,summary,created_at,main_seg FROM activity WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL AND archived_at IS NULL)';
  }else{json(res,409,{error:unavailable});return true;}
  const items=(await ctx.pool.query(query+" AND tool_use_id=$2 AND kind IN ('tool_use','tool_result') ORDER BY id LIMIT 3",[scope,audit.tool_use_id])).rows;
  if(!items.length){json(res,410,{error:"The corresponding session or execution record has been deleted or does not exist"});return true;}
  const call=items[0],result=items[1];
  if(items.length>2||call.kind!=='tool_use'||call.tool!==detail.tool_name||result&&(result.kind!=='tool_result'||result.worker!==call.worker||result.tool&&result.tool!==call.tool||result.node_id!==call.node_id||Number(result.main_seg??0)!==Number(call.main_seg??0))){json(res,409,{error:unavailable});return true;}
  let session='';if(detail.conversation_id===null){session=call.worker==='mainagent'?`main:${call.main_seg??0}`:call.worker==='planner'?'plan':call.node_id!==null?`intent:${call.node_id}`:'';if(!session){json(res,409,{error:unavailable});return true;}}
  json(res,200,{conversation_id:detail.conversation_id,task_id:detail.task_id,session,seq:Number(call.id),items:items.map(activityDTO)});return true;
 }catch(error){const status=(error as {status?:number}).status;if(status===400||error instanceof SyntaxError){json(res,400,{error:(error as Error).message});return true;}throw error;}
}
