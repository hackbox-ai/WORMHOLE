/**
 * F02 Bypass question storage layer。
 * Semantic Points：
 * - SaveSideSnapshot Lock parent row (session/Task/Intent exists and has not been deleted or archived) post-condition upsert（Updated only run/version）。
 * - StartSideRequest Within transaction: lock parent → Read generation FOR UPDATE → Same as (key,generation,client) Idempotent
 *   （Same question returns to the old row, different question 409 Copywriting）→ Occupancy check during operation（ErrSideBusy）→ Insert running OK。
 * - UpdateSideRequest Condition update (only running、sequence monotonous、generation still matches) - late callback and
 *   Delete/Cannot be revived after clearing。
 * - ClearSideHistory：generation+1、memory Reset, delete request。
 * - InterruptSideRequests：Start recovery running → interrupted。
 */
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export interface SideParent {
  conversationId?: number;
  taskId?: number;
  explorationId?: number;
  intentId?: number;
}
export interface SideModel {
  profile_id: number;
  name: string;
  format: string;
  model: string;
  identity: string;
  streaming: boolean;
  window_tokens: number;
}
/** Snapshot: The complete context of the most recent model call in the main session（Pi Context of JSON Projection + Tool List）。 */
export interface SideSnapshot {
  parent: SideParent;
  run_id: number;
  version: number;
  captured_at: string;
  model: SideModel;
  request: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] };
}
export interface SideUsage {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
}
export interface SideContextInfo {
  phase?: string;
  recent_exchanges: number;
  history_summarized: boolean;
  snapshot_summarized: boolean;
  estimated_input_tokens?: number;
  input_budget?: number;
  output_tokens?: number;
  overflow_retried?: boolean;
}
export interface SideMemory {
  history?: string;
  through?: number;
  snapshot_key?: string;
  snapshot_summary?: string;
  tail_start?: number;
}
export interface SideExchange {
  id: string;
  client_request_id: string;
  question: string;
  answer: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error?: string;
  model: SideModel;
  snapshot_at: string;
  created_at: string;
  sequence: number;
  usage: SideUsage;
  ordinal: number;
  context: SideContextInfo;
  sessionKey: string;
  generation: number;
}

export const ERR_SIDE_BUSY = "There are already bypass questions being answered in the current session.";
export const ERR_SIDE_PARENT_GONE = "Bypass parent session deleted or archived";

export function parentKey(p: SideParent): string {
  if (p.conversationId) return `conv-${p.conversationId}`;
  if (p.intentId) return `task-${p.taskId}-exp-${p.explorationId}-worker-i${p.intentId}`;
  return `task-${p.taskId}-exp-${p.explorationId}-main`;
}

const COLS = "id,ordinal,session_key,generation,client_id,question,answer,status,error,model,snapshot_at,created_at,sequence,usage,context_info";
type Row = Record<string, unknown>;
function dto(r: Row): SideExchange {
  return {
    id: String(r.id),
    ordinal: Number(r.ordinal),
    sessionKey: String(r.session_key),
    generation: Number(r.generation),
    client_request_id: String(r.client_id),
    question: String(r.question),
    answer: String(r.answer),
    status: r.status as SideExchange["status"],
    ...(r.error ? { error: String(r.error) } : {}),
    model: r.model as SideModel,
    snapshot_at: r.snapshot_at instanceof Date ? r.snapshot_at.toISOString() : String(r.snapshot_at),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    sequence: Number(r.sequence),
    usage: {
      input_tokens: Number((r.usage as Row)?.input_tokens ?? 0),
      output_tokens: Number((r.usage as Row)?.output_tokens ?? 0),
      cache_read_tokens: Number((r.usage as Row)?.cache_read_tokens ?? 0),
      cache_write_tokens: Number((r.usage as Row)?.cache_write_tokens ?? 0),
    },
    context: (r.context_info ?? {}) as SideContextInfo,
  };
}
const client = async (pool: Pool, fn: () => Promise<unknown>) => { /* pg Pool Connection i.e. transaction boundaries are determined by the caller BEGIN/COMMIT */ };

/** Lock father line（FOR SHARE），Overwrite soft delete/Archive/Intent to stop; does not exist → ERR_SIDE_PARENT_Gone。 */
type Querier = Pool | PoolClient;
async function lockParent(pool: Querier, p: SideParent): Promise<void> {
  if (p.conversationId) {
    const r = await pool.query("SELECT id FROM conversations WHERE id=$1 FOR SHARE", [p.conversationId]);
    if ((r.rowCount ?? 0) === 0) throw new Error(ERR_SIDE_PARENT_GONE);
    return;
  }
  const t = await pool.query("SELECT id FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR SHARE", [p.taskId, p.explorationId]);
  if ((t.rowCount ?? 0) === 0) throw new Error(ERR_SIDE_PARENT_GONE);
  if (p.intentId) {
    const n = await pool.query("SELECT id FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent' AND state<>'stopped' FOR SHARE", [p.intentId, p.explorationId]);
    if ((n.rowCount ?? 0) === 0) throw new Error(ERR_SIDE_PARENT_GONE);
  }
}
const nullable = (v?: number) => (v ? v : null);

export class SideStore {
  constructor(readonly pool: Pool) {}

  async saveSnapshot(s: SideSnapshot): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await lockParent(c, s.parent);
      await c.query(
        `INSERT INTO side_question_sessions(session_key,conversation_id,task_id,exploration_id,intent_id,run_id,version,snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_key) DO UPDATE SET run_id=EXCLUDED.run_id,version=EXCLUDED.version,snapshot=EXCLUDED.snapshot
         WHERE (side_question_sessions.run_id,side_question_sessions.version)<(EXCLUDED.run_id,EXCLUDED.version)`,
        [parentKey(s.parent), nullable(s.parent.conversationId), nullable(s.parent.taskId), nullable(s.parent.explorationId), nullable(s.parent.intentId), s.run_id, s.version, JSON.stringify(s)],
      );
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }

  async snapshot(key: string): Promise<SideSnapshot | null> {
    const r = await this.pool.query("SELECT snapshot FROM side_question_sessions WHERE session_key=$1", [key]);
    return r.rows[0] ? (r.rows[0].snapshot as SideSnapshot) : null;
  }

  async existingRequest(key: string, clientId: string): Promise<SideExchange | null> {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM side_question_requests WHERE session_key=$1 AND client_id=$2 AND generation=(SELECT generation FROM side_question_sessions WHERE session_key=$1)`,
      [key, clientId],
    );
    return r.rows[0] ? dto(r.rows[0]) : null;
  }

  async request(id: string): Promise<SideExchange | null> {
    const r = await this.pool.query(`SELECT ${COLS} FROM side_question_requests WHERE id=$1`, [id]);
    return r.rows[0] ? dto(r.rows[0]) : null;
  }

  async currentRequest(key: string): Promise<SideExchange | null> {
    const r = await this.pool.query(`SELECT ${COLS} FROM side_question_requests WHERE session_key=$1 AND status='running'`, [key]);
    return r.rows[0] ? dto(r.rows[0]) : null;
  }

  async history(key: string, before: number, limit: number): Promise<SideExchange[]> {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM side_question_requests WHERE session_key=$1 AND ($2::bigint=0 OR ordinal<$2) ORDER BY ordinal DESC LIMIT $3`,
      [key, before, limit],
    );
    return r.rows.map(dto);
  }

  /** Transaction: Lock parent → generation FOR UPDATE → Idempotent/Busy check → Insert running；Back (OK, Whether to create a new)。 */
  async startRequest(s: SideSnapshot, clientId: string, question: string): Promise<{ e: SideExchange; created: boolean }> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await lockParent(c, s.parent);
      const key = parentKey(s.parent);
      const g = await c.query("SELECT generation FROM side_question_sessions WHERE session_key=$1 FOR UPDATE", [key]);
      const generation = Number(g.rows[0].generation);
      const prior = await c.query(`SELECT ${COLS} FROM side_question_requests WHERE session_key=$1 AND generation=$2 AND client_id=$3`, [key, generation, clientId]);
      if (prior.rows[0]) {
        const e = dto(prior.rows[0]);
        if (e.question !== question) throw new Error("The same request ID cannot be used for different issues");
        await c.query("COMMIT");
        return { e, created: false };
      }
      const busy = await c.query("SELECT EXISTS(SELECT 1 FROM side_question_requests WHERE session_key=$1 AND status='running') AS b", [key]);
      if (busy.rows[0].b) throw new Error(ERR_SIDE_BUSY);
      const ins = await c.query(
        `INSERT INTO side_question_requests(id,session_key,generation,client_id,question,status,model,snapshot_at) VALUES ($1,$2,$3,$4,$5,'running',$6,$7) RETURNING ${COLS}`,
        [randomUUID(), key, generation, clientId, question, JSON.stringify(s.model), s.captured_at],
      );
      const e = dto(ins.rows[0]);
      await c.query("COMMIT");
      return { e, created: true };
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }

  /** Condition update: only running、sequence Strictly incremental、generation Match。 */
  async updateRequest(e: SideExchange): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE side_question_requests r SET answer=$2,status=$3,error=$4,sequence=$5,usage=$6,context_info=$7
       WHERE r.id=$1 AND r.status='running' AND r.sequence<$5
         AND EXISTS(SELECT 1 FROM side_question_sessions s WHERE s.session_key=r.session_key AND s.generation=r.generation)`,
      [e.id, e.answer, e.status, e.error ?? "", e.sequence, JSON.stringify(e.usage), JSON.stringify(e.context)],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async clearHistory(key: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE side_question_sessions SET generation=generation+1,memory='{}' WHERE session_key=$1", [key]);
      await c.query("DELETE FROM side_question_requests WHERE session_key=$1", [key]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }

  async memory(e: SideExchange): Promise<SideMemory> {
    const r = await this.pool.query(
      `SELECT s.memory FROM side_question_sessions s JOIN side_question_requests r ON r.session_key=s.session_key
       WHERE r.id=$1 AND r.generation=s.generation AND s.generation=$2 AND r.status='running'`,
      [e.id, e.generation],
    );
    return (r.rows[0]?.memory ?? {}) as SideMemory;
  }

  /** Paging cursor not successfully exchanged (during this request ordinal Before, ascending 20 OK/page）。 */
  async replayPage(e: SideExchange, after: number): Promise<SideExchange[]> {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM side_question_requests WHERE session_key=$1 AND generation=$2
       AND status='completed' AND ordinal>$3 AND ordinal<$4 ORDER BY ordinal LIMIT 20`,
      [e.sessionKey, e.generation, after, e.ordinal],
    );
    return r.rows.map(dto);
  }

  async saveMemory(e: SideExchange, memory: SideMemory): Promise<void> {
    const r = await this.pool.query(
      `UPDATE side_question_sessions s SET memory=$3 WHERE s.session_key=$1 AND s.generation=$2
       AND EXISTS(SELECT 1 FROM side_question_requests r WHERE r.id=$4 AND r.session_key=s.session_key AND r.generation=s.generation AND r.status='running')`,
      [e.sessionKey, e.generation, JSON.stringify(memory), e.id],
    );
    if ((r.rowCount ?? 0) === 0) throw new Error(ERR_SIDE_PARENT_GONE);
  }

  async interruptRunning(): Promise<void> {
    await this.pool.query("UPDATE side_question_requests SET status='interrupted',error='Service restarted, answer interrupted',sequence=sequence+1 WHERE status='running'");
  }
}
