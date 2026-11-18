import {taskWorkDir,artifactSpec} from '../workspace/layout.ts';
import {composeAgentMessage,type ChatAttachment} from '../workspace/attachments.ts';
/**
 * F02 Task Master Agent Chat Chain：
 * - POST /api/chat?task=<id> → 202 Asynchronous execution (same as conversation But tied to the task）
 * - Pausing tasks does not intercept the main Agent Dialogue
 * - Message dropped activity（business_events，kind=chat + main_seg Segmentation）
 */
import type { Pool } from "pg";
import {CHAT_MODELING_GUIDANCE} from '../modeling/tools.ts';
import type { PihostConfig } from "../../config.ts";
import { createHostedSession } from "../../pi/session-host.ts";
import {ActivityService} from "../activity/service.ts";
import type { AgentsService } from "../agents/service.ts";

export class TaskChatService {
  /** G13：Segment busy bit——main_seg Isolate (default segment 1） */
  private readonly busy = new Set<string>();
  private readonly turns = new Map<string, {abort: AbortController; done: Promise<void>; session?: import("@earendil-works/pi-coding-agent").AgentSession}>();
  /** G13：Delete barrier and task running state（main.ts Injection engine） */
  private engine: { isDeleting(id: number): boolean;acquireTaskSession?:(id:number,signal:AbortSignal)=>Promise<()=>void> } | null = null;
  /** G13：Main Agent Platform Tool Assembler (Read Picture/Discovery/Tips/Pause - Control mainagent Tool） */
  private toolsProvider: ((taskId: number, signal: AbortSignal, businessId: string) => Promise<import("@earendil-works/pi-coding-agent").ToolDefinition[]>) | null = null;
  private conversationRuntime: Pick<import('../conversations/service.ts').ConversationsService,'send'|'stop'> | null = null;
  attachConversations(runtime:Pick<import('../conversations/service.ts').ConversationsService,'send'|'stop'>):void {this.conversationRuntime=runtime;}

  constructor(
    private readonly pool: Pool,
    private readonly config: PihostConfig,
    private readonly agents: AgentsService,
  ) {}

  /** main.ts Wiring: Engine Delete Barrier + mainagent Tool */
  wire(engine: { isDeleting(id: number): boolean;acquireTaskSession?:(id:number,signal:AbortSignal)=>Promise<()=>void> }, tools: (taskId: number, signal: AbortSignal, businessId: string) => Promise<import("@earendil-works/pi-coding-agent").ToolDefinition[]>): void {
    this.engine = engine;
    this.toolsProvider = tools;
  }

  /** POST /api/chat?task=N —— 202/404/409 Semantics*/
  async send(taskId: number, message: string, seg?: number,attachments:ChatAttachment[]=[]): Promise<{ status: number; error?: string }> {
    const task = (await this.pool.query("SELECT id, status, name,goal FROM tasks WHERE id=$1 AND deleted_at IS NULL", [taskId])).rows[0] as
      | { id: number; status: string; name: string; goal:string }
      | undefined;
    if (!task) return { status: 404, error: "no active task" };
    // G13：Deleting the barrier actually takes effect (engine beginDelete Reject new messages during the period）
    if (this.engine?.isDeleting(taskId)) return { status: 409, error: "Task is being deleted and new messages cannot be sent" };
    const owner=(await this.pool.query("SELECT c.id FROM conversations c JOIN tasks t ON t.id=c.task_id WHERE t.id=$1 AND t.queue_mode='pentest_chat'",[taskId])).rows[0];
    if(owner&&this.conversationRuntime){if(seg&&seg>0)return {status:409,error:"The independent penetration task uses the original session. Please create a new context in the original session."};return this.conversationRuntime.send(Number(owner.id),message,attachments);}
    const msg = message.trim();
    if (!msg&&attachments.length===0) return { status: 400, error: "Message cannot be empty" };
    // G13：main_seg True Segmentation—Busy Bit AND Pi Session businessId All isolated by segment
    const mainSeg=seg!==undefined&&seg>=0?seg:await new ActivityService(this.pool).currentMain(taskId);
    if(this.engine?.isDeleting(taskId))return {status:409,error:"Task is being deleted and new messages cannot be sent"};
    const segKey = `${taskId}:${mainSeg}`;
    if (this.isBusy(taskId)) return { status: 409, error: "The main agent of this task is processing the previous message" };

    this.busy.add(segKey);
    const abort = new AbortController();
    let finish!: () => void;
    const turn = {abort, done: new Promise<void>((resolve) => { finish = resolve; }), session: undefined as import("@earendil-works/pi-coding-agent").AgentSession | undefined};
    this.turns.set(segKey, turn);
    void (async () => {
      let releaseSlot:(()=>void)|undefined;
      try {
        // Human input is recorded once, without the agent-only absolute-path manifest.
        if(abort.signal.aborted)return;
        await this.pool.query(`INSERT INTO activity(exploration_id,worker,kind,summary,detail,main_seg)
          SELECT exploration_id,'mainagent','user',$2,$3,$4 FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
          [taskId,message,attachments.length?JSON.stringify({text:message,attachments}):'',mainSeg]);
        releaseSlot=await this.engine?.acquireTaskSession?.(taskId,abort.signal);if(abort.signal.aborted)return;
        const spec = await this.agents.resolveSessionSpec("mainagent",{Goal:task.goal??"",DataDir:this.config.dataDir});
        const h = await createHostedSession(this.pool, this.config, {
          kind: "mainagent",
          cwd:taskWorkDir(this.config,taskId),
          activity:{taskId,worker:"mainagent",mainSeg,userRecorded:true},
          reviewBackground:{source:'user_message',text:message},
          businessId: `task-${taskId}-main${mainSeg > 0 ? `-seg${mainSeg}` : ""}`,
          // G13：Repair original "${task.name}" Ordinary string not interpolated
          systemPrompt: (spec?.systemPrompt || "You are the task master Agent, responsible for communicating task progress with users.") + `
Current Task: #${taskId} ${task.name}
When the user requests to pause the task, call pause_current_task; when the user requests to stop or terminate the task, first call stop_current_task, and then read the existing records such as list_findings and give a summary. After the stop is successful, you can still read the evidence and reply to the user. Do not send tests, restart intentions, or treat unverified speculation as a vulnerability. The tool return value must be used to confirm whether the control was successful.`+CHAT_MODELING_GUIDANCE+artifactSpec(taskWorkDir(this.config,taskId)),
          provider: spec?.provider,
          modelId: spec?.modelId,
          // G13：Main Agent Platform Tools（get_task_graph/list_task_findings/add_task_hint/pause_task…）
          customTools: this.toolsProvider ? await this.toolsProvider(taskId, abort.signal, `task-${taskId}-main${mainSeg > 0 ? `-seg${mainSeg}` : ""}`) : undefined,
        });
        turn.session = h.session;
        try {
          if (abort.signal.aborted || this.engine?.isDeleting(taskId)) return;
          await h.session.prompt(composeAgentMessage(message,attachments,taskWorkDir(this.config,taskId)));
          await h.flushEvents();
          if(h.modelFailure&&!abort.signal.aborted)throw new Error(h.modelFailure);
        } finally {
          await h.dispose();
        }
      } catch (err) {
        console.error(`[task-chat ${taskId}] Main session execution failed:`, err);
        if(!abort.signal.aborted)await this.pool.query(`INSERT INTO activity(exploration_id,worker,kind,summary,detail,main_seg,is_error)
          SELECT exploration_id,'mainagent','result','Main Agent execution failed',$2,$3,TRUE FROM tasks WHERE id=$1 AND deleted_at IS NULL`,[taskId,String(err),mainSeg]).catch(console.error);
      } finally {
        releaseSlot?.();
        this.busy.delete(segKey);
        this.turns.delete(segKey);
        finish();
      }
    })();
    return { status: 202 };
  }

  isBusy(taskId: number): boolean {
    return [...this.busy].some((key) => key.startsWith(`${taskId}:`));
  }
  async stopTask(taskId: number): Promise<void> {
    const owner=(await this.pool.query("SELECT c.id FROM conversations c JOIN tasks t ON t.id=c.task_id WHERE t.id=$1 AND t.queue_mode='pentest_chat'",[taskId])).rows[0];
    if(owner&&this.conversationRuntime)await this.conversationRuntime.stop(Number(owner.id));
    const turns = [...this.turns.entries()].filter(([key]) => key.startsWith(`${taskId}:`)).map(([,turn]) => turn);
    for (const turn of turns) { turn.abort.abort(); await turn.session?.abort(); }
    await Promise.all(turns.map((turn) => turn.done));
  }
  async shutdown(): Promise<void> {
    const ids = new Set([...this.turns.keys()].map((key) => Number(key.split(":")[0])));
    await Promise.all([...ids].map((id) => this.stopTask(id)));
  }
}
