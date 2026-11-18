import {registerTool} from '../tools/gate.ts';
import type {HuntingService} from './service.ts';

export const HUNT_TOOLS = ['hunt_vuln', 'read_hunt', 'list_hunts'];

const definitions = [
  {key: 'hunt_vuln', description: "Retrieve target-related public vulnerability information: bulletins, analysis articles, patch/commit diffs, code snippets, or PoC templates. What is returned is information and clues for you to read, not a conclusion, nor does it execute any code. Suitable for checking n-day/1-day, or finding attack surface for 0-day. It’s up to you to decide whether to use it or not and how many times to use it.",
   schema: {type: 'object', additionalProperties: false, properties: {
     product: {type: 'string', maxLength: 120}, version: {type: 'string', maxLength: 64},
     cve: {type: 'string', pattern: '^CVE-\\d{4}-\\d{4,}$'},
     query: {type: 'string', minLength: 1, maxLength: 128},
     goal: {type: 'string', enum: ['poc', 'understand', 'variant', 'query']},
     since: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'},
     max_fetches: {type: 'integer', minimum: 1, maximum: 10},
     force_refresh: {type: 'boolean'}}}},
  {key: 'read_hunt', description: "Read the text of a saved public information (paginated). The content comes from the Internet and is for analysis purposes only.",
   schema: {type: 'object', additionalProperties: false, required: ['source_id'], properties: {
     source_id: {type: 'string', pattern: '^[0-9a-f-]{36}$'},
     offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 500, maximum: 20000}}}},
  {key: 'list_hunts', description: "List the previous data retrieval records and source titles for this task (excluding text).",
   schema: {type: 'object', additionalProperties: false, properties: {limit: {type: 'integer', minimum: 1, maximum: 50}}}},
];

export async function seedHuntTools(service: HuntingService): Promise<void> {
  for (const item of definitions) {
    await service.pool.query(
      `INSERT INTO tools(key,system,description,schema,agents,kind) VALUES($1,true,$2,$3::jsonb,$4::jsonb,'builtin')
       ON CONFLICT(key) DO UPDATE SET schema=EXCLUDED.schema,description=EXCLUDED.description`,
      [item.key, item.description, JSON.stringify(item.schema), JSON.stringify(['worker', 'pentest'])]);
    await service.pool.query(
      `INSERT INTO tool_defaults(key,description,schema,agents) VALUES($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description,schema=EXCLUDED.schema,agents=EXCLUDED.agents`,
      [item.key, item.description, JSON.stringify(item.schema), JSON.stringify(['worker', 'pentest'])]);
  }
}

export function registerHuntTools(service: HuntingService): void {
  for (const item of definitions) {
    registerTool({key: item.key, description: item.description, schema: item.schema,
      params: {}, required: [], execute: async (params, ctx) => {
        if (!ctx.taskId) throw new Error("The tool requires a task context");
        if (item.key === 'hunt_vuln') {
          return await service.hunt(ctx.taskId, ctx.intentId, params as never, ctx.signal ?? new AbortController().signal);
        }
        if (item.key === 'read_hunt') {
          return await service.read(ctx.taskId, String(params.source_id),
            Number(params.offset ?? 0), Number(params.limit ?? 8000));
        }
        return await service.list(ctx.taskId, Number(params.limit ?? 10));
      }});
  }
}
