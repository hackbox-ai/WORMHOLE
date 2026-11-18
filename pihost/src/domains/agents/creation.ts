import type { Pool } from "pg";
import type { AgentInput } from "./service.ts";
import { inspectTemplate } from "./template.ts";

export interface AgentCreateInput extends AgentInput {
  prompt?: string;
  visibility?: { mcp?: number[]; skill?: string[] };
  tools?: string[];
  triggers?: Record<string, unknown>[];
}
type Result = { ok: true; agent: Record<string, unknown> } | { ok: false; status: number; error: string };

/** Persist the complete draft together: failure must not leave a half-created agent. */
export async function createAgentRecord(
  pool: Pool,
  input: AgentCreateInput,
  defaultPrompt: string,
  triggerSchema: { fields: readonly string[]; values: (input: Record<string, unknown>) => unknown[] },
): Promise<Result> {
  const reject = (error: string): never => {
    throw Object.assign(new Error(error), { status: 400 });
  };
  try {
    for (const field of [
      "key",
      "name",
      "description",
      "role",
      "prompt",
      "wrapup_prompt",
      "task_timeout_wrapup_prompt",
    ] as const)
      if (input[field] != null && typeof input[field] !== "string") reject(field + " Must be text");
    const key = (input.key ?? "").trim(),
      name = (input.name ?? "").trim();
    if (!/^[a-z][a-z0-9_]*$/.test(key)) reject("key must start with a lowercase letter and only contain lowercase letters/numbers/underscores");
    if (!name) reject("Name cannot be empty");
    for (const field of [
      "max_turns",
      "run_seconds",
      "wrapup_max_turns",
      "task_timeout_wrapup_max_turns",
      "trigger_max_parallel",
    ] as const)
      if (input[field] != null && (!Number.isSafeInteger(input[field]) || input[field]! < 0))
        reject(field + " Must be a non-negative integer");
    for (const field of ["enabled", "web_search", "interactive_shell"] as const)
      if (input[field] != null && typeof input[field] !== "boolean") reject(field + " Must be a switch value");
    if (input.llm_profile_id != null && !Number.isSafeInteger(input.llm_profile_id)) reject("llm_profile_id format error");
    if (input.trigger_run_mode != null && !["serial", "parallel"].includes(input.trigger_run_mode))
      reject("Trigger run mode is invalid");
    if (input.trigger_merge_mode != null && !["all", "by_task", "none"].includes(input.trigger_merge_mode))
      reject("Trigger merge mode is invalid");
    const vis = input.visibility ?? {};
    if (!vis || typeof vis !== "object" || Array.isArray(vis)) reject("visibility format error");
    if (vis.mcp != null && (!Array.isArray(vis.mcp) || !vis.mcp.every(Number.isSafeInteger)))
      reject("MCP must be an array of integers");
    if (vis.skill != null && (!Array.isArray(vis.skill) || !vis.skill.every((x) => typeof x === "string" && x.trim())))
      reject("Skill must be an array of names");
    if (
      input.tools != null &&
      (!Array.isArray(input.tools) || !input.tools.every((x) => typeof x === "string" && x.trim()))
    )
      reject("Tools must be an array of names");
    if (
      input.triggers != null &&
      (!Array.isArray(input.triggers) || !input.triggers.every((x) => x && typeof x === "object" && !Array.isArray(x)))
    )
      reject("Trigger format error");
    const triggers = (input.triggers ?? []).map((t) => triggerSchema.values(t));
    const prompt = input.prompt?.trim() ? input.prompt : defaultPrompt;
    const parsed = await inspectTemplate(prompt);
    if (parsed.syntaxError) reject("Template syntax error: " + parsed.syntaxError);
    for (const field of parsed.fields)
      if (!["Now", "DataDir"].includes(field)) reject("Variable {{." + field + "}} is not in the allowed list of this agent");
    const mcp = [...new Set(vis.mcp ?? [])],
      skills = [...new Set(vis.skill ?? [])],
      tools = [...new Set(input.tools ?? [])];
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (
        input.llm_profile_id != null &&
        !(
          await c.query("SELECT id FROM llm_profiles WHERE id=$1 AND trim(api_key)<>'' FOR KEY SHARE", [
            input.llm_profile_id,
          ])
        ).rowCount
      )
        reject("The specified LLM configuration does not exist or is invalid");
      if (
        mcp.length &&
        (await c.query("SELECT id FROM mcp_servers WHERE id=ANY($1::bigint[]) FOR KEY SHARE", [mcp])).rowCount !==
          mcp.length
      )
        reject("The selected MCP no longer exists, please refresh and try again");
      if (
        tools.length &&
        (await c.query("SELECT key FROM tools WHERE key=ANY($1::text[]) FOR UPDATE", [tools])).rowCount !== tools.length
      )
        reject("The selected tool no longer exists, please refresh and try again");
      const row = (
        await c.query(
          "INSERT INTO agents " +
            "(key,name,description,role,enabled,llm_profile_id,max_turns,run_seconds,web_search,interactive_shell," +
            "wrapup_prompt,wrapup_max_turns,task_timeout_wrapup_prompt,task_timeout_wrapup_max_turns," +
            "trigger_run_mode,trigger_merge_mode,trigger_max_parallel) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *",
          [
            key,
            name,
            input.description ?? "",
            input.role ?? "assistant",
            input.enabled ?? true,
            input.llm_profile_id ?? null,
            input.max_turns ?? 0,
            input.run_seconds ?? 1200,
            input.web_search ?? false,
            input.interactive_shell ?? false,
            input.wrapup_prompt ?? "",
            input.wrapup_max_turns ?? 0,
            input.task_timeout_wrapup_prompt ?? "",
            input.task_timeout_wrapup_max_turns ?? 0,
            input.trigger_run_mode ?? "serial",
            input.trigger_merge_mode ?? "all",
            input.trigger_max_parallel ?? 5,
          ],
        )
      ).rows[0];
      const version = (
        await c.query(
          "INSERT INTO agent_prompts(agent_key,version,prompt,note,updated_by) VALUES($1,1,$2,$3,'ui') RETURNING id",
          [key, prompt, input.prompt?.trim() ? "Configure on creation" : "Built-in default"],
        )
      ).rows[0];
      await c.query("UPDATE agents SET current_prompt_id=$2 WHERE key=$1", [key, version.id]);
      row.current_prompt_id = version.id;
      for (const id of mcp)
        await c.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES($1,'mcp',$2)", [
          key,
          String(id),
        ]);
      for (const skill of skills)
        await c.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES($1,'skill',$2)", [
          key,
          skill,
        ]);
      if (tools.length)
        await c.query(
          "UPDATE tools SET agents=CASE WHEN agents @> jsonb_build_array($1::text) THEN agents ELSE agents||jsonb_build_array($1::text) END WHERE key=ANY($2::text[])",
          [key, tools],
        );
      for (const values of triggers)
        await c.query(
          "INSERT INTO agent_triggers(agent_key," +
            triggerSchema.fields.join(",") +
            ") VALUES($1," +
            triggerSchema.fields.map((_, i) => "$" + (i + 2)).join(",") +
            ")",
          [key, ...values],
        );
      await c.query("COMMIT");
      return { ok: true, agent: row };
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  } catch (error) {
    const e = error as Error & { status?: number; code?: string };
    if (e.code === "23505") return { ok: false, status: 409, error: "The key already exists" };
    if (e.status) return { ok: false, status: e.status, error: e.message };
    throw error;
  }
}
