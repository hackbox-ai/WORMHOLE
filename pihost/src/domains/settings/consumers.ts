/**
 * F21 Set up consumer：
 * - traffic_capture / global_proxy / llm_pool / web_search Change → Rebuild agent Assembly
 *   （invalidateProfileAgents：Discard builds under old switch provider/Toolset → Next time run Rebuild）
 * - workers / task_concurrency → engine Read
 * - python_interpreter → Custom script tool interpreter
 * Every time the consumer takes effect, write business_events Audit（kind=settings, event=consumers_applied）。
 */
import type { Pool } from "pg";
import { appendEvent } from "../../events/ledger.ts";
import { SettingsService } from "./service.ts";

/** Engine concurrency parameter snapshot */
export interface EngineConcurrency {
  workers: number;
  taskConcurrencyEnabled: boolean;
  taskConcurrencyLimit: number;
  trafficCapture: boolean;
  globalProxy: string;
  pythonInterpreter: string;
}

export class SettingsConsumers {
  /** Cached concurrent snapshots——PUT Refresh after change (takes effect on tasks started later)） */
  private snapshot: EngineConcurrency | null = null;
  /** Rebuild counter - every time invalidate +1 */
  private rebuildCount = 0;

  constructor(
    private readonly pool: Pool,
    private readonly settings: SettingsService,
    private readonly dlqPath: string,
  ) {}

  /** Load on startup */
  async load(): Promise<EngineConcurrency> {
    const s = await this.settings.payload();
    this.snapshot = {
      workers: Number(s.workers) || 3,
      taskConcurrencyEnabled: s.task_concurrency_enabled === true,
      taskConcurrencyLimit: Number(s.task_concurrency_limit) || 5,
      trafficCapture: s.traffic_capture === true,
      globalProxy: String(s.global_proxy ?? ""),
      pythonInterpreter: String(s.python_interpreter ?? ""),
    };
    return this.snapshot;
  }

  get(): EngineConcurrency {
    if (!this.snapshot) throw new Error("SettingsConsumers is not loaded (call load first)");
    return this.snapshot;
  }

  getRebuildCount(): number {
    return this.rebuildCount;
  }

  /**
   * PUT settings Post call: Identify keys that require assembly rebuild，
   * Refresh concurrent snapshots and write audit events. Returns whether a rebuild was triggered。
   */
  async onSettingsChanged(changedFields: string[]): Promise<{ rebuilt: boolean; concurrency: EngineConcurrency }> {
    const REBUILD_KEYS = new Set([
      "traffic_capture", "agent_traffic_binding", "global_proxy",
      "web_search_enabled", "web_search_backend", "brave_search_api_key", "tavily_search_api_key", "web_search_proxy",
      "llm_pool_enabled", "llm_pool_bind_fallback",
    ]);
    const rebuilt = changedFields.some((k) => REBUILD_KEYS.has(k));
    const concurrency = await this.load();
    if (rebuilt) {
      this.rebuildCount += 1;
    }
    await appendEvent(this.pool, this.dlqPath, {
      business_kind: "settings", business_id: "global",
      event_type: "consumers_applied",
      payload: { rebuilt, rebuild_count: this.rebuildCount, changed_fields: changedFields, concurrency },
    });
    return { rebuilt, concurrency };
  }
}
