import {networkBinding} from '../network/binding.ts';
/**
 * F21 System configuration reading, pointer semantic update and consumer coordination。
 * GET：21 Field aggregation (key only returns *_set Boolean, the original text is not echoed）。
 * PUT：Pointer semantics（null=Do not change, string ""=Clear, key ""=Clear）；
 *      Write each change business_events Audit（event_type=settings_changed）。
 * Effective time: This slice falls first KV + Audit; Consumer side of each switch（engine/agent Assembly) comes with F03/F11 Access
 * ——Applied at runtime by configuration consumer。
 */
import type { Pool } from "pg";
import type {EfficiencyOptions} from '../tasks/efficiency.ts';
import {readEfficiencyOptions,validateEfficiencyPatch,EFFICIENCY_KEY} from '../tasks/efficiency-settings.ts';
import {validateGlobalProxy} from '../traffic/network.ts';
import { existsSync } from "node:fs";
import { appendEvent } from "../../events/ledger.ts";

type Def =
  | { kind: "bool"; key: string; def: boolean }
  | { kind: "str"; key: string; def: string }
  | { kind: "int"; key: string; def: number; min: number };

const K = {
  trafficCapture: "settings.traffic_capture",
  agentTrafficBinding: "settings.agent_traffic_binding",
  llmRecord: "settings.llm_record",
  webSearchEnabled: "settings.web_search_enabled",
  webSearchBackend: "settings.web_search_backend",
  webSearchProxy: "settings.web_search_proxy",
  globalProxy: "settings.global_proxy",
  pythonInterpreter: "settings.python_interpreter",
  workers: "settings.workers",
  taskConcEnabled: "settings.task_concurrency_enabled",
  taskConcLimit: "settings.task_concurrency_limit",
  llmPoolEnabled: "settings.llm_pool_enabled",
  llmPoolBindFallback: "settings.llm_pool_bind_fallback",
  constraintsPlanner: "settings.constraints_inject_planner",
  constraintsWorker: "settings.constraints_inject_worker",
  noaCompaction: "settings.noa_compaction",
  notifyEnabled: "settings.notify_enabled",
  notifyBaseURL: "settings.notify_public_base_url",
  notifyDigestMin: "settings.notify_digest_interval_min",
  braveKey: "secret.brave_search_api_key",
  tavilyKey: "secret.tavily_search_api_key",
};

/** GET Field definition (the default value is echoed against the baseline empty library, see contracts/run/settings-baseline.json） */
const DEFS: Record<string, Def> = {
  network_mode:{kind:'str',key:'settings.network_mode',def:'standard'},
  network_channel_id:{kind:'int',key:'settings.network_channel_id',def:0,min:0},
  traffic_capture: { kind: "bool", key: K.trafficCapture, def: false },
  agent_traffic_binding: { kind: "bool", key: K.agentTrafficBinding, def: false },
  llm_record: { kind: "bool", key: K.llmRecord, def: false },
  web_search_enabled: { kind: "bool", key: K.webSearchEnabled, def: false },
  web_search_backend: { kind: "str", key: K.webSearchBackend, def: "ddgs" },
  web_search_proxy: { kind: "str", key: K.webSearchProxy, def: "" },
  global_proxy: { kind: "str", key: K.globalProxy, def: "" },
  python_interpreter: { kind: "str", key: K.pythonInterpreter, def: "" },
  workers: { kind: "int", key: K.workers, def: 3, min: 1 },
  task_concurrency_enabled: { kind: "bool", key: K.taskConcEnabled, def: false },
  task_concurrency_limit: { kind: "int", key: K.taskConcLimit, def: 3, min: 1 },
  batch_task_timeout_seconds:{kind:'int',key:'settings.batch_task_timeout_seconds',def:1800,min:60},
  llm_pool_enabled: { kind: "bool", key: K.llmPoolEnabled, def: false },
  llm_pool_bind_fallback: { kind: "bool", key: K.llmPoolBindFallback, def: false },
  constraints_inject_planner: { kind: "bool", key: K.constraintsPlanner, def: true },
  constraints_inject_worker: { kind: "bool", key: K.constraintsWorker, def: true },
  noa_compaction: { kind: "bool", key: K.noaCompaction, def: false },
  notify_enabled: { kind: "bool", key: K.notifyEnabled, def: true },
  notify_public_base_url: { kind: "str", key: K.notifyBaseURL, def: "" },
  notify_digest_interval_min: { kind: "int", key: K.notifyDigestMin, def: 30, min: 1 },
};

export class SettingsService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    private readonly efficiencyFallback?: Partial<EfficiencyOptions>,
  ) {}

  private async rawGet(key: string): Promise<string | null> {
    const r = await this.pool.query("SELECT value FROM app_settings WHERE key=$1", [key]);
    return r.rows[0] ? String(r.rows[0].value) : null;
  }

  private async rawSet(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
      [key, value],
    );
  }

  async payload(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [field, def] of Object.entries(DEFS)) {
      const v = await this.rawGet(def.key);
      if (def.kind === "bool") out[field] = v === null ? def.def : v === "true";
      else if (def.kind === "str") out[field] = v ?? def.def;
      else out[field] = v === null ? def.def : Math.max(def.min, Number(v) || def.def);
    }
    out.task_concurrency_limit=Math.min(3,Number(out.task_concurrency_limit));
    out.brave_key_set = ((await this.rawGet(K.braveKey)) ?? "").trim() !== "";
    out.tavily_key_set = ((await this.rawGet(K.tavilyKey)) ?? "").trim() !== "";
    // python_interpreter：When not set, echo the runtime auto-detection value (against the baseline custom-tool Automatic detection）
    const pyStored = await this.rawGet(K.pythonInterpreter);
    out.python_interpreter = pyStored ?? (existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "");
    out.task_efficiency = await readEfficiencyOptions(this.pool,this.efficiencyFallback);
    return out;
  }

  /** Apply changes; return {applied} or {status,error}。changed Only fields with actual changes (same value PUT No event will be sent if no writing is done）。 */
  async apply(patch: Record<string, unknown>): Promise<{ ok: true; changed: string[] } | { ok: false; status: number; error: string }> {
    const hasNetworkPatch=patch.network_mode!=null||patch.network_channel_id!=null;
    if(patch.network_channel_id!=null&&(!Number.isSafeInteger(patch.network_channel_id)||Number(patch.network_channel_id)<0))return {ok:false,status:400,error:"Invalid channel number"};
    if(patch.task_efficiency!=null){const error=validateEfficiencyPatch(patch.task_efficiency);if(error)return {ok:false,status:400,error};}
    if(patch.global_proxy!=null){if(typeof patch.global_proxy!=='string')return{ok:false,status:400,error:'invalid body'};
      const error=validateGlobalProxy(patch.global_proxy);if(error)return{ok:false,status:400,error};}
    const changed: string[] = [];
    if(hasNetworkPatch){
      const c=await this.pool.connect();
      try{
        await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('wormhole-network-defaults'))");
        const rows=(await c.query("SELECT key,value FROM app_settings WHERE key IN ('settings.network_mode','settings.network_channel_id')")).rows;
        const before=Object.fromEntries(rows.map(r=>[r.key,r.value]));
        const mode=patch.network_mode??before['settings.network_mode']??'standard';
        const channel=patch.network_channel_id??Number(before['settings.network_channel_id']??0);
        await networkBinding(c,{network_mode:mode,network_channel_id:channel});
        for(const [field,value]of [['network_mode',String(mode)],['network_channel_id',String(channel)]]){
          const key='settings.'+field;
          if((before[key]??(field==='network_mode'?'standard':'0'))!==value){
            await c.query('INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[key,value]);changed.push(field!);
          }
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');return {ok:false,status:400,error:(e as Error).message};}
      finally{c.release();}
    }
    const set = async (field: string, key: string, value: string) => {
      const cur = await this.rawGet(key);
      // If the effective value remains unchanged, it will not be written (not stored in the library) + PUT Default value Treat as unchanged）
      const def = DEFS[field];
      const defStr =
        def === undefined
          ? undefined
          : def.kind === "bool"
            ? def.def
              ? "true"
              : "false"
            : def.kind === "int"
              ? String(def.def)
              : def.def;
      const effective = cur ?? defStr;
      if (effective === value) return; // Idempotent with the same value: no library writing, no auditing
      await this.rawSet(key, value);
      changed.push(field);
    };
    for (const [field, v] of Object.entries(patch)) {
      if (v === null || v === undefined || field==='network_mode' || field==='network_channel_id') continue;
      switch (field) {
        case "task_efficiency": {
          const current=await readEfficiencyOptions(this.pool,this.efficiencyFallback);
          const next={...current,...v as Partial<EfficiencyOptions>};
          if(JSON.stringify(current)!==JSON.stringify(next))await set(field,EFFICIENCY_KEY,JSON.stringify(next));
          break;
        }
        case "brave_search_api_key":
        case "tavily_search_api_key": {
          const key = field === "brave_search_api_key" ? K.braveKey : K.tavilyKey;
          await set(field, key, String(v).trim());
          break;
        }
        case "notify_public_base_url": {
          const base = String(v).trim().replace(/\/+$/, "");
          if (base !== "" && !/^https?:\/\//.test(base)) {
            return { ok: false, status: 400, error: "The return link address must start with http:// or https://" };
          }
          await set(field, K.notifyBaseURL, base);
          break;
        }
        case "network_mode":
        case "web_search_proxy":
        case "global_proxy":
        case "python_interpreter":
        case "web_search_backend":
          await set(field, DEFS[field]!.key, String(v).trim());
          break;
        case "network_channel_id":
        case "workers":
        case "batch_task_timeout_seconds":
        case "task_concurrency_limit":
        case "notify_digest_interval_min": {
          const def = DEFS[field] as { kind: "int"; key: string; min: number };
          const n = Number(v);
          if(field==='batch_task_timeout_seconds'&&n>86400)return {ok:false,status:400,error:"Batch task timeout up to 1440 minutes"};
          if(field==='task_concurrency_limit'&&n>3)return {ok:false,status:400,error:"Maximum of 3 tasks concurrently"};
          if (!Number.isInteger(n) || n < def.min) {
            return { ok: false, status: 400, error: `${field} Required to be >= ${def.min} is an integer` };
          }
          await set(field, def.key, String(n));
          break;
        }
        default: {
          const def = DEFS[field];
          if (!def || def.kind !== "bool") return { ok: false, status: 400, error: `Unknown setting item ${field}` };
          if (typeof v !== "boolean") return { ok: false, status: 400, error: `${field} Expected Boolean` };
          await set(field, def.key, v ? "true" : "false");
        }
      }
    }
    if (changed.length > 0) {
      await appendEvent(this.pool, this.dlqPath, {
        business_kind: "settings",
        business_id: "global",
        event_type: "settings_changed",
        payload: { changed_fields: changed },
      });
    }
    return { ok: true, changed };
  }
}
