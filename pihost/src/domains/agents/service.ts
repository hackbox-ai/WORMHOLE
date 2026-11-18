/**
 * F12 Agent Configuration, prompt word version, trigger and authorization service。
 * Built-in agent Cannot be deleted；prompt PUT Generate new version; trigger/Visibility/Variable button WORMHOLE Shape。
 * F12 Release gate (compiled to Pi session）：resolveSessionSpec(agentKey) Output
 * systemPrompt(Latest prompt Version, Variable rendering) + Model(llm_profile Binding → F11 Compile provider)。
 */
import type { Pool } from "pg";
import { createAgentRecord, type AgentCreateInput } from "./creation.ts";
import {readFileSync} from "node:fs";
import {inspectTemplate,renderTemplate} from "./template.ts";
import {formatTriggerTime} from "../tasks/scheduler.ts";
export const promptDefaults=JSON.parse(readFileSync(new URL("./prompt-defaults.json",import.meta.url),"utf8")) as {prompts:Record<string,string>;custom:Record<string,string>;assistant:string;wrapup:Record<string,{prompt:string;turns:number;task_timeout:string}>};
import { appendEvent } from "../../events/ledger.ts";
import { methodologyGuidance } from "../skills/methodology.ts";
import { vulnIntelGuidance } from "../skills/vuln-intel.ts";

const AGENT_COLS = `id, key, name, description, role, builtin, enabled, llm_profile_id,
  max_turns, run_seconds, web_search, interactive_shell, wrapup_prompt, wrapup_max_turns,
  task_timeout_wrapup_prompt, task_timeout_wrapup_max_turns,
  trigger_run_mode, trigger_merge_mode, trigger_max_parallel`;

export interface AgentInput {
  key?: string;
  name?: string;
  description?: string;
  role?: string;
  enabled?: boolean;
  llm_profile_id?: number | null;
  max_turns?: number;
  run_seconds?: number;
  web_search?: boolean;
  interactive_shell?: boolean;
  wrapup_prompt?: string;
  wrapup_max_turns?: number;
  task_timeout_wrapup_prompt?: string;
  task_timeout_wrapup_max_turns?: number;
  trigger_run_mode?: string;
  trigger_merge_mode?: string;
  trigger_max_parallel?: number;
}

export class AgentsService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
  ) {}

  async list(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(`SELECT ${AGENT_COLS} FROM agents ORDER BY id`);
    return this.decorate(r.rows as Record<string, unknown>[]);
  }

  async get(key: string): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query(`SELECT ${AGENT_COLS} FROM agents WHERE key=$1`, [key]);
    if ((r.rowCount ?? 0) === 0) return null;
    return (await this.decorate(r.rows as Record<string, unknown>[]))[0]!;
  }

  /** Additional mcp_count/skill_count（Compare baseline list shape） */
  private async decorate(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    for (const row of rows) {
      const k = row.key as string;
      const v = await this.pool.query("SELECT count(*)::int AS n FROM agent_visibility WHERE agent_key=$1 AND resource_kind='mcp'", [k]);
      const tc = await this.pool.query("SELECT count(*)::int AS n FROM tools WHERE agents @> to_jsonb(ARRAY[$1]::text[])", [k]);
      const s = await this.pool.query("SELECT count(*)::int AS n FROM agent_visibility WHERE agent_key=$1 AND resource_kind='skill'", [k]);
      row.mcp_count = (v.rows[0] as { n: number }).n;
      row.skill_count = (s.rows[0] as { n: number }).n;
      row.tool_count = (tc.rows[0] as { n: number }).n;
      // List shape versus baseline: Excluded wrapup_*/task_timeout_*（The details interface is also）
      delete row.wrapup_prompt;
      delete row.wrapup_max_turns;
      delete row.task_timeout_wrapup_prompt;
      delete row.task_timeout_wrapup_max_turns;
    }
    return rows;
  }

  async create(input: AgentCreateInput): Promise<{ ok: true; agent: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    const result = await createAgentRecord(this.pool, input, promptDefaults.assistant, {fields:TRIGGER_EDITABLE,values:triggerFields});
    if (result.ok) await this.audit("agent_created", {key:result.agent.key});
    return result;
  }

  /** PATCH /config Shared: Partially updated */
  async update(key: string, input: AgentInput): Promise<{ ok: true; agent: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    const raw = (await this.pool.query(`SELECT ${AGENT_COLS} FROM agents WHERE key=$1`, [key])).rows[0] as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, status: 404, error: "agent does not exist" };
    const cur = raw;
    const merged = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([key, v]) => v !== undefined && (v !== null || key === 'llm_profile_id'))) };
    await this.pool.query(
      `UPDATE agents SET name=$2, description=$3, role=$4, enabled=$5, llm_profile_id=$6, max_turns=$7,
         run_seconds=$8, web_search=$9, interactive_shell=$10, wrapup_prompt=$11, wrapup_max_turns=$12,
         task_timeout_wrapup_prompt=$13, task_timeout_wrapup_max_turns=$14,
         trigger_run_mode=$15, trigger_merge_mode=$16, trigger_max_parallel=$17, updated_at=now()
       WHERE key=$1`,
      [
        key, merged.name, merged.description, merged.role, merged.enabled, merged.llm_profile_id,
        merged.max_turns, merged.run_seconds, merged.web_search, merged.interactive_shell,
        merged.wrapup_prompt, merged.wrapup_max_turns, merged.task_timeout_wrapup_prompt,
        merged.task_timeout_wrapup_max_turns, merged.trigger_run_mode, merged.trigger_merge_mode, merged.trigger_max_parallel,
      ],
    );
    await this.audit("agent_updated", { key });
    return { ok: true, agent: (await this.get(key))! };
  }

  async remove(key: string): Promise<{ ok: boolean; status: number; error?: string }> {
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const row=(await c.query("SELECT builtin FROM agents WHERE key=$1 FOR UPDATE",[key])).rows[0];
      if(!row){await c.query("ROLLBACK");return {ok:false,status:404,error:"agent does not exist"};}
      if(row.builtin){await c.query("ROLLBACK");return {ok:false,status:400,error:"The built-in agent cannot be deleted"};}
      await c.query("DELETE FROM agents WHERE key=$1",[key]);
      await c.query("DELETE FROM agent_visibility WHERE agent_key=$1",[key]);
      await c.query("DELETE FROM agent_variables WHERE agent_key=$1",[key]);
      await c.query("DELETE FROM scheduler_state WHERE agent_key=$1",[key]);
      await c.query("UPDATE tools SET agents=COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(agents) AS entries(value) WHERE value<>to_jsonb($1::text)),'[]'::jsonb) WHERE agents @> jsonb_build_array($1::text)",[key]);
      await c.query("COMMIT");
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
    await this.audit("agent_deleted", {key});
    return {ok:true,status:200};
  }

  // ── prompts（Versioning） ──
  async prompts(key: string): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      "SELECT id, version, prompt, updated_at,created_at,note,updated_by FROM agent_prompts WHERE agent_key=$1 ORDER BY version DESC",
      [key],
    );
    return r.rows;
  }

  async raw(key:string):Promise<Record<string,any>|null>{
    return (await this.pool.query("SELECT "+AGENT_COLS+" FROM agents WHERE key=$1",[key])).rows[0]??null;
  }
  async putPrompt(key:string,prompt:string,note="",by="ui"):Promise<{ok:boolean;version:number}> {
    const c=await this.pool.connect();let version:number;
    try{await c.query("BEGIN");const agent=(await c.query("SELECT id FROM agents WHERE key=$1 FOR UPDATE",[key])).rows[0];
      if(!agent)throw Object.assign(new Error("agent not found"),{status:404});
      const row=(await c.query("INSERT INTO agent_prompts(agent_key,version,prompt,note,updated_by) VALUES($1,COALESCE((SELECT max(version)+1 FROM agent_prompts WHERE agent_key=$1),1),$2,$3,$4) RETURNING id,version",[key,prompt,note,by])).rows[0];
      version=Number(row.version);await c.query("UPDATE agents SET current_prompt_id=$2 WHERE key=$1",[key,row.id]);await c.query("COMMIT");
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
    await this.audit("agent_prompt_updated",{key,version});return {ok:true,version};
  }
  async latestPrompt(key:string):Promise<string> {
    const row=(await this.pool.query("SELECT p.prompt FROM agents a JOIN agent_prompts p ON p.agent_key=a.key AND (p.id=a.current_prompt_id OR a.current_prompt_id IS NULL) WHERE a.key=$1 ORDER BY p.version DESC LIMIT 1",[key])).rows[0];
    return row?String(row.prompt):"";
  }
  async catalog(key:string):Promise<Record<string,string>[]> {
    const rows=(await this.pool.query("SELECT name,description,example,source FROM agent_variables WHERE agent_key=$1 AND name NOT IN ('Now','DataDir') ORDER BY name",[key])).rows;
    return [...rows,{name:"Now",description:"The current time of the server (refreshed in real time every time it runs; it can be subtracted from the fixed starting time to determine the elapsed time)",example:"2026-08-11 14:30:00 CST",source:"runtime"},{name:"DataDir",description:"Server data root directory (the root of all tasks/session products; the subdirectory under which each agent actually writes disks, such as <DataDir>/<taskID>)",example:"/app/data",source:"runtime"}];
  }
  async validatePrompt(key:string,template:string):Promise<string> {
    const parsed=await inspectTemplate(template);if(parsed.syntaxError)return "Template syntax error: "+parsed.syntaxError;
    const allowed=new Set((await this.catalog(key)).map(v=>v.name));
    for(const name of parsed.fields)if(!allowed.has(name))return "Variable {{."+name+"}} is not in the allowed list of this agent";
    return "";
  }
  async previewPrompt(key:string,template:string,sample:Record<string,string>={}):Promise<{rendered:string;error?:string}> {
    const data=Object.fromEntries((await this.catalog(key)).map(v=>[v.name!,v.example!]));
    const result=await renderTemplate(template||await this.latestPrompt(key),{...data,...sample});
    return result.syntaxError||result.error?{rendered:"",error:result.syntaxError??result.error}:{rendered:result.rendered??""};
  }
  async renderPrompt(key:string,runtime:Record<string,string>={}):Promise<string> {
    const custom={...Object.fromEntries((await this.catalog(key)).map(v=>[String(v.name),""])),...Object.fromEntries((await this.variables(key)).map(v=>[String(v.name),String(v.value??"")]))};
    const result=await renderTemplate(await this.latestPrompt(key),{...custom,...runtime,Now:formatTriggerTime(new Date()),DataDir:runtime.DataDir??process.env.WORMHOLE_DATA_DIR??""});
    if(result.syntaxError||result.error)throw new Error(result.syntaxError??result.error);return result.rendered??"";
  }
  async resetPrompt(key:string):Promise<{ok:boolean;version:number}> {
    if(!await this.get(key))throw Object.assign(new Error("agent not found"),{status:404});
    const prompt=promptDefaults.prompts[key];if(prompt===undefined)throw Object.assign(new Error("The agent has no built-in default prompt word and cannot be restored."),{status:400});
    return this.putPrompt(key,prompt,"Revert to built-in default","system");
  }

  async variables(key: string): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query("SELECT name, value FROM agent_variables WHERE agent_key=$1 ORDER BY name", [key]);
    return r.rows;
  }

  // ── triggers ──
  async triggers(key: string): Promise<Record<string, unknown>[]> {
    return (await this.pool.query("SELECT * FROM agent_triggers WHERE agent_key=$1 ORDER BY id", [key])).rows.map(triggerDTO);
  }

  async addTrigger(key: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const agent=await this.get(key);
    if(!agent)throw Object.assign(new Error("agent does not exist"),{status:404});
    if(agent.builtin)throw Object.assign(new Error("Trigger only supports custom agents"),{status:400});
    const fields=triggerFields(input);
    const result=await this.pool.query("INSERT INTO agent_triggers(agent_key,"+TRIGGER_EDITABLE.join(',')+") VALUES($1,"+TRIGGER_EDITABLE.map((_,i)=>'$'+(i+2)).join(',')+") RETURNING *",[key,...fields]);
    await this.audit('agent_trigger_added',{key});return triggerDTO(result.rows[0]);
  }
  async updateTrigger(id:number,input:Record<string,unknown>):Promise<void>{
    const fields=triggerFields(input);
    await this.pool.query('UPDATE agent_triggers SET '+TRIGGER_EDITABLE.map((k,i)=>k+'=$'+(i+2)).join(',')+' WHERE id=$1',[id,...fields]);
  }
  async removeTrigger(id:number):Promise<void>{await this.pool.query('DELETE FROM agent_triggers WHERE id=$1',[id]);}

  // ── visibility ──
  async visibility(key: string): Promise<Record<string, unknown>> {
    const r = await this.pool.query(
      "SELECT resource_kind, resource_id FROM agent_visibility WHERE agent_key=$1 ORDER BY resource_kind, resource_id",
      [key],
    );
    const out: Record<string, string[]> = { mcp: [], tool: [], skill: [] };
    for (const row of r.rows as { resource_kind: string; resource_id: string }[]) {
      (out[row.resource_kind] ??= []).push(row.resource_id);
    }
    return out;
  }

  async putVisibility(key: string, vis: Record<string, string[]>): Promise<void> {
    await this.pool.query("DELETE FROM agent_visibility WHERE agent_key=$1", [key]);
    for (const [kind, ids] of Object.entries(vis)) {
      for (const id of ids ?? []) {
        await this.pool.query(
          "INSERT INTO agent_visibility (agent_key, resource_kind, resource_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [key, kind, id],
        );
      }
    }
    await this.audit("agent_visibility_updated", { key });
  }

  /**
   * F12 Release gate：agent → Pi session Assembly specifications（system prompt Variable rendering + Model binding analysis）。
   * Model parsing priority：agent.llm_profile_id → F11 Activate profile。
   */
  async resolveSessionSpec(key: string,runtime:Record<string,string>={}): Promise<{
    agentKey: string;
    systemPrompt: string;
    provider?: string;
    modelId?: string;
    llmProfileId: number | null;
  }> {
    const agent = await this.get(key);
    if (!agent) throw new Error(`agent does not exist: ${key}`);
    const grants = (await this.pool.query(
      "SELECT resource_id FROM agent_visibility WHERE agent_key=$1 AND resource_kind='skill'", [key],
    )).rows.map(row => String(row.resource_id));
    const systemPrompt = await this.renderPrompt(key,runtime) + methodologyGuidance(key,grants) + vulnIntelGuidance(key,grants);
    let provider: string | undefined;
    let modelId: string | undefined;
    const profileId = agent.llm_profile_id ? Number(agent.llm_profile_id) : null;
    if (profileId) {
      const p = await this.pool.query("SELECT id, model FROM llm_profiles WHERE id=$1", [profileId]);
      if (p.rows[0]) {
        provider = `profile-${p.rows[0]!.id}`;
        modelId = String(p.rows[0]!.model);
      }
    } else {
      const act = await this.pool.query("SELECT id, model FROM llm_profiles WHERE is_default=TRUE LIMIT 1");
      if (act.rows[0]) {
        provider = `profile-${act.rows[0]!.id}`;
        modelId = String(act.rows[0]!.model);
      }
    }
    return { agentKey: key, systemPrompt, provider, modelId, llmProfileId: profileId };
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "agents", business_id: "global", event_type: event, payload });
  }
}

const TRIGGER_EDITABLE=['enabled','interval_sec','on_finding','on_goal_met','on_task_timeout','on_tool_call','on_task_create','interval_message','finding_message','goal_message','task_timeout_message','tool_call_message','task_create_message','tool_names'] as const;
function triggerFields(input:Record<string,unknown>):unknown[]{
 const error=(message:string):never=>{throw Object.assign(new Error(message),{status:400});};
 for(const key of TRIGGER_EDITABLE){
  const v=input[key];if(v===undefined||v===null)continue;
  const kind=key==='interval_sec'?'int':key==='enabled'||key.startsWith('on_')?'bool':key==='tool_names'?'[]string':'string';
  const valid=kind==='int'?typeof v==='number'&&Number.isSafeInteger(v):kind==='bool'?typeof v==='boolean':kind==='[]string'?Array.isArray(v)&&v.every(n=>n===null||typeof n==='string'):typeof v==='string';
  if(!valid)error('json: cannot unmarshal '+(Array.isArray(v)?'array':typeof v)+' into Go struct field triggerReq.'+key+' of type '+kind);
 }
 const interval=Math.max(0,Number(input.interval_sec??0));
 if(!interval&&!['on_finding','on_goal_met','on_task_timeout','on_tool_call','on_task_create'].some(k=>input[k]===true))error("Select at least one trigger condition (timing/finding/goal achievement/task timeout/tool call/task creation)");
 const names=((input.tool_names??[]) as (string|null)[]).map(n=>n??'');
 if(input.on_tool_call&&!names.length)error("Tool call trigger selects at least one tool");
 return TRIGGER_EDITABLE.map(k=>k==='interval_sec'?interval:k==='tool_names'?(names.length?JSON.stringify(names):''):k==='enabled'||k.startsWith('on_')?input[k]??false:input[k]??'');
}
function triggerDTO(row:Record<string,any>):Record<string,unknown>{
 let names=[];try{names=JSON.parse(row.tool_names||'[]');}catch{}
 return {id:Number(row.id),agent_key:row.agent_key,...Object.fromEntries(TRIGGER_EDITABLE.map(k=>[k,k==='tool_names'?names:row[k]])),...(row.last_fire?{last_fire:row.last_fire}:{})};
}
