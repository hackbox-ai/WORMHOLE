import { randomUUID } from "node:crypto";
export const CONTEXT_HEADER = "x-wormhole-capture-context";
export interface CaptureContext {
	taskId?: number;
	intentId?: number;
	requestId: string;
	checkId?: string;
	view: "wire" | "plaintext";
	reverse?: boolean;
  proxyId?: string;
  browserEnvironmentId?:string;
}
const tickets = new Map<string, { context: CaptureContext; until: number }>();
export function issueCapture(context: CaptureContext): string {
	for (const [id, item] of tickets)
		if (item.until < Date.now()) tickets.delete(id);
	if (tickets.size >= 4096) throw new Error("Traffic association queue is full");
	const id = randomUUID();
	tickets.set(id, { context, until: Date.now() + 60_000 });
	return id;
}
export function revokeCapture(id: string) {
	tickets.delete(id);
}
export function consumeCapture(id: unknown): CaptureContext | undefined {
	if (typeof id !== "string") return;
	const item = tickets.get(id);
	tickets.delete(id);
	return item && item.until >= Date.now() ? item.context : undefined;
}
