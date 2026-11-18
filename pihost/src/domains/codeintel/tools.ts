import {currentNetwork,taskNetworkScope} from '../network/context.ts';
import {CONTEXT_HEADER,issueCapture,revokeCapture,type CaptureContext} from '../traffic/context.ts';
/** Give worker ’s code query tool. does not appear in the name"White box"：This is the object code for the model。 */
import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream, readFileSync} from 'node:fs';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import {request as httpRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {proxyAgent, targetRoute} from '../traffic/network.ts';
import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import {detect} from './artifacts.ts';
import type {CodeIntelService} from './service.ts';

const str = {type: 'string'};
const bool = {type: 'boolean'};
const int = {type: 'integer'};
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({type: 'object', properties, required, additionalProperties: false});

const MAX_BYTES = 512 * 1024 * 1024;

function safeName(raw: string): string {
  const base = raw.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\-+@]/g, '_').slice(0, 120);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download.bin';
}

/** Streaming placement and hash calculation at the same time. Use platform target routing (including global proxy) instead of naked fetch。 */
export async function downloadTo(url: string, dest: string, maxBytes: number, signal?: AbortSignal,context?:Pick<CaptureContext,'taskId'|'intentId'>): Promise<{size: number; sha256: string; contentType: string}> {
  const scoped=(context?.taskId?await taskNetworkScope(context.taskId):undefined)??currentNetwork();
  if(scoped?.mode==='jump'&&!scoped.route)throw new Error("Springboard tasks currently cannot download products");
  const route = scoped?.route??targetRoute();
  const tls = route.caFile ? {ca: readFileSync(route.caFile)} : {};
  // The task cancellation signal and the download itself deadline are**Tied**Relationship: There is a task signal There must also be a total time limit
  const deadline = AbortSignal.timeout(600_000);
  const signalOrTimeout = signal ? AbortSignal.any([signal, deadline]) : deadline;

  // Self and redirect：node:http It will not follow automatically, and we must use an agent agent
  let current = new URL(url);
  let res: IncomingMessage | null = null;
  let agent: ReturnType<typeof proxyAgent> | null = null;
  const tickets:string[]=[];
  const agents: ReturnType<typeof proxyAgent>[] = [];   // for each hop agent All turned off
  // Entire jump/Transport life cycle into the same try，Exception paths should also be agent Close clean
  try {
  for (let hop = 0; hop <= 5; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) throw new Error("Only http(s) addresses are supported");
    agent = route.proxy ? proxyAgent(route.proxy, current.protocol === 'https:', tls) : null;
    if (agent) agents.push(agent);
    const target = current;
    const ticket=route.capture&&context?.taskId?issueCapture({...context,requestId:randomUUID(),view:"wire"}):"";if(ticket)tickets.push(ticket);
    const issued = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target, {method: 'GET', agent: agent ?? false, ...tls, signal: signalOrTimeout, headers: {'user-agent': 'WORMHOLE-SecurityTest/1.0',...(ticket?{[CONTEXT_HEADER]:ticket}:{})}}, resolve);
      req.on('error', reject);
      req.end();
    });
    const status = issued.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && issued.headers.location) {
      issued.resume();
      current = new URL(String(issued.headers.location), target);
      continue;
    }
    res = issued;
    break;
  }
  if (!res) throw new Error("Too many redirects");
  try {
    if(res.headers['x-wormhole-network-error'])throw new Error(decodeURIComponent(String(res.headers['x-wormhole-network-error'])));
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Download failed: HTTP ${res.statusCode}`);
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > maxBytes) throw new Error(`File too large:${declared} Bytes, upper limit ${maxBytes}`);
    const hash = createHash('sha256');
    let written = 0;
    // pipeline will catch errors from both sides: the disk is full, the target is a directory, and the connection is interrupted will only cause this tool to fail.
    await pipeline(
      res,
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > maxBytes) return cb(new Error(`Size limit exceeded ${maxBytes} Bytes, aborted`));
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(dest),
    );
    return {size: written, sha256: hash.digest('hex'), contentType: String(res.headers['content-type'] ?? '')};
  } catch (error) {
    await rm(dest, {force: true}).catch(() => {});
    throw error;
  }
  } finally {
    res?.resume();for(const ticket of tickets)revokeCapture(ticket);
    for (const item of agents) { try { item.destroy(); } catch {} }
  }
}


/** Download the product: write the temporary file first, and then address it according to the content after success; failure only affects this temporary file。 */
export async function downloadArtifact(
  service: CodeIntelService,
  ctx: {taskId: number; intentId: number; cwd: string; signal?: AbortSignal},
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = String(params.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s) absolute address");
  const cwd = ctx.cwd;
  const dir = path.join(cwd, 'downloads');
  await mkdir(dir, {recursive: true, mode: 0o755});
  const base = safeName(String(params.name ?? '') || url);
  const maxBytes = Math.min(Math.max(Number(params.max_mb ?? 512), 1), 2048) * 1024 * 1024;
  const tmp = path.join(dir, `.part-${process.pid}-${Date.now()}-${base}`);
  const got = await downloadTo(url, tmp, maxBytes, ctx.signal,{taskId:ctx.taskId,intentId:ctx.intentId}).catch(async error => {
    await rm(tmp, {force: true}).catch(() => {});
    throw error;
  });
  const dest = path.join(dir, `${got.sha256.slice(0, 12)}-${base}`);
  await rename(tmp, dest).catch(async error => {
    await rm(tmp, {force: true}).catch(() => {});
    throw error;
  });
  const indexed = await service.ingestFile(ctx.taskId, ctx.intentId ?? 0, dest,
    {wxapkg_appid: String(params.wxapkg_appid ?? '').trim() || undefined}).catch(() => null);
  const kind = indexed?.kind ?? await detect(dest).catch(() => null);
  await service.recordArtifact(ctx.taskId,ctx.intentId,dest,{name:base,size:got.size,sha256:got.sha256,kind});
  const native = kind === 'elfbin' || kind === 'pe' || kind === 'macho';
  const note = indexed ? "Registered, the platform is building index in the background; you can use search_target_code / read_target_code to view when ready"
    : kind === 'macho' && dest.toLowerCase().endsWith('.ipa')
      ? `The iOS package itself is a compressed package: first decompress and remove the executable file under Payload/*.app, and then use open_binary to open its absolute path`
      : native ? `This type of file is not parsed by the white box, and no index is built; if you want to reverse it, just use open_binary to open this absolute path:${dest}`
      : "Saved to workspace";
  return {
    path: path.relative(cwd, dest), abs_path: dest, size: got.size, sha256: got.sha256,
    content_type: got.contentType, kind, indexed: !!indexed,
    index_state: indexed ? 'registered' : 'not_indexed', note,
  };
}

const specs = [
  {
    key: 'download_file',
    agents: ['worker'],
    description: "Stream download any HTTP(S) file (APK, IPA, wxapkg, source package, binary) to the working directory of this intention, returning the local path, size, sha256 and type. The response body does not enter the context, so large files can be downloaded. Identifies file type after download; indexes in the background when code analysis service is enabled.",
    schema: object({url: str, name: str, max_mb: int, wxapkg_appid: str}, ['url']),
  },
  {
    key: 'list_target_sources',
    agents: ['worker'],
    description: "List the existing code sources of this task and their audit status (unaudited/in progress/audited/failed/timed out) and the number of output clues. Read this before adjusting audit_target_code to avoid repeated audits.",
    schema: object({}),
  },
  {
    key: 'list_target_code',
    agents: ['worker'],
    description: "File listing of object code (recursively). Used to first understand the project structure and then decide what to search for.",
    schema: object({dir: str, source: str}),
  },
  {
    key: 'search_target_code',
    agents: ['worker'],
    description: "Do a regular search (ignoring case) in the indexed target code. Used to confirm the true implementation of a certain interface/parameter, authentication judgment, SQL splicing method, encryption, decryption and signature algorithm, intranet address and hard-coded credentials. Returns path:line and the matching line contents; .class/.dll hits are mapped back to the original file.",
    schema: object({pattern: str, source: str, limit: int}, ['pattern']),
  },
  {
    key: 'read_target_code',
    agents: ['worker'],
    description: "Read the contents of a single file in the target code (.class/.dll will be automatically decompiled and then returned). First use search_target_code to locate the path, and then use this tool to read the specific implementation; when the file is very long, use offset/limit to read it in segments.",
    schema: object({path: str, source: str, offset: int, limit: int}, ['path']),
  },
  {
    key: 'audit_target_code',
    agents: ['worker'],
    description: "Initiate a static audit of the indexed code source, optional. The code source that has been audited will not be run again by default (to prevent repeated consumption). If you really need to review it from another angle, use focus. After running, clues and facts in the form of \"suspected...\" will appear on the exploration map. Those are just clues and still need to be verified.",
    schema: object({source: str, focus: str, force: bool}),
  },
];

export const CODE_INTEL_TOOLS = specs.map(spec => spec.key);

export function registerCodeIntelTools(service: CodeIntelService): void {
  for (const spec of specs) {
    registerTool({
      key: spec.key,
      description: spec.description,
      params: {},
      required: [],
      schema: spec.schema,
      execute: async (params, ctx) => {
        if (!ctx.taskId) throw new Error("The tool requires a task context");

        if (spec.key === 'download_file') {
          return await downloadArtifact(service, {
            taskId: ctx.taskId, intentId: ctx.intentId ?? 0,
            cwd: ctx.cwd ?? service.workDir(ctx.taskId, ctx.intentId ?? 0), signal: ctx.signal,
          }, params);
        }

        const source = String(params.source ?? '').trim() || undefined;
        if (spec.key === 'list_target_sources') return service.describeSources(ctx.taskId);
        if (spec.key === 'search_target_code') {
          return service.search(ctx.taskId, String(params.pattern ?? ''), source, Number(params.limit ?? 30), ctx.signal);
        }
        if (spec.key === 'read_target_code') {
          return service.read(ctx.taskId, String(params.path ?? ''), source, ctx.signal,
            Number(params.offset ?? 0), Number(params.limit ?? 8000));
        }
        if (spec.key === 'audit_target_code') {
          return service.requestAudit(ctx.taskId, source, String(params.focus ?? ''), ctx.signal, params.force === true);
        }
        return service.list(ctx.taskId, String(params.dir ?? ''), source, ctx.signal);
      },
    });
  }
}

export async function seedCodeIntelTools(pool: Pool): Promise<void> {
  const conflicts = (await pool.query(
    'SELECT key FROM tools WHERE key=ANY($1::text[]) AND system=FALSE', [CODE_INTEL_TOOLS])).rows;
  if (conflicts.length) throw new Error("Code tool name conflicts with existing custom tool: " + conflicts.map((row: {key: string}) => row.key).join(', '));
  for (const spec of specs) {
    const agents = JSON.stringify(spec.agents);
    await pool.query(
      `INSERT INTO tools(key,description,schema,agents,enabled,system,kind)
       VALUES($1,$2,$3,$4,TRUE,TRUE,'builtin') ON CONFLICT(key) DO NOTHING`,
      [spec.key, spec.description, spec.schema, agents]);
    await pool.query(
      'INSERT INTO tool_defaults(key,description,schema,agents) VALUES($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING',
      [spec.key, spec.description, spec.schema, agents]);
  }
}
