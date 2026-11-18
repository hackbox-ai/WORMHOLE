import {toolAvailable} from '../extensions/availability.ts';
import {inTaskNetwork} from '../network/context.ts';
/**
 * B06 Tool/Approval Gate - Single Registration and Final Execution Wrapper。
 * The Iron Law of Sequence: Visibility → Parameter verification → Interception Strategy → Manual approval → Execute → Audit。
 * Even if the upper level（Pi hook）Modified parameters, still before final execution executor Verify again+Authorization。
 */
import type { Pool } from "pg";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {beginReview,finishReview} from '../intercept/reviews.ts';

export interface ToolSchema {
  key: string;
  description: string;
  /** Simplified form JSON Schema：only supports required Field existence + Type assertion (stage sufficient) A Core semantics） */
  params: Record<string, "string" | "number" | "boolean">;
  required: string[];
  /** Complete schema for arrays, objects, enums and combinations. */
  schema?: Record<string, unknown>;
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  businessKind: string;
  businessId: string;
  runId?: string;
  agentKey: string;
  /** G04：Structured attribution - determined by the host during assembly session, never taken from model tool parameters。
   * worker Session：taskId/intentId；Dialogue session：conversationId。
   * in global registry handler Only allow task ownership to be parsed from here, and closure capture of task state is prohibited.。 */
  taskId?: number;
  intentId?: number;
  /** Original worker attribution label, supplied only by the task host. */
  workerName?:string;
  conversationId?: number;
  signal?: AbortSignal;
  nativeToolCallId?: string;
  /** Explicit authenticated manual tool-test endpoint is outside agent binding. */
  manualInvocation?: boolean;
  cwd?:string;
  interactiveShellSession?:{execute(name:string,params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>};
  customSession?:{execute(key:string,params:Record<string,unknown>,nativeId?:string,signal?:AbortSignal):Promise<unknown>};
  /** Explicit current human input only; generated worker/planner prompts never qualify. */
  reviewBackground?:{source:string;text:string;truncated?:boolean};
  reviewRunId?:string;
  reviewEntries?(currentToolId?:string): {kind:string;tool?:string;tool_use_id?:string;text:string;is_error?:boolean;truncated?:boolean}[];
  generalSession?:{execute(name:string,params:Record<string,unknown>,nativeId?:string,signal?:AbortSignal):Promise<unknown>};
  /** Session-owned augmentations; never read from model parameters. */
  mcpSession?: {
    call(serverId:number,name:string,params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>;
    invokeSkill(name:string,args?:string):Promise<unknown>;
    search(query:string):Promise<unknown>;
    execute(name:string,params:Record<string,unknown>,nativeId?:string,signal?:AbortSignal):Promise<unknown>;
  };
  canExecute?(toolKey?:string): Promise<boolean>;
  /** Per-work steering hook, evaluated at the final side-effect boundary. */
  beforeExecute?():Promise<void>;
}

export interface InterceptRule {
  id?:number;
  name?:string;
  configDigest?:string;
  toolPattern: Pick<RegExp, 'test'>;
  paramPattern?: Pick<RegExp, 'test'>;
  action: "allow" | "block" | "ask";
  reason?: string;
  /** G06：ask The rule comes with approval timeout Effective when（timeout_enabled effective when） */
  timeoutSeconds?: number;
  timeoutEnabled?: boolean;
  /** G06：Action after timeout (compare to baseline timeout_action） */
  timeoutAction?: "deny" | "allow";
}

export interface GateDecision {
  action: "allow" | "block" | "ask";
  rule?: InterceptRule;
  /** G06：judge Description of the all-inclusive ruling (empty when the rule hits） */
  reason?: string;
  timeoutSeconds?:number;
  timeoutAction?:'allow'|'deny';
  reviewed?:boolean;
  modelFallback?:boolean;
  modelInput?:unknown;
  profileId?:number;
}

export type ApprovalDecision = "approved" | "denied";

const registery = new Map<string, ToolSchema>();

export function registerTool(tool: ToolSchema): void {
  registery.set(tool.key, tool);
}

export function getTool(key: string): ToolSchema | undefined {
  return registery.get(key);
}

/** Agent Visibility: Stage A Whitelist map（agentKey → Available tool keys）；Empty array=All visible */
const visibility = new Map<string, string[]>();

export function setVisibility(agentKey: string, toolKeys: string[]): void {
  visibility.set(agentKey, toolKeys);
}

export function isVisible(agentKey: string, toolKey: string): boolean {
  const list = visibility.get(agentKey);
  return !list || list.includes(toolKey);
}

export function validateParams(tool: ToolSchema, params: Record<string, unknown>): string | null {
  if (tool.schema) {
    try {
      if (!Value.Check(tool.schema as TSchema, params)) {
        const errors = [...Value.Errors(tool.schema as TSchema, params)];
        return `Parameter verification failed: ${errors.map(e => `${e.instancePath}: ${e.message}`).join('; ')}`;
      }
    } catch (e) { return `Tool schema is invalid: ${String(e)}`; }
    return null;
  }
  for (const key of tool.required) {
    if (params[key] === undefined) return `Missing required parameter ${key}`;
  }
  for (const [key, kind] of Object.entries(tool.params)) {
    const v = params[key];
    if (v === undefined) continue;
    const t = typeof v;
    if (kind === "number" && t !== "number") return `Parameters ${key} should be number`;
    if (kind !== "number" && t !== kind) return `Parameters ${key} should be ${kind}`;
  }
  return null;
}

/** Interception judgment: The order of rules is the priority, the first hit takes effect; no hit, the default allow */
export function evaluateRules(rules: InterceptRule[], toolKey: string, params: Record<string, unknown>): GateDecision {
  for (const rule of rules) {
    if (!rule.toolPattern.test(toolKey)) continue;
    if (rule.paramPattern) {
      const hay = JSON.stringify(params);
      if (!rule.paramPattern.test(hay)) continue;
    }
    return { action: rule.action, rule };
  }
  return { action: "allow" };
}

export interface GateResult {
  status: "executed" | "blocked" | "denied" | "not-visible" | "invalid-params" | "approval-timeout";
  output?: unknown;
  error?: string;
  toolCallId?: number;
  approvalId?: number;
}

export interface GateOptions {
  /** Runtime assemblies honor the original selected-tool scope; explicit unit gates may opt out. */
  enforceInterceptScope?: boolean;
  rules?: InterceptRule[];
  /** Live rule view; editing a policy must affect the next call in an existing session. */
  getRules?():Promise<InterceptRule[]>;
  /** ask Approval callback during action; default=Automatically rejected (not allowed when there is no manual channel)）。
   * timeoutMs The approval timeout that takes effect this time (rule timeout_enabled or judge ask_timeout_seconds）；
   * timeoutAction is a timeout action（allow=Release / deny=Reject); Return "timeout-allow" indicates timeout release。 */
  requestApproval?(toolCallId: number, reason?: string, timeoutMs?: number, timeoutAction?: "deny" | "allow", signal?: AbortSignal): Promise<ApprovalDecision | "timeout" | "timeout-allow">;
  /** G06：When rule misses LLM The verdict is complete (Cont. guard.applyIntercept → Judge）。
   * Back null = Not enabled/Not wired → Maintain release。 */
  judge?(toolKey: string, params: Record<string, unknown>,context:ToolContext): Promise<{ action: "allow" | "deny" | "ask"; comment: string; modelFallback: boolean;timeoutSeconds?:number;timeoutAction?:'allow'|'deny' } | null>;
}

export async function runTool(
  pool: Pool,
  toolKey: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  opts: GateOptions = {},
): Promise<GateResult> {
  const invokedAt=Date.now();let executionAt:number|undefined;
  if (ctx.signal?.aborted || (ctx.canExecute && !(await ctx.canExecute(toolKey)))) return {status: "blocked", error: "Run canceled"};
  const tool = getTool(toolKey);
  if (!tool) return { status: "blocked", error: `Tool not registered ${toolKey}` };
  if(!await toolAvailable(toolKey,ctx.taskId))return {status:"blocked",error:"Optional capability is not installed, not configured, or disabled"};
  // Re-read editable binding at every invocation, including after approval.
  const binding = async () => {
    const r=await pool.query('SELECT enabled,agents FROM tools WHERE key=$1',[toolKey]);
    return !r.rowCount || (r.rows[0].enabled && (ctx.manualInvocation || (r.rows[0].agents as string[]).includes(ctx.agentKey)));
  };
  if (!(await binding())) return {status:'not-visible',error:`agent ${ctx.agentKey} Invisible tools ${toolKey}`};
  if (!isVisible(ctx.agentKey, toolKey)) {
    return { status: "not-visible", error: `agent ${ctx.agentKey} Invisible tools ${toolKey}` };
  }
  const invalid = validateParams(tool, params);
  if (invalid) return { status: "invalid-params", error: invalid };
  // Original server/tool_usage.go: catalog calls are metered best-effort.
  // Explicit unsaved editor probes never create runtime usage.
  if(!ctx.manualInvocation)await pool.query("INSERT INTO tool_usage(tool_key,agent_key,task_id,exploration_id,intent_id,session_id) SELECT key,$2,$3,(SELECT exploration_id FROM tasks WHERE id=$3),$4,$5 FROM tools WHERE key=$1",[toolKey,ctx.agentKey||null,ctx.taskId??null,ctx.intentId??null,ctx.conversationId?String(ctx.conversationId):ctx.businessKind==='chat'?ctx.businessId:null]).catch(error=>console.warn('[toolusage] insert failed',String(error)));
  const admittedInput = JSON.stringify(params);
  const entries=ctx.reviewEntries?.(ctx.nativeToolCallId)??[];
  const reviewContext={...ctx,reviewEntries:()=>entries};

  let interceptEnabled=true;
  if(opts.enforceInterceptScope){
    const saved=(await pool.query("SELECT value FROM app_settings WHERE key='intercept_enabled_tools'")).rows[0];
    let names:unknown=['Bash','WebFetch','web_search','shell_open','shell_send','Write','Edit','MultiEdit'];
    if(saved)try{names=JSON.parse(saved.value);}catch{names=[];}
    interceptEnabled=Array.isArray(names)&&names.every(n=>typeof n==='string')&&names.includes(toolKey);
  }
  const currentRules=interceptEnabled ? await opts.getRules?.() ?? opts.rules ?? [] : [];
  let decision = evaluateRules(currentRules, toolKey, params);
  // G06：Rule miss → LLM The verdict is complete (Cont. guard.applyIntercept：!matched Talent Judge）。
  // Ruling event ledger（judge_verdict）For approval history page display。
  if (interceptEnabled && !decision.rule && opts.judge) {
    const j = await opts.judge(toolKey, params,ctx);
    if (j) {
      decision = j.action === "deny" ? { action: "block", reason: j.comment } : { action: j.action, rule: undefined, reason: j.comment };
      decision.timeoutSeconds=j.timeoutSeconds;decision.timeoutAction=j.timeoutAction;
      decision.reviewed=true;decision.modelFallback=j.modelFallback;
      decision.modelInput=(j as {modelInput?:unknown}).modelInput;decision.profileId=(j as {profileId?:number}).profileId;
      await pool.query(
        `INSERT INTO business_events (business_kind, business_id, event_type, payload) VALUES ('intercept',$1,'judge_verdict',$2)`,
        [ctx.businessId, JSON.stringify({ tool: toolKey, action: j.action, comment: j.comment, model_fallback: j.modelFallback, params: JSON.stringify(params).slice(0, 2000) })],
      ).catch(() => {});
    }
  }
  const call = await pool.query<{ id: number }>(
    `INSERT INTO tool_calls (business_kind, business_id, run_id, tool_key, params,native_tool_call_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.businessKind, ctx.businessId, ctx.runId ?? null, toolKey, JSON.stringify(params),ctx.nativeToolCallId ?? null],
  );
  const toolCallId = call.rows[0]!.id;
  await beginReview(pool,toolCallId,toolKey,params,reviewContext,decision).catch(error=>{
    console.error('[intercept] review persistence failed',String(error));
    if(decision.action==='ask')throw error; // Never wait for/execute an unpersisted approval.
  });

  if (decision.action === "block") {
    await pool.query("UPDATE tool_calls SET is_error=TRUE, error_text=$2 WHERE id=$1", [
      toolCallId,
      `intercept: ${decision.rule?.reason ?? decision.reason ?? "Rule blocking"}`,
    ]);
    return { status: "blocked", error: decision.rule?.reason ?? decision.reason ?? "Blocking by interception rules", toolCallId };
  }

  let approvalId: number | undefined;
  if (decision.action === "ask") {
    const ap = await pool.query<{ id: number }>(
      "INSERT INTO tool_approvals (tool_call_id) VALUES ($1) RETURNING id",
      [toolCallId],
    );
    approvalId = ap.rows[0]!.id;
    // G06：Approval timeout from rule timeout_enabled（Default if none 300s），Timeout action timeout_action
    const seconds=decision.rule?.timeoutSeconds??decision.timeoutSeconds;
    const timeoutEnabled = decision.rule ? decision.rule.timeoutEnabled ?? (seconds !== undefined) : seconds !== undefined;
    // Rule timeout disabled means indefinite waiting, as HandleAsk; enabled invalid seconds defaults to 60s.
    const ruleTimeoutMs = timeoutEnabled ? (seconds && seconds > 0 ? seconds * 1000 : 60_000) : 0;
    const ruleTimeoutAction = decision.rule?.timeoutAction ?? decision.timeoutAction ?? "deny";
    const verdict = opts.requestApproval
      ? await opts.requestApproval(toolCallId, decision.rule?.reason ?? decision.reason, ruleTimeoutMs, ruleTimeoutAction, ctx.signal)
      : "denied";
    const statusMap: Record<string, string> = { approved: "approved", denied: "denied", timeout: "timeout", "timeout-allow": "timeout" };
    await pool.query(
      "UPDATE tool_approvals SET status=$2, decided_at=now() WHERE id=$1 AND status='pending'",
      [approvalId, statusMap[verdict]],
    );
    if (verdict === "timeout" || verdict === "timeout-allow") {
      if (verdict === "timeout-allow") {
        // G06：timeout_action=allow Release after the rule times out (the approval document has been recorded timeout，tool_calls Record release reason）
        await pool.query("UPDATE tool_calls SET result='Approval timeout, release according to rule timeout_action' WHERE id=$1", [toolCallId]).catch(() => {});
      } else {
        await pool.query("UPDATE tool_calls SET is_error=TRUE, error_text='Approval timeout' WHERE id=$1", [toolCallId]);
        return { status: "approval-timeout", toolCallId, approvalId };
      }
    }
    if (verdict === "denied") {
      await pool.query("UPDATE tool_calls SET is_error=TRUE, error_text='Approval Rejected' WHERE id=$1", [toolCallId]);
      return { status: "denied", toolCallId, approvalId };
    }
  }

  if (ctx.signal?.aborted || (ctx.canExecute && !(await ctx.canExecute(toolKey)))) {
    await pool.query("UPDATE tool_calls SET is_error=TRUE,error_text='Run canceled' WHERE id=$1",[toolCallId]);
    await finishReview(pool,toolCallId,'not_executed',"Pre-execution work canceled");
    return {status: "blocked", error: "Run canceled",toolCallId,approvalId};
  }
  // Final execution wrapper layer（G06 Reinspection): Visibility may be withdrawn and parameters may be rewritten while waiting for approval.
  if (!isVisible(ctx.agentKey, toolKey) || !(await binding())) {
    await pool.query("UPDATE tool_calls SET is_error=TRUE, error_text=$2 WHERE id=$1", [toolCallId, "Revalidation failed: Visibility withdrawn"]);
    await finishReview(pool,toolCallId,'not_executed',"Revalidation failed: Visibility withdrawn");
    return { status: "not-visible", error: `agent ${ctx.agentKey} Tool is no longer visible ${toolKey}`, toolCallId };
  }
  const invalid2 = validateParams(tool, params);
  if (invalid2) {
    await pool.query("UPDATE tool_calls SET is_error=TRUE, error_text=$2 WHERE id=$1", [toolCallId, invalid2]);
    await finishReview(pool,toolCallId,'not_executed',invalid2);
    return { status: "invalid-params", error: invalid2, toolCallId };
  }
  try {
    await ctx.beforeExecute?.();
    // beforeExecute can await steering/leases. Recheck at the actual effect
    // boundary, and execute a detached snapshot of the approved input.
    if (ctx.signal?.aborted || (ctx.canExecute && !(await ctx.canExecute(toolKey)))) {
      throw new Error("Pre-execution work canceled");
    }
    if (JSON.stringify(params) !== admittedInput) {
      throw new Error("Reinspection failed: Tool parameters have been changed and need to be re-approved");
    }
    if (!isVisible(ctx.agentKey, toolKey) || !(await binding())) {
      throw new Error("Revalidation failed: Visibility withdrawn");
    }
    if(!await toolAvailable(toolKey,ctx.taskId))throw new Error("Optional capability is not installed, not configured, or disabled");
    executionAt=Date.now();
    const output = await inTaskNetwork(ctx.taskId,()=>tool.execute(JSON.parse(admittedInput), ctx));
    await pool.query("UPDATE tool_calls SET result=$2,preflight_ms=$3,execution_ms=$4,finished_at=now() WHERE id=$1", [toolCallId, JSON.stringify(output ?? null),executionAt-invokedAt,Date.now()-executionAt]);
    await finishReview(pool,toolCallId,'succeeded',output);
    if (approvalId) {
      await pool.query("UPDATE tool_approvals SET status='executed', decided_at=COALESCE(decided_at, now()) WHERE id=$1", [approvalId]);
    }
    return { status: "executed", output, toolCallId, approvalId };
  } catch (err) {
    await pool.query("UPDATE tool_calls SET is_error=TRUE,error_text=$2,preflight_ms=$3,execution_ms=$4,finished_at=now() WHERE id=$1", [toolCallId,String(err),(executionAt??Date.now())-invokedAt,executionAt===undefined?null:Date.now()-executionAt]);
    await finishReview(pool,toolCallId,'failed',String(err));
    return { status: "blocked", error: String(err), toolCallId };
  }
}
