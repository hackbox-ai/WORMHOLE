/**
 * F02 Bypass question routing。
 * Mount: Dialogue/Task Master/Intent worker Three parent keys × GET/POST/DELETE + events SSE + cancel。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { SideStore, parentKey, type SideParent, type SideExchange } from "../domains/sidequestions/store.ts";
import { SideRuntime } from "../domains/sidequestions/service.ts";
import { createSideChannel, identityOf } from "../domains/sidequestions/channel.ts";
import type { PihostConfig } from "../config.ts";

type JsonFn = (res: ServerResponse, status: number, value: unknown) => void;

function validRequestId(id: string): boolean {
  if (!id || id.length > 128) return false;
  for (const r of id) {
    if (!((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") || (r >= "0" && r <= "9") || r === "-" || r === "_" || r === "." || r === ":")) return false;
  }
  return true;
}

export interface SideRouteDeps {
  pool: Pool;
  config: PihostConfig;
  runtime: SideRuntime;
  isTaskDeleting(taskId: number): boolean;
}

export async function routeSideQuestions(req: IncomingMessage, res: ServerResponse, url: URL, deps: SideRouteDeps, json: JsonFn, readJson: (req: IncomingMessage) => Promise<unknown>): Promise<boolean> {
  const path = url.pathname;
  const store = new SideStore(deps.pool);

  // ── Event Flow and Cancellation ──
  const eventsM = /^\/api\/side-questions\/([^/]+)\/events$/.exec(path);
  if (eventsM && req.method === "GET") {
    const id = decodeURIComponent(eventsM[1]!);
    const first = await store.request(id);
    if (!first) return json(res, 404, { error: "side question not found" }), true;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    let seq = -1;
    let current: SideExchange | null = first;
    const tick = setInterval(() => void (async () => {
      try {
        current = await store.request(id);
        if (!current) { res.write("event: cleared\ndata: {}\n\n"); return; }
        if (current.sequence > seq) {
          seq = current.sequence;
          res.write(`id: ${seq}\nevent: snapshot\ndata: ${JSON.stringify(current)}\n\n`);
        }
        if (current.status !== "running") { clearInterval(tick); clearInterval(beat); res.end(); }
      } catch { /* Instantaneous DB Error continuing polling */ }
    })(), 250);
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => { clearInterval(tick); clearInterval(beat); });
    return true;
  }
  const cancelM = /^\/api\/side-questions\/([^/]+)\/cancel$/.exec(path);
  if (cancelM && req.method === "POST") {
    const e = await store.request(decodeURIComponent(cancelM[1]!));
    if (!e) return json(res, 404, { error: "side question not found" }), true;
    const run = deps.runtime.runs.get(e.id);
    run?.cancel.abort();
    return json(res, 200, { cancelled: true }), true;
  }

  // ── Three parent key routing ──
  const convM = /^\/api\/conversations\/(\d+)\/side-questions$/.exec(path);
  const mainM = /^\/api\/tasks\/(\d+)\/chat\/side-questions$/.exec(path);
  const workerM = /^\/api\/tasks\/(\d+)\/intents\/(\d+)\/side-questions$/.exec(path);
  const match = convM ?? mainM ?? workerM;
  if (!match) return false;
  const id = Number(match[1]);
  let parent: SideParent | null = null;
  if (convM) {
    const c = await deps.pool.query("SELECT id FROM conversations WHERE id=$1", [id]);
    if ((c.rowCount ?? 0) === 0) return json(res, 404, { error: "conversation not found" }), true;
    parent = { conversationId: id };
  } else {
    const t = await deps.pool.query("SELECT id, exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL AND archived_at IS NULL", [id]);
    if ((t.rowCount ?? 0) === 0) return json(res, 404, { error: "task not found" }), true;
    if (deps.isTaskDeleting(id)) return json(res, 409, { error: "Task has been archived or is being deleted" }), true;
    const explorationId = Number(t.rows[0].exploration_id);
    if (mainM) {
      parent = { taskId: id, explorationId };
    } else {
      const iid = Number(workerM![2]);
      const n = await deps.pool.query("SELECT id FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent' AND state<>'stopped'", [iid, explorationId]);
      if ((n.rowCount ?? 0) === 0) return json(res, 404, { error: "intent not found" }), true;
      parent = { taskId: id, explorationId, intentId: iid };
    }
  }
  const key = parentKey(parent);

  // DELETE：Cancel the operation of this key + Qing History（generation+1、memory Reset）
  if (req.method === "DELETE") {
    for (const run of [...deps.runtime.runs.values()]) if (run.key === key) run.cancel.abort();
    try { await store.clearHistory(key); } catch (e) { return json(res, 500, { error: String((e as Error).message ?? e) }), true; }
    return json(res, 200, { cleared: true }), true;
  }

  const snapshot = await deps.runtime.snapshotFor(parent).catch((e) => { throw e; });

  // GET：History 21→20+next_cursor、Running current、Snapshot meta
  if (req.method === "GET") {
    const before = Number(url.searchParams.get("before") ?? "0") || 0;
    let items: SideExchange[];
    try { items = await store.history(key, before, 21); } catch (e) { return json(res, 500, { error: String((e as Error).message ?? e) }), true; }
    let next = 0;
    if (items.length > 20) { items = items.slice(0, 20); next = items[items.length - 1]!.ordinal; }
    const current = await store.currentRequest(key).catch(() => null);
    let meta: unknown = null;
    if (snapshot) {
      let reason = "";
      try { await createSideChannel(deps.pool, deps.config, snapshot); } catch (e) { reason = String((e as Error).message ?? e); }
      meta = { captured_at: snapshot.captured_at, model: snapshot.model, available: !reason, reason };
    }
    return json(res, 200, { items, current, next_cursor: next, snapshot: meta }), true;
  }

  // POST：32KB Upper limit、1–4000 character,request ID Verification, idempotence, snapshot/Model check, busy/Concurrency
  if (req.method === "POST") {
    const body = (await readJson(req)) as { question?: string; client_request_id?: string } | null;
    const question = String(body?.question ?? "").trim();
    const clientId = String(body?.client_request_id ?? "");
    if (!question || Array.from(question).length > 4000 || !validRequestId(clientId)) {
      return json(res, 400, { error: "Question must be 1–4000 characters in length and provide a valid request ID" }), true;
    }
    if (parent.taskId && deps.isTaskDeleting(parent.taskId)) return json(res, 409, { error: "Task is being archived or deleted" }), true;
    const existing = await store.existingRequest(key, clientId).catch((e) => { throw e; });
    if (existing) {
      if (existing.question !== question) return json(res, 409, { error: "The same request ID cannot be used for different issues" }), true;
      return json(res, 200, existing), true;
    }
    if (!snapshot) return json(res, 409, { error: "No context snapshot yet, please run the main Agent first" }), true;
    let channel;
    try { channel = await createSideChannel(deps.pool, deps.config, snapshot); } catch (e) { return json(res, 409, { error: String((e as Error).message ?? e) }), true; }
    const busy = [...deps.runtime.runs.values()].some((r) => r.key === key);
    if (busy) { await channel.dispose().catch(() => {}); return json(res, 409, { error: "There are already bypass questions being answered in the current session." }), true; }
    if (deps.runtime.runs.size >= 4) { await channel.dispose().catch(() => {}); return json(res, 429, { error: "The concurrency limit of bypass requests has been reached, please try again later." }), true; }
    await store.saveSnapshot(snapshot).catch(() => {});
    let started: { e: SideExchange; created: boolean };
    try { started = await store.startRequest(snapshot, clientId, question); } catch (e) { await channel.dispose().catch(() => {}); return json(res, 409, { error: String((e as Error).message ?? e) }), true; }
    if (started.created) {
      // Channel multiplexing：run Inside dispose
      void deps.runtime.runWithChannel(started.e, parent, snapshot, channel);
    } else {
      await channel.dispose().catch(() => {});
    }
    return json(res, 202, started.e), true;
  }
  return false;
}
