/**
 * F08 Asset + F18 Asset interception - platform behavior（0016 Close up and see B03-table-mapping.md）。
 * Asset deduplication：per-type Key column，
 * The remaining types are not deduplicated. Generic internal column value Bidirectional synchronization with type columns；task_ids The array is WORMHOLE Belong。
 * Gate semantics unchanged: global block > Task block > Task allow；agent Entrance gate。
 */
import { isIP } from "node:net";
import {assetRuleMatches as ruleMatches,assetRuleReason} from "./asset-match.ts";
import type { Pool } from "pg";
import { appendEvent } from "../../events/ledger.ts";
import { SourceAssetWrites, type SourceAssetInput } from './source-writes.ts';

export interface AssetInput {
  type: string;
  value: string;
  company_id?: number | null;
  task_id?: number | null;
  source?: string;
  remark?: string;
  attrs?: Record<string, unknown>;
}

/** type → Deduplicate key columns；undefined=Do not remove duplicates */
function dedupColumn(type: string): "domain" | "ip" | "url" | undefined {
  if (type === "root_domain" || type === "domain") return "domain";
  if (type === "ip") return "ip";
  if (type === "url") return "url";
  return undefined;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  ruleSource: "global-block" | "task-block" | "task-allow" | "default";
}

export class AssetsService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
  ) {}

  // ── F18 Gate ──
  async evaluateGate(type: string, value: string, taskId?: number | null): Promise<GateResult> {
    return this.evaluateCandidates([[type,value]],taskId);
  }
  private async gateRules(taskId?:number|null){
    const global=(await this.pool.query("SELECT * FROM asset_intercept_rules WHERE enabled=TRUE ORDER BY builtin DESC,id DESC")).rows;
    const task=taskId?(await this.pool.query("SELECT * FROM task_intercept_rules WHERE task_id=$1 AND enabled=TRUE ORDER BY action,id",[taskId])).rows:[];
    const normalize=(r:Record<string,any>)=>({...r,kind:r.kind||r.scope_kind,pattern:r.pattern||r.value,action:r.action,note:r.note??"",enabled:true});
    return {global:global.map(normalize),task:task.map(normalize)};
  }
  private decideCandidates(candidates:[string,string][],rules:Awaited<ReturnType<AssetsService['gateRules']>>):GateResult{
    const matches=(r:typeof rules.global[number])=>candidates.some(([t,v])=>ruleMatches(r.kind,r.pattern,t,v));
    const global=rules.global.find(matches);if(global)return {allowed:false,reason:assetRuleReason(global),ruleSource:'global-block'};
    const block=rules.task.find(r=>r.action!=='allow'&&matches(r));if(block)return {allowed:false,reason:assetRuleReason(block),ruleSource:'task-block'};
    if(rules.task.some(r=>r.action==='allow'&&matches(r)))return {allowed:true,reason:'',ruleSource:'task-allow'};
    if(rules.task.some(r=>r.action==='allow'))return {allowed:false,reason:"Not within the task permission (whitelist) range, testing is not allowed",ruleSource:'task-allow'};
    return {allowed:true,reason:'',ruleSource:'default'};
  }
  async evaluateCandidates(candidates:[string,string][],taskId?:number|null):Promise<GateResult>{
    try{return this.decideCandidates(candidates,await this.gateRules(taskId));}
    catch(error){console.error("[asset-gate] Rule reading failed, skipping judgment (fail-open, compare to WORMHOLE):",error);return {allowed:true,reason:'rule-read-failed(fail-open)',ruleSource:'default'};}
  }
  /** Original add_intent gate is stricter than insert_assets: read failures
   * reject scheduling; globally load assets so task scope cannot hide a block. */
  async checkAssetIds(taskId:number,ids:number[]):Promise<{asset_id:number;reason:string;description:string}[]>{
    if(!ids.length)return [];
    const rules=await this.gateRules(taskId);if(!rules.global.length&&!rules.task.some(r=>r.action==='allow'||r.action==='block'))return [];
    const rows=(await this.pool.query('SELECT * FROM assets WHERE id=ANY($1::bigint[]) ORDER BY last_seen DESC',[ids])).rows,hits=[];
    for(const row of rows){const candidates:[string,string][]=[];
      const add=(t:string,v:unknown)=>{if(typeof v==='string'&&v.trim())candidates.push([t,v]);};
      add('domain',row.domain);add('domain',row.root_domain);for(const d of row.bound_domains??[])add('domain',d);add('ip',row.ip);add('url',row.url);
      if(row.url)try{const host=new URL(row.url.startsWith('//')?'http:'+row.url:row.url).hostname.replace(/^\[|\]$/g,'');add(isIP(host)?'ip':'domain',host);}catch{}
      const decision=this.decideCandidates(candidates,rules);if(!decision.allowed){const label="Asset#"+row.id+'['+row.type+'] '+(row.domain||row.url||row.ip||'#'+row.id);hits.push({asset_id:Number(row.id),reason:decision.reason,description:label+' → '+decision.reason});}
    }
    return hits;
  }

  async listRules(): Promise<Record<string, unknown>[]> {
    const rows = (await this.pool.query("SELECT * FROM asset_intercept_rules ORDER BY id DESC")).rows as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), enabled: r.enabled, kind: r.kind || r.scope_kind, pattern: r.pattern || r.value, note: r.note ?? "", builtin: r.builtin ?? false, created_at: r.created_at, updated_at: r.updated_at ?? r.created_at }));
  }

  /** WORMHOLE assetRuleReq：kind/pattern/action（kind Enumeration exact_domain/exact_url/fuzzy_domain/fuzzy_ip/fuzzy_url/exact_ip/exact_cidr） */
  async createRule(input: Record<string, unknown>): Promise<{ ok: boolean; status: number; rule?: Record<string, unknown>; error?: string }> {
    const pattern = String(input.pattern ?? "").trim();
    const kind = String(input.kind ?? input.scope_kind ?? "").trim();
    const action = String(input.action ?? "block");
    if (!pattern) return { ok: false, status: 400, error: "pattern cannot be empty" };
    const scopeKind = kind; // Old fields compatible
    if (!["domain", "ip", "cidr", "url", "exact_domain", "exact_url", "fuzzy_domain", "fuzzy_ip", "fuzzy_url", "exact_ip", "exact_cidr"].includes(scopeKind)) return { ok: false, status: 400, error: "kind illegal" };
    if (!["block", "allow"].includes(action)) return { ok: false, status: 400, error: "action must be block|allow" };
    const r = await this.pool.query(
      "INSERT INTO asset_intercept_rules (scope_kind, value, kind, pattern, action, remark, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [scopeKind, pattern, kind, pattern, action, String(input.remark ?? input.message ?? ""), input.enabled ?? false],
    );
    await this.audit("asset_rule_created", { id: r.rows[0]!.id });
    return { ok: true, status: 200, rule: r.rows[0] };
  }

  async removeRule(id: number): Promise<boolean> {
    return ((await this.pool.query("DELETE FROM asset_intercept_rules WHERE id=$1", [id])).rowCount ?? 0) > 0;
  }

  async taskRules(taskId: number): Promise<Record<string, unknown>[]> {
    return (await this.pool.query("SELECT * FROM task_intercept_rules WHERE task_id=$1 ORDER BY id", [taskId])).rows;
  }

  async addTaskRule(taskId: number, input: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      await this.pool.query(
        "INSERT INTO task_intercept_rules (task_id, scope_kind, value, action) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [taskId, String(input.scope_kind ?? "domain"), String(input.value ?? ""), String(input.action ?? "block")],
      );
      return { ok: true, status: 200 };
    } catch (err) {
      return { ok: false, status: 400, error: String(err) };
    }
  }

  // ── F08 Asset ──
  /** Source typed writes, including its eight natural keys and derived assets. */
  async upsertSource(input:SourceAssetInput, opts:{viaAgent?:boolean;endpointTool?:boolean}={}):Promise<{ok:boolean;status:number;asset?:Record<string,unknown>;insertedNew?:boolean;error?:string}>{
    if(opts.viaAgent){
      // Gate every supplied domain/IP/URL before any derived host is inserted.
      const candidates:[string,string][]=[];
      if(input.domain)candidates.push(['domain',input.domain]);
      for(const domain of input.bound_domains??[])candidates.push(['domain',domain]);
      if(input.ip)candidates.push(['ip',input.ip]);if(input.service_ip)candidates.push(['ip',input.service_ip]);
      if(input.url){candidates.push(['url',input.url]);try{const host=new URL(input.url).hostname.replace(/^\[|\]$/g,'');candidates.push([isIP(host)?'ip':'domain',host]);}catch{}}
      const result=await this.evaluateCandidates(candidates,input.task_id);if(!result.allowed){await this.audit('agent_insert_blocked',{candidates,reason:result.reason});return {ok:false,status:403,error:result.reason};}
    }
    // The original endpoint tool gates plain ip, but only service_ip enriches
    // its write. Do not discard ip until after the gate has evaluated it.
    const writeInput=opts.endpointTool&&input.type==='endpoint'?{...input,ip:undefined}:input;
    try{const result=await new SourceAssetWrites(this.pool).upsert(writeInput);return {ok:true,status:200,...result};}
    catch(error){return {ok:false,status:400,error:error instanceof Error?error.message:String(error)};}
  }
  /** Idempotent Upsert：per-type Key column deduplication；agent Source gate */
  async upsert(input: AssetInput, opts: { viaAgent?: boolean } = {}): Promise<{ ok: boolean; status: number; asset?: Record<string, unknown>; insertedNew?: boolean; error?: string }> {
    const value = input.value.trim();
    const type = input.type.trim().toLowerCase();
    if (!value || !type) return { ok: false, status: 400, error: "type/value cannot be empty" };
    if (opts.viaAgent) {
      const gate = await this.evaluateGate(type, value, input.task_id ?? null);
      if (!gate.allowed) {
        await this.audit("agent_insert_blocked", { type, value, reason: gate.reason });
        return { ok: false, status: 403, error: gate.reason };
      }
    }
    const keyCol = dedupColumn(type);
    const taskIds = input.task_id ? [input.task_id] : [];
    // Type Column and Internal value Synchronization
    const typeCols: Record<string, unknown> = { value };
    if (keyCol) typeCols[keyCol] = value;

    const cols = ["type", "company_id", "task_id", "source", "remark", "attrs", "task_ids", ...Object.keys(typeCols)];
    const vals: unknown[] = [type, input.company_id ?? null, input.task_id ?? null, input.source ?? "manual", input.remark ?? "", JSON.stringify(input.attrs ?? {}), taskIds, ...Object.keys(typeCols).map((k) => typeCols[k])];
    const ph = cols.map((_, i) => `$${i + 1}`).join(",");
    try {
      const r = await this.pool.query(`INSERT INTO assets (${cols.join(",")}) VALUES (${ph}) RETURNING *`, vals);
      return { ok: true, status: 200, asset: r.rows[0], insertedNew: true };
    } catch (err) {
      if (!/duplicate key|unique constraint/i.test(String(err))) throw err;
      if (!keyCol) throw err; // Unique conflicts of non-deduplication type should not occur
      const cur = await this.pool.query(`SELECT id FROM assets WHERE type=$1 AND ${keyCol}=$2`, [type, value]);
      if ((cur.rowCount ?? 0) === 0) throw err;
      const id = (cur.rows[0] as { id: number }).id;
      await this.pool.query(
        `UPDATE assets SET company_id=COALESCE($2, company_id), remark=CASE WHEN $5::text='' THEN assets.remark ELSE $5::text END, task_ids = (SELECT ARRAY(SELECT DISTINCT unnest(task_ids || $3::bigint[]))), attrs=assets.attrs || $4::jsonb, updated_at=now() WHERE id=$1`,
        [id, input.company_id ?? null, taskIds, JSON.stringify(input.attrs ?? {}), input.remark ?? ""],
      );
      const after = await this.pool.query("SELECT * FROM assets WHERE id=$1", [id]);
      return { ok: true, status: 200, asset: after.rows[0], insertedNew: false };
    }
  }

  async batchUpsert(inputs: AssetInput[], opts: { viaAgent?: boolean } = {}): Promise<{ inserted: number; blocked: number; errors: string[] }> {
    let inserted = 0;
    let blocked = 0;
    const errors: string[] = [];
    for (const a of inputs) {
      const r = await this.upsert(a, opts);
      if (r.ok && r.insertedNew !== false) inserted++;
      else if (r.status === 403) blocked++;
      else if (!r.ok) errors.push(r.error ?? "Unknown error");
    }
    return { inserted, blocked, errors };
  }

  async list(filter: { type?: string; company?: number; q?: string } = {}, limit = 200): Promise<Record<string, unknown>[]> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.type) { args.push(filter.type); where.push(`type=$${args.length}`); }
    if (filter.company) { args.push(filter.company); where.push(`company_id=$${args.length}`); }
    if (filter.q) { args.push(`%${filter.q}%`); where.push(`(value ILIKE $${args.length} OR domain ILIKE $${args.length} OR ip ILIKE $${args.length} OR url ILIKE $${args.length})`); }
    args.push(limit);
    const r = await this.pool.query(
      `SELECT a.*, c.name AS company_name FROM assets a LEFT JOIN companies c ON c.id=a.company_id
       WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT $${args.length}`,
      args,
    );
    return r.rows;
  }

  async counts(): Promise<Record<string, number>> {
    const r = await this.pool.query("SELECT type, count(*)::int AS n FROM assets GROUP BY type");
    return Object.fromEntries(r.rows.map((x) => [(x as { type: string }).type, (x as { n: number }).n]));
  }

  async remove(id: number): Promise<boolean> {
    return ((await this.pool.query("DELETE FROM assets WHERE id=$1", [id])).rowCount ?? 0) > 0;
  }

  // ── Enterprise ──
  async listCompanies(): Promise<Record<string, unknown>[]> {
    return (await this.pool.query("SELECT c.*, (SELECT count(*)::int FROM assets a WHERE a.company_id=c.id) AS assets FROM companies c ORDER BY c.id")).rows;
  }

  async createCompany(name: string, description = "", scopes: string[] = []): Promise<{ ok: boolean; status: number; company?: Record<string, unknown>; error?: string }> {
    if (!name.trim()) return { ok: false, status: 400, error: "Company name cannot be empty" };
    const r = await this.pool.query(
      "INSERT INTO companies (name, description, nkey) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description RETURNING *",
      [name.trim(), description, name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")],
    );
    for (const s of scopes) {
      await this.pool.query("INSERT INTO company_scope (company_id, scope) VALUES ($1,$2) ON CONFLICT DO NOTHING", [r.rows[0]!.id, s.trim()]);
    }
    return { ok: true, status: 200, company: r.rows[0] };
  }

  async removeCompany(id: number): Promise<boolean> {
    return ((await this.pool.query("DELETE FROM companies WHERE id=$1", [id])).rowCount ?? 0) > 0;
  }

  async linkTask(taskId: number, assetId: number): Promise<void> {
    await this.pool.query("INSERT INTO task_assets (task_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [taskId, assetId]);
  }

  async taskAssets(taskId: number): Promise<Record<string, unknown>[]> {
    return (await this.pool.query(
      "SELECT a.*, ta.rel FROM task_assets ta JOIN assets a ON a.id=ta.asset_id WHERE ta.task_id=$1 ORDER BY a.id",
      [taskId],
    )).rows;
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "assets", business_id: "global", event_type: event, payload });
  }
}
