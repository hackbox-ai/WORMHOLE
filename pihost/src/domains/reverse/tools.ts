/**
 * Worker-facing tools for the reverse-engineering proxy.
 *
 * Deliberately narrow: a worker can start a proxy for one interface and look up
 * proxies that already exist. Nothing here schedules work, creates intents or
 * changes how the task graph advances.
 */
import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import type {ReverseProxies} from './proxy.ts';

const str = {type: 'string'};
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({type: 'object', properties, required, additionalProperties: false});

const specs = [
  {
    key: 'start_reverse_proxy',
    agents: ['worker'],
    description: "Default adapter mode: only accepts Node .mjs/.js/.cjs, exports encodeRequest({url,method,headers,body,bodyBytes}) and decodeResponse({status,headers,body,bodyBytes}); body is a UTF-8 string and bodyBytes is a Buffer; returns {headers,body}. Don’t build your own services or outsource them. After the reversal is completed, the transparent encryption and decryption agent is started: the host allocates a port, pulls up and health checks the script process, and shuts down when paused, task ended or explicitly stopped; retained scripts can be restarted when testing is resumed."
      + "The proxy only takes effect on the declared origin+method+path, converts the plaintext into the target real encrypted message and decrypts the response."
      + "When there is already a running agent on the same interface, the process will not be repeated: that agent will be returned by default for direct reuse; use replace=true to remove it when confirming that it is unavailable.",
    schema: object({script_path: str, url: str, method: str, path: str, usage: str, replace: {type: 'boolean'},mode:{type:'string',enum:['adapter','legacy'],default:'adapter'}}, ['script_path', 'url', 'method', 'usage']),
  },
  {
    key: 'stop_reverse_proxy',agents:['worker'],description:"Stop the reverse proxy specified in the current task and retain scripts, logs and registration records.",
    schema:object({proxy_id:str},['proxy_id']),
  },
  {
    key: 'reverse_proxies',
    agents: ['worker', 'planner'],
    description: "Query the registered reverse proxy for this task (including running status, port and usage). Encryptable interfaces preferentially reuse the proxy here, and do not reverse the same interface repeatedly.",
    schema: object({origin: str}),
  },
];

export const REVERSE_PROXY_TOOLS = specs.map(spec => spec.key);

export const reverseWorkerGuidance = `
[Optional capabilities: Web request encryption/signature/response encoding]
The following abilities belong to you. It is up to you to decide whether to do them, which ones to use, and whether to use them or not:
- Browser: task_browser / browser_navigate / browser_network_requests / browser_evaluate - see the real message, confirm the key source, and try calculation on the page.
- Local unpacking: use webcrack, js-beautify, terser only if the corresponding components are installed; these commands are not included in the base installation.
- Hosted adapter: Write adapter.mjs in the original intent directory (export encodeRequest / decodeResponse), use start_reverse_proxy to pass the script_path, target url, method, and usage to the host; the host is responsible for the port, MITM routing, process, health check, and recycling. After that, http_request takes the proxy parameter to create a text request, and encryption and decryption are completed by the adapter. Returning reused:true indicates that the interface already has a proxy, and the returned proxy_url is used directly.
- Existing proxy: Direct reuse running in reverse_proxies and covering the interface does not need to be redone; when the routing configuration changes or collection is enabled and the old proxy is in legacy mode, the host will require replace=true to restart.
- REA: Loaded only when the ability status is available and the Skill list contains wormhole-rea-toolkit; each analysis backend is used according to the actual detection results.
When signature or encryption blocks the way, you decide which one to use and whether to use it or not; you can also change the path (read the source code, bypass the interface, change the test direction).
If this result is useful to subsequent workers, record another fact (summary starts with [REVERSE_READY] or [REVERSE_UNUSABLE]) and write down the agent address, scope of application, and algorithm conclusion; not recording it will not affect the progress of the task.
`;

export function registerReverseTools(proxies: ReverseProxies): void {
  for (const spec of specs) {
    registerTool({
      key: spec.key,
      description: spec.description,
      params: {},
      required: [],
      schema: spec.schema,
      execute: async (params, ctx) => {
        if (!ctx.taskId) throw new Error("Reverse proxy tool requires task context");
        if (spec.key === 'start_reverse_proxy') {
          return proxies.start(ctx, params as unknown as Parameters<ReverseProxies['start']>[1], params.replace === true);
        }
        if(spec.key==='stop_reverse_proxy')return proxies.stop(ctx.taskId,String(params.proxy_id));
        return proxies.list(ctx.taskId, String(params.origin ?? ''));
      },
    });
  }
}

export async function seedReverseProxyTools(pool: Pool): Promise<void> {
  const conflicts = (await pool.query(
    'SELECT key FROM tools WHERE key=ANY($1::text[]) AND system=FALSE', [REVERSE_PROXY_TOOLS])).rows;
  if (conflicts.length) throw new Error("The reverse proxy tool name conflicts with an existing custom tool: " + conflicts.map((row: {key: string}) => row.key).join(', '));
  for (const spec of specs) {
    const agents = JSON.stringify(spec.agents);
    await pool.query(
      `INSERT INTO tools(key,description,schema,agents,enabled,system,kind)
       VALUES($1,$2,$3,$4,TRUE,TRUE,'builtin') ON CONFLICT(key) DO NOTHING`,
      [spec.key, spec.description, spec.schema, agents]);
    await pool.query("UPDATE tools SET description=$2 WHERE key=$1 AND system=TRUE AND description=(SELECT description FROM tool_defaults WHERE key=$1)",[spec.key,spec.description]);
    await pool.query(
      'INSERT INTO tool_defaults(key,description,schema,agents) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING',
      [spec.key, spec.description, spec.schema, agents]);
    await pool.query('UPDATE tool_defaults SET description=$2 WHERE key=$1',[spec.key,spec.description]);
  }
}
