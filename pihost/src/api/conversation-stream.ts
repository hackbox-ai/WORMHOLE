import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ConversationsService } from "../domains/conversations/service.ts";

export async function streamConversation(
  req: IncomingMessage, res: ServerResponse, conversations: ConversationsService, id: number, url: URL,
) {
  const supplied = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  if (typeof supplied !== "string" || !/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid conversation cursor" }));
    return;
  }
  let cursor = Number(supplied);
  const connection = new AbortController();
  const close = () => connection.abort();
  res.once("close", close);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  let previousRunning: boolean | undefined;
  try {
    while (!connection.signal.aborted) {
      // Sample state before reading. A turn that finishes during the query
      // gets one more drain pass before the client sees the idle frame.
      const running = conversations.isRunning(id);
      const page = await conversations.messages(id, cursor);
      if (connection.signal.aborted) break;
      const items = page?.items ?? [];
      const full = items.length >= 1000;
      const active = Boolean(page && (running || full));
      cursor = page?.cursor ?? cursor;
      const frame = items.length || previousRunning !== active
        ? "id: " + cursor + "\ndata: " + JSON.stringify({ items, cursor, running: active }) + "\n\n"
        : ": keep-alive\n\n";
      if (!res.write(frame)) await once(res, "drain", { signal: connection.signal });
      previousRunning = active;
      if (!active) break;
      if (!full) await delay(500, undefined, { signal: connection.signal });
    }
  } catch (error) {
    if (!connection.signal.aborted) throw error;
  } finally {
    res.off("close", close);
    if (!res.destroyed) res.end();
  }
}
