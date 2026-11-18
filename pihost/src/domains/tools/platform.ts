import {registerCurrentTaskControls} from '../tasks/current-task-controls.ts';
import {registerTaskOrchestration} from './task-orchestration.ts';
import {registerPlatformManagement,PLATFORM_MANAGEMENT} from './platform-management.ts';
import path from 'node:path';
import {registerFindingReadTools} from '../findings/tools.ts';
import {MODELING_REQUEST_TOOLS} from '../modeling/tools.ts';
import {augmentSession,bindAugmentation} from '../mcp/session.ts';
/**
 * F02 Conversation Platform Toolset。
 * + platformTools（Reconstruction skill / MCP，Give Auto Use）+ pentest Standalone Penetration Tool
 * （toolcatalog seedPentestDefaultBindings：list/insert_assets + report_finding + list_findings）。
 *
 * Execute unified walking B06 Door（runTool：Visibility→Verification→Interception→Approval→Execute→Audit），
 * http_request with engine worker Sharing tool gate and traffic proxy path。
 */
import type { Pool } from "pg";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerTool, runTool, type InterceptRule, type ToolContext } from "./gate.ts";
import { registerBusinessTools, type BusinessToolDeps } from "./business.ts";
import {assembleTools} from './assembly.ts';
import {GRAPH_TOOLS} from '../exploration/tools.ts';
import {ExplorationService} from '../exploration/service.ts';
import type {McpService} from '../mcp/service.ts';
import type {SkillsService} from '../skills/service.ts';
import {registerAssetTools,ASSET_TOOLS} from '../assets/tools.ts';
import {POC_TOOLS} from '../pocs/tools.ts';
import {FINGERPRINT_TOOLS} from '../fingerprints/tools.ts';
import {WORK_CONTROLS} from '../tasks/work-tools.ts';
import {registerTraceTools,TRACE_TOOLS} from '../activity/tools.ts';

export interface PlatformDeps {
  trafficFlow?:BusinessToolDeps['trafficFlow'];
  reverseProxies?:BusinessToolDeps['reverseProxies'];
  pocs?:import('../pocs/service.ts').PocService;
  fingerprints?:import('../fingerprints/service.ts').FingerprintService;
  modeling?:BusinessToolDeps['modeling'];
  graph?: ExplorationService;
  taskOperation?(id:number):(()=>void)|null;
  taskRuntimeState?(id:number):Promise<{started:boolean;paused:boolean;ready:boolean}>;
  pool: Pool;
  dlqPath?:string;
  /** TaskService.create（!queued time onLaunch Automatically start the engine, and HTTP POST /api/tasks Same link） */
  tasks: {
    create(input: Record<string, unknown>): Promise<{ ok: boolean; task?: Record<string, unknown>; status?: number; error?: string }>;
    list(filter?: { status?: string; archived?: boolean | null }): Promise<Record<string, unknown>[]>;
    control(id: number, action: string): Promise<{ ok: boolean; status: number; error?: string }>;
  };
  findings: BusinessToolDeps['findings'] & {
    list(filter?: { task?: number; severity?: string; status?: string; q?: string }): Promise<Record<string, unknown>[]>;
    create(input: Record<string, unknown>): Promise<{ ok: boolean; finding?: Record<string, unknown>; status?: number; error?: string }>;
  };
  assets: BusinessToolDeps['assets'] & {
    list(filter?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    batchUpsert(inputs: { type: string; value: string }[], opts?: { viaAgent?: boolean }): Promise<{ inserted: number; blocked: number; errors: string[] }>;
  };
  skills: SkillsService;
  mcp: McpService;
  intercept: {
    gateRules(): Promise<InterceptRule[]>;
    requestApproval(toolCallId: number, reason?: string, timeoutMs?: number, timeoutAction?: "deny" | "allow", signal?: AbortSignal): Promise<"approved" | "denied" | "timeout" | "timeout-allow">;
  };
  /** G06：LLM The verdict is clear（main.ts Injection runJudge；Default=Not enabled, maintain release） */
  runJudge?(toolKey: string, params: Record<string, unknown>,context:ToolContext): Promise<import('./judge.ts').JudgeOutcome | null>;
}

/** Idempotent registration of all platform tools to B06 Gate (in-process registry）。 */
export function registerPlatformTools(deps: PlatformDeps): void {
  registerFindingReadTools(deps.pool);
  const reg = (t: Parameters<typeof registerTool>[0]) => {
    registerTool(t);
  };

  registerTaskOrchestration(deps);
  registerCurrentTaskControls(deps);

  registerPlatformManagement(deps.pool,deps.skills,deps.mcp,deps.dlqPath??path.join('/tmp','wormhole-platform-dlq.jsonl'));

  // ── pentest Standalone Penetration Tool (Control seedPentestDefaultBindings）──


  // G04：insert_assets / report_finding and tasks worker Share the same copy ctx Driver registration
  //（handler From ToolContext.taskId Analysis of ownership; dialogue scene task_id is empty). Idempotent。
  registerBusinessTools({ trafficFlow:deps.trafficFlow,reverseProxies:deps.reverseProxies, assets: deps.assets, findings: deps.findings,modeling:deps.modeling,fingerprints:deps.fingerprints });
  registerAssetTools(deps.pool);
  registerTraceTools(deps.pool);
}

/** auto Role-visible platform orchestration + Management Tools Key。 */
const AUTO_TOOLS = [
  "list_tasks", "list_llm_profiles", "spawn_task", "pause_task", "get_task_graph",
  "list_task_findings", "get_task_node_detail", "add_task_hint", "get_task_worker_trace",
  ...PLATFORM_MANAGEMENT.map(t=>t.key),"list_task_worker_traces","search_task_worker_traces",
];
/** pentest Tool keys for independent infiltration characters。 */
const PENTEST_TOOLS = ["list_assets", "insert_assets", "list_findings", "report_finding","list_companies"];

const TOOL_DESC: Record<string, string> = {
  list_tasks: "View global task list",
  list_llm_profiles: "List available LLM configurations (for spawn_task model selection)",
  spawn_task: "Create and start a penetration testing subtask (within authorization scope)",
  pause_task: "Pause a running task",
  get_task_graph: "Read the exploration graph node of a task (progress/intent/vulnerability)",
  list_task_findings: "List the registered vulnerabilities for a task",
  add_task_hint: "Inject high priority hints into tasks",
  get_task_worker_trace: "Review the execution event flow of a task/intent",
  create_skill: "Create skill",
  update_skill_file: "Write skill file",
  create_mcp: "Register MCP Server",
  list_assets: "View registered assets",
  insert_assets: "Asset storage (JSON array string)",
  list_findings: "View reported vulnerabilities",
  report_finding: "Report verified vulnerability (including evidence)",
};

/**
 * Assembling something agent ’s conversation tool（Pi customTools）。Each execute Sutra B06 Gate Execution。
 * http_request for pentest Direct Connect Detection Tool (with worker Consistent）。
 */
/** G13：Task Master Agent ’s layout tool (cf. mainagent：Reading pictures/Discovery/Track + Tips/Pause） */
const MAINAGENT_TOOLS = [
  "get_task_graph", "list_task_findings", "get_task_node_detail", "add_task_hint", "get_task_worker_trace",
  "pause_task", "list_tasks", "pause_current_task", "stop_current_task",
];

export async function chatToolsFor(agentKey: string, ctx: ToolContext, deps: PlatformDeps): Promise<ToolDefinition[]> {
  const keys = agentKey === "auto" ? AUTO_TOOLS : agentKey === "pentest" ? PENTEST_TOOLS : agentKey === "mainagent" ? MAINAGENT_TOOLS : agentKey==='retester'?['get_finding_retest_context','record_finding_retest_result']:[];
  const rules = await deps.intercept.gateRules().catch(() => [] as InterceptRule[]);
  // G06：The dialogue tool is also connected judge Digging and rule timeout
  const gateOpts = {
    rules, getRules:()=>deps.intercept.gateRules(),
    requestApproval: (tcid: number, reason?: string, timeoutMs?: number, timeoutAction?: "deny" | "allow", signal?: AbortSignal) =>
      deps.intercept.requestApproval(tcid, reason, timeoutMs, timeoutAction, signal),
    judge: (toolKey: string, params: Record<string, unknown>,context:ToolContext) => deps.runJudge ? deps.runJudge(toolKey, params,context) : Promise.resolve(null),
  };
  const defaults=agentKey==='mainagent' ? [...keys,...GRAPH_TOOLS.mainagent,...ASSET_TOOLS.mainagent,...WORK_CONTROLS,...TRACE_TOOLS.mainagent,'list_findings','insert_assets','report_finding'] : agentKey==='pentest' ? [...keys,'http_request'] : keys;
  const configured=(await deps.pool.query('SELECT key FROM tools WHERE enabled=TRUE AND agents @> $1::jsonb ORDER BY key',[JSON.stringify([agentKey])])).rows.map(r=>String(r.key));
  const modelingKeys=['auto','pentest','mainagent'].includes(agentKey)?MODELING_REQUEST_TOOLS:[];
  const fingerprintKeys=ctx.taskId&&['planner','worker','pentest','mainagent'].includes(agentKey)?FINGERPRINT_TOOLS:[];
  const boundKeys=[...new Set([...defaults,...configured,...modelingKeys,...fingerprintKeys,...(ctx.taskId?POC_TOOLS:[])])];
  const base=await assembleTools(deps.pool,boundKeys,ctx,gateOpts);
  const augmentation=await augmentSession(deps.pool,deps.mcp,deps.skills,ctx,gateOpts);
  return bindAugmentation([...base,...augmentation.tools],augmentation);
}
