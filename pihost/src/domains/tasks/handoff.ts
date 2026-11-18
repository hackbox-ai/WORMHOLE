import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import {ArtifactStore} from '../../storage/artifacts.ts';

export const HANDOFF_TOOLS=['save_worker_checkpoint','read_worker_handoff','read_worker_artifact'];
export class WorkerHandoffs {
  constructor(readonly pool:Pool,readonly dataDir:string,private fingerprints?:import('../fingerprints/service.ts').FingerprintService,private pocs?:import('../pocs/service.ts').PocService){}
  async save(taskId:number,intentId:number,state:unknown){
    const raw=JSON.stringify(state);if(Buffer.byteLength(raw)>8192)throw new Error('checkpoint exceeds 8192 bytes; keep evidence as references');
    if(!(await this.pool.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent'",[intentId,taskId])).rowCount)throw new Error('intent does not belong to this task');
    return (await this.pool.query(`INSERT INTO worker_handoffs(intent_id,task_id,checkpoint) VALUES($1,$2,$3)
      ON CONFLICT(intent_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint,revision=worker_handoffs.revision+1,updated_at=now()
      WHERE worker_handoffs.task_id=EXCLUDED.task_id RETURNING revision`,[intentId,taskId,raw])).rows[0];
  }
  async packet(taskId:number,intentId:number){
    const c=await this.pool.connect();
    try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const task=(await c.query('SELECT id,name,goal,status,paused,exploration_id,updated_at FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];
    const intent=(await c.query("SELECT id,title,payload,state,attempts,last_error,content_version,updated_at FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent'",[intentId,taskId])).rows[0];
    if(!task||!intent)throw new Error('handoff task or intent is unavailable');
    const checkpoint=(await c.query('SELECT revision,checkpoint,updated_at FROM worker_handoffs WHERE intent_id=$1 AND task_id=$2',[intentId,taskId])).rows[0]??null;
    const constraints=(await c.query('SELECT kind,text FROM task_constraints WHERE task_id=$1 ORDER BY id',[taskId])).rows;
    const references=(value:unknown)=>Array.isArray(value)?value.filter(id=>Number.isSafeInteger(id)&&Number(id)>0).slice(0,32):[];
    const checkpointIds=references(checkpoint?.checkpoint?.evidence_ids),freshIds=references(intent.payload?.new_evidence_ids);
    // Explicit recovery references and this direction's outputs outrank unrelated
    // recent facts. No semantic guesses or cross-task search authorize new work.
    const facts=(await c.query(`WITH candidates AS (
        SELECT unnest($3::bigint[]) AS id,0 AS rank,'checkpoint' AS reason
        UNION ALL SELECT unnest($4::bigint[]),1,'new_evidence'
        UNION ALL SELECT e.src_id,1,'dependency' FROM exploration_edges e WHERE e.dst_id=$2 AND e.rel='derived_from'
        UNION ALL SELECT e.dst_id,2,'intent_output' FROM exploration_edges e WHERE e.src_id=$2 AND e.rel='yields'
        UNION ALL (SELECT n.id,3,'active_hint' FROM exploration_nodes n WHERE n.task_id=$1 AND n.kind='hint' AND n.state='active' AND n.delete_reason IS NULL ORDER BY n.id DESC LIMIT 8)
        UNION ALL (SELECT n.id,4,'recent' FROM exploration_nodes n WHERE n.task_id=$1 AND n.kind IN('fact','finding','hint') AND n.delete_reason IS NULL ORDER BY n.id DESC LIMIT 16)
      ), selected AS (SELECT id,min(rank) AS rank,array_agg(DISTINCT reason ORDER BY reason) AS reasons FROM candidates GROUP BY id)
      SELECT n.id,n.kind,n.state,left(COALESCE(n.payload->>'summary',n.payload->>'text',n.title),600) AS summary,
        n.payload->'conclusion' AS conclusion,n.payload->'traffic_refs' AS traffic_refs,n.created_at,s.reasons AS selection_reasons
      FROM selected s JOIN exploration_nodes n ON n.id=s.id
      WHERE n.task_id=$1 AND n.kind IN('fact','finding','hint') AND n.delete_reason IS NULL
      ORDER BY s.rank,n.priority DESC,n.id DESC LIMIT 64`,[taskId,intentId,checkpointIds,freshIds])).rows;
    const related=(await c.query(`SELECT n.id,n.kind,n.task_id AS source_task_id,(n.task_id<>$1) AS inherited,
        left(COALESCE(n.payload->>'summary',n.title),600) AS summary,e.rel AS relationship FROM exploration_edges e
      JOIN exploration_nodes n ON n.id=e.src_id WHERE e.dst_id=$2 AND e.rel='derived_from' AND n.delete_reason IS NULL AND (n.task_id=$1 OR n.task_id IN
        (SELECT r.source_task_id FROM task_relations r JOIN tasks t ON t.id=r.source_task_id AND t.deleted_at IS NULL WHERE r.task_id=$1)) ORDER BY n.priority DESC,n.id DESC LIMIT 32`,[taskId,intentId])).rows;
    const questions=(await c.query(`SELECT id,state,left(COALESCE(payload->>'text',title),600) AS text,payload->'resolution' AS resolution
      FROM exploration_nodes WHERE task_id=$1 AND kind='goal' AND state='open' AND delete_reason IS NULL ORDER BY priority DESC,id LIMIT 8`,[taskId])).rows;
    const artifacts=(await c.query('SELECT hash,raw_bytes FROM storage_artifacts WHERE task_id=$1 AND intent_id=$2 ORDER BY created_at DESC LIMIT 8',[taskId,intentId])).rows;
    const calls=(await c.query(`SELECT id,tool_key,is_error,left(error_text,200) AS error,native_tool_call_id FROM tool_calls
      WHERE business_id=$1 ORDER BY id DESC LIMIT 6`,[`task-${taskId}-intent-${intentId}`])).rows;
    const text=(value:unknown,bytes:number)=>{
      const raw=JSON.stringify(value);if(Buffer.byteLength(raw)<=bytes)return value;
      return {preview:raw.slice(0,Math.floor(bytes/4)),truncated:true,read:'read_worker_handoff(section=goal|intent,offset=0) or node_detail; original remains in database'};
    };
    const packet={version:2,task:{...task,name:String(task.name??'').slice(0,200),goal:text(task.goal,4000)},intent:{...intent,title:String(intent.title??'').slice(0,400),last_error:String(intent.last_error??'').slice(0,400),payload:text(intent.payload,4000)},
      constraints,checkpoint,poc_knowledge:await this.pocs?.summary(taskId,intentId),fingerprints:await this.fingerprints?.summary(taskId,intentId),anchors:related,recentEvidence:facts.map(row=>({...row,traffic_refs:text(row.traffic_refs,800)})),artifacts,recentToolCalls:calls,
      openQuestions:questions,selection:{order:['checkpoint','dependency/new_evidence','intent_output','active_hint','recent'],
        checkpointReferences:checkpointIds.map(String),unavailableCheckpointReferences:checkpointIds.map(String).filter(id=>!facts.some(row=>String(row.id)===id))},
      omittedEvidenceIds:[] as string[],omittedAnchorIds:[] as string[],omittedQuestionIds:[] as string[],authorityOverBudget:false,
      instructions:"The current task status and operational constraints take precedence; the summary is only for navigation, not execution authorization. First check the next step of the checkpoint and the existing positive/negative evidence to avoid repeated side effects; the basis related to the next step in omittedEvidenceIds/omittedAnchorIds is checked with node_detail. Omitting it does not mean that it does not exist. Results are still written back using record_fact/report_finding. Large results are read in hash pages. Use save_worker_checkpoint to save progress, next step, blocking and evidence ID before starting a long action or at the end of a stage. Tool call receipts cannot alone prove that the external operation did not occur."};
    const over=()=>Buffer.byteLength(JSON.stringify(packet))>32768;
    while(over()&&packet.poc_knowledge?.candidates.length){packet.poc_knowledge.candidates.pop();packet.poc_knowledge.omitted++;}
    // Drop fallback navigation before explicitly referenced recovery evidence.
    while(over()){
      const index=packet.recentEvidence.findLastIndex(row=>row.selection_reasons.every((reason:string)=>reason==='recent'||reason==='active_hint'));
      if(index<0)break;packet.omittedEvidenceIds.push(String(packet.recentEvidence.splice(index,1)[0]!.id));
    }
    while(over()&&packet.recentToolCalls.length>1)packet.recentToolCalls.pop();
    while(over()&&packet.artifacts.length>1)packet.artifacts.pop();
    while(over()&&packet.openQuestions.length)packet.omittedQuestionIds.push(String(packet.openQuestions.pop()!.id));
    while(over()&&packet.recentEvidence.length)packet.omittedEvidenceIds.push(String(packet.recentEvidence.pop()!.id));
    while(over()&&packet.anchors.length)packet.omittedAnchorIds.push(String(packet.anchors.pop()!.id));
    // User constraints are authoritative and never shortened just to meet a budget.
    if(over())packet.authorityOverBudget=true;
    await c.query('COMMIT');return packet;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async observe(taskId:number,intentId:number,state:{outcome:string;summary:string}){
    // Runtime observations augment rather than replace the model's explicit next step.
    await this.pool.query(`INSERT INTO worker_handoffs(intent_id,task_id,checkpoint) VALUES($1,$2,jsonb_build_object('runtime',$3::jsonb))
      ON CONFLICT(intent_id) DO UPDATE SET checkpoint=jsonb_set(worker_handoffs.checkpoint,'{runtime}',$3::jsonb),
      revision=worker_handoffs.revision+1,updated_at=now() WHERE worker_handoffs.task_id=EXCLUDED.task_id`,[intentId,taskId,JSON.stringify({...state,summary:state.summary.slice(0,1800)})]);
  }
  async section(taskId:number,intentId:number,section:string,offset:number){
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('invalid handoff offset');
    const row=(await this.pool.query(`SELECT t.goal,n.payload FROM tasks t JOIN exploration_nodes n ON n.task_id=t.id
      WHERE t.id=$1 AND n.id=$2 AND t.deleted_at IS NULL`,[taskId,intentId])).rows[0];
    if(!row)throw new Error('handoff not found');const raw=JSON.stringify(section==='goal'?row.goal:row.payload),end=Math.min(raw.length,offset+8000);
    return {section,text:raw.slice(offset,end),nextOffset:end,done:end===raw.length};
  }
  register(){
    const owner=(ctx:{taskId?:number;intentId?:number})=>{if(!ctx.taskId||!ctx.intentId)throw new Error('worker handoff requires an owned intent');return [ctx.taskId,ctx.intentId] as const;};
    registerTool({key:'save_worker_checkpoint',description:"Save a brief structured handover state of this Worker. Reference the evidence ID and product hash, and do not copy the main text; task ownership is determined by the host.",params:{},required:[],schema:{type:'object',additionalProperties:false,properties:{progress:{type:'string',maxLength:2000},next_step:{type:'string',maxLength:2000},blockers:{type:'string',maxLength:1000},evidence_ids:{type:'array',maxItems:32,items:{type:'integer',minimum:1}}},required:['progress','next_step']},execute:async(p,ctx)=>{const [task,intent]=owner(ctx);if(Array.isArray(p.evidence_ids)&&p.evidence_ids.length){const rows=await this.pool.query('SELECT id FROM exploration_nodes WHERE task_id=$1 AND id=ANY($2::bigint[])',[task,p.evidence_ids]);if(rows.rowCount!==new Set(p.evidence_ids).size)throw new Error('evidence IDs must belong to this task');}return this.save(task,intent,p);}});
    registerTool({key:'read_worker_handoff',description:"Read this Worker's latest authoritative task status, constraints, handover summary, and evidence references. Large goal/intent text can be paged with section and offset.",params:{},required:[],schema:{type:'object',properties:{section:{type:'string',enum:['overview','goal','intent']},offset:{type:'integer',minimum:0}},additionalProperties:false},execute:async(p,ctx)=>{const [task,intent]=owner(ctx);return p.section&&p.section!=='overview'?this.section(task,intent,String(p.section),Number(p.offset??0)):this.packet(task,intent);}});
    registerTool({key:'read_worker_artifact',description:"Read the losslessly saved tool results of this task according to the character range. Continue reading nextOffset to avoid fully loading large products.",params:{},required:[],schema:{type:'object',additionalProperties:false,properties:{hash:{type:'string',pattern:'^[a-f0-9]{64}$'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:16000}},required:['hash']},execute:async(p,ctx)=>{if(!ctx.taskId)throw new Error('task context required');return new ArtifactStore(this.pool,this.dataDir).read(ctx.taskId,String(p.hash),Number(p.offset??0),Number(p.limit??8000));}});
  }
}
