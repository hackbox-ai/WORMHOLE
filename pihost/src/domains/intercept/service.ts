/**
 * F17 Interception rules and F19 Approval Record Service。
 * Rules：name/match_target(tool_name|tool_input)/match_type(regex|exact|contains)/
 * pattern/action(allow|deny|ask)/message/priority/timeout_*；Prioritize first hit。
 * Approval：ask time gate of requestApproval Register Waiter（pendingManager）+ tool_approvals Durable。
 */
import type { Pool } from "pg";
import type { InterceptRule } from "../tools/gate.ts";
import { appendEvent } from "../../events/ledger.ts";
import {createHash} from 'node:crypto';
import { RE2JS } from 're2js';

/** Go regexp/RE2 syntax is part of the persisted rule contract. Native JS
 * RegExp cannot load inline flags, POSIX classes or Go named captures. */
function matchRegex(matchType: string, pattern: string): Pick<RegExp, 'test'> {
  if (matchType === "string") return {test: (subject: string) => subject.includes(pattern)};
  return RE2JS.compile(pattern);
}

type Waiter = (decision: "approved" | "denied") => void;

export class InterceptService {
  private readonly waiters = new Map<number, Waiter>();

  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
  ) {}

  ruleError(input: Record<string, unknown>): string | null {
    const fields:Record<string,string>={name:'string',match_target:'string',match_type:'string',pattern:'string',action:'string',message:'string',priority:'int',enabled:'bool',timeout_enabled:'bool',timeout_seconds:'int',timeout_action:'string'};
    for(const [key,kind] of Object.entries(fields)){
      const value=input[key];if(value===null||value===undefined)continue;
      if(kind==='int'?typeof value!=='number'||!Number.isSafeInteger(value):typeof value!==(kind==='bool'?'boolean':kind)){
        const received=Array.isArray(value)?'array':typeof value==='number'?'number '+String(value):typeof value;
        return `json: cannot unmarshal ${received} into Go struct field interceptRuleReq.${key} of type ${kind}`;
      }
    }
    if((input.name??'')==='')return "name cannot be empty";
    if(!['tool_name','tool_input'].includes(String(input.match_target??'')))return "match_target must be tool_name or tool_input";
    if(!['string','regex'].includes(String(input.match_type??'')))return "match_type must be string or regex";
    if((input.pattern??'')==='')return "pattern cannot be empty";
    if(!['allow','deny','ask'].includes(String(input.action??'')))return "action must be allow, deny, or ask";
    if(input.match_type==='regex')try{RE2JS.compile(String(input.pattern));}catch(error){return `pattern is not a valid regular expression:${(error as Error).message}`;}
    return null;
  }

  // ── F17 Rules CRUD ──
  async listRules(): Promise<Record<string, unknown>[]> {
    const rows = (await this.pool.query("SELECT * FROM intercept_rules ORDER BY priority DESC, id")).rows as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), name: r.name, enabled: r.enabled, priority: r.priority,
      match_target: r.match_target, match_type: r.match_type, pattern: r.pattern,
      action: r.action, message: r.message, timeout_enabled: r.timeout_enabled,
      timeout_seconds: r.timeout_seconds, timeout_action: r.timeout_action,
      created_at: r.created_at, updated_at: r.updated_at ?? r.created_at,
    }));
  }

  async createRule(input: Record<string, unknown>): Promise<{ ok: boolean; status: number; rule?: Record<string, unknown>; error?: string }> {
    const invalid=this.ruleError(input);if(invalid)return {ok:false,status:400,error:invalid};
    const name = String(input.name ?? "");
    if (!name) return { ok: false, status: 400, error: "name cannot be empty" };
    const matchTarget = String(input.match_target ?? "");
    if (!["tool_name", "tool_input"].includes(matchTarget)) return { ok: false, status: 400, error: "match_target must be tool_name or tool_input" };
    const matchType = String(input.match_type ?? "");
    if (!["string", "regex"].includes(matchType)) return { ok: false, status: 400, error: "match_type must be string or regex" };
    const pattern = String(input.pattern ?? "");
    if (!pattern) return { ok: false, status: 400, error: "pattern cannot be empty" };
    const action = String(input.action ?? "");
    if (!["allow", "deny", "ask"].includes(action)) return { ok: false, status: 400, error: "action must be allow, deny, or ask" };
    const r = await this.pool.query(
      `INSERT INTO intercept_rules (name, match_target, match_type, pattern, action, message, priority, enabled, timeout_enabled, timeout_seconds, timeout_action)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,TRUE),$9,COALESCE($10,0),$11) RETURNING *`,
      [name, matchTarget, matchType, pattern, action, String(input.message ?? ""), input.priority ?? null,
        input.enabled ?? false, input.timeout_enabled === true, input.timeout_seconds ?? null, String(input.timeout_action ?? "")],
    );
    await this.audit("rule_created", { id: r.rows[0]!.id });
    return { ok: true, status: 200, rule: r.rows[0] };
  }

  async updateRule(id: number, input: Record<string, unknown>): Promise<boolean> {
    const invalid=this.ruleError(input);if(invalid)throw Object.assign(new Error(invalid),{status:400});
    const result=await this.pool.query(
      `UPDATE intercept_rules SET name=$2, match_target=$3, match_type=$4, pattern=$5, action=$6, message=$7, priority=$8, enabled=$9, timeout_enabled=$10,timeout_seconds=$11,timeout_action=$12,updated_at=now() WHERE id=$1 RETURNING id`,
      [id, String(input.name ?? ''), String(input.match_target ?? ''), String(input.match_type ?? ''),
        String(input.pattern ?? ''), String(input.action ?? ''), String(input.message ?? ''),
        Number(input.priority ?? 0), input.enabled ?? false,input.timeout_enabled??false,input.timeout_seconds??0,input.timeout_action??''],
    );
    if(result.rowCount)await this.audit("rule_updated", { id });
    return !!result.rowCount;
  }

  async removeRule(id: number): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM intercept_rules WHERE id=$1", [id]);
    if ((r.rowCount ?? 0) > 0) await this.audit("rule_deleted", { id });
    return (r.rowCount ?? 0) > 0;
  }

  /** Supply B06 gate Rule set used */
  async gateRules(): Promise<InterceptRule[]> {
    const rows = (await this.pool.query(
      "SELECT * FROM intercept_rules WHERE enabled=TRUE ORDER BY priority DESC, id ASC",
    )).rows as any[];
    // Imported legacy invalid patterns are skipped by the original loadLocked.
    // A bad row must not prevent all sessions from assembling their tool gate.
    return rows.flatMap((r) => {
      let matcher: Pick<RegExp, 'test'>;
      try { matcher = matchRegex(r.match_type, r.pattern); }
      catch { return []; }
      return [{
        id:Number(r.id), name:r.name, configDigest:createHash('sha256').update(JSON.stringify(r)).digest('hex'),
        toolPattern: r.match_target === "tool_name" ? matcher : {test: () => true},
        paramPattern: r.match_target === "tool_input" ? matcher : undefined,
        action: r.action === "deny" ? ("block" as const) : (r.action as "allow" | "ask"),
        reason: r.message || (r.action==='deny'?`Interception Rules [${r.name}] Execution of this tool is prohibited`:r.action==='ask'?`Interception Rules [${r.name}] User approval is required, please wait.`:''),
        timeoutSeconds: r.timeout_enabled && r.timeout_seconds > 0 ? r.timeout_seconds : undefined,
        timeoutEnabled: r.timeout_enabled,
        timeoutAction: r.timeout_action === "allow" ? ("allow" as const) : ("deny" as const),
      }];
    });
  }

  // ── F19 Approval ──
  async requestApproval(
    toolCallId: number,
    reason?: string,
    timeoutMs = 300_000,
    timeoutAction: "deny" | "allow" = "deny",
    signal?: AbortSignal,
  ): Promise<"approved" | "denied" | "timeout" | "timeout-allow"> {
    await this.pool.query(
      `UPDATE tool_approvals SET status='pending', reason=COALESCE($2, reason) WHERE tool_call_id=$1 AND status='pending'`,
      [toolCallId, reason ?? null],
    );
    return await new Promise((resolve,reject) => {
      let finished=false,polling=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish = (decision: "approved" | "denied" | "timeout" | "timeout-allow") => {
        if(finished)return;finished=true;
        if(timer)clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener("abort", cancel);
        this.waiters.delete(toolCallId);
        resolve(decision);
      };
      const saved = async () => {
        await this.pool.query(`UPDATE tool_approvals a SET status=CASE ip.status WHEN 'allowed' THEN 'approved' ELSE ip.status END,
          decided_at=ip.decided_at,decided_by=CASE WHEN ip.status='timeout' AND ip.audit->>'effective_action'='allow' THEN 'timeout-allow' ELSE 'persistent-review' END
          FROM intercept_pending ip WHERE a.tool_call_id=$1 AND ip.tool_call_id=a.tool_call_id AND a.status='pending' AND ip.status<>'pending'`,[toolCallId]);
        const row=(await this.pool.query('SELECT status,decided_by FROM tool_approvals WHERE tool_call_id=$1',[toolCallId])).rows[0];
        if(!row)throw new Error("The approval form has been deleted");
        if(row.status==='pending')return;
        finish(row.status==='approved'||row.status==='executed'?'approved':row.status==='timeout'?(row.decided_by==='timeout-allow'?'timeout-allow':'timeout'):'denied');
      };
      const check=async()=>{if(finished||polling)return;polling=true;try{await saved();}catch(error){if(!finished){finished=true;if(timer)clearTimeout(timer);clearInterval(poll);signal?.removeEventListener('abort',cancel);this.waiters.delete(toolCallId);reject(error);}}finally{polling=false;}};
      const settle=async(status:'denied'|'timeout',by:string)=>{
        try{
          await this.resolveCall(toolCallId,status,by);
          await saved();
        }catch(error){if(!finished){finished=true;if(timer)clearTimeout(timer);clearInterval(poll);signal?.removeEventListener('abort',cancel);this.waiters.delete(toolCallId);reject(error);}}
      };
      const cancel = () => {void settle('denied','cancelled');};
      const poll=setInterval(()=>void check(),100);
      if(timeoutMs>0)timer=setTimeout(()=>void settle('timeout',timeoutAction==='allow'?'timeout-allow':'timeout-deny'),Math.max(1,timeoutMs));
      this.waiters.set(toolCallId, finish);
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) cancel();else void check(); // Re-read after registering: do not lose an early API decision.
    });
  }

  async decide(approvalId: number, decision: "approved" | "denied", by = "admin"): Promise<{ ok: boolean; status: number; error?: string }> {
    const row=(await this.pool.query('SELECT tool_call_id FROM tool_approvals WHERE id=$1',[approvalId])).rows[0];
    if(!row||!await this.resolveCall(Number(row.tool_call_id),decision,by))return {ok:false,status:409,error:"The approval form does not exist or has been decided"};
    const toolCallId = Number(row.tool_call_id);
    const w = this.waiters.get(toolCallId);
    if (w) w(decision);
    await this.audit("approval_decided", { approvalId, decision });
    return { ok: true, status: 200 };
  }

  async decideReview(id:number,decision:'approved'|'denied'){
    const row=(await this.pool.query('SELECT a.id FROM intercept_pending ip JOIN tool_approvals a ON a.tool_call_id=ip.tool_call_id WHERE ip.id=$1',[id])).rows[0];
    if(row)return this.decide(Number(row.id),decision);
    // Imported source pending rows have no live target waiter. Preserve source state without authorizing a new call.
    const action=decision==='approved'?'allow':'deny',status=decision==='approved'?'allowed':'denied';
    const patch={effective_action:action,decision_reason:decision==='approved'?"Manually allow execution":"Manual rejection of execution",execution_status:action==='allow'?'awaiting_result':'not_executed'};
    const r=await this.pool.query("UPDATE intercept_pending SET status=$2,decided_at=now(),audit=CASE WHEN audit IS NULL THEN NULL ELSE audit||$3::jsonb||CASE WHEN $2='allowed' AND audit->>'correlation' IS DISTINCT FROM 'exact' THEN '{\"execution_status\":\"unknown\"}'::jsonb ELSE '{}'::jsonb END END WHERE id=$1 AND status='pending'",[id,status,JSON.stringify(patch)]);
    return r.rowCount?{ok:true,status:200}:{ok:false,status:409,error:"The approval has been processed or does not exist, please refresh the record"};
  }

  private async resolveCall(callId:number,status:'approved'|'denied'|'timeout',by:string):Promise<boolean>{
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const r=await db.query("UPDATE tool_approvals SET status=$2,decided_at=now(),decided_by=$3 WHERE tool_call_id=$1 AND status='pending' RETURNING id",[callId,status,by]);
      if(r.rowCount){
        const review=(await db.query('SELECT status FROM intercept_pending WHERE tool_call_id=$1 FOR UPDATE',[callId])).rows[0];
        if(review&&review.status!=='pending'){await db.query('ROLLBACK');return false;}
        const action=status==='approved'||by==='timeout-allow'?'allow':'deny';
        const reason=by==='cancelled'?"Job canceled":status==='timeout'?"Approval timeout, processed according to timeout policy":action==='allow'?"Manually allow execution":"Manual rejection of execution";
        await db.query("UPDATE intercept_pending SET status=$2,decided_at=now(),audit=CASE WHEN audit IS NULL THEN NULL ELSE audit||$3::jsonb END WHERE tool_call_id=$1 AND status='pending'",[callId,status==='approved'?'allowed':status,JSON.stringify({effective_action:action,decision_reason:reason,execution_status:action==='allow'?'awaiting_result':'not_executed'})]);
      }
      await db.query('COMMIT');return !!r.rowCount;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  async pending(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT a.id, a.tool_call_id, a.reason, a.ts, c.tool_key, c.params, c.business_kind, c.business_id
       FROM tool_approvals a JOIN tool_calls c ON c.id = a.tool_call_id
       WHERE a.status='pending' ORDER BY a.id DESC LIMIT 100`,
    );
    return r.rows;
  }

  async history(limit = 100): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT a.id, a.tool_call_id, a.status, a.reason, a.decided_at, a.decided_by, a.ts, c.tool_key
       FROM tool_approvals a JOIN tool_calls c ON c.id = a.tool_call_id
       WHERE a.status <> 'pending' ORDER BY a.id DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }

  async detail(id: number): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query(
      `SELECT a.*, c.tool_key, c.params, c.result, c.is_error, c.error_text
       FROM tool_approvals a JOIN tool_calls c ON c.id = a.tool_call_id WHERE a.id=$1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "intercept", business_id: "global", event_type: event, payload });
  }
}
