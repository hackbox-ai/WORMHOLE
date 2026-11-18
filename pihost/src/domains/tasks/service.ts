import {networkBinding} from '../network/binding.ts';
import {taskProgress,progressSQL,modelingPendingSQL,modelingUnavailableSQL} from './progress.ts';
/**
 * F03 Task creation, status control and list metering services。
 * State Machine Vs. CAS Receive reuse B05（state-machine + host）；This document supplements API Face and layout entrance。
 */
import type { Pool,PoolClient } from "pg";
import {withTaskReport} from './report.ts';
import { appendEvent } from "../../events/ledger.ts";
import { assertTaskTransition, type TaskStatus } from "./state-machine.ts";
import {validateAssetRule,goTrim} from '../assets/asset-match.ts';
import {initialTaskName} from "./name.ts";
import {TaskLLMChains} from '../llm/task-chain.ts';
import {normalizeTarget} from '../modeling/document.ts';
import {taskWebTargets} from './targets.ts';

export interface TaskInput {
  network_mode?:'standard'|'jump';
  network_channel_id?:number|null;
  source_task_ids?: (number|string)[];
  parent_ref?: string;
  seed_first_intent?: boolean;
  intercept_rules?:Record<string,unknown>[];
  name?: string;
  goal?: string;
  category?: string;
  queued?: boolean;
  plan_heartbeat_seconds?: number;
  timeout_seconds?: number;
  llm_profile_id?: number | null;
  llm_profile_ids?:number[];
  agent_key?: string;
  description?: string;
  modeling_targets?:string[];
}

export class TaskService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    private readonly onLaunch: (taskId: number) => void,
    /** G03：Control plane callback——pause Cancel current session；stop Terminate entire RunContext */
    private readonly onControl: (taskId: number, action: "pause" | "resume" | "stop") => void | Promise<void> = () => {},
  ) {}

  async create(input: TaskInput,client?:PoolClient): Promise<{ ok: true; task: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    const db=client??this.pool;
    let network;try{network=await networkBinding(db,input);}catch(e){return {ok:false,status:400,error:(e as Error).message};}
    const initialRules=input.intercept_rules??[];
    if(!Array.isArray(initialRules))return {ok:false,status:400,error:"intercept_rules must be an array"};
    const rules:Record<string,unknown>[]=[];
    for(const item of initialRules){const rule=item??{};if(typeof rule!=='object'||Array.isArray(rule))return {ok:false,status:400,error:"intercept_rules must be an array of rules objects"};
      const error=validateAssetRule(rule,true);if(error)return {ok:false,status:400,error};
      rules.push({kind:rule.kind,pattern:goTrim(String(rule.pattern??'')),action:rule.action||'block',note:rule.note??'',enabled:rule.enabled??false});
    }
    const goal = input.goal ?? "";
    const rawSources=input.source_task_ids??[];
    if(!Array.isArray(rawSources)||rawSources.length>8)return {ok:false,status:400,error:"Select up to 8 associated tasks"};
    const sourceIDs:number[]=[];
    for(const raw of rawSources){const text=goTrim(String(raw)),id=/^[+-]?[0-9]+$/.test(text)?Number(text):0;
      if(!Number.isSafeInteger(id)||id<=0||sourceIDs.includes(id))return {ok:false,status:400,error:"The associated task id is invalid or duplicate"};
      if(!(await db.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rowCount)return {ok:false,status:400,error:`Associated tasks #${id} does not exist`};
      sourceIDs.push(id);
    }
    if(input.modeling_targets!==undefined&&(!Array.isArray(input.modeling_targets)||input.modeling_targets.length>20||input.modeling_targets.some(t=>typeof t!=='string'||t.length>2048)))return {ok:false,status:400,error:"Modeling target must be an array of up to 20 addresses"};
    let targets:string[];try{targets=[...new Set((input.modeling_targets??[]).map(normalizeTarget))];}catch{return {ok:false,status:400,error:"Invalid modeling target address"};}
    const webTargets=taskWebTargets({modeling_targets:targets,goal,description:input.description});
    const ids=input.llm_profile_ids??(input.llm_profile_id?[input.llm_profile_id]:[]);
    if(!Array.isArray(ids)||ids.some((n,i)=>!Number.isSafeInteger(n)||n<=0||ids.indexOf(n)!==i))return {ok:false,status:400,error:"LLM configuration id is invalid or duplicate"};
    for(const id of ids)if(!(await db.query('SELECT 1 FROM llm_profiles WHERE id=$1 AND api_key<>\'\'',[id])).rowCount)return {ok:false,status:400,error:`LLM Configuration #${id} API Key does not exist or is not set`};
    // Baseline Behavior: Null goal can also be created（description=Unnamed task）
    const hb = Math.max(600, Number(input.plan_heartbeat_seconds) || 600);
    let r;try{r = await db.query(
      `WITH e AS (INSERT INTO explorations(goal,description) VALUES($2,$9) RETURNING id),
       t AS (INSERT INTO tasks (name, goal, category, queued, plan_heartbeat_seconds, deadline_at, llm_profile_id,active_llm_profile_id, agent_key,description,exploration_id,timeout_seconds,queued_at,parent_ref,modeling_targets,network_mode,network_channel_id,network_version,web_targets)
       SELECT $1,$2,$3,$4,$5, NULL, $7,$7, $8,$9,e.id,$6,CASE WHEN $4 THEN now() ELSE NULL END,$13,$15::jsonb,$16,$17,$18,$19::jsonb FROM e RETURNING *),
       chain AS (INSERT INTO task_llm_profiles(task_id,profile_id,position) SELECT t.id,p.id,p.ordinality-1 FROM t CROSS JOIN unnest($10::bigint[]) WITH ORDINALITY p(id,ordinality) RETURNING task_id)
       ,rules AS (INSERT INTO task_intercept_rules(task_id,scope_kind,value,kind,pattern,note,enabled,action)
       SELECT t.id,r.kind,r.pattern,r.kind,r.pattern,r.note,r.enabled,r.action FROM t CROSS JOIN jsonb_to_recordset($11::jsonb) AS r(kind text,pattern text,note text,enabled boolean,action text) RETURNING id)
       ,refs AS (INSERT INTO task_relations(task_id,source_task_id) SELECT t.id,unnest($12::bigint[]) FROM t RETURNING task_id)
       ,root AS (INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,priority,state,origin)
         SELECT t.id,t.exploration_id,'fact','Task starting point: '||t.description||'; Goal: '||t.goal,jsonb_build_object('summary','Task starting point: '||t.description||'; Goal: '||t.goal,'description',t.description,'goal',t.goal),0,'origin','system' FROM t RETURNING id,exploration_id)
       ,seed AS (INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,priority,state,origin)
         SELECT t.id,t.exploration_id,'intent','Complete the task goal: '||t.goal||' (Task: '||t.description||')',jsonb_build_object('summary','Complete the task goal: '||t.goal||' (Task: '||t.description||')'),8,'open','seed' FROM t WHERE $14::boolean RETURNING id,exploration_id)
       ,seed_link AS (INSERT INTO exploration_edges(exploration_id,src_id,dst_id,rel) SELECT root.exploration_id,root.id,seed.id,'derived_from' FROM root JOIN seed USING(exploration_id) RETURNING src_id)
       SELECT * FROM t`,
      [
        initialTaskName(input), goal, input.category ?? "",
        input.queued ?? false, hb, Number(input.timeout_seconds) || 0,
        ids[0]??null, input.agent_key ?? "",
        input.description ?? '',ids,JSON.stringify(rules),sourceIDs,input.parent_ref??'',input.seed_first_intent===true,JSON.stringify(targets),network.mode,network.channelId,network.version,JSON.stringify(webTargets),
      ],
    );
    }catch(error){if((error as {code?:string}).code==='40001')return {ok:false,status:409,error:"The network configuration has been updated, please reselect the channel and create the task"};throw error;}
    const task = r.rows[0] as Record<string, unknown>;
    await taskProgress(db,Number(task.id),'accepted',"The task has been accepted and is waiting for execution conditions");
    Object.assign(task,await new TaskLLMChains(this.pool).state(Number(task.id),db));
    if(client)await client.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'task_created',$2)",[String(task.id),JSON.stringify({name:task.name})]);
    else await this.audit(Number(task.id), "task_created", { name: task.name });
    if (!input.queued&&!client) this.onLaunch(Number(task.id));
    return { ok: true, task };
  }

  async get(id: number): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query(`SELECT t.*,${progressSQL()} AS progress,${modelingPendingSQL()} AS modeling_pending,${modelingUnavailableSQL()} AS modeling_unavailable FROM tasks t WHERE id=$1`, [id]);
    if ((r.rowCount ?? 0) === 0) return null;
    const task = r.rows[0] as Record<string, unknown>;
    const intents = await this.pool.query(
      "SELECT id, title, state, priority, attempts, claimed_by, last_error FROM exploration_nodes WHERE task_id=$1 AND kind='intent' ORDER BY priority DESC, id",
      [id],
    );
    task.status=['done','failed','timeout'].includes(String(task.status))?task.status:task.paused?'paused':task.status;
    task.intents = intents.rows;
    Object.assign(task,await new TaskLLMChains(this.pool).state(id));
    return task;
  }

  async list(filter: { status?: string; archived?: boolean | null; id?: number } = {}): Promise<Record<string, unknown>[]> {
    // Collections represent user-facing security tests. Explicit ID reads are
    // also used by modeling execution/control pages and must retain their DTOs.
    const where: string[] = filter.id === undefined ? ["t.kind='pentest'"] : [];
    const args: unknown[] = [];
    if (filter.status) {
      args.push(filter.status);
      where.push(`t.status=$${args.length}`);
    }
    if (filter.id !== undefined) {
      args.push(filter.id);
      where.push(`t.id=$${args.length}`);
    }
    if (filter.archived !== null) {
      args.push(filter.archived ?? false);
      where.push(`t.archived=$${args.length}`);
    }
    // TaskDTO + TaskListMetricsAll（token/goal/intent/finding Lateral polymerization）。
    const r = await this.pool.query(
      `SELECT t.id, t.exploration_id, t.name, t.description, t.goal, t.status,t.kind,t.network_mode,t.network_channel_id,t.network_version,
              (SELECT name FROM network_channels nc WHERE nc.id=t.network_channel_id) AS network_channel_name,
              ${modelingPendingSQL()} AS modeling_pending,${modelingUnavailableSQL()} AS modeling_unavailable,${progressSQL()} AS progress,
              t.batch_id,t.batch_position,t.execution_mode,t.target_input,t.timeout_seconds,t.first_run_at,
              t.queued, t.paused, t.archived, t.category, t.category_id, t.deadline_at,
              t.created_at, t.updated_at, t.completed_at, t.coverage_enabled,
              t.parent_ref, t.pinned_at, t.llm_profile_id, t.active_llm_profile_id, t.company_id,
              cat.name AS category_name,
              COALESCE(tok.input_tokens,0)::int AS input_tokens,
              COALESCE(tok.output_tokens,0)::int AS output_tokens,
              COALESCE(tok.cache_read_tokens,0)::int AS cache_read_tokens,
              COALESCE(tok.cache_write_tokens,0)::int AS cache_write_tokens,
              COALESCE(act.last_activity,0)::bigint AS last_activity,
              COALESCE(g.total,0)::int AS goals_total,
              COALESCE(g.met,0)::int AS goals_met,
              COALESCE(inf.running,0)::int AS in_flight,
              COALESCE(fc.critical,0)::int AS f_critical,
              COALESCE(fc.high,0)::int AS f_high,
              COALESCE(fc.medium,0)::int AS f_medium,
              COALESCE(fc.low,0)::int AS f_low
       FROM tasks t
       LEFT JOIN task_categories cat ON cat.id = t.category_id
       LEFT JOIN LATERAL (
         SELECT sum(a.input_tokens) AS input_tokens, sum(a.output_tokens) AS output_tokens,
                sum(a.cache_read_tokens) AS cache_read_tokens, sum(a.cache_write_tokens) AS cache_write_tokens
         FROM activity a
         WHERE a.exploration_id=t.exploration_id AND a.kind='result'
       ) tok ON TRUE
       LEFT JOIN LATERAL (
         SELECT extract(epoch from max(a.created_at))::bigint AS last_activity
         FROM activity a WHERE a.exploration_id=t.exploration_id
       ) act ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(*) FILTER (WHERE state='met') AS met
         FROM exploration_nodes n
         WHERE n.exploration_id = t.exploration_id AND n.kind = 'goal'
       ) g ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS running
         FROM exploration_nodes n
         WHERE n.exploration_id = t.exploration_id AND n.kind = 'intent' AND n.state = 'running'
       ) inf ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE severity='critical') AS critical,
                count(*) FILTER (WHERE severity='high') AS high,
                count(*) FILTER (WHERE severity='medium') AS medium,
                count(*) FILTER (WHERE severity='low') AS low
         FROM findings f WHERE f.task_id = t.id
       ) fc ON TRUE
       WHERE t.deleted_at IS NULL AND ${where.join(" AND ")}
       ORDER BY t.id DESC LIMIT 200`,
      args,
    );
    const unix = (v: unknown) => (v ? Math.floor(new Date(v as string).getTime() / 1000) : 0);
    const chainRows=(await this.pool.query("SELECT task_id,profile_id,status,last_error,exhausted_at::text exhausted_at FROM task_llm_profiles WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,position",[r.rows.map(row=>row.id)])).rows;
    const byTask=new Map<string,any[]>();for(const e of chainRows){const list=byTask.get(String(e.task_id))??[];list.push(e);byTask.set(String(e.task_id),list);}
    const sourceRows=(await this.pool.query('SELECT task_id,source_task_id FROM task_relations WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,source_task_id',[r.rows.map(row=>row.id)])).rows;
    return r.rows.map((row: Record<string, unknown>) => {const chain=byTask.get(String(row.id))??[],latest=chain.filter(e=>e.exhausted_at).sort((a,b)=>String(b.exhausted_at).localeCompare(String(a.exhausted_at)))[0];return ({
      id: String(row.id),
      kind: row.kind,network_mode:row.network_mode,network_channel_id:row.network_channel_id,network_version:row.network_version,network_channel_name:row.network_channel_name,
      modeling_pending: Number(row.modeling_pending??0),
      modeling_unavailable:Number(row.modeling_unavailable??0),progress:row.progress,
      exploration_id: row.exploration_id ?? 0,
      name: row.name ?? "",
      category_id: row.category_id ?? null,
      category_name: row.category_name ?? "",
      pinned: !!row.pinned_at,
      pinned_at: row.pinned_at ?? "",
      description: row.description ?? "",
      goal: row.goal ?? "",
      status: ['done','failed','timeout'].includes(String(row.status))?row.status:row.paused?'paused':row.status??'created',
      created_at: row.created_at,
      created_unix: unix(row.created_at),
      completed_at: row.completed_at ?? "",
      completed_unix: unix(row.completed_at),
      last_activity_unix: Math.max(Number(row.last_activity ?? 0), unix(row.updated_at)),
      paused: !!row.paused,
      queued: !!row.queued,batch_id:row.batch_id,batch_position:row.batch_position,execution_mode:row.execution_mode,target_input:row.target_input,timeout_seconds:row.timeout_seconds,first_run_at:row.first_run_at,
      tokens: {
        input_tokens: Number(row.input_tokens ?? 0),
        output_tokens: Number(row.output_tokens ?? 0),
        cache_read_tokens: Number(row.cache_read_tokens ?? 0),
        cache_write_tokens: Number(row.cache_write_tokens ?? 0),
      },
      goals_total: Number(row.goals_total ?? 0),
      goals_met: Number(row.goals_met ?? 0),
      in_flight: Number(row.in_flight ?? 0),
      findings: {
        critical: Number(row.f_critical ?? 0),
        high: Number(row.f_high ?? 0),
        medium: Number(row.f_medium ?? 0),
        low: Number(row.f_low ?? 0),
      },
      llm_profile_id: row.llm_profile_id ?? null,
      llm_profile_ids: chain.map(e=>Number(e.profile_id)),
      active_llm_profile_id: row.active_llm_profile_id ?? null,
      llm_failover_state: chain.length?(chain.some(e=>Number(e.profile_id)===Number(row.active_llm_profile_id)&&e.status==='ready')?'ready':'chain_exhausted'):'default',
      ...(latest?.last_error?{llm_failover_reason:latest.last_error}:{}),
      parent_ref: row.parent_ref??'',
      source_task_ids: sourceRows.filter(s=>String(s.task_id)===String(row.id)).map(s=>Number(s.source_task_id)),
      company_ids: row.company_id ? [Number(row.company_id)] : [],
      coverage_enabled: row.coverage_enabled !== false,
      category: row.category ?? "",
      deadline_at: row.deadline_at ?? null,
      archived: !!row.archived,
      updated_at: row.updated_at,
    });});
  }

  /** Status Control：pause/resume/stop/run（Contains state machine verification） */
  async control(id: number, action: string): Promise<{ ok: boolean; status: number; error?: string }> {
    const cur = await this.pool.query<{ status: TaskStatus; paused: boolean; queue_mode:string }>("SELECT status, paused, queue_mode FROM tasks WHERE id=$1 AND deleted_at IS NULL", [id]);
    if ((cur.rowCount ?? 0) === 0) return { ok: false, status: 404, error: "Task does not exist" };
    const row = cur.rows[0]!;
    if(row.queue_mode==='pentest_chat'&&action==='run')return {ok:false,status:409,error:"This task is driven by a penetration testing conversation, please use continue or original session"};
    const now = () => this.pool.query("UPDATE tasks SET updated_at=now() WHERE id=$1", [id]);
    switch (action) {
      case "run": {
        try {
          assertTaskTransition(row.paused?"paused":row.status, "running");
        } catch (err) {
          return { ok: false, status: 400, error: String(err) };
        }
        await this.pool.query("UPDATE tasks SET status='running', paused=FALSE, updated_at=now() WHERE id=$1", [id]);
        await this.pool.query('DELETE FROM task_planner_recovery WHERE task_id=$1',[id]);
        this.onLaunch(id);
        break;
      }
      case "pause": {
        if(['done','failed','timeout'].includes(row.status))return {ok:false,status:400,error:"Final state task cannot execute pause"};
        if(row.paused)return {ok:false,status:400,error:"Task has been suspended"};
        const changed=await this.pool.query("UPDATE tasks SET paused=TRUE,status=CASE WHEN queue_mode='pentest_chat' THEN 'paused' ELSE status END,queued=FALSE,queued_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND status NOT IN ('done','failed','timeout') AND NOT paused RETURNING id",[id]);
        if(!changed.rowCount)return {ok:false,status:409,error:"The task status has changed and cannot be paused"};
        await this.onControl(id, "pause");
        break;
      }
      case "resume": {
        try {
          assertTaskTransition(row.paused?"paused":row.status, "running");
        } catch (err) {
          return { ok: false, status: 400, error: String(err) };
        }
        await this.pool.query("UPDATE tasks SET status='running', paused=FALSE, updated_at=now() WHERE id=$1", [id]);
        await this.pool.query('DELETE FROM task_planner_recovery WHERE task_id=$1',[id]);
        await this.onControl(id, "resume");
        break;
      }
      case "stop": {
        if (!["done","failed","timeout"].includes(row.status)) {
          await withTaskReport(this.pool,id,"User stopped task",async c=>{
            const changed = await c.query(
              "UPDATE tasks SET status='failed', stopped_reason='manual', paused=FALSE,queued=false,queued_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND status NOT IN ('done','failed','timeout') RETURNING id", [id],
            );
            if (changed.rowCount) await c.query(
              "UPDATE exploration_nodes SET state='stopped',claimed_by=NULL,claimed_at=NULL,completed_at=now(),updated_at=now() WHERE task_id=$1 AND kind='intent' AND state IN ('open','running','paused','blocked')", [id],
            );
          });
        }
        await this.onControl(id, "stop");
        break;
      }
      default:
        return { ok: false, status: 400, error: "Unknown control action" };
    }
    await now();
    await this.audit(id, `task_${action}`, {});
    return { ok: true, status: 200 };
  }

  async remove(id: number): Promise<{ ok: boolean; status: number; error?: string }> {
    const cur = await this.pool.query("SELECT status FROM tasks WHERE id=$1", [id]);
    if ((cur.rowCount ?? 0) === 0) return { ok: false, status: 404, error: "Task does not exist" };
    // HTTP host has installed the delete barrier and drained all active runs.
    // WORMHOLE supports deleting a running task after this drain, rather than returning 409.
    const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1)',[7337741004]);await c.query('DELETE FROM tasks WHERE id=$1',[id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    await this.audit(id, "task_deleted", {});
    return { ok: true, status: 200 };
  }

  async archive(id: number): Promise<{ ok: boolean; status: number; error?: string }> {
    const r = await this.pool.query(
      "UPDATE tasks SET archived=TRUE, archived_at=now(), updated_at=now() WHERE id=$1 AND archived=FALSE AND status IN ('done','failed','timeout')",
      [id],
    );
    if ((r.rowCount ?? 0) === 0) return { ok: false, status: 400, error: "Only final tasks can be archived" };
    await this.audit(id, "task_archived", {});
    return { ok: true, status: 200 };
  }

  async restore(id: number): Promise<boolean> {
    const r = await this.pool.query("UPDATE tasks SET archived=FALSE, archived_at=NULL, updated_at=now() WHERE id=$1", [id]);
    if ((r.rowCount ?? 0) > 0) await this.audit(id, "task_restored", {});
    return (r.rowCount ?? 0) > 0;
  }

  private async audit(taskId: number, event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "task", business_id: String(taskId), event_type: event, payload });
  }
}
