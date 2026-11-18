import {validatePocReferences,pocEvent} from '../pocs/lifecycle.ts';
import {markFindingPaths} from './paths.ts';
/** Durable finding snapshots. All writes belong to the host's
 * task context; related task nodes are a live, read-only view, never claimable. */
import type { Pool, PoolClient } from 'pg';
import {PlannerOverview} from './planner-overview.ts';
import {normalizeRefs} from '../findings/evidence.ts';
import {goTrim} from '../assets/asset-match.ts';
import {AssetsService} from '../assets/service.ts';
import {directExplorationScope} from './scope.ts';
import {finishAchievedTask} from '../tasks/completion.ts';
import {createHash} from 'node:crypto';
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:unknown)=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ');

export interface GraphNode {
  id: string; task_id: string; exploration_id: string; kind: string;
  payload: Record<string, unknown>; priority: number; state: string; origin: string | null;
  delete_reason: string | null; created_at: Date; source_task_id?: string; inherited?: boolean;
}
export type GraphPayload = Record<string, unknown>;
const ids = (v: unknown): number[] => Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isSafeInteger(n) && n>0))] : [];
export const nodeDTO = (n: GraphNode) => ({ id:String(n.id), type:n.kind, payload:JSON.stringify(n.payload), priority:n.priority,
  state:n.state, origin:n.origin ?? '', ts:new Date(n.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  ...(n.delete_reason ? {delete_reason:n.delete_reason}:{}), ...(n.inherited ? {source_task_id:String(n.source_task_id), inherited:true}:{}) });
export const goalDTO = (n: GraphNode) => ({id:String(n.id), text:String(n.payload.text ?? ''), state:n.state,
  ...(n.payload.resolution?{resolution:n.payload.resolution}:{}),...(n.payload.objective_type?{objective_type:n.payload.objective_type}:{}),
  ...(n.payload.vulnclass ? {vulnclass:n.payload.vulnclass}:{}), ...(n.origin ? {origin:n.origin}:{}), ts:nodeDTO(n).ts});
const edgeDTO = (e: {src_id:unknown; dst_id:unknown; rel:string}) => ({src:String(e.src_id), dst:String(e.dst_id), rel:e.rel});

export class ExplorationService {
  constructor(private readonly pool: Pool, private readonly notify: (taskId:number)=>void = ()=>{},private readonly notifyHint?:(taskId:number,texts:string[])=>void) {}
  async transaction<T>(taskId:number, fn:(c:PoolClient, explorationId:number)=>Promise<T>,client?:PoolClient):Promise<T> {
    const c=client??await this.pool.connect();
    try {
      if(!client)await c.query('BEGIN');
      const r=await c.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId]);
      if (!r.rowCount) throw new Error('task not found');
      const eid=Number(r.rows[0].exploration_id);
      if (!eid) throw new Error("Task exploration graph is not initialized");
      const result=await fn(c,eid);if(!client)await c.query('COMMIT');return result;
    } catch(e) {if(!client)await c.query('ROLLBACK');throw e;} finally {if(!client)c.release();}
  }
  async ensure(taskId:number):Promise<void> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r=await c.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId]);
      if (!r.rowCount) throw new Error('task not found');
      const t=r.rows[0];let eid=Number(t.exploration_id);
      if (!eid) {
        eid=Number((await c.query('INSERT INTO explorations(goal,description) VALUES($1,$2) RETURNING id',[t.goal,t.description])).rows[0].id);
        await c.query('UPDATE tasks SET exploration_id=$2 WHERE id=$1',[taskId,eid]);
      }
      await c.query('UPDATE exploration_nodes SET exploration_id=$2 WHERE task_id=$1 AND exploration_id IS NULL',[taskId,eid]);
      if (!(await c.query("SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='origin'",[eid])).rowCount)
        await c.query(`INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,state,origin)
          VALUES($1,$2,'fact',$3,$4,'origin','system')`,[taskId,eid,t.goal,JSON.stringify({summary:t.goal,description:t.description ?? ''})]);
      await c.query('COMMIT');
    } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  private async scopedNode(c:PoolClient,taskId:number,id:number,inherited=false):Promise<GraphNode|null> {
    const r=await c.query(`WITH ${directExplorationScope} SELECT n.*,s.task_id FROM exploration_nodes n
      JOIN scopes s ON s.exploration_id=n.exploration_id WHERE n.id=$2
      ${inherited?"AND (NOT s.inherited OR n.kind<>'intent' OR n.state IN('done','blocked','exhausted','stopped'))":"AND NOT s.inherited"}`,[taskId,id]);
    const n=r.rows[0] as GraphNode|undefined;
    return n ? {...n,...(Number(n.task_id)!==taskId?{inherited:true,source_task_id:n.task_id}:{})}:null;
  }
  private async add(c:PoolClient,taskId:number,eid:number,kind:string,payload:GraphPayload,state:string,origin:string,priority=0,anchors:number[]=[]):Promise<number> {
    const title=String(payload.summary ?? payload.text ?? '');
    const r=await c.query(`INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,state,origin,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[taskId,eid,kind,title,JSON.stringify(payload),state,origin,priority]);
    const id=Number(r.rows[0].id);
    for(const asset of anchors) await c.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,asset]);
    await c.query(`INSERT INTO business_events(business_kind,business_id,event_type,payload)
      VALUES('task',$1,'exploration_node_created',$2)`,[String(taskId),JSON.stringify({id,kind,state})]);
    return id;
  }
  private async link(c:PoolClient,eid:number,from:number,rel:string,to:number):Promise<void> {
    await c.query('INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[eid,from,rel,to]);
  }
  private async origin(c:PoolClient,eid:number):Promise<number> {
    return Number((await c.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='origin' ORDER BY id LIMIT 1",[eid])).rows[0]?.id ?? 0);
  }
  async addIntent(taskId:number,p:GraphPayload,options:{viaAgent?:boolean;allowCompleted?:boolean}={}):Promise<number> {
    if(!String(p.summary ?? '').trim()) throw new Error("summary cannot be empty");
    return this.transaction(taskId,async(c,eid)=>{
      if(options.viaAgent&&!options.allowCompleted){const t=(await c.query("SELECT status,paused,(SELECT status FROM explorations WHERE id=$2) AS exploration_status FROM tasks WHERE id=$1",[taskId,eid])).rows[0];if(!['created','running'].includes(t.status)||t.paused||t.exploration_status==='achieved')throw new Error("The task has been paused or ended, and the delegation intent cannot be continued");}
      const parents=ids(p.parent_ids), anchors=ids(p.asset_ids);
      for(const parent of parents){const n=await this.scopedNode(c,taskId,parent,true);
        if(!n)throw new Error(`parent_id ${parent} Does not exist in this task or is directly related to the task: parent_ids must be the existing [fact/finding] node id; please leave blank parent_ids for the top-level new direction`);
        if(!['fact','finding'].includes(n.kind))throw new Error(`parent_id ${parent} is "${n.kind}"Nodes cannot be used as intent anchors: intents can only be anchored on confirmed [facts/findings] and cannot be hung on intentions/goals/prompts; please leave blank parent_ids for the top-level new direction`);
      }
      if(p.business_system_id&&!(await c.query('SELECT 1 FROM task_business_models WHERE task_id=$1 AND system_id=$2',[taskId,Number(p.business_system_id)])).rowCount)throw new Error("business_system_id must be the system associated with this task");
      if(options.viaAgent&&anchors.length){
        let hits;try{hits=await new AssetsService(this.pool,'').checkAssetIds(taskId,anchors);}catch(error){throw new Error("Asset interception verification failed:"+(error as Error).message);}
        if(hits.length)throw new Error("Intention \""+p.summary+"\"The bound assets have not passed the test range verification. Please stop testing related assets:"+hits.map(h=>'\n - '+h.description).join(''));
      }
      const key=fingerprint([canonical(p.test_key||p.summary),[...anchors].sort((a,b)=>a-b)]);
      const previous=(await c.query("SELECT id,state,created_at,updated_at,payload FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND (payload->>'execution_fingerprint'=$2 OR (NOT payload ? 'execution_fingerprint' AND title=$3)) ORDER BY id DESC LIMIT 1",[taskId,key,String(p.summary)])).rows[0];
      const pocRefs=await validatePocReferences(c,taskId,p.poc_candidate_ids,true);
      const evidence=ids(p.new_evidence_ids),fingerprintRefs=ids(p.fingerprint_observation_ids);if(fingerprintRefs.length>20)throw new Error("Maximum of 20 fingerprint references");if(fingerprintRefs.length){const refs=await c.query('SELECT o.id FROM fingerprint_observations o JOIN fingerprint_jobs j ON j.id=o.job_id JOIN fingerprint_materials m ON m.id=j.material_id WHERE m.task_id=$1 AND o.id=ANY($2::bigint[])',[taskId,fingerprintRefs]);if(refs.rowCount!==fingerprintRefs.length)throw new Error("The fingerprint reference must belong to the current task");}
      if(previous){
        if(['open','running','paused'].includes(previous.state))return Number(previous.id);
        if(!evidence.length)return Number(previous.id);
        const fresh=(await c.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND id=ANY($2::bigint[]) AND kind IN('fact','finding') AND created_at>$3 AND id<>ALL($4::bigint[])",[taskId,evidence,previous.updated_at,ids(previous.payload?.new_evidence_ids)])).rows;
        if(fresh.length!==evidence.length)throw new Error("Repeated exploration requires new facts/findings of this task after the end of the direction as a basis; old evidence cannot be unlocked and retried repeatedly.");
      }
      const payload:GraphPayload={summary:p.summary,...(p.business_system_id?{business_system_id:Number(p.business_system_id)}:{}),execution_fingerprint:key,...(anchors.length?{asset_ids:anchors}:{})};
      if(pocRefs.length)payload.poc_candidate_ids=pocRefs;
      if(fingerprintRefs.length)payload.fingerprint_observation_ids=fingerprintRefs;
      for(const field of ['test_key','hypothesis','stop_condition'])if(canonical(p[field]))payload[field]=String(p[field]);
      if(evidence.length){
        for(const id of evidence){const ev=await this.scopedNode(c,taskId,id);if(!ev||!['fact','finding'].includes(ev.kind))throw new Error("new_evidence_ids must be facts/findings for this task");}
        payload.new_evidence_ids=evidence;
      }
      const id=await this.add(c,taskId,eid,'intent',payload,'open','planner',Number(p.priority)||5,anchors);
      if(pocRefs.length)await pocEvent(c,taskId,'poc_intent_linked',{intent_id:id,candidate_ids:pocRefs,hypothesis:p.hypothesis,stop_condition:p.stop_condition});
      if(fingerprintRefs.length)await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'fingerprint_intent_linked',$2)",[String(taskId),JSON.stringify({intent_id:id,observation_ids:fingerprintRefs,hypothesis:p.hypothesis,stop_condition:p.stop_condition})]);
      if(p.business_system_id)await c.query('INSERT INTO intent_business_models(intent_id,task_id,system_id) VALUES($1,$2,$3)',[id,taskId,Number(p.business_system_id)]);
      if(!parents.length){const origin=await this.origin(c,eid);if(origin)parents.push(origin);}
      for(const parent of parents)await this.link(c,eid,parent,'derived_from',id);
      return id;
    });
  }
  async recordFact(taskId:number,p:GraphPayload,origin='worker',defaultIntent=0):Promise<number> {
    if(!String(p.summary ?? '').trim())throw new Error("summary cannot be empty");
    return this.transaction(taskId,async(c,eid)=>{
      const intent=Number(p.intent_id)||defaultIntent;
      if(intent){const n=await this.scopedNode(c,taskId,intent);if(!n||n.kind!=='intent')throw new Error("intent_id must be the intent of this task (the associated task intent is read-only)");}
      const pocRefs=await validatePocReferences(c,taskId,p.poc_candidate_ids);
      // Vulnerability data reference: optional, record only"Which article did you refer to?"，does not mean verified
      let huntRefs: string[] = [];
      if (p.hunt_source_ids !== undefined) {
        const raw = p.hunt_source_ids;
        if (!Array.isArray(raw) || raw.length > 20 || raw.some(v => typeof v !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(v))) {
          throw new Error("hunt_source_ids must be a maximum of 20 source UUIDs");
        }
        huntRefs = [...new Set(raw as string[])];
        if (huntRefs.length) {
          const found = await c.query('SELECT id FROM hunt_sources WHERE task_id=$1 AND id=ANY($2::uuid[])', [taskId, huntRefs]);
          if (found.rowCount !== huntRefs.length) throw new Error("hunt_source_ids must belong to the current task");
        }
      }
      const payload:GraphPayload={summary:p.summary,...(pocRefs.length?{poc_candidate_ids:pocRefs}:{}),
        ...(huntRefs.length?{hunt_source_ids:huntRefs}:{})};
      for(const key of ['detail','evidence','confidence'])if(String(p[key] ?? '').trim())payload[key]=p[key];
      payload.evidence_fingerprint=fingerprint([canonical(p.summary),String(p.detail??''),String(p.evidence??''),ids(p.asset_ids).sort((a,b)=>a-b)]);
      const existing=(await c.query("SELECT id FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'evidence_fingerprint'=$2 LIMIT 1",[taskId,payload.evidence_fingerprint])).rows[0];
      const id=existing?Number(existing.id):await this.add(c,taskId,eid,'fact',payload,'confirmed',origin,5,ids(p.asset_ids));
      if(pocRefs.length){await c.query("UPDATE exploration_nodes SET payload=jsonb_set(payload,'{poc_candidate_ids}',(SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(COALESCE(payload->'poc_candidate_ids','[]'::jsonb)||$2::jsonb) v)) WHERE id=$1",[id,JSON.stringify(pocRefs)]);await pocEvent(c,taskId,'poc_evidence_linked',{fact_id:id,intent_id:intent,candidate_ids:pocRefs});}
      if(huntRefs.length)await c.query("UPDATE exploration_nodes SET payload=jsonb_set(payload,'{hunt_source_ids}',(SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(COALESCE(payload->'hunt_source_ids','[]'::jsonb)||$2::jsonb) v)) WHERE id=$1",[id,JSON.stringify(huntRefs)]);
      if(intent)await this.link(c,eid,intent,'yields',id);
      return id;
    });
  }
  async addGoal(taskId:number,p:GraphPayload,origin='human'):Promise<number>{
    const text=String(p.text ?? '').trim();if(!text)throw new Error("text cannot be empty");
    const id=await this.transaction(taskId,async(c,eid)=>{
      const id=await this.add(c,taskId,eid,'goal',{text,...(p.vulnclass?{vulnclass:String(p.vulnclass).trim()}:{}),...(p.objective_type?{objective_type:p.objective_type}:{})},'open',origin);
      const of=await this.origin(c,eid);if(of)await this.link(c,eid,of,'spawns',id);return id;
    });this.notify(taskId);return id;
  }
  private async writeHint(taskId:number,p:GraphPayload):Promise<number>{
    if(Array.isArray(p.traffic_refs)&&p.traffic_refs.length){const flag=(await this.pool.query("SELECT value FROM app_settings WHERE key='settings.agent_traffic_binding'")).rows[0];if(flag?.value!=='true')throw new Error("Agent's automatic binding of traffic has been turned off, and the prompt carrying traffic_refs has not been saved; it can be turned on in the system settings, or only handover text");}
    const text=typeof p.text==='string'?p.text:'';if(!goTrim(text))throw new Error("text cannot be empty");
    const refs=normalizeRefs(p.traffic_refs);
    return this.transaction(taskId,async(c,eid)=>this.add(c,taskId,eid,'hint',{text,...(refs.length?{traffic_refs:refs}:{})},'active','human',0,ids(p.asset_ids)));
  }
  private hintsChanged(taskId:number,texts:string[]):void{if(!texts.length)return;if(this.notifyHint)this.notifyHint(taskId,texts);else this.notify(taskId);}
  async addHint(taskId:number,p:GraphPayload):Promise<number>{const id=await this.writeHint(taskId,p);this.hintsChanged(taskId,[goTrim(String(p.text))]);return id;}
  async addHints(taskId:number,p:GraphPayload,signal?:AbortSignal):Promise<string|{ids:number[];errors?:Record<string,string>}>{
    const batch=Array.isArray(p.hints)&&p.hints.length>0,items=batch?p.hints as GraphPayload[]:[p],out:number[]=[],errors:Record<string,string>={},texts:string[]=[];
    for(let i=0;i<items.length;i++){if(signal?.aborted)throw new Error("Run canceled");try{out.push(await this.writeHint(taskId,items[i]??{}));texts.push(goTrim(String(items[i]?.text??'')));}catch(e){out.push(0);errors[String(i)]=(e as Error).message;}}
    this.hintsChanged(taskId,texts);
    if(!batch){if(errors['0'])throw new Error(errors['0']);return 'hint added: '+out[0];}
    return {ids:out,...(Object.keys(errors).length?{errors}:{})};
  }
  async addConstraint(taskId:number,p:GraphPayload,origin='human'):Promise<number>{
    const text=String(p.text ?? '').trim(),kind=String(p.type ?? 'deny').trim().toLowerCase();
    if(!text)throw new Error("text cannot be empty");if(!['allow','deny'].includes(kind))throw new Error("type must be allow or deny");
    return this.transaction(taskId,async(c,eid)=>Number((await c.query('INSERT INTO task_constraints(task_id,exploration_id,kind,text,origin) VALUES($1,$2,$3,$4,$5) RETURNING id',[taskId,eid,kind,text,origin])).rows[0].id));
  }
  async proveGoal(taskId:number,goalId:number,evidenceId:number):Promise<{allMet:boolean;goals:number;completed:boolean}>{
    const result=await this.transaction(taskId,async(c,eid)=>{
      const goal=await this.scopedNode(c,taskId,goalId);
      if(!goal||goal.kind!=='goal')throw new Error("goal_id must be the target node of this task (the associated task target is read-only)");
      const ev=await this.scopedNode(c,taskId,evidenceId,true);
      if(!ev||!['fact','finding'].includes(ev.kind))throw new Error("evidence_id must be the fact/vulnerability node of this task or a directly related task");
      await this.link(c,eid,evidenceId,'proves',goalId);
      await c.query("UPDATE exploration_nodes SET state='met',payload=payload-'resolution',content_version=content_version+1,updated_at=now() WHERE id=$1",[goalId]);
      const counts=(await c.query("SELECT count(*)::int AS n,count(*) FILTER(WHERE state<>'met')::int AS remaining FROM exploration_nodes WHERE task_id=$1 AND kind='goal'",[taskId])).rows[0];
      let completed=false;if(counts.n>0&&counts.remaining===0){completed=await finishAchievedTask(c,taskId);if(completed)await c.query("UPDATE explorations SET status='achieved',updated_at=now() WHERE id=$1",[eid]);}
      await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'goal_proved',$2)",[String(taskId),JSON.stringify({goalId,evidenceId})]);
      return {allMet:counts.n>0&&counts.remaining===0,goals:counts.n,completed};
    });this.notify(taskId);return result;
  }
  async resolveGoal(taskId:number,goalId:number,evidenceId:number,outcome:string,reason:string):Promise<void>{
    if(!['tested_negative','blocked'].includes(outcome)||!reason.trim())throw new Error("Requires valid outcome and non-empty reason");
    await this.transaction(taskId,async(c,eid)=>{
      const task=(await c.query('SELECT status,paused FROM tasks WHERE id=$1',[taskId])).rows[0];
      if(task.status!=='running'||task.paused)throw new Error("The task is not being executed and the target cannot be closed automatically.");
      const goal=await this.scopedNode(c,taskId,goalId),ev=await this.scopedNode(c,taskId,evidenceId);
      if(!goal||goal.kind!=='goal'||goal.state==='met')throw new Error("Can only close the unfulfilled goals of this task");
      if(!ev||ev.kind!=='fact'||ev.state!=='confirmed')throw new Error("The closing statement must cite the true recorded facts of this task");
      if(outcome==='tested_negative'&&!canonical(ev.payload.evidence)&&!canonical(ev.payload.detail))throw new Error("A negative test must contain actual evidence or detail, and cannot be closed with only one conclusion.");
      const resolution={outcome,reason,evidence_id:evidenceId,ts:new Date().toISOString()};
      await c.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('resolution',$2::jsonb),content_version=content_version+1,updated_at=now() WHERE id=$1",[goalId,JSON.stringify(resolution)]);
      await this.link(c,eid,evidenceId,'resolves',goalId);
      await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'goal_resolved',$2)",[String(taskId),JSON.stringify({goalId,...resolution})]);
    });this.notify(taskId);
  }
  async node(taskId:number,id:number,inherited=true):Promise<GraphNode|null>{const c=await this.pool.connect();try{return await this.scopedNode(c,taskId,id,inherited);}finally{c.release();}}
  async nodes(taskId:number,kind?:string):Promise<GraphNode[]> {
    return (await this.pool.query(`SELECT * FROM exploration_nodes WHERE task_id=$1 ${kind?'AND kind=$2':''} ORDER BY id DESC LIMIT 10000`,kind?[taskId,kind]:[taskId])).rows;
  }
  async graph(taskId:number):Promise<{nodes:ReturnType<typeof nodeDTO>[];edges:ReturnType<typeof edgeDTO>[]}>{
    const nodes=await this.pool.query(`WITH ${directExplorationScope} SELECT n.*,s.task_id,CASE WHEN s.inherited THEN s.task_id END source_task_id,s.inherited FROM exploration_nodes n
      JOIN scopes s ON s.exploration_id=n.exploration_id ORDER BY id LIMIT 2000`,[taskId]);
    const edges=await this.pool.query(`WITH ${directExplorationScope} SELECT e.* FROM exploration_edges e JOIN scopes s USING(exploration_id) ORDER BY src_id,dst_id,rel LIMIT 5000`,[taskId]);
    const visible=nodes.rows.filter(n=>!n.inherited||n.kind!=='intent'||['done','blocked','exhausted','stopped'].includes(n.state));
    const visibleIds=new Set(visible.map(n=>String(n.id)));
    return markFindingPaths(visible.map(nodeDTO),edges.rows.filter(e=>visibleIds.has(String(e.src_id))&&visibleIds.has(String(e.dst_id))).map(edgeDTO));
  }
  async page(taskId:number,q:URLSearchParams):Promise<Record<string,unknown>>{
    const page=Math.max(1,Number(q.get('page'))||1),size=Math.min(200,Math.max(1,Number(q.get('size'))||20));
    const args:unknown[]=[taskId],where=['task_id=$1'];
    for(const key of ['kind','state']){const v=(q.get(key)??'').split(',').map(s=>s.trim()).filter(Boolean);if(v.length){args.push(v);where.push(`${key}=ANY($${args.length}::text[])`);}}
    const query=q.get('q')?.trim();if(query){args.push(`%${query}%`);let search=`(payload::text ILIKE $${args.length} OR COALESCE(origin,'') ILIKE $${args.length}`;
      if(/^#?\d+$/.test(query)){args.push(Number(query.replace('#','')));search+=` OR id=$${args.length}`;}where.push(search+')');}
    const total=Number((await this.pool.query(`SELECT count(*) AS n FROM exploration_nodes WHERE ${where.join(' AND ')}`,args)).rows[0].n);
    const rows=await this.pool.query(`SELECT * FROM exploration_nodes WHERE ${where.join(' AND ')} ORDER BY id ${q.get('order')==='asc'?'ASC':'DESC'} LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,size,(page-1)*size]);
    const nodeIds=rows.rows.map(n=>Number(n.id));
    const edges=(await this.pool.query('SELECT * FROM exploration_edges WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1) AND (src_id=ANY($2::bigint[]) OR dst_id=ANY($2::bigint[])) ORDER BY src_id,dst_id,rel',[taskId,nodeIds])).rows;
    const neighbors=[...new Set(edges.flatMap(e=>[Number(e.src_id),Number(e.dst_id)]))].filter(id=>!nodeIds.includes(id));
    const refs=(await this.pool.query('SELECT * FROM exploration_nodes WHERE id=ANY($1::bigint[])',[neighbors])).rows;
    const anchored=(await this.pool.query('SELECT a.node_id,b.id,b.type,b.value FROM exploration_anchors a JOIN assets b ON b.id=a.asset_id WHERE a.node_id=ANY($1::bigint[]) ORDER BY b.id',[nodeIds.concat(neighbors)])).rows;
    const assets:Record<string,unknown[]>={};for(const a of anchored)(assets[a.node_id]??=[]).push({id:a.id,type:a.type,value:a.value});
    return {items:rows.rows.map(nodeDTO),total,page,size,edges:edges.map(edgeDTO),refs:Object.fromEntries(refs.map(n=>[n.id,nodeDTO(n)])),assets};
  }
  async facts(taskId:number,p:GraphPayload):Promise<Record<string,unknown>>{
    const limit=Math.min(100,Math.max(1,Number(p.limit)||20));const before=Number(p.before)||0,q=String(p.q??'').trim();
    const base=`kind='fact' AND ($2::text='' OR payload->>'summary' ILIKE '%'||$2||'%')`;
    const total=Number((await this.pool.query(`WITH ${directExplorationScope} SELECT count(*) AS n FROM exploration_nodes n JOIN scopes s USING(exploration_id) WHERE ${base}`,[taskId,q])).rows[0].n);
    const ns=(await this.pool.query(`WITH ${directExplorationScope} SELECT n.*,s.task_id FROM exploration_nodes n JOIN scopes s USING(exploration_id) WHERE ${base} AND ($3::bigint=0 OR id<$3) ORDER BY id DESC LIMIT $4`,[taskId,q,before,limit+1])).rows;
    const hasMore=ns.length>limit,items=ns.slice(0,limit).map(n=>{const summary=String(n.payload.summary??''),tooLong=Array.from(summary).length>160;
      return {id:Number(n.id),kind:n.kind,state:n.state,summary:tooLong?Array.from(summary).slice(0,160).join('')+'…':summary,...(tooLong?{summary_truncated:true}:{}),...(Number(n.task_id)!==taskId?{source_task_id:Number(n.task_id),inherited:true}:{})};});
    return {facts:items,total,has_more:hasMore,...(hasMore&&items.length?{next_before:items.at(-1)!.id}:{})};
  }
  async overview(taskId:number,includeCoverage=true):Promise<Record<string,unknown>>{return new PlannerOverview(this.pool).read(taskId,includeCoverage);}
  async expandDigest(taskId:number,id:number):Promise<Record<string,unknown>>{return new PlannerOverview(this.pool).expand(taskId,id);}
}
