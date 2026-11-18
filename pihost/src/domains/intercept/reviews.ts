import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import type {ToolContext,GateDecision} from '../tools/gate.ts';

export function bounded(text:string,limit:number):{text:string;truncated:boolean}{
 const bytes=Buffer.from(text);let end=Math.min(bytes.length,limit);while(end<bytes.length&&end>0&&(bytes[end]!&0xc0)===0x80)end--;
 return {text:bytes.subarray(0,end).toString(),truncated:end<bytes.length};
}
export function canonicalJson(value:unknown):string{
 const encode=(v:any):string=>Array.isArray(v)?'['+v.map(encode).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>JSON.stringify(k)+':'+encode(v[k])).join(',')+'}':JSON.stringify(v);
 return encode(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
export async function beginReview(pool:Pool,toolCallId:number,tool:string,params:Record<string,unknown>,context:ToolContext,decision:GateDecision):Promise<number|null>{
 if(!decision.rule&&!decision.reviewed)return null;
 const reason=decision.rule?.reason??decision.reason??'',action=decision.action==='block'?'deny':decision.action;
 const status=action==='ask'?'pending':action==='allow'?'allowed':'denied';
 const user=bounded(context.reviewBackground?.source==='user_message'?context.reviewBackground.text:'',32*1024);
 const trace=context.reviewEntries?.()??[];const entries=trace.slice(-24).map(entry=>{const b=bounded(entry.text,8*1024);return {...entry,text:b.text,...(entry.truncated||b.truncated?{truncated:true}:{})};});
 const audit:Record<string,unknown>={...(context.reviewRunId??context.runId?{run_id:context.reviewRunId??context.runId}:{}),...(context.nativeToolCallId?{tool_use_id:context.nativeToolCallId}:{}),correlation:context.nativeToolCallId?'exact':'unavailable',input_digest:createHash('sha256').update(canonicalJson(params)).digest('hex'),user_message:status==='allowed'?'':user.text,context:status==='allowed'?null:entries,captured_at:new Date().toISOString(),initial_action:action,initial_reason:reason,execution_status:status==='allowed'?(context.nativeToolCallId?'awaiting_result':'unknown'):status==='denied'?'not_executed':'not_started'};
 if(user.truncated&&status!=='allowed')audit.user_truncated=true;
 if(status!=='allowed'&&(trace.length>24||entries.some(e=>e.truncated)))audit.context_truncated=true;
 if(status!=='pending')audit.effective_action=action;
 if(decision.rule?.name)audit.rule_name=decision.rule.name;
 if(decision.rule?.configDigest)audit.config_digest=decision.rule.configDigest;
 if(decision.modelFallback)audit.model_fallback=true;
 if(decision.modelInput){audit.model_input=decision.modelInput;audit.model_input_digest=createHash('sha256').update(canonicalJson(decision.modelInput)).digest('hex');}
 if(decision.profileId)audit.profile_id=decision.profileId;
 const id=(await pool.query(`INSERT INTO intercept_pending(rule_id,conversation_id,task_id,agent_name,tool_name,tool_input,status,reason,decision_source,audit,tool_call_id,decided_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7='pending' THEN NULL ELSE now() END) RETURNING id`,[decision.rule?.id??null,context.conversationId??null,context.taskId?String(context.taskId):null,context.workerName??context.agentKey,tool,JSON.stringify(params),status,reason,decision.rule?'rule':'model',JSON.stringify(audit),toolCallId])).rows[0].id;
 if(status==='pending')try{
  const detail=JSON.stringify({pending_id:Number(id),tool,input:params}),summary=`Tools ${tool} Request Approval (#${id})`;
  if(context.conversationId)await pool.query("INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail) VALUES($1,$2,'intercept_request',$3,$4)",[context.conversationId,context.workerName??context.agentKey,summary,detail]);
  else if(context.taskId)await pool.query("INSERT INTO activity(exploration_id,node_id,worker,kind,summary,detail) SELECT exploration_id,$2,$3,'intercept_request',$4,$5 FROM tasks WHERE id=$1",[context.taskId,context.intentId??null,context.workerName??context.agentKey,summary,detail]);
 }catch(error){console.error('[intercept] inline review activity failed',String(error));}
 return Number(id);
}

export async function finishReview(pool:Pool,callId:number,status:'succeeded'|'failed'|'not_executed',output:unknown):Promise<void>{
 const text=typeof output==='string'?output:JSON.stringify(output??null),b=bounded(text,64*1024);
 const patch={execution_status:status,output:b.text,output_truncated:b.truncated,execution_ended_at:new Date().toISOString()};
 await pool.query("UPDATE intercept_pending SET audit=audit||$2::jsonb WHERE tool_call_id=$1 AND audit->>'effective_action'='allow' AND audit->>'execution_status'='awaiting_result'",[callId,JSON.stringify(patch)]).catch(error=>{console.error('[intercept] execution audit write failed; tool outcome preserved',String(error));});
}

const source="COALESCE(NULLIF(ip.decision_source,''),CASE WHEN ip.rule_id IS NOT NULL THEN 'rule' WHEN ip.reason LIKE '[model]%' THEN 'model' ELSE 'unknown' END)";
const columns=`ip.id,ip.rule_id,ip.conversation_id,ip.task_id,ip.agent_name,ip.tool_name,ip.tool_input,ip.status,ip.reason,ip.decided_at,ip.created_at,${source} AS decision_source`;
const enriched=`${columns},COALESCE(c.title,'') AS conv_title,COALESCE(c.agent_key,'') AS conv_agent_key,COALESCE(ir.name,'') AS rule_name`;
const joins=' FROM intercept_pending ip LEFT JOIN conversations c ON c.id=ip.conversation_id LEFT JOIN intercept_rules ir ON ir.id=ip.rule_id';
const dto=(row:any)=>({...row,id:Number(row.id),rule_id:row.rule_id===null?null:Number(row.rule_id),conversation_id:row.conversation_id===null?null:Number(row.conversation_id)});
export async function pendingReviews(pool:Pool){return (await pool.query(`SELECT ${columns} FROM intercept_pending ip WHERE ip.status='pending' ORDER BY ip.created_at DESC`)).rows.map(dto);}
export async function reviewDetail(pool:Pool,id:number,audit:boolean){
 const r=await pool.query(`SELECT ${audit?enriched+',ip.audit':columns}${audit?joins:' FROM intercept_pending ip'} WHERE ip.id=$1`,[id]);if(!r.rows[0])return null;
 const row=dto(r.rows[0]);if(audit&&row.audit){
  const raw=row.audit,required={correlation:'',input_digest:'',user_message:'',context:null,captured_at:'0001-01-01T00:00:00Z',initial_action:'',initial_reason:'',execution_status:''};
  const allowed=new Set([...Object.keys(required),'run_id','tool_use_id','user_truncated','context_truncated','model_fallback','model_input','model_input_digest','effective_action','decision_reason','rule_name','config_digest','profile_id','output','output_truncated','execution_ended_at']);
  row.audit={...required,...Object.fromEntries(Object.entries(raw).filter(([key,value])=>allowed.has(key)&&(key in required||value!==null&&value!==false&&value!==''&&value!==0)))};
 }
 return row;
}
export async function historyReviews(pool:Pool,q:URLSearchParams,taskId=''){
 const status=q.get('status')??'',decision=q.get('decision_source')??'';
 if(!['','pending','allowed','denied','timeout'].includes(status))throw Object.assign(new Error("status must be pending, allowed, denied, or timeout"),{status:400});
 if(!['','model','rule','unknown'].includes(decision))throw Object.assign(new Error("decision_source must be model, rule, or unknown"),{status:400});
 const paged=!!(q.get('page')||q.get('size')||status||decision);
 const integer=(raw:string|null,def:number)=>raw!==null&&/^[+-]?\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):def;
 const page=Math.max(1,integer(q.get('page'),1)),requested=integer(q.get('size'),20),size=requested<1?20:Math.min(100,requested);
 const args:unknown[]=[],conditions:string[]=[];
 for(const [col,val] of [['ip.task_id',taskId],['ip.status',status],[source,decision]])if(val){args.push(val);conditions.push(`${col}=$${args.length}`);}
 const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
 const total=Number((await pool.query('SELECT count(*) FROM intercept_pending ip'+where,args)).rows[0].count);
 const limit=paged?size:taskId?null:200;
 const rows=(await pool.query(`SELECT ${enriched}${joins}${where} ORDER BY ip.created_at DESC${paged?',ip.id DESC':''}${limit===null?'':` LIMIT $${args.length+1}`}${paged?` OFFSET $${args.length+2}`:''}`,[...args,...(limit===null?[]:[limit]),...(paged?[(page-1)*size]:[])])).rows.map(dto);
 return {items:rows,total:paged?total:rows.length,...(paged?{page,page_size:size}:{})};
}
