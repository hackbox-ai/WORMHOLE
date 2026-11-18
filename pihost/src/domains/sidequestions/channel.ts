/**
 * F02 Bypass completion channel: via Pi Session original streamFunction Direct adjustment (no advance agent loop、
 * No tool execution, no master transcription - comparison sidequestion.SideQuestionService.Answer）。
 * Model Identity Verification: Snapshot identity Reject if inconsistent with the current parsable model (original text sideProvider）。
 */
import type { Pool } from "pg";
import type { PihostConfig } from "../../config.ts";
import { createHostedSession } from "../../pi/session-host.ts";
import type { CompleteFn } from "./service.ts";
import type { Req } from "./service-types.ts";
import type { SideSnapshot, SideUsage } from "./store.ts";
import { createHash as nodeHash } from "node:crypto";

export function identityOf(model: { provider: string; id: string; contextWindow: number }): string {
  return nodeHash("sha256").update(JSON.stringify([model.provider, model.id, model.contextWindow, true])).digest("hex");
}

type StreamFn = (model: unknown, context: unknown, options?: unknown) => { result(): Promise<Record<string, unknown>> } & AsyncIterable<{ type?: string; delta?: string }>;

export async function createSideChannel(pool: Pool, config: PihostConfig, snapshot: SideSnapshot): Promise<CompleteFn & { dispose(): Promise<void> }> {
  const provider = snapshot.model.profile_id > 0 ? `profile-${snapshot.model.profile_id}` : undefined;
  const h = await createHostedSession(pool, config, {
    kind: "btw",
    businessId: `btw-${snapshot.parent.conversationId ?? snapshot.parent.taskId}-${Date.now()}`,
    systemPrompt: snapshot.request.systemPrompt ?? "",
    provider,
    modelId: snapshot.model.model,
  });
  const session = h.session as unknown as { agent: { streamFunction: StreamFn } };
  const native = session.agent.streamFunction.bind(session.agent);
  const model = (h as unknown as { model?: { provider: string; id: string; contextWindow: number } }).model;
  if (model) {
    const current = identityOf(model);
    if (current !== snapshot.model.identity) {
      await h.dispose().catch(() => {});
      throw new Error("The model configuration has been deleted or changed, please run the main Agent to update the context first");
    }
  }
  return Object.assign(
    async (req: Req, signal: AbortSignal): Promise<{ text: string; usage: SideUsage; toolUse: boolean; stopReason: string }> => {
      const stream = native(model, { systemPrompt: req.systemPrompt, messages: req.messages, tools: req.tools }, { signal, maxRetries: 0 });
      for await (const _ev of stream) { void _ev; /* Events accumulated with result shall prevail (with the original Answer Equivalent: text/Tool/The usage is in the final state message） */ }
      const result = (await stream.result()) as unknown as {
        stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        content?: { type?: string; text?: string }[];
      };
      const text = (result.content ?? []).map((c) => c.type === "text" ? (c.text ?? "") : "").join("");
      const toolUse = (result.content ?? []).some((c) => c.type === "toolCall");
      if (result.stopReason === "error") throw new Error(result.errorMessage || "model error");
      if (result.stopReason === "aborted" || signal.aborted) throw signal.reason ?? new Error("aborted");
      if (result.stopReason && !["stop", "length", "error", "aborted"].includes(result.stopReason) === false && result.stopReason !== "stop") {
        // stop=length Wait for the non-error final state and return the text as usual (original text Complete Semantics）
      }
      return {
        text,
        usage: {
          input_tokens: Number(result.usage?.input) || 0,
          output_tokens: Number(result.usage?.output) || 0,
          cache_read_tokens: Number(result.usage?.cacheRead) || 0,
          cache_write_tokens: Number(result.usage?.cacheWrite) || 0,
        },
        toolUse,
        stopReason: result.stopReason ?? "stop",
      };
    },
    { dispose: () => h.dispose() },
  );
}
