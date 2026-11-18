/**
 * F06 Tool execution read model + F20 Log + F07 LLM Recording/Dosage。
 * F06：tool_calls Paired reading model of ledger (input/Result/Error/Attribution) and Statistics。
 * F20：server_logs Near end/History/Write；SSE Multiplexing /api/logs/stream（Press seq cursor）。
 * F07：session Dosage → llm_usage（Always log）；llm_record Appendix original text when the switch is on llm_records。
 */
import type { Pool } from "pg";
import {expandRecordBodies,packLegacyBodies} from '../../storage/record-body.ts';

export class ObservabilityService {
  constructor(private readonly pool: Pool) {}

  // ── F06 ──
  async commands(filter: { tool?: string; kind?: string } = {}, limit = 100, offset = 0): Promise<Record<string, unknown>[]> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.tool) {
      args.push(filter.tool);
      where.push(`tool_key=$${args.length}`);
    }
    const r = await this.pool.query(
      `SELECT id, ts, business_kind, business_id, run_id, tool_key, params, result, is_error, error_text, approval_id
       FROM tool_calls WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    return r.rows;
  }

  async commandStats(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT tool_key, count(*)::int AS calls, count(*) FILTER (WHERE is_error)::int AS errors
       FROM tool_calls GROUP BY tool_key ORDER BY calls DESC`,
    );
    return r.rows;
  }

  // ── F20 ──
  async log(level: string, tag: string, text: string): Promise<void> {
    await this.pool.query("INSERT INTO server_logs (level, tag, text) VALUES ($1,$2,$3)", [level, tag, text]).catch(() => {});
  }

  async recentLogs(limit = 100): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query("SELECT seq, ts, level, tag, text FROM server_logs ORDER BY seq DESC LIMIT $1", [limit]);
    return r.rows.reverse();
  }

  async logHistory(cursor = 0, limit = 100): Promise<{ items: Record<string, unknown>[]; cursor: number }> {
    const r = await this.pool.query(
      "SELECT seq, ts, level, tag, text FROM server_logs WHERE seq > $1 ORDER BY seq ASC LIMIT $2",
      [cursor, limit],
    );
    const items = r.rows as Record<string, unknown>[];
    const last = items.at(-1) as { seq: number } | undefined;
    return { items, cursor: last ? last.seq : cursor };
  }

  // ── F07 ──
  /** F07：Call level record delegation（usage Hengji / bodies Gating, see implementation records.ts） */
  async recordCall(e: import("./records.ts").LlmCallEntry, recordingEnabled: boolean, businessKind: string): Promise<void> {
    const { LlmRecords } = await import("./records.ts");
    await new LlmRecords(this.pool).recordCall(e, recordingEnabled, businessKind);
  }

  async recordUsage(u: {
    model: string; profileId?: number | null; businessKind: string; businessId: string;
    input: number; output: number; cacheRead?: number; cacheWrite?: number;
    requestText?: string; responseText?: string; isError?: boolean; errorText?: string;
  }, recordingEnabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_usage (model, profile_id, business_kind, business_id, input_tokens, output_tokens, cache_read, cache_write)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [u.model, u.profileId ?? null, u.businessKind, u.businessId, u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0],
    );
    if (recordingEnabled) {
      let packed:Awaited<ReturnType<typeof packLegacyBodies>>|undefined;
      try{packed=await packLegacyBodies({request_text:u.requestText??'',response_text:u.responseText??'',request_body:null,response_body:null,raw_request:null,raw_response:null});}
      catch{console.warn('[storage] legacy recording packing failed; retaining original text');}
      await this.pool.query(
        `INSERT INTO llm_records (model, profile_id, business_kind, business_id, request_text, response_text, input_tokens, output_tokens, is_error, error_text,
          body_storage,body_codec,body_raw_bytes,body_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [u.model, u.profileId ?? null, u.businessKind, u.businessId,packed?'':u.requestText??'',packed?'':u.responseText??'', u.input, u.output, u.isError ?? false, (u.errorText ?? "").slice(0, 2000),
          packed?.bytes??null,packed?.codec??null,packed?.rawBytes??null,packed?.hash??null],
      );
    }
  }

  async llmRecords(limit = 100, model?: string): Promise<Record<string, unknown>[]> {
    const r = model
      ? await this.pool.query("SELECT id, ts, model, business_kind, business_id, input_tokens, output_tokens, is_error FROM llm_records WHERE model=$1 ORDER BY id DESC LIMIT $2", [model, limit])
      : await this.pool.query("SELECT id, ts, model, business_kind, business_id, input_tokens, output_tokens, is_error FROM llm_records ORDER BY id DESC LIMIT $1", [limit]);
    return r.rows;
  }

  async llmRecordDetail(id: number): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query("SELECT * FROM llm_records WHERE id=$1", [id]);
    return r.rows[0] ? await expandRecordBodies(r.rows[0]) : null;
  }

  async usageByModel(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT model, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
       FROM llm_usage GROUP BY model ORDER BY input_tokens DESC`,
    );
    return r.rows;
  }

  async usageSummary(): Promise<Record<string, unknown>> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS calls, COALESCE(sum(input_tokens),0)::int AS input_tokens, COALESCE(sum(output_tokens),0)::int AS output_tokens FROM llm_usage`,
    );
    return r.rows[0] ?? {};
  }

  async usageDaily(days = 14): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT date_trunc('day', ts)::date AS date, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens, sum(cache_read)::int AS cache_read_tokens, sum(cache_write)::int AS cache_write_tokens
       FROM llm_usage WHERE ts > now() - make_interval(days => $1::int) GROUP BY 1 ORDER BY 1`,
      [days],
    );
    return r.rows;
  }

  async usageByConversation(): Promise<Record<string, unknown>[]> {
    // WORMHOLE ConvTokenSummary：One line per session（result Sum of usage，0=No completed wheel yet) for dashboard Press image/Aggregation by day。
    const r = await this.pool.query(
      `SELECT c.llm_profile_id, c.created_at::text AS created_at,
              COALESCE(sum(ca.input_tokens),0)::int AS input_tokens,
              COALESCE(sum(ca.output_tokens),0)::int AS output_tokens,
              COALESCE(sum(ca.cache_read_tokens),0)::int AS cache_read_tokens,
              COALESCE(sum(ca.cache_write_tokens),0)::int AS cache_write_tokens
       FROM conversations c
       LEFT JOIN conversation_activities ca ON ca.conversation_id = c.id AND ca.kind = 'result'
       GROUP BY c.id, c.llm_profile_id, c.created_at
       ORDER BY c.id`,
    );
    return r.rows.map(row=>({...row,llm_profile_id:row.llm_profile_id==null?null:Number(row.llm_profile_id)}));
  }
}
