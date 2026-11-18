import {openSync,closeSync} from 'node:fs';
import {targetSpawn,shellQuote} from '../network/sandbox.ts';
import {currentNetwork} from '../network/context.ts';
/**
 * Managed reverse-engineering proxies.
 *
 * A reverse worker analyses a site's JavaScript, writes a small local proxy and
 * asks the host to run it. That proxy turns plaintext into the site's real
 * encrypted wire format for exactly one interface, so every later worker can
 * keep using the ordinary http_request tool and merely pass an explicit
 * `proxy` argument. Risk stays per call instead of becoming a global route.
 *
 * The host owns the process: it allocates the port, health-checks the listener,
 * records it in reverse_proxies and kills it once the task reaches a terminal
 * state. Workers never manage background processes themselves.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, open, readFile, readdir, realpath, stat,rm} from 'node:fs/promises';
import {connect, createServer,type Server,type Socket} from 'node:net';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {targetRoute,type TargetRoute} from '../traffic/network.ts';
import type {Pool} from 'pg';
import type {ToolContext} from '../tools/gate.ts';

const TERMINAL_STATUS = ['done', 'failed', 'timeout'];
const routeHash=(route:TargetRoute)=>createHash('sha256').update(JSON.stringify([route.proxy,route.caFile,!!route.capture])).digest('hex');
const START_BUDGET_MS = 20_000;
const LIVE_SQL = `SELECT id,pid,script_path FROM reverse_proxies WHERE task_id=$1 AND status IN('starting','running')`;

export interface ProxyScope {origin: string; method: string; path: string}

export interface StartProxyInput {
  script_path: string;
  url: string;
  method: string;
  path?: string;
  usage: string;
  mode?:'adapter'|'legacy';
}

interface ChildEntry {child: ChildProcess; taskId: number; script: string;bridge?:Server;sockets?:Set<Socket>;unix?:string}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("Unable to allocate local port")));
    });
  });
}

function waitListening(port: number, deadline: number, check: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const attempt = (): void => {
      if (settled) return;
      try { check(); } catch(error) { settled=true; reject(error); return; }
      if (Date.now() > deadline) { settled = true; reject(new Error("Agent did not start listening on port within budget " + port)); return; }
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(750);
      let retried=false;
      const retry = () => {
        if (settled||retried) return;
        retried=true;
        socket.destroy();
        setTimeout(attempt, 120);
      };
      socket.once('connect', () => {
        if (settled) { socket.destroy(); return; }
        settled = true; socket.destroy(); resolve();
      });
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function checkedScope(url: string, method: string, pathOverride?: string): ProxyScope {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("url must be http:// or https://");
  if (parsed.username || parsed.password) throw new Error("url cannot carry credentials");
  const verb = String(method ?? '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(verb)) throw new Error("method must be an uppercase HTTP method name");
  const target = pathOverride?.trim() || parsed.pathname;
  if (!target.startsWith('/') || /[?#\\\x00-\x20]/.test(target) || target.includes('*')) {
    throw new Error("path must be an exact path starting with /, or a path template in the form /items/:id, wildcards are not accepted");
  }
  const parts = target.split('/');
  if (parts.some(part => part === '.' || part === '..')) throw new Error("path cannot contain . or ..");
  if (parts.some(part => part.startsWith(':') && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(part))) throw new Error("The path template parameter name is illegal");
  return {origin: parsed.origin, method: verb, path: target};
}

async function markerAlive(pid: number, script: string): Promise<boolean> {
  try {
    const cmdline = await readFile('/proc/' + pid + '/cmdline', 'utf8');
    return cmdline.split('\0').includes(script);
  } catch { return false; }
}

/** Resolve the socket through a directory fd: Linux limits AF_UNIX address bytes,
 * while a legitimate task workspace can have a much longer filesystem path. */
function connectWorkspaceSocket(file:string):Socket {
  const directory=openSync(path.dirname(file),'r');
  let released=false;
  const release=()=>{if(!released){released=true;closeSync(directory);}};
  try {
    const socket=connect(`/proc/self/fd/${directory}/${path.basename(file)}`);
    socket.once('connect',release);socket.once('error',release);socket.once('close',release);
    return socket;
  } catch(error) {release();throw error;}
}

export class ReverseProxies {
  private readonly children = new Map<string, ChildEntry>();
  private readonly starts = new Map<number, Promise<unknown>>();
  private readonly revisions = new Map<number, number>();
  private shutdownRevision = 0;
  constructor(private readonly pool: Pool, private readonly dataDir: string) {}

  private async taskRow(taskId: number): Promise<{status: string; paused: boolean; deleted_at: unknown} | undefined> {
    return (await this.pool.query('SELECT status,paused,deleted_at FROM tasks WHERE id=$1', [taskId])).rows[0];
  }

  private async resolveScript(ctx: ToolContext, taskId: number, relative: string): Promise<string> {
    const root = await realpath(path.join(this.dataDir, 'workspace', 'tasks', String(taskId)));
    const base = ctx.cwd ?? path.join(root, 'i' + ctx.intentId);
    const resolved = await realpath(path.resolve(base, relative)).catch(() => {
      throw new Error("The agent script does not exist or is unreadable; please write it in the intended working directory first and then reference it with a relative path: " + relative);
    });
    if (!resolved.startsWith(root + path.sep)) throw new Error("The agent script must be located in the working directory of this task");
    if (!(await stat(resolved)).isFile()) throw new Error("Agent script is not an ordinary file");
    if (!/\.(?:mjs|js|cjs)$/i.test(resolved)) throw new Error("Agent script must be a .mjs/.js/.cjs file");
    return resolved;
  }

  async start(ctx: ToolContext, input: StartProxyInput, replace = false): Promise<Record<string, unknown>> {
    const taskId=Number(ctx.taskId), revision=this.revisions.get(taskId)??0, shutdown=this.shutdownRevision;
    const previous=this.starts.get(taskId)??Promise.resolve();
    const check=()=>{
      ctx.signal?.throwIfAborted();
      if(revision!==(this.revisions.get(taskId)??0)||shutdown!==this.shutdownRevision)throw new Error("Agent startup canceled");
    };
    const operation=previous.catch(()=>{}).then(()=>{check();return this.startInner(ctx,input,replace,check);});
    this.starts.set(taskId,operation);
    try{return await operation;}finally{if(this.starts.get(taskId)===operation)this.starts.delete(taskId);}
  }

  private async startInner(ctx:ToolContext,input:StartProxyInput,replace:boolean,check:()=>void):Promise<Record<string,unknown>> {
    const taskId = Number(ctx.taskId), intentId = Number(ctx.intentId);
    if (!taskId || !intentId) throw new Error("Starting a reverse proxy requires task and intent context");
    if (!input?.url || !input?.script_path || !input?.usage?.trim()) throw new Error("Required url, script_path and usage usage instructions");
    const task = await this.taskRow(taskId);
    if (!task || task.deleted_at) throw new Error("The task does not exist or has been deleted");
    if (task.status !== 'running' || task.paused) throw new Error("The task is not currently running and the reverse proxy cannot be started.");
    if(ctx.canExecute&&!await ctx.canExecute())throw new Error("Current execution has ended");
    if(!(await this.pool.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent' AND state='running'",[intentId,taskId])).rowCount)throw new Error("Intent does not belong to the currently running task");
    check();
    const scope = checkedScope(input.url, input.method, input.path);
    const duplicate = (await this.pool.query(
      `SELECT id,listen_port,usage,mode,route_hash,status FROM reverse_proxies WHERE task_id=$1 AND origin=$2 AND method=$3 AND path=$4 AND status IN('starting','running')`,
      [taskId, scope.origin, scope.method, scope.path])).rows[0];
    if (duplicate && !replace && duplicate.status === 'starting') {
      return {reused: true, proxy_id: duplicate.id, state: 'starting', scope,
        next: "The agent for the same interface is starting and the port is not ready yet. Wait a few seconds and adjust again; the connection will fail when sending a request at this time."};
    }
    if (duplicate && !replace) {
      check();
      if(duplicate.route_hash!==routeHash(targetRoute()))throw new Error("The proxy routing configuration has changed, please restart with replace=true");
      if(duplicate.mode==='legacy'&&targetRoute().capture)throw new Error("Please replace adapter with adapter when collection is enabled.");
      // Duplicate reverse work is tolerated, but a second listener is not:
      // hand the live one back so this worker continues without redoing it.
      return {
        reused: true, proxy_id: duplicate.id, proxy_url: 'http://127.0.0.1:' + duplicate.listen_port,
        scope, usage: duplicate.usage,
        next: "This interface already has a running reverse proxy, use it to create text requests directly; your script has not been started. Confirm that the existing proxy is unavailable and then restart it with replace=true.",
      };
    }
    // replace=true: an operator or a worker with evidence drops the broken one first.
    if (duplicate) await this.stop(taskId, duplicate.id);
    const script = await this.resolveScript(ctx, taskId, input.script_path);
    check();

    const jump=currentNetwork()?.mode==='jump';
    const route=targetRoute(),mode=input.mode??'adapter';
    if(jump&&mode!=='adapter')throw new Error("Springboard mode uses adapter mode to preserve traffic correlation");
    if(mode==='legacy'&&targetRoute().capture)throw new Error("The adapter mode must be used when traffic collection is turned on. The old self-packaging script cannot guarantee MITM association.");
    const id = randomUUID();
    const port = await allocatePort();
    const dir = path.dirname(script);
    const logPath = path.join(this.dataDir, 'reverse-proxies', id + '.log');
    await mkdir(path.dirname(logPath), {recursive: true, mode: 0o700});
    const outFd = await open(logPath, 'a', 0o600), errFd = await open(logPath, 'a', 0o600);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(dir, 'home'),
      WORMHOLE_REVERSE_PROXY_ID: id,
      WORMHOLE_REVERSE_UPSTREAM:JSON.stringify({proxy:route.proxy,caFile:route.caFile}),
      WORMHOLE_REVERSE_PROXY_PORT: String(port),
      WORMHOLE_REVERSE_PROXY_ORIGIN: scope.origin,
      WORMHOLE_REVERSE_PROXY_METHOD: scope.method,
      WORMHOLE_REVERSE_PROXY_PATH: scope.path,
      WORMHOLE_REVERSE_PROXY_SCOPE: JSON.stringify(scope),
      WORMHOLE_REVERSE_PROXY_LOG: logPath,
    };
    let child: ChildProcess;
    let entry:ChildEntry|undefined;
    const state: {exit?: string} = {};
    try {
      const runner=fileURLToPath(new URL('./runner.mjs',import.meta.url));
      if(jump){
        const gateway=new URL(route.proxy);gateway.hostname='127.0.0.1';gateway.port='18080';env.WORMHOLE_REVERSE_UPSTREAM=JSON.stringify({proxy:gateway.href,caFile:route.caFile});
        const isolated=targetSpawn({command:[process.execPath,runner,script].map(shellQuote).join(' '),cwd:dir,env},{marker:script,envKeys:Object.keys(env),mounts:[path.dirname(runner),fileURLToPath(new URL('../../../node_modules',import.meta.url))],exports:[{port,socket:path.join(dir,'.wormhole-rp-'+id.replaceAll('-','').slice(0,16)+'.sock')}]});
        child=spawn('/bin/bash',['-c',isolated.command],{cwd:dir,env:isolated.env,stdio:['ignore',outFd.fd,errFd.fd],windowsHide:true});
      }else child = spawn(process.execPath, mode==='adapter'?[runner,script]:[script], {cwd: dir, env, stdio: ['ignore', outFd.fd, errFd.fd], windowsHide: true});
      // Monitor and follow spawn：The same is true for closing the log handle below await，may also be triggered during error
      const proc = child;
      proc.once('exit', (code, signal) => {
        state.exit = `The agent process has exited code=${code ?? ''} signal=${signal ?? ''}`;
        if (this.children.get(id)?.child !== proc) return;
        this.children.delete(id);for(const socket of entry?.sockets??[])socket.destroy();entry?.bridge?.close();if(entry?.unix)void rm(entry.unix,{force:true});
        void this.pool.query(
          `UPDATE reverse_proxies SET status='failed',error=$2,updated_at=now(),stopped_at=now()
            WHERE id=$1 AND status IN('starting','running')`, [id, state.exit]).catch(() => {});
      });
      proc.once('error', error => { state.exit = "Agent process failed to start: " + String((error as Error).message); });
    } finally {
      await outFd.close();
      await errFd.close();
    }
    entry={child,taskId,script};this.children.set(id,entry);
    if(jump){
      entry.unix=path.join(dir,'.wormhole-rp-'+id.replaceAll('-','').slice(0,16)+'.sock');entry.sockets=new Set();
      entry.bridge=createServer(client=>{let upstream:Socket;try{upstream=connectWorkspaceSocket(entry.unix!);}catch{client.destroy();return;}for(const peer of [client,upstream]){entry.sockets!.add(peer);peer.on('close',()=>{entry.sockets!.delete(peer);client.destroy();upstream.destroy();});peer.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);});
    }
    // Register first starting and write PID：After this, the host crashes and recovery can be PID Find it and end it
    try {
      await this.pool.query(
        `INSERT INTO reverse_proxies(id,task_id,intent_id,origin,method,path,listen_port,pid,status,usage,script_path,log_path,mode,route_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'starting',$9,$10,$11,$12,$13)`,
        [id, taskId, intentId, scope.origin, scope.method, scope.path, port, child.pid ?? null,
         input.usage.trim(), script, logPath, mode, routeHash(route)]);
    } catch (error) {
      await this.terminate(id, null, null);
      throw error;
    }
    const abort = async (reason: string): Promise<never> => {
      await this.terminate(id,null,null);
      await this.pool.query("UPDATE reverse_proxies SET status='failed',error=$2,stopped_at=now(),updated_at=now() WHERE id=$1 AND status IN('starting','running')",[id,reason]).catch(()=>{});
      const tail = await readFile(logPath, 'utf8').then(text => text.slice(-1200)).catch(() => '');
      throw new Error(reason + (tail ? "\nAgent log tail:\n" + tail : ''));
    };
    if (state.exit) return await abort(state.exit);
    try {
      if(jump){const deadline=Date.now()+START_BUDGET_MS;while(!await stat(entry!.unix!).then(x=>x.isSocket()).catch(()=>false)){check();if(state.exit)throw new Error(state.exit);if(Date.now()>deadline)throw new Error("Agent isolation listening timeout");await sleep(100);}
        await new Promise<void>((resolve,reject)=>entry!.bridge!.once('error',reject).listen(port,'127.0.0.1',resolve));}
      await waitListening(port, Date.now() + START_BUDGET_MS,()=>{check();if(state.exit)throw new Error(state.exit);});
      check();
      const current=await this.taskRow(taskId);
      if(!current||current.deleted_at||current.paused||current.status!=='running'||ctx.canExecute&&!await ctx.canExecute())throw new Error("Task execution has stopped, agent startup canceled");
      check();
      if (state.exit) throw new Error(state.exit);
      const activated = await this.pool.query(
        `UPDATE reverse_proxies SET status='running',pid=$2,updated_at=now() WHERE id=$1 AND status='starting'`,
        [id, child.pid ?? null]);
      if (!activated.rowCount) throw new Error("The agent has been stopped or replaced before the startup is completed, and the result is invalid.");
      check();
      if(state.exit)throw new Error(state.exit);
    } catch (error) {
      return await abort(String((error as Error).message));
    }
    return {
      proxy_id: id,
      proxy_url: 'http://127.0.0.1:' + port,
      scope,
      usage: input.usage.trim(),
      next: "Use record_fact to write proxy_url, scope and usage back to the exploration graph; subsequent workers use the proxy parameter of http_request to create text requests to automatically encrypt and decrypt.",
    };
  }

  async list(taskId: number, origin?: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.pool.query(
      `SELECT id,intent_id,origin,method,path,listen_port,status,usage,error,fact_id,created_at
         FROM reverse_proxies WHERE task_id=$1 AND ($2::text IS NULL OR origin=$2)
        ORDER BY created_at DESC LIMIT 50`, [taskId, origin?.trim() || null])).rows;
    return rows.map(row => ({...row, proxy_url: row.status === 'running' ? 'http://127.0.0.1:' + row.listen_port : null}));
  }

  /**
   * Press WORMHOLE_REVERSE_PROXY_ID in /proc Looking for residual processes。
   * found=Found；absent=Reliably checked and determined not to have；unknown=Cannot be checked and cannot be treated as non-existent。
   */
  private async findByProxyId(id: string): Promise<{state: 'found'; pid: number} | {state: 'absent'} | {state: 'unknown'; reason: string}> {
    if (process.platform !== 'linux') return {state: 'unknown', reason: "Not Linux, cannot check process table"};
    let names: string[];
    try { names = await readdir('/proc'); }
    catch (error) { return {state: 'unknown', reason: "Unable to enumerate /proc: " + String((error as Error).message)}; }
    const needle = `WORMHOLE_REVERSE_PROXY_ID=${id}`;
    let unreadable = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let env: string;
      try { env = await readFile(`/proc/${name}/environ`, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        unreadable += 1; continue;
      }
      if (env.split('\0').includes(needle)) return {state: 'found', pid: Number(name)};
    }
    if (unreadable > 0) return {state: 'unknown', reason: `${unreadable} Processes cannot read environment variables`};
    return {state: 'absent'};
  }

  private async terminate(id: string, pid: number | null, script: string | null): Promise<boolean> {
    const entry = this.children.get(id);
    if (entry) {
      this.children.delete(id);for(const socket of entry.sockets??[])socket.destroy();entry.bridge?.close();if(entry.unix)await rm(entry.unix,{force:true});
      entry.child.kill('SIGTERM');
      for (let i = 0; i < 30; i++) {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) return true;
        await sleep(100);
      }
      try { entry.child.kill('SIGKILL'); } catch {}
      return true;
    }
    // None PID：Press unique agent ID Verification; only ”confirmed not to exist” is the cleanup completed
    if (!pid || !script) {
      const first = await this.findByProxyId(id);
      if (first.state === 'absent') return true;
      if (first.state === 'unknown') {
        console.warn("[proxy] Unable to verify residual processes, keep records for retry", JSON.stringify({id, reason: first.reason}));
        return false;
      }
      try { process.kill(first.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 20; i++) {
        if ((await this.findByProxyId(id)).state === 'absent') return true;
        await sleep(100);
      }
      try { process.kill(first.pid, 'SIGKILL'); } catch {}
      const last = await this.findByProxyId(id);
      if (last.state === 'unknown') {
        console.warn("[proxy] still cannot be verified after termination, keep records", JSON.stringify({id, reason: last.reason}));
        return false;
      }
      return last.state === 'absent';
    }
    if (!await markerAlive(pid, script)) return true;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20; i++) {
      if (!await markerAlive(pid, script)) return true;
      await sleep(100);
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return !(await markerAlive(pid, script));
  }

  private async stopRows(rows: {id: string; pid: number | null; script_path: string}[], reason: string): Promise<number> {
    let stopped = 0;
    for (const row of rows) {
      const confirmed = await this.terminate(row.id, row.pid, row.script_path).catch(() => false);
      if (!confirmed) {
        // Remain active without confirming the termination, and will try again in the next round of recovery
        await this.pool.query(
          `UPDATE reverse_proxies SET error=$2,updated_at=now() WHERE id=$1 AND status IN('starting','running')`,
          [row.id, "Unconfirmed termination:" + reason]).catch(() => {});
        continue;
      }
      await this.pool.query(
        `UPDATE reverse_proxies SET status='stopped',error=COALESCE(error,$2),stopped_at=now(),updated_at=now()
          WHERE id=$1 AND status IN('starting','running')`, [row.id, reason]);
      stopped++;
    }
    return stopped;
  }

  async stop(taskId: number, proxyId?: string): Promise<{stopped: number}> {
    const rows = proxyId
      ? (await this.pool.query(
          `SELECT id,pid,script_path FROM reverse_proxies WHERE id=$1 AND task_id=$2 AND status IN('starting','running')`,
          [proxyId, taskId])).rows
      : (await this.pool.query(LIVE_SQL, [taskId])).rows;
    return {stopped: await this.stopRows(rows, "Stopped explicitly by tool")};
  }

  /** Task reached a terminal state: its proxies must not outlive it. */
  async stopTaskIfTerminal(taskId: number): Promise<void> {
    const task = await this.taskRow(taskId);
    if (task && !TERMINAL_STATUS.includes(task.status)) return;
    await this.stopTask(taskId);
  }

  async stopTask(taskId: number): Promise<number> {
    this.revisions.set(taskId,(this.revisions.get(taskId)??0)+1);
    await this.starts.get(taskId)?.catch(()=>{});
    const rows = (await this.pool.query(LIVE_SQL, [taskId])).rows;
    let stopped = await this.stopRows(rows, "Task has ended");
    for (const [id, entry] of [...this.children.entries()]) {
      if (entry.taskId !== taskId) continue;
      await this.terminate(id, null, null).catch(() => {});
      stopped++;
    }
    return stopped;
  }

  /** Boot: no proxy from a previous host process may survive. */
  async recover(): Promise<number> {
    const rows = (await this.pool.query(
      `SELECT id,pid,script_path FROM reverse_proxies WHERE status IN('starting','running')`)).rows;
    return this.stopRows(rows, "Host restart cleanup");
  }

  async stopAll(): Promise<number> {
    this.shutdownRevision++;
    await Promise.allSettled([...this.starts.values()]);
    const rows = (await this.pool.query(
      `SELECT id,pid,script_path FROM reverse_proxies WHERE status IN('starting','running')`)).rows;
    let stopped = await this.stopRows(rows, "Host shut down");
    for (const id of [...this.children.keys()]) {
      await this.terminate(id, null, null).catch(() => {});
      stopped++;
    }
    return stopped;
  }

  /** The per-call override must reference this task's live, registered endpoint. */
  async authorize(taskId:number|undefined,proxy:string,url:string,method:string):Promise<TargetRoute>{
    if(!taskId)throw new Error("Reverse proxy requires current task context");
    const address=new URL(proxy);
    if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||!address.port||address.username||address.password||address.pathname!=='/'||address.search||address.hash)throw new Error("proxy must be a registered local loopback proxy address");
    const row=(await this.pool.query("SELECT p.id,p.origin,p.method,p.path,p.mode,p.route_hash FROM reverse_proxies p JOIN tasks t ON t.id=p.task_id WHERE p.task_id=$1 AND p.listen_port=$2 AND p.status='running' AND t.status='running' AND NOT t.paused AND t.deleted_at IS NULL",[taskId,Number(address.port)])).rows[0];
    if(!row)throw new Error("The agent is not registered in the currently running task");
    const route=targetRoute();if(row.route_hash!==routeHash(route))throw new Error("The proxy routing configuration has changed, please restart the adapter");
    if(row.mode==='legacy'&&route.capture)throw new Error("The old agent cannot guarantee MITM collection, please switch to adapter mode");
    const target=new URL(url),parts=String(row.path).split('/'),actual=target.pathname.split('/');
    if(row.origin!==target.origin||row.method!==method||parts.length!==actual.length||!parts.every((p:string,i:number)=>p.startsWith(':')?!!actual[i]:p===actual[i]))throw new Error("The request exceeds the interface range of the registered agent");
    return {...route,reverseProxyId:String(row.id)};
  }
}
