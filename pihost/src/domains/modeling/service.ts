import {initialModelingTargets,discoveryModelingTarget} from '../tasks/targets.ts';
import {networkBinding} from '../network/binding.ts';
import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {endpointIndex,mergeDocument,normalizeTarget,object,skeleton,validateDocument,validateEntities,type JsonObject} from './document.ts';

export class ModelingError extends Error {
  constructor(message:string,readonly status=400){super(message);}
}
export interface ModelingRequest {
  network_binding?:{mode:string;channelId:number|null;version:number|null};
  target:string;
  name?:string;
  environment?:string;
  auth_context?:string;
  task_id?:number;
  intent_id?:number;
  conversation_id?:number;
  asset_id?:number;
  reason?:string;
  trigger?:'initial'|'discovery'|'manual';
  queued?:boolean;
  /** Host-only: a failed run's preserved draft, never a model tool argument. */
  draft_from?:number;
}
export interface ModelingSubmission {
  openapi?:unknown;paths?:unknown;components?:unknown;entities?:unknown;note?:string;
}
export class ModelingService {
  private launch:(id:number)=>void=()=>{};
  private wake:(id:number)=>void=()=>{};
  constructor(readonly pool:Pool){}
  bind(launch:(id:number)=>void,wake:(id:number)=>void){this.launch=launch;this.wake=wake;}
  private async event(c:PoolClient,id:number,type:string,payload:unknown){
    await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('modeling',$1,$2,$3::jsonb)",[String(id),type,JSON.stringify(payload)]);
  }
  async request(input:ModelingRequest){
    let target:string;try{target=normalizeTarget(input.target);}catch{throw new ModelingError("Please enter a valid HTTP/HTTPS destination address");}
    const environment=(input.environment??'default').trim()||'default',auth=(input.auth_context??'').trim();
    if(target.length>2048||environment.length>100||auth.length>200)throw new ModelingError("Target or environment, identity tag is too long");
    const name=input.name?.trim().slice(0,120)||target;
    const c=await this.pool.connect();let id=0,created=false,systemId=0;
    try{
      await c.query('BEGIN');
      const source=input.task_id?(await c.query("SELECT * FROM tasks WHERE id=$1 AND kind='pentest' AND deleted_at IS NULL FOR UPDATE",[input.task_id])).rows[0]:undefined;
      if(input.task_id&&!source)throw new ModelingError("The associated test task does not exist",404);
      if(source&&input.trigger!=='manual'&&(source.paused||!['created','running'].includes(source.status)))throw new ModelingError("The source test task has been paused or ended",409);
      if(input.intent_id&&(!source||!(await c.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent' AND state IN ('open','running','blocked')",[input.intent_id,input.task_id])).rowCount))throw new ModelingError("The source intent does not belong to the current test task");
      if(input.conversation_id&&!(await c.query('SELECT 1 FROM conversations WHERE id=$1',[input.conversation_id])).rowCount)throw new ModelingError("Source session does not exist",404);
      if(input.asset_id&&!(await c.query('SELECT 1 FROM assets WHERE id=$1',[input.asset_id])).rowCount)throw new ModelingError("The associated asset does not exist",404);
      if(source&&input.trigger==='discovery')target=discoveryModelingTarget(source,target);
      const constraints=source?(await c.query('SELECT kind,text,origin FROM task_constraints WHERE task_id=$1 ORDER BY kind,text',[input.task_id])).rows:[];
      const scopes=source?(await c.query("SELECT kind,domain,net::text,value FROM task_scope WHERE task_id=$1 AND source<>'auto' ORDER BY kind,domain,net::text,value",[input.task_id])).rows:[];
      const binding=input.network_binding??(source?{mode:source.network_mode,channelId:source.network_channel_id==null?null:Number(source.network_channel_id),version:source.network_version}:await networkBinding(c,{}));
      // Derived goal rows can arrive after startup; executionKey already hashes
      // the original briefing. Human/worker constraints still distinguish runs.
      const scopeKey=createHash('sha256').update(JSON.stringify({constraints:constraints.filter(r=>r.origin!=='goals').map(({kind,text})=>({kind,text})),scopes,...(binding.mode==='jump'?{network:binding}:{})})).digest('hex');
      // Share active work only when original briefings also match. Historical
      // documents remain reusable references that each new run must revalidate.
      const executionKey=createHash('sha256').update(JSON.stringify({scopeKey,network:binding,briefing:source?`${source.goal}\n${source.description}`:''})).digest('hex');
      // A system row lock serializes creation across all entry points/processes.
      const system=(await c.query(`INSERT INTO business_systems(name,target,environment,auth_context,asset_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(target,environment,auth_context) DO UPDATE SET asset_id=COALESCE(business_systems.asset_id,EXCLUDED.asset_id) RETURNING *`,[name,target,environment,auth,input.asset_id??null])).rows[0];
      systemId=Number(system.id);
      if(source&&input.trigger==='discovery'){
        const linked=(await c.query('SELECT m.modeling_task_id,m.version_id FROM task_business_models m JOIN business_model_versions v ON v.id=m.version_id WHERE m.task_id=$1 AND m.system_id=$2 AND v.scope_key=$3',[input.task_id,systemId,scopeKey])).rows[0];
        if(linked?.version_id){
          await c.query('COMMIT');
          return {task_id:Number(linked.modeling_task_id),system_id:systemId,target,created:false,ready:true,version_id:Number(linked.version_id)};
        }
      }
      const current=(await c.query(`SELECT r.task_id FROM business_model_runs r JOIN tasks t ON t.id=r.task_id
        WHERE r.system_id=$1 AND r.scope_key=$2 AND r.execution_key=$3 AND t.status IN ('created','running','paused') AND t.deleted_at IS NULL ORDER BY r.task_id DESC LIMIT 1`,[systemId,scopeKey,executionKey])).rows[0];
      if(current)id=Number(current.task_id);
      else{
        const base=(await c.query('SELECT * FROM business_model_versions WHERE system_id=$1 AND scope_key=$2 ORDER BY id DESC LIMIT 1',[systemId,scopeKey])).rows[0];
        const seed=input.draft_from?(await c.query('SELECT document,entities FROM business_model_runs WHERE task_id=$1 AND system_id=$2 AND scope_key=$3',[input.draft_from,systemId,scopeKey])).rows[0]:undefined;
        const document=seed?mergeDocument(base?.document??skeleton(name,target),seed.document):base?.document??skeleton(name,target);
        const entities=seed?seed.entities:base?.entities??[];
        const exploration=(await c.query('INSERT INTO explorations(goal,description) VALUES($1,$2) RETURNING id',[`Business Modeling:${target}`,input.reason??''])).rows[0];
        const task=(await c.query(`INSERT INTO tasks(kind,name,goal,description,agent_key,exploration_id,queued,queued_at,queue_mode,timeout_seconds,deadline_at,modeling_initialized,network_mode,network_channel_id,network_version)
          VALUES('modeling',$1,$2,$3,'modeler',$4,TRUE,now(),'bootstrap',900,NULL,TRUE,$5,$6,$7) RETURNING id`,[`Business Modeling · ${name}`,`Restore ${target} Business interfaces, entities and relationships`,[input.reason??'',...(source?[`Original test task goal:${source.goal}`,`Original test task description:${source.description}`]:[])].join('\n'),exploration.id,binding.mode,binding.channelId,binding.version])).rows[0];
        id=Number(task.id);created=true;
        await c.query(`INSERT INTO business_model_runs(task_id,system_id,trigger_kind,source_task_id,source_intent_id,source_conversation_id,base_version_id,document,entities,scope_key,execution_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[id,systemId,input.trigger??'manual',input.task_id??null,input.intent_id??null,input.conversation_id??null,base?.id??null,JSON.stringify(document),JSON.stringify(entities),scopeKey,executionKey]);
        if(source){
          await c.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) SELECT $1,profile_id,position FROM task_llm_profiles WHERE task_id=$2',[id,input.task_id]);
          await c.query('UPDATE tasks SET llm_profile_id=$2,active_llm_profile_id=$2 WHERE id=$1',[id,source.active_llm_profile_id??source.llm_profile_id]);
          await c.query(`INSERT INTO task_constraints(task_id,exploration_id,kind,text,origin)
            SELECT $1,$2,kind,text,origin FROM task_constraints WHERE task_id=$3`,[id,exploration.id,input.task_id]);
          await c.query(`INSERT INTO task_scope(task_id,kind,company_id,domain,net,value,source,reason)
            SELECT $1,kind,company_id,domain,net,value,source,reason FROM task_scope WHERE task_id=$2 ON CONFLICT DO NOTHING`,[id,input.task_id]);
        }
        await this.event(c,id,'modeling_created',{system_id:systemId,target,source_task_id:input.task_id??null,trigger:input.trigger??'manual',base_version_id:base?.id??null});
      }
      if(source){
        await c.query(`INSERT INTO task_business_models(task_id,system_id,modeling_task_id,initial_gate) VALUES($1,$2,$3,$4)
          ON CONFLICT(task_id,system_id) DO UPDATE SET modeling_task_id=EXCLUDED.modeling_task_id,version_id=NULL,initial_gate=FALSE`,[input.task_id,systemId,id,false]);
        if(input.intent_id){
          await c.query('INSERT INTO intent_business_models(intent_id,task_id,system_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.intent_id,input.task_id,systemId]);
          await c.query(`UPDATE exploration_nodes SET payload=payload||jsonb_build_object('business_system_id',$3::bigint),updated_at=now() WHERE id=$1 AND task_id=$2`,[input.intent_id,input.task_id,systemId]);
        }
        await this.event(c,id,'modeling_linked',{task_id:input.task_id,intent_id:input.intent_id??null,system_id:systemId,reason:input.reason??''});
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    if(!input.queued)this.launch(id);
    if(input.task_id)this.wake(input.task_id);
    return {task_id:id,system_id:systemId,target,created};
  }
  async initializeTask(taskId:number){
    const lock=await this.pool.connect();
    try{
      await lock.query("SELECT pg_advisory_lock(hashtext('wormhole-modeling-initialize'),$1::int)",[taskId]);
      const row=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND kind='pentest' AND modeling_initialized=FALSE AND deleted_at IS NULL",[taskId])).rows[0];
      if(!row)return;
      const targets=initialModelingTargets(row);
      for(const target of targets)await this.request({target,task_id:taskId,trigger:'initial',reason:"Pre-business modeling of test targets"});
      await this.pool.query('UPDATE tasks SET modeling_initialized=TRUE WHERE id=$1',[taskId]);
    }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('wormhole-modeling-initialize'),$1::int)",[taskId]);lock.release();}
  }
  /** Compatibility query: supplemental modeling never blocks task admission. */
  async pending(taskId:number,_initialOnly=false):Promise<boolean>{return !!(await this.pool.query("SELECT 1 FROM task_business_models m JOIN tasks t ON t.id=m.modeling_task_id WHERE m.task_id=$1 AND m.version_id IS NULL AND t.status IN('created','running','paused') AND t.deleted_at IS NULL LIMIT 1",[taskId])).rowCount;}
  async fail(id:number,status:'failed'|'timeout',reason:string){
    const c=await this.pool.connect();let parents:number[]=[];
    try{await c.query('BEGIN');
      const changed=await c.query("UPDATE tasks SET status=$2,queued=false,paused=false,completed_at=now(),updated_at=now(),stopped_reason=$3 WHERE id=$1 AND kind='modeling' AND status IN('created','running') RETURNING id",[id,status,reason]);
      if(changed.rowCount){parents=(await c.query('SELECT task_id FROM task_business_models WHERE modeling_task_id=$1',[id])).rows.map(r=>Number(r.task_id));await this.event(c,id,status==='timeout'?'modeling_timeout':'modeling_failed',{reason,draft_preserved:true,task_ids:parents});}
      await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    for(const taskId of parents)this.wake(taskId);
  }
  async list(taskId?:number){
    const rows=await this.pool.query(`SELECT r.task_id,r.system_id,r.trigger_kind,r.source_task_id,r.source_intent_id,r.base_version_id,r.submissions,r.summary,r.updated_at,
      s.name,s.target,s.environment,s.auth_context,CASE WHEN t.paused AND t.status NOT IN ('done','failed','timeout') THEN 'paused' ELSE t.status END AS status,t.paused,t.queued,t.stopped_reason,t.created_at,t.completed_at,
      (SELECT count(*)::int FROM business_model_versions v WHERE v.system_id=r.system_id AND v.scope_key=r.scope_key) AS version_count,
      jsonb_array_length(r.entities) AS entity_count,(SELECT count(*)::int FROM jsonb_object_keys(r.document->'paths')) AS path_count,
      (SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'version_id',l.version_id)) FROM task_business_models l JOIN tasks p ON p.id=l.task_id WHERE l.modeling_task_id=r.task_id) AS linked_tasks
      FROM business_model_runs r JOIN tasks t ON t.id=r.task_id JOIN business_systems s ON s.id=r.system_id
      WHERE t.deleted_at IS NULL AND ($1::bigint IS NULL OR EXISTS(SELECT 1 FROM task_business_models l WHERE l.task_id=$1 AND l.modeling_task_id=r.task_id))
      ORDER BY r.task_id DESC LIMIT 500`,[taskId??null]);
    return rows.rows;
  }
  async get(id:number){
    const row=(await this.pool.query(`SELECT r.*,s.name,s.target,s.environment,s.auth_context,s.asset_id,CASE WHEN t.paused AND t.status NOT IN ('done','failed','timeout') THEN 'paused' ELSE t.status END AS status,t.paused,t.queued,t.stopped_reason,t.deadline_at
      FROM business_model_runs r JOIN tasks t ON t.id=r.task_id JOIN business_systems s ON s.id=r.system_id WHERE r.task_id=$1 AND t.deleted_at IS NULL`,[id])).rows[0];
    if(!row)throw new ModelingError("The modeling task does not exist",404);
    const versions=(await this.pool.query('SELECT id,run_task_id,summary,path_count,operation_count,created_at FROM business_model_versions WHERE system_id=$1 AND scope_key=$2 ORDER BY id DESC',[row.system_id,row.scope_key])).rows;
    const events=(await this.pool.query("SELECT seq,event_type,payload,ts AS created_at FROM business_events WHERE business_id=$1 AND (business_kind='modeling' OR (business_kind='task' AND event_type LIKE 'modeling_%')) ORDER BY seq DESC LIMIT 200",[String(id)])).rows;
    const links=(await this.pool.query('SELECT l.*,t.name,t.status FROM task_business_models l JOIN tasks t ON t.id=l.task_id WHERE l.modeling_task_id=$1',[id])).rows;
    return {...row,versions,events,linked_tasks:links,endpoints:endpointIndex(row.document)};
  }
  private async lockRun(c:PoolClient,id:number){
    const task=(await c.query("SELECT * FROM tasks WHERE id=$1 AND kind='modeling' AND status='running' AND paused=FALSE AND queued=FALSE AND deleted_at IS NULL FOR UPDATE",[id])).rows[0];
    if(!task)throw new ModelingError("The modeling task has been paused, terminated, or has not yet run",409);
    const run=(await c.query('SELECT * FROM business_model_runs WHERE task_id=$1 FOR UPDATE',[id])).rows[0];
    if(!run)throw new ModelingError("Modeling record does not exist",404);
    return run;
  }
  async submit(id:number,input:ModelingSubmission){
    const c=await this.pool.connect();try{
      await c.query('BEGIN');const run=await this.lockRun(c,id);
      if(input.openapi!==undefined&&!object(input.openapi))throw new ModelingError("openapi must be a document object");
      for(const key of ['paths','components'] as const)if(input[key]!==undefined&&!object(input[key]))throw new ModelingError(`${key} Must be an object`);
      const doc=mergeDocument((input.openapi??run.document) as JsonObject,{...(input.paths!==undefined?{paths:input.paths}:{}),...(input.components!==undefined?{components:input.components}:{})});
      const errors=validateDocument(doc);if(errors.length)throw new ModelingError(errors.join('；')+". Submission format: paths only contain paths starting with /; responses only contain status codes; the document header is placed in openapi, and the entities are placed in the outermost entities. Only correct this batch of errors, there is no need to resend all saved content.");
      const entities=input.entities===undefined?run.entities:validateEntities(input.entities);
      await c.query('UPDATE business_model_runs SET document=$2::jsonb,entities=$3::jsonb,submissions=submissions+1,finish_requested=FALSE,updated_at=now() WHERE task_id=$1',[id,JSON.stringify(doc),JSON.stringify(entities)]);
      const counters={path_count:Object.keys(doc.paths as JsonObject).length,operation_count:endpointIndex(doc).length,entity_count:entities.length};
      await this.event(c,id,'modeling_submitted',{...counters,note:input.note??''});await c.query('COMMIT');return counters;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async requestFinish(id:number,summary:string){
    if(!summary.trim())throw new ModelingError("Please describe the coverage, uncovered modules and inferred content");
    const c=await this.pool.connect();try{
      await c.query('BEGIN');const run=await this.lockRun(c,id);
      const errors=validateDocument(run.document,true);if(errors.length)throw new ModelingError(errors.join('；'));
      if(!run.submissions)throw new ModelingError("The model has not been submitted or verified this time");
      await c.query('UPDATE business_model_runs SET finish_requested=TRUE,summary=$2,updated_at=now() WHERE task_id=$1',[id,summary.slice(0,16000)]);
      await c.query('COMMIT');return {accepted:true,message:"Delivery submitted, results will be published after the current run ends successfully"};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async publish(id:number){
    const c=await this.pool.connect();let parents:number[]=[];try{
      await c.query('BEGIN');
      // Match request()'s system lock: a newly attached consumer must not miss publication.
      await c.query('SELECT id FROM business_systems WHERE id=(SELECT system_id FROM business_model_runs WHERE task_id=$1) FOR UPDATE',[id]);
      const run=await this.lockRun(c,id);
      if(!run.finish_requested)throw new ModelingError("Agent did not call api_model_done, the draft has been retained, and the task is not completed");
      const errors=validateDocument(run.document,true);if(errors.length)throw new ModelingError(errors.join('；'));
      const version=(await c.query(`INSERT INTO business_model_versions(system_id,run_task_id,document,entities,summary,path_count,operation_count,scope_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[run.system_id,id,JSON.stringify(run.document),JSON.stringify(run.entities),run.summary,Object.keys(run.document.paths).length,endpointIndex(run.document).length,run.scope_key])).rows[0];
      parents=(await c.query('UPDATE task_business_models SET version_id=$2 WHERE modeling_task_id=$1 RETURNING task_id',[id,version.id])).rows.map(r=>Number(r.task_id));
      await c.query(`UPDATE exploration_nodes n SET state='open',blocked_reason=NULL,claimed_by=NULL,claimed_at=NULL,updated_at=now()
        FROM tasks t WHERE n.task_id=t.id AND t.status IN ('created','running','paused') AND t.deleted_at IS NULL
        AND n.state='blocked' AND n.blocked_reason='business_modeling' AND n.claimed_by IS NULL
        AND EXISTS(SELECT 1 FROM intent_business_models im WHERE im.intent_id=n.id)
        AND NOT EXISTS(SELECT 1 FROM intent_business_models im JOIN task_business_models m ON m.task_id=im.task_id AND m.system_id=im.system_id WHERE im.intent_id=n.id AND m.version_id IS NULL)`);
      await c.query("UPDATE tasks SET status='done',completed_at=now(),updated_at=now() WHERE id=$1",[id]);
      await this.event(c,id,'modeling_completed',{version_id:Number(version.id),system_id:Number(run.system_id),task_ids:parents});
      for(const taskId of parents)await c.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'business_model_ready',$2::jsonb)`,[String(taskId),JSON.stringify({modeling_task_id:id,system_id:Number(run.system_id),version_id:Number(version.id)})]);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    for(const taskId of parents)this.wake(taskId);
  }
  async catalog(taskId:number){
    return (await this.pool.query(`SELECT l.system_id,l.modeling_task_id,l.version_id,l.initial_gate,s.name,s.target,t.status,
      v.summary,v.path_count,v.operation_count FROM task_business_models l JOIN business_systems s ON s.id=l.system_id
      LEFT JOIN tasks t ON t.id=l.modeling_task_id LEFT JOIN business_model_versions v ON v.id=l.version_id WHERE l.task_id=$1 ORDER BY l.system_id`,[taskId])).rows;
  }
  async conversationCatalog(conversationId:number){
    return (await this.pool.query(`SELECT r.system_id,r.task_id AS modeling_task_id,r.source_task_id,s.name,s.target,
      CASE WHEN t.paused AND t.status NOT IN ('done','failed','timeout') THEN 'paused' ELSE t.status END AS status,
      v.id AS version_id,v.summary,v.path_count,v.operation_count
      FROM business_model_runs r JOIN tasks t ON t.id=r.task_id JOIN business_systems s ON s.id=r.system_id
      LEFT JOIN business_model_versions v ON v.run_task_id=r.task_id
      WHERE r.source_conversation_id=$1 AND t.deleted_at IS NULL ORDER BY r.task_id DESC LIMIT 500`,[conversationId])).rows;
  }
  async readForConversation(conversationId:number,systemId:number,path?:string){
    const record=(await this.pool.query(`SELECT r.task_id,t.status,t.paused FROM business_model_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.source_conversation_id=$1 AND r.system_id=$2 AND t.deleted_at IS NULL ORDER BY r.task_id DESC LIMIT 1`,[conversationId,systemId])).rows[0];
    if(!record)throw new ModelingError("The current conversation does not initiate modeling of this system. Please query the modeling directory first.",404);
    return {modeling_task_id:record.task_id,status:record.paused?'paused':record.status,...await this.readForTask(Number(record.task_id),systemId,path)};
  }
  async readForTask(taskId:number,systemId:number,path?:string){
    const draft=(await this.pool.query('SELECT * FROM business_model_runs WHERE task_id=$1 AND system_id=$2',[taskId,systemId])).rows[0];
    if(draft){
      if(path){if(!draft.document.paths?.[path])throw new ModelingError("Draft does not have this path",404);return {document:{...draft.document,paths:{[path]:draft.document.paths[path]}},entities:draft.entities};}
      return {endpoints:endpointIndex(draft.document).slice(0,500),entities:draft.entities,hint:"Press path to read the draft interface that needs to be verified"};
    }
    const row=(await this.pool.query(`SELECT v.* FROM task_business_models l JOIN business_model_versions v ON v.id=l.version_id WHERE l.task_id=$1 AND l.system_id=$2`,[taskId,systemId])).rows[0];
    if(!row)throw new ModelingError("The current task is not associated with a published model of this system",404);
    const doc=row.document as JsonObject;
    if(path){if(!object(doc.paths)||!doc.paths[path])throw new ModelingError("The model does not have this path",404);return {...row,document:{...doc,paths:{[path]:doc.paths[path]}}};}
    // First read is a bounded index; full operations are read by path.
    return {version_id:row.id,summary:row.summary,entities:row.entities,endpoints:endpointIndex(doc).slice(0,500),hint:"Use path to read interface parameters and responses; the version is fixed by the associated record of the test task"};
  }
  async version(id:number){
    const row=(await this.pool.query('SELECT * FROM business_model_versions WHERE id=$1',[id])).rows[0];
    if(!row)throw new ModelingError("Model version does not exist",404);return row;
  }
  async retry(id:number,taskId?:number){
    const record=await this.get(id);
    if(['created','running','paused'].includes(record.status))throw new ModelingError("The current modeling has not ended, please use Run or Continue",409);
    if(taskId&&!record.linked_tasks.some((t:{task_id:unknown})=>Number(t.task_id)===taskId))throw new ModelingError("This test task is not associated with the original modeling record");
    const pending=record.status!=='done'?record.linked_tasks.filter((t:{version_id:unknown})=>t.version_id===null):[];
    const sources:number[]=pending.length?pending.map((t:{task_id:unknown})=>Number(t.task_id)):taskId?[taskId]:[];
    const original=(await this.pool.query('SELECT network_mode,network_channel_id,network_version FROM tasks WHERE id=$1',[id])).rows[0];
    const retained={mode:original.network_mode,channelId:original.network_channel_id,version:original.network_version};
    const inputs=sources.length?sources:[undefined];
    const results=[];
    for(const source of inputs)results.push(await this.request({network_binding:source?undefined:retained,target:record.target,name:record.name,environment:record.environment,auth_context:record.auth_context,task_id:source,draft_from:record.status==='done'?undefined:id,trigger:'manual',reason:`Continue modeling #${id}, verify the existing results and fill the gaps`}));
    return results[0]!;
  }
}
