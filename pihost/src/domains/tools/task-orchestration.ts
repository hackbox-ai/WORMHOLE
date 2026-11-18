/** Runtime implementations for original server/orchestration.go task operations.
 * Public schemas/reset defaults come from the independent frozen source census.
 */
import type {Pool} from 'pg';
import {registerTool} from './gate.ts';
import type {PlatformDeps} from './platform.ts';
import {ExplorationService} from '../exploration/service.ts';
import {goTrim} from '../assets/asset-match.ts';
import seeds from './platform-tool-seeds.json' with {type:'json'};
const terminal=(status:unknown)=>['done','failed','timeout'].includes(String(status));
export async function resolveTask(pool:Pool,value:unknown):Promise<number>{
 const raw=typeof value==='string'?value:'';if(!goTrim(raw))throw new Error("task_id is required");
 if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||!(await pool.query('SELECT 1 FROM tasks WHERE id::text=$1 AND deleted_at IS NULL',[raw])).rowCount)throw new Error("task does not exist: "+raw);return Number(raw);
}
function profileID(raw:unknown):number{const text=typeof raw==='string'?goTrim(raw):typeof raw==='number'&&Number.isInteger(raw)?String(raw):'';return /^[+-]?[0-9]+$/.test(text)&&Number.isSafeInteger(Number(text))?Number(text):0;}
export function registerTaskOrchestration(deps:PlatformDeps):void{
 const graph=deps.graph??new ExplorationService(deps.pool);
 const handlers:Record<string,(p:Record<string,unknown>,ctx:import('./gate.ts').ToolContext)=>Promise<unknown>>={
 list_tasks:async()=>{
  const profiles=(await deps.pool.query('SELECT id,name FROM llm_profiles ORDER BY id')).rows,now=Math.floor(Date.now()/1000);
  const rows=(await deps.pool.query(`SELECT t.*,floor(extract(epoch from t.created_at))::bigint created_seconds,COALESCE((SELECT extract(epoch from max(a.created_at))::bigint FROM activity a WHERE a.exploration_id=t.exploration_id),0) last_activity FROM tasks t WHERE t.deleted_at IS NULL AND NOT t.archived ORDER BY t.pinned_at DESC NULLS LAST,t.id DESC`)).rows;
  return Promise.all(rows.map(async t=>{const state=await deps.taskRuntimeState?.(Number(t.id)),status=terminal(t.status)?t.status:t.paused||state?.paused?'paused':state?.started&&state.ready?'running':'created';const end=Number(t.last_activity),created=Number(t.created_seconds),duration=status==='running'?now-created:end>created?end-created:0;
    const pinned=t.llm_profile_id,profile=profiles.find(p=>String(p.id)===String(pinned));return {id:String(t.id),description:t.description,goal:t.goal,status,run_seconds:duration,...(t.parent_ref?{parent_ref:t.parent_ref}:{}),llm_profile:pinned==null?"(activate configuration)":profile?.name??`#${pinned}(Deleted)`};}));
 },
 list_llm_profiles:async()=>({profiles:(await deps.pool.query('SELECT id,name,model,format,is_default FROM llm_profiles ORDER BY id')).rows.map(p=>({id:Number(p.id),name:p.name,model:p.model,format:p.format,is_active:p.is_default}))}),
 spawn_task:async p=>{
  const description=typeof p.description==='string'&&goTrim(p.description)?p.description:"Unnamed task",goal=typeof p.goal==='string'?p.goal:'';if(!goTrim(goal))throw new Error("goal is required");
  const sources=Array.isArray(p.source_task_ids)?p.source_task_ids:[];if(sources.length>8)throw new Error("Select up to 8 associated tasks");const ids:number[]=[];
  for(const raw of sources){const text=typeof raw==='string'?goTrim(raw):'',id=/^[+-]?[0-9]+$/.test(text)?Number(text):0;if(!Number.isSafeInteger(id)||id<=0||ids.includes(id))throw new Error("The associated task id is invalid or duplicate");if(!(await deps.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rowCount)throw new Error(`Associated tasks #${id} does not exist`);ids.push(id);}
  const parent=typeof p.parent_ref==='string'?p.parent_ref:'';let pin:number|null=null;const explicit=profileID(p.llm_profile_id);
  if(explicit>0){if(!(await deps.pool.query("SELECT 1 FROM llm_profiles WHERE id=$1 AND api_key<>''",[explicit])).rowCount)throw new Error(`LLM Configuration #${explicit} API Key does not exist or is not set`);pin=explicit;}
  else if(parent){const row=(await deps.pool.query('SELECT llm_profile_id FROM tasks WHERE id::text=$1 AND deleted_at IS NULL',[parent])).rows[0];if(row?.llm_profile_id)pin=Number(row.llm_profile_id);}
  const result=await deps.tasks.create({description,goal,parent_ref:parent,source_task_ids:ids,llm_profile_id:pin,timeout_seconds:Math.max(0,Number(p.timeout_seconds)||0),plan_heartbeat_seconds:Number(p.plan_heartbeat_seconds)||0,seed_first_intent:p.seed_first_intent===true});
  if(!result.ok)throw new Error(result.error??"Task creation failed");return 'task created: '+result.task!.id;
 },
 pause_task:async p=>{const raw=typeof p.task_id==='string'?p.task_id:'';if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||!(await deps.pool.query('SELECT 1 FROM tasks WHERE id::text=$1 AND deleted_at IS NULL',[raw])).rowCount)throw new Error("task does not exist: "+raw);const release=deps.taskOperation?.(Number(raw));if(deps.taskOperation&&!release)throw new Error("Task is being deleted and cannot be controlled");try{const result=await deps.tasks.control(Number(raw),'pause');if(!result.ok)throw new Error(result.error??"Pause failed");return 'task paused: '+raw;}finally{release?.();}},
 get_task_graph:async p=>graph.overview(await resolveTask(deps.pool,p.task_id),false),
 add_task_hint:async(p,c)=>graph.addHints(await resolveTask(deps.pool,p.task_id),p,c.signal),
 };
 for(const [key,execute] of Object.entries(handlers)){const seed=seeds.find(s=>s.key===key)!;registerTool({key,description:seed.description+(key==='spawn_task'?". Immediately after acceptance, the task number and status are fed back to the user; the progress is tracked by the task module, and there is no polling to wait for completion.":''),schema:seed.schema,params:{},required:[],execute});}
}
