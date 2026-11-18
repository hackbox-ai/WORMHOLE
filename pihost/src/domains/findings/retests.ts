import type {Pool} from 'pg';
import type {PihostConfig} from '../../config.ts';
import type {AgentsService} from '../agents/service.ts';
import type {ConversationsService} from '../conversations/service.ts';
import {getPiRuntime} from '../../pi/session-host.ts';
import {registerTool} from '../tools/gate.ts';
import {setFindingStatus} from './status.ts';
import {RETESTER_PROMPT} from './retester-prompt.ts';
import {goLocalTime} from './reads.ts';
const ended="This retest has ended or has not yet started. Please initiate a new retest from the vulnerability details.";
const timeSQL=(key:string)=>`to_char(${key} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${key}`;
const cols=`id,finding_id,conversation_id,status,verdict,notes,summary,evidence,error,${['created_at','started_at','finished_at'].map(timeSQL).join(',')}`;
const dto=(r:any)=>({id:Number(r.id),finding_id:Number(r.finding_id),conversation_id:r.conversation_id==null?null:Number(r.conversation_id),status:r.status,verdict:r.verdict,notes:r.notes,summary:r.summary,evidence:r.evidence,error:r.error,...Object.fromEntries(['created_at','started_at','finished_at'].map(k=>[k,r[k]?goLocalTime(String(r[k])):null])),...(r.snapshot!==undefined?{snapshot:r.snapshot}:{})});
export type RetestResult={ok:false;status:number;error:string}|{ok:true;status:200|202;body:{retest:Record<string,unknown>;created:boolean}};
export class FindingRetests {
 private closing=false;
 constructor(private pool:Pool,private config:PihostConfig,private agents:AgentsService,private conversations:ConversationsService){this.register();}
 private schemas(){return [
  {key:'get_finding_retest_context',description:"Read the vulnerability evidence snapshot, retest status, supplementary instructions and current task constraints associated with the current retest session. No parameters, only this session can be read.",schema:{type:'object',properties:{}}},
  {key:'record_finding_retest_result',description:"Save the only conclusion for the current retest session; the original vulnerability evidence and report remain unchanged. When the session ends successfully and the conclusion is fixed, the system automatically changes the vulnerability status to fixed; other conclusions retain their original status. Evidence of this actual inspection must be provided, and if it cannot be confirmed, the cause of the obstruction must be stated.",schema:{type:'object',properties:{verdict:{type:'string',enum:['reproduced','fixed','inconclusive']},summary:{type:'string',description:"Summary of conclusions of this retest"},evidence:{type:'string',description:"Markdown: The actual steps, observations, comparisons, and conclusion basis of this time; if it cannot be confirmed, the checked content and blocking reasons will be listed."}},required:['verdict','summary','evidence']}},
 ];}
 private register(){for(const tool of this.schemas())registerTool({...tool,params:{},required:[],execute:async(p,ctx)=>{
  const conversationId=ctx.conversationId??0;
  if(tool.key==='get_finding_retest_context')return this.context(conversationId);
  await this.record(conversationId,String(p.verdict??''),String(p.summary??''),String(p.evidence??''));return {saved:true,verdict:p.verdict};
 }});}
 async seed():Promise<void>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(7337741010)');
   for(const t of this.schemas())await c.query("INSERT INTO tools(key,system,description,schema,agents,kind) VALUES($1,TRUE,$2,$3::jsonb,'[\"retester\"]','builtin') ON CONFLICT(key) DO NOTHING",[t.key,t.description,JSON.stringify(t.schema)]);
   const flag=(await c.query("SELECT value FROM app_settings WHERE key='finding_retester_seed_v1'")).rows[0];
   if(flag?.value!=='true'){
    const inserted=await c.query("INSERT INTO agents(key,name,description,role,builtin,enabled,run_seconds) VALUES('retester','Vulnerability retest','Manually start from the vulnerability details, read the original evidence and save the independent retest conclusion.','assistant',FALSE,TRUE,1200) ON CONFLICT(key) DO NOTHING RETURNING id");
    // Repair only the unchanged empty placeholder created by old migration 0006.
    const placeholder=(await c.query("SELECT 1 FROM agents WHERE key='retester' AND builtin=TRUE AND description='' AND name='Vulnerability retest' AND NOT EXISTS(SELECT 1 FROM agent_prompts WHERE agent_key='retester')")).rowCount;
    if(inserted.rowCount||placeholder){await c.query("UPDATE agents SET builtin=FALSE, description='Manually start from vulnerability details, read original evidence and save independent retest conclusions. ' WHERE key='retester'");await c.query("INSERT INTO agent_prompts(agent_key,version,prompt) VALUES('retester',1,$1) ON CONFLICT DO NOTHING",[RETESTER_PROMPT]);}
    await c.query("INSERT INTO app_settings(key,value) VALUES('finding_retester_seed_v1','true') ON CONFLICT(key) DO UPDATE SET value='true'");
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async recover():Promise<void>{await this.pool.query("UPDATE finding_retests SET status='stopped',error='Service restarted, retest has been interrupted, please restart',finished_at=now() WHERE status IN('pending','running')");}
 async shutdown():Promise<void>{this.closing=true;}
 async history(id:number):Promise<Record<string,unknown>[]>{return (await this.pool.query(`SELECT ${cols} FROM finding_retests WHERE finding_id=$1 ORDER BY id DESC`,[id])).rows.map(dto);}
 async active():Promise<Record<string,unknown>[]>{return (await this.pool.query("SELECT id,finding_id,conversation_id,status FROM finding_retests WHERE status IN('pending','running') AND conversation_id IS NOT NULL ORDER BY id")).rows.map(r=>({id:Number(r.id),finding_id:String(r.finding_id),conversation_id:Number(r.conversation_id),status:r.status}));}
 async start(id:number,notes:string):Promise<RetestResult>{
  notes=notes.trim();if([...notes].length>4000)return {ok:false,status:400,error:"Supplementary instructions for retest can be up to 4000 characters."};
  if(!(await this.pool.query('SELECT 1 FROM findings WHERE id=$1',[id])).rowCount)return {ok:false,status:404,error:'finding not found'};
  const agent=await this.agents.get('retester');if(!agent?.enabled)return {ok:false,status:409,error:"The vulnerability retest Agent does not exist or is not enabled. Please configure the retester in Agent management."};
  for(const tool of this.schemas()){const row=(await this.pool.query('SELECT enabled,agents FROM tools WHERE key=$1',[tool.key])).rows[0];if(!row?.enabled||!row.agents.includes('retester'))return {ok:false,status:409,error:"Please enable and bind tools for the retest Agent:"+tool.key};}
  const spec=await this.agents.resolveSessionSpec('retester');if(!(await getPiRuntime(this.config)).getModel(spec.provider??this.config.pi.provider,spec.modelId??this.config.pi.modelId))return {ok:false,status:503,error:"There is currently no runnable LLM configuration"};
  if(this.closing)return {ok:false,status:503,error:"Service is stopping"};
  const c=await this.pool.connect();let row:any,created=false,conversationId:number|undefined,workspaceTaskIds:number[]=[];
  try{await c.query('BEGIN');
   const source=(await c.query(`SELECT COALESCE(NULLIF(f.name,''),NULLIF(f.vulnclass,''),'Unclassified') title,
    jsonb_build_object('finding',to_jsonb(f)-'detail'-'updated_at',
     'assets',COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM assets a WHERE f.asset_ids @> to_jsonb(ARRAY[a.id])),'[]'::jsonb),
     'constraints',COALESCE((SELECT jsonb_agg(to_jsonb(tc)) FROM task_constraints tc JOIN tasks t ON t.exploration_id=tc.exploration_id WHERE t.id=f.task_id),'[]'::jsonb)) snapshot
    FROM findings f WHERE f.id=$1 FOR UPDATE OF f`,[id])).rows[0];
   if(!source){await c.query('ROLLBACK');return {ok:false,status:404,error:'finding not found'};}
   const workspaceTaskId=Number(source.snapshot?.finding?.task_id);
   if(Number.isSafeInteger(workspaceTaskId)&&workspaceTaskId>0)workspaceTaskIds=[workspaceTaskId];
   row=(await c.query(`SELECT ${cols} FROM finding_retests WHERE finding_id=$1 AND status IN('pending','running')`,[id])).rows[0];
   if(!row){created=true;conversationId=Number((await c.query("INSERT INTO conversations(agent_key,title) VALUES('retester',$1) RETURNING id",[`Retest #${id} · ${[...source.title].slice(0,100).join('')}`])).rows[0].id);
    row=(await c.query(`INSERT INTO finding_retests(finding_id,conversation_id,notes,snapshot) VALUES($1,$2,$3,$4::jsonb) RETURNING ${cols}`,[id,conversationId,notes,JSON.stringify(source.snapshot)])).rows[0];
    await c.query("INSERT INTO conversation_activities(conversation_id,seq,worker,kind,summary,detail) VALUES($1,1,'retester','user',$2,$3)",[conversationId,`Please retest the vulnerability #${id}`,this.initial(id,notes)]);
   }await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  if(created){const retestId=Number(row.id);try{const r=await this.conversations.send(conversationId!,this.initial(id,notes),[],{
     workspaceTaskIds,userRecorded:true,timeoutMs:Number(agent.run_seconds)>0?Number(agent.run_seconds)*1000:undefined,
     start:async()=>!!(await this.pool.query("UPDATE finding_retests SET status='running',started_at=now() WHERE id=$1 AND status='pending' RETURNING id",[retestId])).rowCount,
     finish:(status,reason)=>this.finish(retestId,status,reason),
    });if(r.status!==202)await this.finish(retestId,'failed',r.error??"Retest session not started");}
   catch(e){await this.finish(retestId,'failed',(e as Error).message);throw e;}}
  return {ok:true,status:created?202:200,body:{retest:dto(row),created}};
 }
 private initial(id:number,notes:string):string{return `Please retest the vulnerability #${id}. First call get_finding_retest_context to read the original evidence and constraints associated with this session, then perform targeted verification, and finally call record_finding_retest_result to save the conclusion.`+(notes?"\n\nSupplementary instructions for this retest:\n"+notes:'');}
 async context(conversationId:number):Promise<Record<string,unknown>>{
  const row=(await this.pool.query(`SELECT ${cols},snapshot FROM finding_retests WHERE conversation_id=$1`,[conversationId])).rows[0];if(!row)throw new Error("The current session is not associated with a retest record. Please initiate a retest from the vulnerability details.");
  const constraints=(await this.pool.query(`SELECT tc.id,tc.kind,tc.text,tc.origin,${timeSQL('tc.created_at').replace('AS tc.created_at','AS created_at')} FROM task_constraints tc JOIN tasks t ON t.exploration_id=tc.exploration_id JOIN findings f ON f.task_id=t.id WHERE f.id=$1 AND t.deleted_at IS NULL ORDER BY (tc.kind='deny'),tc.id`,[row.finding_id])).rows;
  return {retest:dto(row),current_constraints:constraints.length?constraints.map(r=>({id:Number(r.id),kind:r.kind,text:r.text,...(r.origin?{origin:r.origin}:{}),created_at:goLocalTime(r.created_at)})):null};
 }
 async record(conversationId:number,verdict:string,summary:string,evidence:string):Promise<void>{
  if(!['reproduced','fixed','inconclusive'].includes(verdict))throw new Error("verdict must be reproduced / fixed / inconclusive");summary=summary.trim();evidence=evidence.trim();
  if(!summary||!evidence)throw new Error("summary and evidence cannot be empty; if it cannot be confirmed, please indicate the actual inspection and blocking reasons.");
  if(Buffer.byteLength(summary)>16000||Buffer.byteLength(evidence)>128000)throw new Error("The retest conclusion is too long (summary ≤ 16KB, evidence ≤ 128KB)");
  if(!(await this.pool.query("UPDATE finding_retests SET verdict=$2,summary=$3,evidence=$4 WHERE conversation_id=$1 AND status='running' AND (verdict='' OR (verdict=$2 AND summary=$3 AND evidence=$4)) RETURNING id",[conversationId,verdict,summary,evidence])).rowCount)throw new Error(ended);
 }
 async finish(id:number,status:'completed'|'failed'|'stopped',reason:string):Promise<void>{
  const c=await this.pool.connect();try{await c.query('BEGIN');const f=(await c.query('SELECT f.id FROM findings f WHERE f.id=(SELECT finding_id FROM finding_retests WHERE id=$1) FOR UPDATE OF f',[id])).rows[0];if(!f){await c.query('ROLLBACK');return;}
   const r=(await c.query("UPDATE finding_retests SET status=CASE WHEN $2='completed' AND verdict='' THEN 'failed' ELSE $2 END,error=CASE WHEN $2='completed' AND verdict='' THEN 'Agent The retest conclusion is not saved, please check the session and retest' ELSE $3 END,finished_at=now() WHERE id=$1 AND status IN('pending','running') RETURNING status,verdict",[id,status,reason])).rows[0];
   if(r?.status==='completed'&&r.verdict==='fixed')await setFindingStatus(c,Number(f.id),'fixed');await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}
