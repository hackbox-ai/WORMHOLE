import { registerTool } from "../tools/gate.ts";
import type { TrafficFlow } from "./flow.ts";
export const CHECK_TOOLS = [
	"traffic_candidates",
	"claim_http_check",
	"complete_http_check",
];
const descriptions = {
	traffic_candidates:
		"Only read-only view of the interfaces, parameters and shared inspection results actually collected by the current task will not be actively sent.",
	claim_http_check:
		"Worker is claimed before starting a type of check; when claimed=false, existing execution or results are reused to avoid repeated testing.",
	complete_http_check:
		"Worker saves the inspection conclusion of the actual package; suspected is only a clue and cannot replace vulnerability evidence and reporting.",
};
export function registerCheckTools(flow: TrafficFlow) {
	const properties: Record<string, Record<string, unknown>> = {
		traffic_candidates: {before_id:{type:'integer',minimum:1}},
		claim_http_check: {
			endpoint_id: { type: "integer", minimum: 1 },
			parameter: { type: "string" },
			new_evidence_id: { type: "integer", minimum: 1 },
			check_type: {
				type: "string",
				enum: [
					"sqli",
					"xss",
					"ssrf",
					"path_traversal",
					"authorization",
					"input_validation",
					"business_logic",
				],
			},
		},
		complete_http_check: {
			check_id: { type: "string", format: "uuid" },
			status: {
				type: "string",
				enum: ["negative", "inconclusive", "suspected"],
			},
			summary: { type: "string", maxLength: 1500 },
		},
	};

	for (const key of CHECK_TOOLS)
		registerTool({
			key,
			description: descriptions[key as keyof typeof descriptions],
			schema: {
				type: "object",
				properties: properties[key],
				required: Object.keys(properties[key]!).filter(
					(k) => k !== "new_evidence_id" && k !== "before_id",
				),
				additionalProperties: false,
			},
			params: {},
			required: [],
			execute: async (p, ctx) => {
				if (!ctx.taskId) throw new Error("Current task context required");
				return key === "traffic_candidates"
					? flow.list(ctx.taskId,Number(p.before_id)||0)
					: key === "claim_http_check"
						? flow.claim(ctx, p)
						: flow.complete(ctx, p);
			},
		});
}
export async function seedCheckTools(pool: TrafficFlow["pool"]) {
	const conflicts = (
		await pool.query(
			"SELECT key FROM tools WHERE key=ANY($1::text[]) AND system=FALSE",
			[CHECK_TOOLS],
		)
	).rows;
	if (conflicts.length) throw new Error("Shared inspection tool name conflicts with custom tool");
	for (const key of CHECK_TOOLS) {
		const agents = JSON.stringify(
			key === "traffic_candidates"
				? ["planner", "worker", "mainagent"]
				: ["worker"],
		);
		await pool.query(
			"INSERT INTO tools(key,description,schema,agents,system,kind) VALUES($1,$2,'{}',$3,TRUE,'builtin') ON CONFLICT(key) DO NOTHING",
			[key, descriptions[key as keyof typeof descriptions], agents],
		);
	}
}
