import {extensionAvailable} from '../extensions/availability.ts';
import path from 'node:path';
import {workspaceGate} from '../workspace/maintenance.ts';
import {withTaskReport,saveTaskReport} from '../tasks/report.ts';
import {FINGERPRINT_GUIDANCE} from '../fingerprints/service.ts';
import {conversationWorkDir} from '../workspace/layout.ts';
import {composeAgentMessage,type ChatAttachment} from '../workspace/attachments.ts';
/**
 * F02 Dialog, Message and Session Execution Services。
 * Send chain：agent Verification → Same session busy 409 → Drop user activity → 202 Asynchronous execution
 * （Pi chat Session, event progress business_events）→ Fall assistant/usage activity。
 */
import type { Pool } from "pg";
import {CHAT_MODELING_GUIDANCE} from '../modeling/tools.ts';
import type { PihostConfig } from "../../config.ts";
import { appendEvent } from "../../events/ledger.ts";
import { createHostedSession,getPiRuntime } from "../../pi/session-host.ts";
import {validProfile} from '../llm/profile-runtime.ts';
import type { AgentsService } from "../agents/service.ts";
import type { ToolContext } from "../tools/gate.ts";
import {activityDTO} from '../activity/service.ts';
import {firstLine} from '../activity/projector.ts';
import {EfficiencySupervisor,efficiencyDecision} from '../tasks/efficiency.ts';

export function conversationDTO(c:Record<string,any>):Record<string,unknown>{
  return {id:Number(c.id),agent_key:c.agent_key,title:c.title,
    ...(c.task_id!=null?{task_id:Number(c.task_id)}:{}),
    ...(c.llm_profile_id!=null?{llm_profile_id:Number(c.llm_profile_id)}:{}),pinned:!!c.pinned_at,
    ...(c.pinned_at?{pinned_at:c.pinned_at}:{}),created_at:c.created_at,updated_at:c.updated_at};
}

/** Dialog Tool Assembler（main.ts Injection platform.ts of chatToolsFor；auto/pentest There is a tool set） */
export type ChatToolProvider = (agentKey: string, ctx: ToolContext) => Promise<import("@earendil-works/pi-coding-agent").ToolDefinition[]>;
export interface OwnedConversationTurn {
  toolNames?:string[];
  systemPrompt?:string;
  workspaceTaskIds?:number[];
  userRecorded?:boolean;
  timeoutMs?:number;
  start():Promise<boolean>;
  finish(status:'completed'|'failed'|'stopped',reason:string):Promise<void>;
}

export class ConversationsService {
  private readonly busy = new Set<number>();
  private readonly turns = new Map<number, {abort: AbortController; done: Promise<void>}>();
  /** G13：Currently running per session HostedSession——stop True cancellation (not false success） */
  private readonly activeSessions = new Map<number, import("@earendil-works/pi-coding-agent").AgentSession>();

  constructor(
    private readonly pool: Pool,
    private readonly config: PihostConfig,
    private readonly agents: AgentsService,
    private readonly dlqPath: string,
    private readonly chatTools?: ChatToolProvider,
    private readonly acquireTask?:(taskId:number,signal:AbortSignal)=>Promise<()=>void>,
  ) {}

  async create(agentKey: string, title: string, llmProfileId: number | null): Promise<{ ok: true; conv: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    if (!agentKey.trim()) return { ok: false, status: 400, error: "agent_key cannot be empty" };
    const agent = await this.agents.get(agentKey.trim());
    if (!agent) return { ok: false, status: 404, error: "agent does not exist" };
    const c=await this.pool.connect();try{await c.query('BEGIN');
      let row=(await c.query('INSERT INTO conversations(agent_key,title) VALUES($1,$2) RETURNING *',[agentKey.trim(),title.trim()||"New conversation"])).rows[0];
      if(llmProfileId!=null){if(!(await c.query('SELECT id FROM llm_profiles WHERE id=$1 FOR KEY SHARE',[llmProfileId])).rowCount)throw new Error('LLM profile not found');
        row=(await c.query('UPDATE conversations SET llm_profile_id=$2 WHERE id=$1 RETURNING *',[row.id,llmProfileId])).rows[0];}
      await c.query('COMMIT');return {ok:true,conv:conversationDTO(row)};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async list(includePreview=false): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      includePreview?`SELECT c.*,COALESCE(p.preview,'') AS last_message FROM conversations c
        LEFT JOIN LATERAL (SELECT left(COALESCE(NULLIF(detail,''),summary),200) AS preview
          FROM conversation_activities a WHERE a.conversation_id=c.id AND a.kind IN('user','result')
          ORDER BY a.id DESC LIMIT 1) p ON TRUE
        ORDER BY (c.pinned_at IS NOT NULL) DESC,c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id DESC`:
        `SELECT * FROM conversations ORDER BY (pinned_at IS NOT NULL) DESC,pinned_at DESC NULLS LAST,updated_at DESC,id DESC`,
    );
    return r.rows.map(c=>({...conversationDTO(c),running:this.isRunning(Number(c.id)),...(includePreview?{last_message:c.last_message}: {})}));
  }

  async get(id:number):Promise<Record<string,any>|null>{return (await this.pool.query('SELECT * FROM conversations WHERE id=$1',[id])).rows[0]??null;}
  async patch(id:number,patch:{title?:string;pinned?:boolean}):Promise<Record<string,unknown>|null>{
    const row=(await this.pool.query(`UPDATE conversations SET updated_at=now(),title=CASE WHEN $2 THEN $3 ELSE title END,
      pinned_at=CASE WHEN $4::boolean IS NULL THEN pinned_at WHEN $4 THEN COALESCE(pinned_at,now()) ELSE NULL END
      WHERE id=$1 RETURNING *`,[id,patch.title!=null,patch.title??null,patch.pinned??null])).rows[0];
    return row?conversationDTO(row):null;
  }
  async profile(id:number,profileId:number|null):Promise<void>{
    const c=await this.pool.connect();try{await c.query('BEGIN');const exists=await c.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[id]);
      if(exists.rowCount&&profileId!=null){if(!(await c.query('SELECT id FROM llm_profiles WHERE id=$1 FOR KEY SHARE',[profileId])).rowCount)throw new Error('LLM profile not found');}
      if(exists.rowCount)await c.query('UPDATE conversations SET llm_profile_id=$2,updated_at=now() WHERE id=$1',[id,profileId]);await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async rename(id: number, title: string): Promise<boolean> {
    return !!await this.patch(id,{title});
  }

  async setPinned(id: number, pinned: boolean): Promise<boolean> {
    return !!await this.patch(id,{pinned});
  }

  async remove(id: number): Promise<boolean> {
    await this.stop(id);
    const r = await this.pool.query("DELETE FROM conversations WHERE id=$1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Is there a round running for this session?（busy Collection) - Frontend /messages Polled running bit。 */
  isRunning(id: number): boolean {
    return this.busy.has(id);
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.turns.keys()].map((id) => this.stop(id)));
  }

  /** Standalone pentest conversations own a task graph, but the task engine must
   * never claim their run. A process crash has no resumable Pi turn to attach. */
  async recoverPentestTurns(): Promise<number> {
    const rows=await this.pool.query("SELECT DISTINCT t.id FROM tasks t JOIN conversations c ON c.task_id=t.id WHERE c.agent_key='pentest' AND t.queue_mode='pentest_chat' AND t.status='running'");let count=0;
    for(const row of rows.rows){const changed=await withTaskReport(this.pool,Number(row.id),"The session was interrupted due to service restart, save existing results",c=>c.query("UPDATE tasks SET status='failed',stopped_reason='conversation_process_restart',completed_at=now(),updated_at=now(),queued=false,queued_at=NULL WHERE id=$1 AND status='running' RETURNING id",[row.id]));count+=changed.rowCount??0;}
    return count;
  }

  /** One conversation maps to one task. The row lock makes concurrent sends
   * idempotent, and all graph rows plus the association commit atomically. */
  private async ensurePentestTask(id:number,goal:string,profileId:number|null=null):Promise<number> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const conv=(await c.query('SELECT agent_key,task_id,title,llm_profile_id FROM conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!conv||conv.agent_key!=='pentest')throw new Error("pentest session does not exist");
      if(conv.task_id){
        const owned=await c.query("UPDATE tasks SET status='running',paused=FALSE,completed_at=NULL,stopped_reason='',updated_at=now() WHERE id=$1 AND queue_mode='pentest_chat' AND deleted_at IS NULL RETURNING id",[conv.task_id]);
        if(!owned.rowCount)throw new Error("The penetration task associated with the session has been deleted or the ownership is abnormal.");
        await c.query('COMMIT');return Number(conv.task_id);
      }
      const name=(conv.title==="New conversation"?goal:conv.title).trim().slice(0,200)||"Penetration Testing";
      const exploration=(await c.query('INSERT INTO explorations(goal,description) VALUES($1,$2) RETURNING id',[goal,name])).rows[0];
      const task=(await c.query(`INSERT INTO tasks(name,description,goal,status,queued,queue_mode,agent_key,
        exploration_id,llm_profile_id,active_llm_profile_id,first_run_at)
        VALUES($1,$2,$3,'running',FALSE,'pentest_chat','pentest',$4,$5,$5,now()) RETURNING id`,
        [name,name,goal,exploration.id,profileId??conv.llm_profile_id])).rows[0];
      await c.query(`INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,priority,state,origin)
        VALUES($1,$2,'fact',$3,$4::jsonb,0,'origin','system')`,
        [task.id,exploration.id,"Penetration testing goals:"+name,JSON.stringify({summary:goal,description:name})]);
      await c.query('UPDATE conversations SET task_id=$2 WHERE id=$1',[id,task.id]);
      await c.query('COMMIT');
      await appendEvent(this.pool,this.dlqPath,{business_kind:'task',business_id:String(task.id),event_type:'task_created',payload:{source:'pentest_conversation',conversation_id:id}}).catch(()=>{});
      return Number(task.id);
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  /** Repair pre-link pentest sessions without re-running their network probes.
   * It copies only rows owned by this conversation, and can be retried safely. */
  async backfillPentestHistory(id:number):Promise<{taskId:number;activities:number;assets:number}> {
    if(this.isRunning(id))throw new Error("The session is still running and cannot be re-recorded");
    const first=(await this.pool.query("SELECT detail FROM conversation_activities WHERE conversation_id=$1 AND kind='user' ORDER BY id LIMIT 1",[id])).rows[0];
    if(!first)throw new Error("Session has no initial user message");
    const taskId=await this.ensurePentestTask(id,String(first.detail));
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      const task=(await c.query('SELECT exploration_id,created_at FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
      const copied=await c.query(`INSERT INTO activity(exploration_id,worker,kind,tool,tool_use_id,is_error,summary,detail,metadata,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at)
        SELECT $2,'mainagent',a.kind,a.tool,a.tool_use_id,a.is_error,a.summary,a.detail,
          jsonb_build_object('source_conversation_id',$1::bigint,'source_activity_id',a.id,'source_agent',a.worker),
          a.input_tokens,a.output_tokens,a.cache_read_tokens,a.cache_write_tokens,a.created_at
        FROM conversation_activities a WHERE a.conversation_id=$1 AND a.created_at<$3 AND NOT EXISTS(
          SELECT 1 FROM activity prior WHERE prior.exploration_id=$2
            AND prior.metadata->>'source_activity_id'=a.id::text)
        ORDER BY a.id`,[id,task.exploration_id,task.created_at]);
      const attributed=await c.query(`WITH ids AS (
          SELECT DISTINCT (item->>'id')::bigint AS id FROM tool_calls t
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.result->'results','[]'::jsonb)) item
          WHERE t.business_kind='chat' AND t.business_id=$1 AND t.tool_key='insert_assets'
            AND item ? 'id' AND (item->>'id') ~ '^[0-9]+$'
        ) UPDATE assets a SET task_ids=array_append(a.task_ids,$2::bigint)
        FROM ids WHERE a.id=ids.id AND NOT ($2::bigint=ANY(a.task_ids))`,[`conv-${id}`,taskId]);
      const last=(await c.query("SELECT kind,is_error FROM conversation_activities WHERE conversation_id=$1 AND kind='result' ORDER BY id DESC LIMIT 1",[id])).rows[0];
      await saveTaskReport(c,taskId,'final',"Organizing historical penetration session results");
      await c.query("UPDATE tasks SET status=$2,completed_at=now(),updated_at=now(),stopped_reason=$3,queued=false,queued_at=NULL WHERE id=$1 AND queue_mode='pentest_chat'",
        [taskId,last&&!last.is_error?'done':'failed',last&&!last.is_error?'':'legacy_conversation_incomplete']);
      await c.query('COMMIT');
      return {taskId,activities:copied.rowCount??0,assets:attributed.rowCount??0};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  /** G13：Stop session - Cancel running Pi Session. Semantics：cancelled=Run wheel canceled；not_running=No running wheel。 */
  async stop(id: number): Promise<"cancelled" | "not-running" | "no-conversation"> {
    const exists = await this.pool.query("SELECT 1 FROM conversations WHERE id=$1", [id]);
    if ((exists.rowCount ?? 0) === 0) return "no-conversation";
    const turn = this.turns.get(id);
    if (!turn) return "not-running";
    turn.abort.abort("user_stop");
    await this.activeSessions.get(id)?.abort();
    await turn.done;
    return "cancelled";
  }

  async messages(id: number, since?: number, limit = 200, before=0): Promise<{ cursor: number; hasMore: boolean; items: Record<string, unknown>[] } | null> {
    const exists = await this.pool.query("SELECT 1 FROM conversations WHERE id=$1", [id]);
    if ((exists.rowCount ?? 0) === 0) return null;
    const incremental=since!==undefined;
    limit=incremental?Math.max(limit,1000):limit>0?limit:200;
    const rows=(await this.pool.query(`SELECT id,worker,kind,tool,tool_use_id,is_error,summary,created_at,input_tokens,
      output_tokens,cache_read_tokens,cache_write_tokens FROM conversation_activities WHERE conversation_id=$1
      AND ${incremental?'id>$2':'($2<=0 OR id<$2)'} ORDER BY id ${incremental?'ASC':'DESC'} LIMIT $3`,
      [id,incremental?since:before,incremental?limit:limit+1])).rows;
    const hasMore=!incremental&&rows.length>limit;
    const items=(incremental?rows:rows.slice(0,limit).reverse()).map(activityDTO);
    return {cursor:items.length?Number(items.at(-1)!.seq):incremental?since!:before,hasMore,items};
  }
  async detail(id:number,seq:number):Promise<string>{return (await this.pool.query('SELECT detail FROM conversation_activities WHERE conversation_id=$1 AND id=$2',[id,seq])).rows[0]?.detail??'';}

  /**
   * Send (Control pgSendConversationMessage）：Same session busy 409；202 Post asynchronous execution。
   * Back {status:202} indicates that it has been accepted; the assistant replies conversation_activities。
   */
  async send(id: number, message: string, attachments: ChatAttachment[] = [],owned?:OwnedConversationTurn): Promise<{ status: number; error?: string }> {
    const conv = (await this.pool.query("SELECT * FROM conversations WHERE id=$1", [id])).rows[0] as
      | { agent_key: string; title: string; llm_profile_id: number | null; task_id:number|null }
      | undefined;
    if (!conv) return { status: 404, error: "Session does not exist" };
    const msg = message.trim();
    if (!msg && attachments.length === 0) return { status: 400, error: "Message cannot be empty" };
    const bound=(await this.agents.get(conv.agent_key))?.llm_profile_id;
    const pinned=bound!=null?Number(bound):conv.llm_profile_id;
    let selected=pinned!=null?(await this.pool.query('SELECT * FROM llm_profiles WHERE id=$1',[pinned])).rows[0]:undefined;
    let exclusive=validProfile(selected);
    if(!exclusive)selected=(await this.pool.query('SELECT * FROM llm_profiles WHERE is_default=TRUE ORDER BY id LIMIT 1')).rows[0];
    if(!validProfile(selected)){
      const rt=await getPiRuntime(this.config),model=rt.getModel(this.config.pi.provider,this.config.pi.modelId);
      if(!model||!await rt.getAuth(model)){
        const count=Number((await this.pool.query('SELECT count(*) FROM llm_profiles')).rows[0].count);
        return {status:503,error:!count?"LLM has not been configured yet: Please go to System → LLM Configuration to add a configuration":!selected?
          "No LLM configuration activated: Please activate one in System → LLM Configuration, or specify a configuration for this session in this dialog":
          "LLM is not ready for conversation: please check System → LLM Configuration for an available and activated configuration"};
      }
      selected=undefined;exclusive=false;
    }
    if (this.busy.has(id)) return { status: 409, error: "This session is processing the previous message, please wait." };

    // Pentest is a solo agent: keep its Pi conversation, but give its writes a
    // durable task/exploration owner so report_finding and list_findings work.
    const workspaceReleases:(()=>void)[]=[];
    let pentestTaskId:number|undefined;
    try{
      workspaceReleases.push(workspaceGate.use(conversationWorkDir(this.config,id)));
      for(const taskId of [...new Set([...(owned?.workspaceTaskIds??[]),...(conv.task_id?[Number(conv.task_id)]:[])])])workspaceReleases.push(workspaceGate.use(path.join(this.config.dataDir,'workspace','tasks',String(taskId))));
      pentestTaskId=conv.agent_key==='pentest'?await this.ensurePentestTask(id,msg,selected?.id??null):undefined;
    }catch(error){for(const release of workspaceReleases.reverse())release();if((error as {status?:number}).status===409)return {status:409,error:(error as Error).message};throw error;}

    this.busy.add(id);
    const abort = new AbortController();
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    this.turns.set(id, {abort, done});
    try{
      if(!owned?.userRecorded)await this.appendActivity(id,'user',firstLine(msg,200),attachments.length?JSON.stringify({text:msg,attachments}):msg,false,0,0,conv.agent_key);
      if(pentestTaskId&&!owned?.userRecorded)await this.pool.query(`INSERT INTO activity(exploration_id,worker,kind,summary,detail,main_seg,metadata)
        SELECT exploration_id,'mainagent','user',$2,$3,0,$4::jsonb FROM tasks WHERE id=$1 AND deleted_at IS NULL`,[pentestTaskId,firstLine(msg,200),attachments.length?JSON.stringify({text:msg,attachments}):msg,JSON.stringify({source_agent:conv.agent_key,source_conversation_id:id})]);
      if(conv.title==="New conversation"||!conv.title)await this.rename(id,firstLine(msg,40)||"Attachment message");
      await this.pool.query('UPDATE conversations SET updated_at=now() WHERE id=$1',[id]);
    }catch(e){
      if(pentestTaskId)await withTaskReport(this.pool,pentestTaskId,"Session initialization failed, saving existing results",c=>c.query("UPDATE tasks SET status='failed',stopped_reason='conversation_setup_failed',completed_at=now() WHERE id=$1 AND queue_mode='pentest_chat'",[pentestTaskId])).catch(()=>{});
      this.busy.delete(id);this.turns.delete(id);for(const release of workspaceReleases.reverse())release();finished();throw e;
    }
    void (async () => {
      let result:'completed'|'failed'|'stopped'='failed',reason="Retest run not completed";
      const timer=owned?.timeoutMs?setTimeout(()=>abort.abort("owned_timeout"),owned.timeoutMs):undefined;
      const supervisor=pentestTaskId?new EfficiencySupervisor(this.pool,this.config.efficiency):undefined;
      let releaseSlot:(()=>void)|undefined;
      let budgetTimer:ReturnType<typeof setInterval>|undefined,budgetFlight:Promise<void>|undefined;
      const checkBudget=async()=>{
        if(!supervisor||!pentestTaskId||abort.signal.aborted)return;
        await supervisor.refresh();
        const task=(await this.pool.query('SELECT status,paused FROM tasks WHERE id=$1',[pentestTaskId])).rows[0];
        if(!task||task.status!=='running'||task.paused)return;
        const sample=await supervisor.sample(pentestTaskId),state=await supervisor.observe(pentestTaskId,sample);
        await supervisor.review(pentestTaskId,sample);
        const limit=efficiencyDecision(state,sample,supervisor.options,Date.now());
        if(limit&&await supervisor.pause(pentestTaskId,limit,sample)){
          abort.abort();
          await this.appendActivity(id,'text',"Execution met budget, paused and evidence retained. You can continue after adding conditions or adjusting the budget.",limit,false,0,0,conv.agent_key);
        }
      };
      try {
        if(pentestTaskId&&this.acquireTask)releaseSlot=await this.acquireTask(pentestTaskId,abort.signal);
        if(abort.signal.aborted)return;
        if(owned&&!await owned.start())return;
        if(supervisor&&pentestTaskId){
          await supervisor.resetIfSuspended(pentestTaskId);await checkBudget();if(abort.signal.aborted)return;
          budgetTimer=setInterval(()=>{if(!budgetFlight)budgetFlight=checkBudget().catch(error=>console.error('[pentest] budget check failed',error)).finally(()=>{budgetFlight=undefined;});},30000);
          budgetTimer.unref();
        }
        // User message Platform toolset for
        const spec = await this.agents.resolveSessionSpec(conv.agent_key,{DataDir:this.config.dataDir}).catch(() => null);
        const systemPrompt = spec?.systemPrompt?.trim() || "You are a helpful AI assistant.";
        // auto/pentest platform toolset（B06 Execution inside door：spawn_task Distribute tasks, etc.）
        let customTools = this.chatTools
          ? await this.chatTools(conv.agent_key, { businessKind: "chat", businessId: `conv-${id}`, agentKey: conv.agent_key, conversationId: id, taskId:pentestTaskId, signal: abort.signal, canExecute: async () => !abort.signal.aborted && !!(await this.pool.query("SELECT 1 FROM conversations WHERE id=$1",[id])).rowCount && (!pentestTaskId||!!(await this.pool.query("SELECT 1 FROM tasks WHERE id=$1 AND status='running' AND NOT paused AND deleted_at IS NULL",[pentestTaskId])).rowCount) })
          : undefined;
        if(owned?.toolNames)customTools=customTools?.filter(t=>owned.toolNames!.includes(t.name));
        const h = await createHostedSession(this.pool, this.config, {
          kind: "chat",
          activity:{conversationId:id,taskId:pentestTaskId,worker:conv.agent_key,userRecorded:true},
          cwd:conversationWorkDir(this.config,id),
          businessId: `conv-${id}`,
          systemPrompt:(owned?.systemPrompt??systemPrompt)+(pentestTaskId&&await extensionAvailable('fingerprints',pentestTaskId)?FINGERPRINT_GUIDANCE:'')+(customTools?.some(t=>t.name==='request_business_model'||t.name==='spawn_task')?CHAT_MODELING_GUIDANCE:''),
          provider: selected?`profile-${selected.id}`:undefined,
          profileBinding:exclusive,
          modelId: selected?.model,
          customTools,
          customToolsOnly:!!owned?.toolNames,
          reviewBackground:!owned?{source:'user_message',text:message}:undefined,
        });
        this.activeSessions.set(id, h.session);
        const abortSession=()=>void h.session.abort().catch(()=>{});abort.signal.addEventListener('abort',abortSession,{once:true});
        try {
          if (abort.signal.aborted) return;
          await h.session.prompt(composeAgentMessage(msg,attachments,conversationWorkDir(this.config,id)));
          if (abort.signal.aborted) return;
          await h.flushEvents();
          if(h.modelFailure)throw new Error(h.modelFailure);
          const lastMessage=(h.session.messages as {role:string;stopReason?:string;errorMessage?:string}[]).filter(m=>m.role==='assistant').at(-1);
          if(lastMessage?.stopReason==='error')throw new Error(lastMessage.errorMessage||'model error');
          // Durable Pi events project live thinking/tool/usage/result rows. No
          // post-hoc latest-agent_end lookup, duplicate text or last-call-only total.
          result='completed';reason='';
        } finally {
          abort.signal.removeEventListener('abort',abortSession);
          this.activeSessions.delete(id);
          await h.dispose();
        }
      } catch (err) {
        reason=(err as Error).message;
        if (!abort.signal.aborted) await this.appendActivity(id, "text", `(Error:${reason}）`, reason, true,0,0,conv.agent_key).catch(e=>console.error('[conversation] append error failed',id,e));
      } finally {
        if(timer)clearTimeout(timer);
        if(budgetTimer)clearInterval(budgetTimer);
        await budgetFlight;
        if(supervisor&&pentestTaskId&&!abort.signal.aborted)await supervisor.observe(pentestTaskId,await supervisor.sample(pentestTaskId)).catch(error=>console.error('[pentest] final budget sample failed',error));
        if(abort.signal.aborted){result='stopped';reason=owned?.toolNames&&typeof abort.signal.reason==='string'?abort.signal.reason:"Retest has been stopped or the service has been shut down";}
        if(pentestTaskId)await withTaskReport(this.pool,pentestTaskId,result==='completed'?"Penetration dialogue execution completed":"Penetration session execution stopped",c=>c.query(`UPDATE tasks SET status=$2,completed_at=now(),updated_at=now(),
          stopped_reason=$3,queued=false,queued_at=NULL WHERE id=$1 AND queue_mode='pentest_chat' AND status='running' AND NOT paused`,
          [pentestTaskId,result==='completed'?'done':'failed',reason])).catch(e=>console.error('[pentest] task finish failed',id,e));
        if(owned)await owned.finish(result,reason).catch(async e=>{console.error('[retest] finish failed',id,e);await this.appendActivity(id,'error',"Retest conclusion transaction failed, please check and reinitiate",String(e),true).catch(()=>{});});
        this.busy.delete(id);
        this.turns.delete(id);
        await this.pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [id]).catch(() => {});
        await appendEvent(this.pool, this.dlqPath, {
          business_kind: "conversation", business_id: String(id), event_type: "turn_finished", payload: {cancelled: abort.signal.aborted},
        }).catch(() => {});
        releaseSlot?.();
        for(const release of workspaceReleases.reverse())release();
        finished();
      }
    })();
    return { status: 202 };
  }

  private async appendActivity(id: number, kind: string, summary: string, detail: string, isError = false, inputTokens = 0, outputTokens = 0,worker=''): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation_activities (conversation_id, seq, kind, summary, detail, is_error, input_tokens, output_tokens,worker)
       VALUES ($1, COALESCE((SELECT max(seq)+1 FROM conversation_activities WHERE conversation_id=$1), 1), $2,$3,$4,$5,$6,$7,$8)`,
      [id, kind, summary, detail, isError, inputTokens||null, outputTokens||null,worker],
    );
  }
}
