import {registerTaskResource} from '../domains/workspace/resource-paths.ts';
import {extensionGuidance,extensionAvailable} from '../domains/extensions/availability.ts';
import {networkGuidance} from '../domains/network/context.ts';
import {workspaceGate,safeWorkspacePath} from '../domains/workspace/maintenance.ts';
import {clampRunSeconds,budgetSession,type BudgetExit,type RunBudget} from './budget.ts';
import {modelingRunBudget,MODELING_SETTLEMENT_PROMPT} from '../domains/modeling/execution.ts';
import {promptDefaults} from '../domains/agents/service.ts';
import {goTrim} from '../domains/assets/asset-match.ts';
import {findingWorkflow} from '../domains/findings/workflow-guidance.ts';
import { mkdir } from "node:fs/promises";
import { ensurePlaywrightCliConfig } from './playwright-cli.ts';
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { Pool } from "pg";
import type { PihostConfig } from "../config.ts";
import {EventBatchWriter} from '../events/batch-writer.ts';
import {readEfficiencyOptions} from '../domains/tasks/efficiency-settings.ts';
import {durableSessionEvent} from './event-payload.ts';
import {sessionAugmentation} from '../domains/mcp/session.ts';
import {toolPolicy} from '../domains/tools/assembly.ts';
import {interactiveShellTools} from '../domains/tools/interactive-shell.ts';
import {customSessionTools} from '../domains/tools/custom-session.ts';
import {generalTools} from '../domains/tools/general.ts';
import {sessionTrafficTools,TRAFFIC_TOOL_NAMES,trafficCaptureEnabled} from '../domains/traffic/tools.ts';
import {capturedEvents,projectActivity,type ActivityContext} from '../domains/activity/projector.ts';
import {TaskModelResolver,contextWindow,validProfile,type RuntimeProfile} from '../domains/llm/profile-runtime.ts';
import {taskStream,type RouterFailure} from '../domains/llm/task-stream.ts';
import {profileStream,compileRuntimeProfile,type ProfileAttemptRecorder} from '../domains/llm/pool-stream.ts';
import {normalizeRuntimeProfile} from '../domains/llm/configuration.ts';
import {appliedGlobalProfile} from '../domains/llm/global-state.ts';
import {capturedCall,normalizedStopReason} from '../domains/llm/profile-wire.ts';
import {ArtifactStore} from '../storage/artifacts.ts';
import {storagePolicy} from '../storage/policy.ts';
import {workerSessionTooLarge} from './session-size.ts';
import {prepareNativeCheckpoint} from '../storage/checkpoints.ts';

/**
 * B04 Pi Session Host —— pihost Create Pi The only entrance to the session。
 *
 * Boundaries of Responsibilities（RUNBOOK §2）：
 * - Pi Only supports single session model/Tool loop；Task status, approval, and event ledgers are all stored in the product host (this service）。
 * - Session directory button (kind, businessId) Isolation; model is isolated models.json Inject (do not read old WORMHOLE of ~/.pi）。
 * - Incremental and complete message translation into business_events Persistent ledger（SSE Only source for replays），
 *   Pi of JSONL The session file is just Agent Context, not business database。
 */

/** F11：profile Compile（models.json Rebuild after rewriting) runtime（Compared to old WORMHOLE resetModelRuntime） */
export function resetPiRuntime(): void {
  runtimePromise = null;
}

export interface HostedSession {
  readonly budgetExit?:BudgetExit;
  readonly llmFailure?: RouterFailure;
  /** F02 Bypass: The final model selected for this session (identity verification/For direct tone completion） */
  readonly model?: { provider: string; id: string; contextWindow: number };
  /** Terminal provider/harness failure, retained if Pi removes a failed message during compaction. */
  readonly modelFailure?:string;
  readonly modelStopReason?:string;
  sessionId: string;
  sessionDir: string;
  session: AgentSession;
  eventCount: number;
  /** Waiting for the completion of writing to the ledger of all triggered events; the return failed to persist (dropped Number of events for DLQ）number of events */
  flushEvents(): Promise<number>;
  dispose(): Promise<void>;
}

let runtimePromise: Promise<ModelRuntime> | null = null;
const PRODUCT_IDENTITY_PROMPT = `

## Product Identity
You are the AI assistant in the WORMHOLE intelligent security testing platform. Use the name "WORMHOLE" when introducing the platform to users; work within the tasks, tools, and scope of authority provided by the current session. When introducing the platform, only use WORMHOLE as the product name; when users ask about the underlying implementation, answer the technical facts truthfully; when users ask about the architecture, explain that WORMHOLE is responsible for task and business orchestration, and Pi SDK implements the single-session model and tool loop.`;

/** F07 Call level logging entry (cf. llmrec.Record Primary logic LLM Call）：
 * metering（llm_usage）Hengji；bodies（llm_records，Including raw Cable Bytes) by recordingEnabled Gating。
 * Attribution only comes from host injection activity/Session context, never from businessId Guess。 */
export interface LlmCallEntry {
  model: string;
  businessKind: string;
  profileId: number | null;
  profileName: string;
  sessionId: string;
  taskId: string;
  worker: string;
  explorationId: number | null;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  latencyMs: number;
  status: "ok" | "error";
  error: string;
  stopReason: string;
  text: string;
  thinking: string;
  rawRequest: string;
  rawResponse: string;
  requestBody?: string;
  performance?: import('../domains/observability/call-performance.ts').ModelCallPerformance;
}
export type CallRecorder = (e: LlmCallEntry, recordingEnabled: boolean) => Promise<void>;
/** F02 Side-channel question: Main session model calls snapshot release（main Wiring → SideRuntime.publish）。 */
export type SideCaptureSink = (snap: {
  parent: { conversationId?: number; taskId?: number; explorationId?: number; intentId?: number };
  run_id: number; version: number; captured_at: string;
  model: { profile_id: number; name: string; format: string; model: string; identity: string; streaming: boolean; window_tokens: number };
  request: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] };
}) => void;
let sideCaptureSink: SideCaptureSink | null = null;
export function setSideCaptureSink(fn: SideCaptureSink | null): void { sideCaptureSink = fn; }
let sideRunCounter = 0;
let callRecorder: CallRecorder | null = null;
export function setCallRecorder(fn: CallRecorder | null): void {
  callRecorder = fn;
}

export function getPiRuntime(config: PihostConfig): Promise<ModelRuntime> {
  runtimePromise ??= (async () => {
    // Pi Many internal problems getAgentDir() Read default ~/.pi/agent（Including createAgentSession of
    // Internal model runtime). put PI_CODING_AGENT_DIR refers to the isolation of this service models.json
    // directory, prevent reading old WORMHOLE Shared ~/.pi（glm has therefore been actually used key Certification）。
    if (!process.env.PI_CODING_AGENT_DIR) {
      process.env.PI_CODING_AGENT_DIR = path.dirname(config.pi.modelsPath);
    }
    const rt = (await ModelRuntime.create({
      modelsPath: config.pi.modelsPath,
    })) as ModelRuntime;
    // models.json inline apiKey Explicit registration into RuntimeCredentials：
    // getAuth(providerId) with within session getAuth(model) Two parsing paths behave inconsistently，
    // setRuntimeApiKey Make both paths accessible key（Also eliminates the ~/.pi/auth.json Dependencies）。
    try {
      const raw = JSON.parse(await readFile(config.pi.modelsPath, "utf8")) as {
        providers?: Record<string, { apiKey?: string }>;
      };
      for (const [pid, p] of Object.entries(raw.providers ?? {})) {
        if (p?.apiKey) await rt.setRuntimeApiKey(pid, p.apiKey);
      }
    } catch (err) {
      console.warn("[session-host] models.json inline apiKey registration failed (continue):", err);
    }
    return rt;
  })();
  return runtimePromise;
}

function normalizeEvent(ev: AgentSessionEvent): Record<string, unknown> {
  try {
    const plain = durableSessionEvent(ev as unknown as Record<string, unknown>);
    return plain;
  } catch {
    return { type: "unserializable_event", repr: String(ev) };
  }
}

export interface CreateHostedSessionArgs {
  kind: string;
  businessId: string;
  systemPrompt: string;
  cwd?: string;
  /** F11：profile Compilation results override default model selection */
  provider?: string;
  modelId?: string;
  /** Explicit conversation/role/judge binding stays exclusive unless pool fallback is enabled. */
  profileBinding?:boolean;
  /** F03 Full length cut：Pi Controlled tools callable within a session (execution must go through B06 Door） */
  customTools?: ToolDefinition[];
  /** Terminal summaries receive only explicitly supplied tools, without shell or MCP expansion. */
  customToolsOnly?: boolean;
  /** WORMHOLE planner/goals rounds start from a fresh context; chats/workers resume. */
  freshContext?: boolean;
  /** Host-only budget for a bounded terminal summary, after the task deadline. */
  runBudget?: RunBudget;
  /** Original task Activity projection, never inferred from businessId strings. */
  activity?: ActivityContext;
  reviewBackground?:{source:string;text:string;truncated?:boolean};
}

export async function createHostedSession(pool:Pool,config:PihostConfig,args:CreateHostedSessionArgs):Promise<HostedSession>{
  const releases:(()=>void)[]=[];
  try{
    if(args.cwd){releases.push(workspaceGate.use(args.cwd));const root=path.join(config.dataDir,'workspace');if(path.resolve(args.cwd).startsWith(path.resolve(root)+path.sep))await safeWorkspacePath(root,path.relative(root,args.cwd),true);}
    if(args.activity?.taskId)releases.push(workspaceGate.use(path.join(config.dataDir,'workspace','tasks',String(args.activity.taskId))));
    const hosted=await createHostedSessionInternal(pool,config,args),dispose=hosted.dispose;
    let ended=false;
    hosted.dispose=async()=>{if(ended)return;ended=true;try{await dispose();}finally{for(const release of releases.reverse())release();}};
    return hosted;
  }catch(e){for(const release of releases.reverse())release();throw e;}
}
async function createHostedSessionInternal(
  pool: Pool,
  config: PihostConfig,
  args: CreateHostedSessionArgs,
): Promise<HostedSession> {
  args={...args,systemPrompt:(args.systemPrompt??'')+await extensionGuidance(args.activity?.taskId)};

  const runtime = await getPiRuntime(config);
  const policy=toolPolicy(args.customTools??[]);
  const taskModel=args.activity?.taskId&&['planner','worker','mainagent'].includes(args.kind)
    ?new TaskModelResolver(pool,config,runtime,args.activity.taskId,policy?.ctx.agentKey??args.kind):undefined;
  const initialSelection=await taskModel?.current();
  const wantProvider = args.provider ?? config.pi.provider;
  const wantModel = args.modelId ?? config.pi.modelId;
  const profileId=/^profile-(\d+)$/.exec(wantProvider)?.[1];
  const globalProfile=!taskModel&&!args.provider?appliedGlobalProfile(pool)??(await pool.query('SELECT * FROM llm_profiles WHERE is_default=TRUE ORDER BY id LIMIT 1')).rows[0]:undefined;
  const rawProfile=!taskModel?(validProfile(globalProfile)?globalProfile:profileId?(await pool.query('SELECT * FROM llm_profiles WHERE id=$1',[profileId])).rows[0]:undefined):undefined;
  if(!taskModel&&profileId&&!validProfile(rawProfile))throw new Error(`LLM profile #${profileId} is missing or invalid`);
  const initialProfile:RuntimeProfile|undefined=rawProfile?normalizeRuntimeProfile(rawProfile):undefined;
  let model = initialSelection?.model??(validProfile(initialProfile)?await compileRuntimeProfile(runtime,initialProfile):runtime.getModel(wantProvider, wantModel));
  if (!model) {
    throw new Error(`Model not available: ${wantProvider}/${wantModel}(Check ${config.pi.modelsPath}）`);
  }

  const sessionDir = path.join(config.dataDir, "pi-sessions", `${args.kind}-${args.businessId}`);
  await mkdir(sessionDir, { recursive: true });
  if(args.activity?.taskId)await registerTaskResource(pool,args.activity.taskId,'sessions',sessionDir);
  if(policy){policy.ctx.cwd=args.cwd??sessionDir;policy.ctx.reviewBackground=args.reviewBackground;}
  // Session checkpoints and agent artifacts are independent directories.
  if(args.cwd)await mkdir(args.cwd,{recursive:true,mode:0o755});
  await ensurePlaywrightCliConfig(args.cwd ?? sessionDir);

  const storage=storagePolicy(config.storage);
  const workerResume=args.kind==='worker'&&!!args.activity?.nodeId;
  const coldLarge=workerResume&&await prepareNativeCheckpoint(sessionDir,storage.workerSessionBytes);
  const rotate=workerResume&&(coldLarge||await workerSessionTooLarge(sessionDir,storage.workerSessionBytes));
  const sessionManager = args.freshContext||rotate ? SessionManager.create(args.cwd ?? sessionDir,sessionDir) : SessionManager.continueRecent(args.cwd ?? sessionDir, sessionDir);
  const workflow=findingWorkflow(args.customTools??[],(await pool.query("SELECT value FROM app_settings WHERE key='settings.agent_traffic_binding'")).rows[0]?.value==='true');
  const findingGuide=workflow.guidance;
  const loader = new DefaultResourceLoader({
    cwd: args.cwd ?? sessionDir,
    agentDir: config.pi.agentDir,
    systemPrompt: args.systemPrompt+PRODUCT_IDENTITY_PROMPT+findingGuide+await networkGuidance(args.activity?.taskId),
    // Skills are explicitly filtered by agent_visibility and invoked via Skill.
    // Pi directory-wide auto discovery would leak other roles' skill prompts.
    noSkills:true,
  });
  await loader.reload();

  if(taskModel&&initialSelection?.source==='task_chain'){
    const windows=(await pool.query(`SELECT p.context_window_k FROM task_llm_profiles t JOIN llm_profiles p ON p.id=t.profile_id WHERE t.task_id=$1`,[taskModel.taskId])).rows.map(r=>contextWindow(Number(r.context_window_k)));
    if(windows.length)model={...model,contextWindow:Math.min(...windows)};
  }
  const requestedTools=args.customTools??[];
  const customTools=trafficCaptureEnabled()?workflow.tools:workflow.tools.filter(t=>!TRAFFIC_TOOL_NAMES.includes(t.name));
  const trafficTools=args.customToolsOnly?[]:await sessionTrafficTools(pool,requestedTools);
  const general=!args.customToolsOnly&&policy&&policy.ctx.agentKey!=='goals'
    ?await generalTools(pool,args.cwd??sessionDir,policy.ctx,policy.gate):undefined;

  const interactive=!args.customToolsOnly&&policy?await interactiveShellTools(pool,args.cwd??sessionDir,policy.ctx,policy.gate):undefined;
  if(interactive){const bash=general?.tools.find(tool=>tool.name==='Bash');if(bash)bash.description+="\n\nFor programs that require [interactive input] (msfconsole/ssh interactive login/mysql, psql, python, etc. REPL/password or yes/no prompt/nc rebound shell), do not use Bash (it does not have stdin and will get stuck), instead use shell_open to open an interactive session (shell_close is used up). Still use Bash for one-time, non-interactive commands.";}
  const custom=!args.customToolsOnly&&policy?await customSessionTools(pool,policy.ctx,policy.gate):undefined;
  if(custom?.shellHints.length){const bash=general?.tools.find(tool=>tool.name==='Bash');if(bash)bash.description+="\n\nThe following tools are installed in this bash environment and can be called directly from Bash:\n"+custom.shellHints.join('\n');}
  const joinedTools=[...customTools.filter(tool=>!custom?.deferred.has(tool.name)),...trafficTools,...(general?.tools??[]),...(custom?.tools??[]),...(interactive?.tools??[])];
  const uniqueTools=[...new Map(joinedTools.map(tool=>[tool.name,tool])).values()];

  // Durability precedes effects; only trace readers need a synchronous read model.
  const traceReaders=new Set(['get_worker_output','get_worker_trace','search_all_worker_traces','list_worker_traces','get_task_worker_trace','list_task_worker_traces','search_task_worker_traces']);
  const captureTools=(tools:ToolDefinition[])=>args.activity?tools.map(tool=>({...tool,execute:async(...params:Parameters<ToolDefinition['execute']>)=>{
    const started=Date.now();await eventWriter.flush();
    if(traceReaders.has(tool.name))await projectActivity(pool,{runId:sessionId,maxEvents:200});
    const waitMs=Date.now()-started;
    if(waitMs>1000)console.warn('[tool-preflight-slow]',JSON.stringify({taskId:args.activity?.taskId,tool:tool.name,waitMs}));
    const result=await tool.execute(...params);
    if(args.kind==='worker'&&args.activity?.taskId&&args.activity.nodeId&&uniqueTools.some(tool=>tool.name==='read_worker_artifact')&&!['read_worker_artifact','read_worker_handoff'].includes(tool.name)){
      try{return await new ArtifactStore(pool,config.dataDir).externalize(args.activity.taskId,args.activity.nodeId,result,storage.toolInlineBytes);}
      catch{console.warn('[storage] artifact persistence failed; original tool output retained');}
    }
    return result;
  }})):tools;

  const created = await createAgentSession({
    cwd: args.cwd ?? sessionDir,
    noTools: "builtin",
    customTools: captureTools(uniqueTools),
    model,
    // Explicitly inject isolation into this service runtime；Otherwise sdk Will press default ~/.pi/agent Build one yourself
    // （old WORMHOLE Shared directory——glm Gone old key、mock Doesn’t exist at all, it all comes from this）。
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      retry: {
        enabled: !taskModel&&!initialProfile,
        maxRetries: 6,
        baseDelayMs: 500,
        provider: { timeoutMs: 120_000, maxRetries: 3, maxRetryDelayMs: 5_000 },
      },
    }),
  });
  interactive?.attach(created.session);
  // F07 Belong (formerly WithTaskID/WithWorker Semantics): Task Registry id Only from activity，One-time analysis。
  let explorationId: number | null = null;
  if (args.activity?.taskId) {
    explorationId = Number((await pool.query("SELECT exploration_id FROM tasks WHERE id=$1", [args.activity.taskId])).rows[0]?.exploration_id) || null;
  }
  const attribution = {
    taskId: args.activity?.taskId ? String(args.activity.taskId) : "",
    worker: args.activity?.worker ?? (args.kind === "chat" ? "" : args.kind),
    explorationId,
  };
  // Read at call completion so a recording toggle takes effect on the next call.
  const recordBodies = async (): Promise<boolean> => {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='settings.llm_record'");
    return String(r.rows[0]?.value) === "true";
  };
  // F02：Bypass parent key (dialogue/Main Agent/Intent worker）——Deduced from host context, not from businessId Guess
  const convMatch = args.kind === "chat" ? /^conv-(\d+)$/.exec(args.businessId) : null;
  const sideParent = convMatch ? { conversationId: Number(convMatch[1]) }
    : args.kind === "mainagent" && args.activity?.taskId && attribution.explorationId ? { taskId: Number(args.activity.taskId), explorationId: attribution.explorationId }
    : args.kind === "worker" && args.activity?.taskId && args.activity.nodeId && attribution.explorationId
      ? { taskId: Number(args.activity.taskId), explorationId: attribution.explorationId, intentId: Number(args.activity.nodeId) }
    : undefined;
  const augmentation=sessionAugmentation(args.customTools??[]);
  // The active branch includes Skill invocations preceding a compaction entry.
  // Reading every branch would leak grants from a branch the user abandoned.
  await augmentation?.restore(created.session.sessionManager.getBranch().flatMap(sessionEntryToContextMessages));
  await augmentation?.attach(created.session);

  let completeBudgetRun:()=>void=()=>{};
  const controlled=policy?budgetSession(created.session,async()=>{
    if(args.runBudget)return args.runBudget;
    const key=policy.ctx.agentKey,row=(await pool.query('SELECT max_turns,run_seconds,wrapup_prompt,wrapup_max_turns,task_timeout_wrapup_prompt,task_timeout_wrapup_max_turns FROM agents WHERE key=$1',[key])).rows[0];
    const efficiency=await readEfficiencyOptions(pool,config.efficiency),plannerLimit=efficiency.plannerRunSeconds;
    const defaults=promptDefaults.wrapup[key]??promptDefaults.wrapup.custom!;
    const ownSeconds=['goals','mainagent'].includes(key)?0:key==='planner'
      ?plannerLimit?Math.min(Math.max(1,Number(row?.run_seconds)||plannerLimit),plannerLimit):Math.max(0,Number(row?.run_seconds)||0)
      :Math.max(0,Number(row?.run_seconds)||0);
    const clock=policy.ctx.taskId&&['worker','planner','modeler'].includes(key)?(await pool.query('SELECT deadline_at FROM tasks WHERE id=$1',[policy.ctx.taskId])).rows[0]?.deadline_at:undefined;
    if(key==='modeler'){
      const modeled=modelingRunBudget(clock?new Date(clock).getTime():0,ownSeconds);
      return {maxTurns:Math.max(0,Number(row?.max_turns)||0),runSeconds:modeled.seconds,
        settlement:{prompt:MODELING_SETTLEMENT_PROMPT,maxTurns:Number(row?.wrapup_max_turns)>0?Number(row.wrapup_max_turns):3,runSeconds:modeled.settlementSeconds,
          disabledTools:uniqueTools.filter(t=>!['api_model_submit','api_model_done','api_model_read','Read','Write','LS'].includes(t.name)).map(t=>t.name)}};
    }
    const duration=clampRunSeconds(clock?new Date(clock).getTime():0,ownSeconds);
    const taskPrompt=goTrim(String(row?.task_timeout_wrapup_prompt??''))?String(row.task_timeout_wrapup_prompt):defaults.task_timeout;
    const turns=Number(row?.wrapup_max_turns)>0?Number(row.wrapup_max_turns):defaults.turns;
    const agentTurns=Math.max(0,Number(row?.max_turns)||0),plannerTurns=key==='planner'?efficiency.plannerMaxTurns:0;
    return {maxTurns:key==='goals'?8:plannerTurns?agentTurns?Math.min(agentTurns,plannerTurns):plannerTurns:agentTurns,runSeconds:duration.seconds,
      ...(key==='goals'?{}:{settlement:{prompt:goTrim(String(row?.wrapup_prompt??''))?String(row.wrapup_prompt):defaults.prompt,
        maxTurns:duration.clamped&&taskPrompt&&Number(row?.task_timeout_wrapup_max_turns)>0?Number(row.task_timeout_wrapup_max_turns):turns,
        ...(duration.clamped&&taskPrompt?{timeoutPrompt:taskPrompt}:{}),disabledTools:key==='worker'?['Bash']:[]}})};
  },()=>!!policy.ctx.signal?.aborted,()=>completeBudgetRun()):undefined;

  const sessionId = randomUUID();
  let eventCount = 0;
  const dlqPath = path.join(config.dataDir, "events-dlq.jsonl");
  const eventWriter=new EventBatchWriter(pool,dlqPath);
  const projectForDisplay=async()=>{
    if(!args.activity)return;
    try{await projectActivity(pool,{runId:sessionId,maxEvents:1000});}
    catch(error){console.warn('[activity] display deferred',JSON.stringify({sessionId,taskId:args.activity.taskId,error:String(error)}));}
  };
  let ordinal=0;
  let llmFailure:RouterFailure|undefined;
  let modelFailure:string|undefined;
  let modelStopReason:string|undefined;
  const recordCall=async(e:Omit<LlmCallEntry,'sessionId'|'taskId'|'worker'|'explorationId'|'text'|'thinking'|'businessKind'>&{sessionId?:string;taskId?:string;worker?:string;explorationId?:number|null},m:{content?:unknown[]})=>{
    if(!callRecorder)return Promise.resolve();
    let text='',thinking='';
    for(const b of (m.content??[]) as {type:string;text?:string;thinking?:string}[]){
      if(b?.type==='text'&&b.text)text+=b.text;
      if(b?.type==='thinking'&&b.thinking)thinking+=b.thinking;
    }
    const entry:LlmCallEntry={...e,stopReason:normalizedStopReason(e.stopReason,(m as {rawStopReason?:string}).rawStopReason),businessKind:args.kind,sessionId:e.sessionId??args.businessId,taskId:e.taskId??attribution.taskId,worker:e.worker??attribution.worker,explorationId:e.explorationId??attribution.explorationId,text,thinking};
    try{await callRecorder(entry,await recordBodies());}catch(err){console.warn('[llm] call persistence failed',err);}
  };
  // F07：Failed line error prefix HTTP Status code (compare llmrec.Attempts of "HTTP 401 + body" Diagnostic capabilities）
  const httpPrefixedError = (msg: string, capture?: { lastStatus(): number }): string => {
    const code = capture?.lastStatus() ?? 0;
    if (code >= 400 && msg && !/^HTTP \d/.test(msg)) return `HTTP ${code}: ${msg}`;
    return msg;
  };
  const recordProfileAttempt:ProfileAttemptRecorder=async(p,m,_context,latencyMs,capture)=>{
    await recordCall({model:m.model||p.model,profileId:Number(p.id),profileName:String(p.name??''),input:Number(m.usage.input)||0,output:Number(m.usage.output)||0,cacheRead:Number(m.usage.cacheRead)||0,cacheWrite:Number(m.usage.cacheWrite)||0,latencyMs,status:['error','aborted','length'].includes(m.stopReason)?'error':'ok',error:httpPrefixedError(m.errorMessage||(m.stopReason==='length'?"Model output truncated (length)":''),capture),stopReason:m.stopReason??'',performance:capture?.performance.snapshot(),requestBody:capture?.requestBody(),rawRequest:capture?.rawRequest()??'',rawResponse:capture?.rawResponse()??''},m);
  };
  const nativeStream=created.session.agent.streamFunction;
  if(taskModel){created.session.agent.streamFunction=taskStream(nativeStream,taskModel,f=>{llmFailure=f;},async(s,m,context,latencyMs,capture)=>{
    if(s.profile&&s.source!=='task_chain')return; // Inner pool records each real member.
    if(s.profile){await recordProfileAttempt(s.profile,m,context,latencyMs,capture);return;}
    await recordCall({model:m.model,profileId:null,profileName:'',input:Number(m.usage.input)||0,output:Number(m.usage.output)||0,cacheRead:Number(m.usage.cacheRead)||0,cacheWrite:Number(m.usage.cacheWrite)||0,latencyMs,status:['error','aborted','length'].includes(m.stopReason)?'error':'ok',error:m.errorMessage||(m.stopReason==='length'?"Model output truncated (length)":''),stopReason:m.stopReason??'',performance:capture?.performance.snapshot(),requestBody:capture?.requestBody(),rawRequest:capture?.rawRequest()??'',rawResponse:capture?.rawResponse()??''},m);
  },(s,m,context,options)=>s.source==='task_chain'||!s.profile?nativeStream(m,context,options):profileStream(nativeStream,pool,runtime,async()=>({profile:s.profile,binding:s.source==='agent_binding',allowPool:true}),recordProfileAttempt)(m,context,options));}
  else if(initialProfile){created.session.agent.streamFunction=profileStream(nativeStream,pool,runtime,async()=>{
    const binding=args.profileBinding??!initialProfile.is_default;
    const p=(!binding?appliedGlobalProfile(pool):undefined)??(await pool.query(binding?'SELECT * FROM llm_profiles WHERE id=$1':'SELECT * FROM llm_profiles WHERE is_default=TRUE ORDER BY id LIMIT 1',binding?[initialProfile.id]:[])).rows[0];
    if(!p||!validProfile(p))throw new Error(`LLM profile #${initialProfile.id} is missing or invalid`);
    return {profile:{...p,id:Number(p.id)},binding,allowPool:true};
  },recordProfileAttempt);}
  else created.session.agent.streamFunction=(model,context,options)=>capturedCall(nativeStream,model,context,options,{},async(message,latencyMs,capture)=>{
    await recordCall({model:message.model,profileId:null,profileName:'',input:Number(message.usage.input)||0,output:Number(message.usage.output)||0,cacheRead:Number(message.usage.cacheRead)||0,cacheWrite:Number(message.usage.cacheWrite)||0,latencyMs,status:['error','aborted','length'].includes(message.stopReason)?'error':'ok',error:httpPrefixedError(message.errorMessage||(message.stopReason==='length'?"Model output truncated (length)":''),capture),stopReason:message.stopReason,performance:capture.performance.snapshot(),requestBody:capture.requestBody(),rawRequest:capture.rawRequest(),rawResponse:capture.rawResponse()},message);
  });
  // F02：Outermost wrapper - Release snapshot for each actual model call (selected final model with context）
  if (sideParent && sideCaptureSink) {
    const nativeForSide = created.session.agent.streamFunction;
    const runId = Date.now() * 1000 + (sideRunCounter++ % 1000);
    let sideVersion = 0;
    created.session.agent.streamFunction = ((model: unknown, context: unknown, options?: unknown) => {
      sideVersion += 1;
      try {
        const m = model as { provider?: string; id?: string; contextWindow?: number };
        const c = context as { systemPrompt?: string; messages?: unknown[]; tools?: unknown[] };
        sideCaptureSink?.({
          parent: sideParent, run_id: runId, version: sideVersion, captured_at: new Date().toISOString(),
          model: {
            profile_id: Number(/^profile-(\d+)$/.exec(m.provider ?? "")?.[1] ?? 0),
            name: m.provider ?? "", format: "", model: m.id ?? "",
            identity: createHash("sha256").update(JSON.stringify([m.provider, m.id, m.contextWindow, true])).digest("hex"),
            streaming: true, window_tokens: Number(m.contextWindow) || 0,
          },
          request: { systemPrompt: c.systemPrompt, messages: JSON.parse(JSON.stringify(c.messages ?? [])), tools: JSON.parse(JSON.stringify(c.tools ?? [])) },
        });
      } catch { /* Snapshot publishing failure does not block the main session */ }
      return (nativeForSide as (a: unknown, b: unknown, o?: unknown) => unknown)(model, context, options);
    }) as typeof created.session.agent.streamFunction;
  }
  const ownerSignal = policy?.ctx.signal;
  if (ownerSignal) {
    const stream = created.session.agent.streamFunction;
    created.session.agent.streamFunction = (model, context, options) => {
      ownerSignal.throwIfAborted();
      const signal = options?.signal ? AbortSignal.any([ownerSignal, options.signal]) : ownerSignal;
      return stream(model, context, { ...options, signal });
    };
  }
  let budgetEnd:ReturnType<typeof normalizeEvent>|undefined;
  const persistEvent=(eventType:string,payload:ReturnType<typeof normalizeEvent>)=>{
    eventWriter.append({business_kind:args.kind,business_id:args.businessId,event_type:eventType,payload});
  };
  completeBudgetRun=()=>{
    if(!budgetEnd)return;
    const payload={...budgetEnd};budgetEnd=undefined;
    if(args.activity)payload._activity={...args.activity,runId:sessionId,ordinal:ordinal++};
    persistEvent('agent_run_end',payload);
  };
  const unsubscribe = created.session.subscribe((ev) => {
    if(ev.type==='agent_start'){modelFailure=undefined;modelStopReason=undefined;if(policy)policy.ctx.reviewRunId=randomUUID();}
    if(ev.type==='message_end'&&ev.message.role==='assistant'){modelStopReason=ev.message.stopReason;modelFailure=['error','length','aborted'].includes(ev.message.stopReason)?ev.message.errorMessage||`model ${ev.message.stopReason}`:undefined;}
    if(ev.type==='compaction_end'&&ev.errorMessage&&modelFailure)modelFailure=ev.errorMessage;
    eventCount += 1;
    const payload=normalizeEvent(ev);
    // Both native phases remain in the ledger. Only the product projection
    // coalesces completion and keeps usage accumulated across the settlement.
    const budgetActive=controlled?.active;
    if(budgetActive&&ev.type==='agent_end')budgetEnd=payload;
    const project=!(budgetActive&&(ev.type==='agent_end'||(ev.type==='agent_start'&&controlled?.phase==='settlement')));
    if(project&&args.activity&&capturedEvents.has(ev.type))payload._activity={...args.activity,runId:sessionId,ordinal:ordinal++};
    persistEvent(ev.type,payload);
  });
  if(policy)policy.ctx.reviewEntries=(currentToolId)=>{
    const entries:{kind:string;tool?:string;tool_use_id?:string;text:string;is_error?:boolean}[]=[];
    outer:for(const message of created.session.messages as any[]){
      if(message.role==='toolResult'){entries.push({kind:'tool_result',tool:message.toolName,tool_use_id:message.toolCallId,text:(message.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''),...(message.isError?{is_error:true}:{})});continue;}
      const content=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content??[];
      for(const block of content){
        if(block.type==='toolCall'){if(block.id===currentToolId)break outer;entries.push({kind:'tool_use',tool:block.name,tool_use_id:block.id,text:JSON.stringify(block.arguments)});}
        else if(block.type==='text')entries.push({kind:message.role==='user'?'user':'text',text:block.text});
      }
    }
    return entries;
  };

  await pool.query(
    `INSERT INTO pi_session_map (pi_session_id, business_kind, business_id, work_dir)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_kind, business_id)
     DO UPDATE SET pi_session_id = EXCLUDED.pi_session_id, work_dir = EXCLUDED.work_dir`,
    [sessionId, args.kind, args.businessId, sessionDir],
  );

  return {
    get budgetExit(){return controlled?.exit;},
    get llmFailure(){return llmFailure;},
    model,
    get modelFailure(){return modelFailure;},
    get modelStopReason(){return modelStopReason;},
    sessionId,
    sessionDir,
    session: controlled?.session??created.session,
    eventCount,
    flushEvents: async () => {
      const deadCount=await eventWriter.flush();
      await projectForDisplay();
      return deadCount;
    },
    dispose: async () => {
      controlled?.dispose();
      await interactive?.dispose();
      try {
        await created.session.abort?.();
      } catch {
        /* Session ended abort Harmless */
      }
      try{await eventWriter.flush();}
      finally{
        unsubscribe();created.session.dispose();
        await general?.dispose();await augmentation?.dispose();
      }
      await projectForDisplay();
    },
  };
}
