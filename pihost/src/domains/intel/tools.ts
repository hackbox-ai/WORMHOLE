import {registerTool} from '../tools/gate.ts';
import type {IntelClient} from './client.ts';

export const INTEL_TOOLS = ['nvd_lookup', 'osv_lookup', 'github_search'];

const definitions = [
  {key: 'nvd_lookup',
   description: "Check NVD by CVE number or product/version. When there is no key, the NVD speed is limited to 5 times/30 seconds. When the upper limit is reached, it will directly say \"speed limit\", change OSV or try again later. The result is a public vulnerability database record, not a vulnerability conclusion.",
   schema: {type: 'object', additionalProperties: false, properties: {
     cve: {type: 'string', pattern: '^CVE-\\d{4}-\\d{4,}$'},
     product: {type: 'string', maxLength: 120},
     cpe: {type: 'string', maxLength: 300},
     version: {type: 'string', maxLength: 64},
     offset: {type: 'integer', minimum: 0},
     start_index: {type: 'integer', minimum: 0}}}},
  {key: 'osv_lookup',
   description: "Check OSV by open source component name + version (covering npm/PyPI/Go/Maven/NuGet, etc.). Maven needs to write groupId:artifactId. Returns vulnerability, alias CVE, fix version.",
   schema: {type: 'object', additionalProperties: false, required: ['name', 'ecosystem'], properties: {
     name: {type: 'string', maxLength: 200},
     version: {type: 'string', maxLength: 64},
     ecosystem: {type: 'string', enum: ['npm', 'PyPI', 'Go', 'Maven', 'NuGet', 'RubyGems', 'Packagist', 'crates.io', 'Alpine', 'Debian', 'Ubuntu']},
     offset: {type: 'integer', minimum: 0},
     page_token: {type: 'string', maxLength: 200}}}},
  {key: 'github_search',
   description: "Find PoC/EXP repositories, code or read repository files on GitHub. When the token is not configured, you can only search the warehouse and read files. The code search will use one sentence to explain that the token is required.",
   schema: {type: 'object', additionalProperties: false, required: ['kind'], properties: {
     kind: {type: 'string', enum: ['repo', 'code', 'contents']},
     query: {type: 'string', maxLength: 200},
     repo: {type: 'string', maxLength: 200},
     path: {type: 'string', maxLength: 500}}}},
];

export async function seedIntelTools(client: IntelClient, pool: {query: (sql: string, args?: unknown[]) => Promise<unknown>}): Promise<void> {
  for (const item of definitions) {
    await (pool as any).query(
      `INSERT INTO tools(key,system,description,schema,agents,kind) VALUES($1,true,$2,$3::jsonb,$4::jsonb,'builtin')
       ON CONFLICT(key) DO UPDATE SET schema=EXCLUDED.schema,description=EXCLUDED.description`,
      [item.key, item.description, JSON.stringify(item.schema), JSON.stringify(['worker', 'pentest'])]);
    await (pool as any).query(
      `INSERT INTO tool_defaults(key,description,schema,agents) VALUES($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description,schema=EXCLUDED.schema,agents=EXCLUDED.agents`,
      [item.key, item.description, JSON.stringify(item.schema), JSON.stringify(['worker', 'pentest'])]);
  }
}

export function registerIntelTools(client: IntelClient): void {
  for (const item of definitions) {
    registerTool({key: item.key, description: item.description, schema: item.schema, params: {}, required: [],
      execute: async (params, ctx) => {
        if (item.key === 'nvd_lookup') {
          if (params.cve) return await client.nvdCve(String(params.cve).toUpperCase(), ctx.signal);
          const pageOpts = {offset: Number(params.offset ?? 0), startIndex: Number(params.start_index ?? 0)};
          if (params.cpe) return await client.nvdByCpe(String(params.cpe),
            params.version ? String(params.version) : undefined, ctx.signal, pageOpts);
          if (!params.product) return {ok: false, reason: 'invalid_input', hint: "For cve, cpe, or product (can bring version)"};
          return await client.nvdByProduct(String(params.product),
            params.version ? String(params.version) : undefined, ctx.signal, pageOpts);
        }
        if (item.key === 'osv_lookup') {
          return await client.osv(String(params.name), params.version ? String(params.version) : undefined,
            params.ecosystem ? String(params.ecosystem) : undefined, ctx.signal, Number(params.offset ?? 0),
            params.page_token ? String(params.page_token) : undefined);
        }
        if (params.kind === 'contents') {
          if (!params.repo || !params.path) return {ok: false, reason: 'invalid_input', hint: "contents requires repo and path"};
          return await client.githubContents(String(params.repo), String(params.path), ctx.signal);
        }
        if (!params.query) return {ok: false, reason: 'invalid_input', hint: "query required"};
        return params.kind === 'code' ? await client.githubCode(String(params.query), ctx.signal)
          : await client.githubRepos(String(params.query), ctx.signal);
      }});
  }
}
