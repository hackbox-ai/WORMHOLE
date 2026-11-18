/**
 * Code intelligence pipeline: product landing → Import white box → Issue audit → Generate common clue facts。
 *
 * The model does not participate in this section and should not know that the white box exists. It will only see two categories of results：
 *   1. Tool search_target_code / read_target_code / list_target_code（Ready to use）
 *   2. In the form of ”suspected SQL Injection：app.py:128 — …」of ordinary inferred Facts (from audit）
 */
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {copyFile, mkdir, open, readdir, readFile, rm, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Pool} from 'pg';
import {WhiteboxClient, type WhiteboxFinding} from './client.ts';
import {detect, digestFile, inspectZipBudget, isNative, repackToZip, zipDirectory, type ArtifactKind} from './artifacts.ts';

export interface CodeIntelOptions {
  enabled: boolean;
  baseUrl: string;
  pollSeconds: number;
  auditTimeoutSeconds: number;
  focus: string;
  /** White box audit is not automatically sent by default: by worker Use audit_target_code Decide for yourself whether you want to spend this time。 */
  audit: boolean;
  token?:string;
}

const DEFAULTS: CodeIntelOptions = {
  enabled: false,
  baseUrl: '',
  pollSeconds: 15,
  auditTimeoutSeconds: 1800,
  focus: "Prioritize auditing of externally accessible request processing paths, authentication decisions, parameter bindings and data access (SQL/commands/files), ignoring pure front-end styles and test codes.",
  audit: false,
};

export interface ReadySource {
  factId: number;
  repoId: string;
  name: string;
  artifactKind: string;
  sourceKey: string;
  auditState: string;
  findings: number;
  partial?: boolean;
  omitted?: {links: number; paths: number; read_errors: number};
}

/** The white box can be eaten directly, or we can convert it into zip products are taken over; naked ELF/PE（Not Go）White box does not parse, skip。 */
const INGESTIBLE = new Set<ArtifactKind>(['zip', 'jar', 'apk', 'wxapkg', 'gobinary', 'tar', 'gzip', 'bzip2', 'xz', 'zstd']);

const KIND_SOURCE = 'code_source';

/** Only look at these suffixes to avoid traversing the entire tree to do large file hashes。 */
const WORK_ARTIFACT_EXT = /\.(apk|xapk|apks|ipa|zip|jar|war|ear|aar|wxapkg|tar|tgz|gz|bz2|xz|zst|7z)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'tmp', 'pi-sessions', '.cache', '.reverse-tmp', '__pycache__', 'venv', '.venv']);
const SCAN_INTERVAL_MS = 60_000;
const SCAN_MAX_ENTRIES = 20_000;
const SCAN_MAX_DEPTH = 5;

/** Pure binary container: whatever hits are meaningless for text retrieval。 */
const BINARY_EXT = /\.(so|a|dylib|bin|dat|pak|bundle|odex|vdex|zip|png|jpe?g|gif|webp|bmp|ico|ttf|otf|woff2?|eot|mp3|mp4|wav|ogg|webm|pdf|cer|lic|keystore|jks|sqlite|db)$/i;
/** Bytecode containers: Whitebox will decompile them into source code and mark them decompiled，Unmarked only as binary。 */
const DECOMPILABLE_EXT = /\.(class|dll|exe|jar|aar|apk|dex)$/i;
/** The proportion of control characters in the hit text is too high, indicating that what is obtained is binary garbled code.。 */
const looksBinaryText = (text: string): boolean => {
  if (!text) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0xfffd) bad++;
  }
  return bad / text.length > 0.1;
};
const KIND_READY = 'code_ready';
const KIND_FINDING = 'code_finding';
const MAX_IMPORT_ATTEMPTS = 2;
/** Minimum interval for the same workspace snapshot: do not package and import repeatedly when files are changing all the time。 */
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;
/** Snapshot fingerprint and packaging boundaries to avoid disk and packaging in large warehouses CPU Full。 */
const SNAPSHOT_MAX_ENTRIES = 4_000;
const SNAPSHOT_ZIP_TIMEOUT_MS = 120_000;
const SNAPSHOT_ZIP_MAX_BYTES = 512 * 1024 * 1024;
/** claimed It has not been advanced beyond this time. running，Considered as placeholder failure。 */
const CLAIM_TTL_MS = 10 * 60_000;
/** Global import gate: When multiple tasks have large packages at the same time, unpack them/Uploading will not fill up the host。 */
const IMPORT_MAX_CONCURRENCY = 2;
const importGate = {active: 0, waiters: [] as (() => void)[]};
async function withImportSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (importGate.active >= IMPORT_MAX_CONCURRENCY) {
    // Queuing for a slot must also be cancelled, otherwise abort I will continue to work in the future
    await new Promise<void>((resolve, reject) => {
      const grant = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const index = importGate.waiters.indexOf(grant);
        if (index >= 0) importGate.waiters.splice(index, 1);
        reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, {once: true});
      importGate.waiters.push(grant);
    });
  }
  importGate.active++;
  try { return await fn(); }
  finally { importGate.active--; importGate.waiters.shift()?.(); }
}
const execFileAsync = promisify(execFile);

/** Read git Configuration; compatible worktree（.git is a file, the content is "gitdir: ..."）。 */
async function readGitConfig(dir: string): Promise<string | null> {
  const direct = await readFile(path.join(dir, '.git', 'config'), 'utf8').catch(() => null);
  if (direct) return direct;
  const pointer = await readFile(path.join(dir, '.git'), 'utf8').catch(() => null);
  if (!pointer) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
  const gitdir = match?.[1]?.trim();
  if (!gitdir) return null;
  let target = path.resolve(dir, gitdir);
  // linked worktree of gitdir in .git/worktrees/<name>，The real configuration is in commondir points to the public directory
  const common = await readFile(path.join(target, 'commondir'), 'utf8').catch(() => null);
  if (common) target = path.resolve(target, common.trim());
  return await readFile(path.join(target, 'config'), 'utf8').catch(() => null);
}

/** Just look at the head to determine whether it is Go/ELF/PE/Mach-O；Avoid full read of each file。 */
async function looksLikeBinary(file: string): Promise<boolean> {
  // Read-only header 16 Bytes; don’t read the entire file into memory just to ”take a look”
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return false;
  let head: Buffer;
  try {
    head = Buffer.alloc(16);
    const {bytesRead} = await handle.read(head, 0, 16, 0);
    if (bytesRead < 16) return false;
  } finally {
    await handle.close().catch(() => {});
  }
  const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  const pe = head[0] === 0x4d && head[1] === 0x5a;
  const macho = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca]
    .includes(head.readUInt32BE(0));
  return elf || pe || macho;
}

export class CodeIntelService {
  readonly options: CodeIntelOptions;
  private client: WhiteboxClient;
  private reachability = {checkedAt: 0, ok: false};
  private readonly scanCache = new Map<string, {size: number; mtimeMs: number; retryAt?: number}>();
  /** Count of tasks performing file operations on the workspace: Delete/Wait until it returns to zero before cleaning.。 */
  private readonly busyCount = new Map<number, number>();
  private readonly lastScan = new Map<number, number>();

  constructor(private readonly pool: Pool, private readonly dataDir: string, options: Partial<CodeIntelOptions> = {}) {
    this.options = {...DEFAULTS, ...options};
    this.client = new WhiteboxClient(this.options.baseUrl,this.options.token);
  }

  configure(patch:Partial<CodeIntelOptions>){Object.assign(this.options,patch);this.client=new WhiteboxClient(this.options.baseUrl,this.options.token);this.reachability={checkedAt:0,ok:false};}
  async recordArtifact(taskId:number,intentId:number,file:string,info:{name:string;size:number;sha256:string;kind:unknown}){
    await this.addFact(taskId,"Saved products:"+info.name,{kind:'artifact_download',name:info.name,path:file,size:info.size,sha256:info.sha256,artifact_kind:info.kind,intent_id:intentId});
  }
  stopCancelSweeper(){if(this.sweepTimer)clearInterval(this.sweepTimer);this.sweepTimer=null;}
  private async reachable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.reachability.checkedAt < 60_000) return this.reachability.ok;
    this.reachability = {checkedAt: now, ok: await this.client.healthy()};
    return this.reachability.ok;
  }

  /** and workspace/layout.ts of taskWorkDir Maintain consistent directory derivation。 */
  workDir(taskId: number, intentId = 0): string {
    const base = path.join(this.dataDir, 'workspace', 'tasks', String(taskId));
    return intentId > 0 ? path.join(base, 'i' + intentId) : base;
  }

  private async addFact(taskId: number, summary: string, payload: Record<string, unknown>): Promise<number> {
    const row = (await this.pool.query(
      `INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,state,origin,priority)
       SELECT $1, exploration_id, 'fact', $2, $3::jsonb, 'confirmed', 'system', 5 FROM tasks WHERE id=$1
       RETURNING id`, [taskId, summary, JSON.stringify({summary, ...payload})])).rows[0];
    return Number(row.id);
  }

  private async patchFact(factId: number, patch: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE exploration_nodes SET payload=payload||$2::jsonb WHERE id=$1', [factId, JSON.stringify(patch)]);
  }

  // ---------------------------------------------------------------- Landing registration

  async ingestFile(taskId: number, intentId: number, file: string,
                   extra: {wxapkg_appid?: string} = {}): Promise<{name: string; kind: ArtifactKind} | null> {
    if (!this.options.enabled) return null;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < 64) return null;
    const kind = await detect(file);
    if (!kind || !INGESTIBLE.has(kind)) return null;
    const sha256 = await digestFile(file);
    const name = path.basename(file);
    const dup = (await this.pool.query(
      `SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'kind'=$2 AND payload->>'sha256'=$3 LIMIT 1`, [taskId, KIND_SOURCE, sha256])).rowCount;
    if (dup) {
      // Same content but with new parameters added (such as wxapkg AppID）：Merge meta information and allow re-import, do not throw away parameters due to deduplication
      if (extra.wxapkg_appid) {
        await this.pool.query(
          `UPDATE exploration_nodes SET payload = payload || jsonb_build_object(
             'wxapkg_appid',$3,'import_attempts',0,'import_error',NULL)
           WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'sha256'=$4
             AND COALESCE(payload->>'wxapkg_appid','') IS DISTINCT FROM $3`,
          [taskId, KIND_SOURCE, extra.wxapkg_appid, sha256]).catch(() => {});
      }
    }
    if (!dup) {
      const summary = `Registered products:${name}（${info.size} Byte, type ${kind}，sha256 ${sha256.slice(0, 12)}…）`;
      await this.addFact(taskId, summary, {
        kind: KIND_SOURCE, source_type: 'file', source_key: sha256, sha256,
        path: file, name, size: info.size, artifact_kind: kind, intent_id: intentId,
        ...(extra.wxapkg_appid ? {wxapkg_appid: extra.wxapkg_appid} : {}),
      });
    }
    return {name, kind};
  }

  async ingestGit(taskId: number, intentId: number, url: string): Promise<void> {
    if (!this.options.enabled) return;
    const clean = url.trim();
    if (!/^https?:\/\/\S+$/.test(clean)) return;
    const key = 'git:' + clean;
    const dup = (await this.pool.query(
      `SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'kind'=$2 AND payload->>'source_key'=$3 LIMIT 1`, [taskId, KIND_SOURCE, key])).rowCount;
    if (dup) return;
    await this.addFact(taskId, `Registered code repository:${clean}`, {
      kind: KIND_SOURCE, source_type: 'git', source_key: key, url: clean, intent_id: intentId,
    });
  }

  // ---------------------------------------------------------------- State machine

  /** The product is taken over as soon as it is launched: it doesn’t matter how the model is brought in, it will be automatically registered and indexed when it is dropped into the working directory.。 */
  private async scanWorkDir(taskId: number, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    if (now - (this.lastScan.get(taskId) ?? 0) < SCAN_INTERVAL_MS) return;
    this.lastScan.set(taskId, now);
    const root = path.join(this.dataDir, 'workspace', 'tasks', String(taskId));
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > SCAN_MAX_DEPTH || signal?.aborted) return;
      const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
      for (const entry of entries) {
        if (visited++ > SCAN_MAX_ENTRIES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIR.has(entry.name)) continue;
          // worker Use git clone Get down the warehouse: read .git/config of origin Give it to the white box button git Pull
          if (depth <= SCAN_MAX_DEPTH - 1) await this.ingestLocalRepo(taskId, full, signal).catch(() => {});
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(full).catch(() => null);
        if (!info?.isFile() || info.size < 1024) continue;
        // Look at the cache first: even the headers of files that have not changed are not read.
        const seen = this.scanCache.get(full);
        // Successful cache: skip if there is no change; failed cache: skip before expiration, try again after expiration
        if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs
            && (seen.retryAt === undefined || Date.now() < seen.retryAt)) continue;
        const named = WORK_ARTIFACT_EXT.test(entry.name);
        // Files without suffix may also be Go/Native Binary: Take a budget look at the magic number, don’t just look at the extension
        if (!named) {
          if (info.size < 64 * 1024) continue;
          if (!await looksLikeBinary(full)) continue;
        }
        const intent = Number(/[\\/]i(\d+)(?:[\\/]|$)/.exec(full.slice(root.length))?.[1] ?? 0);
        const added = await this.ingestFile(taskId, intent, full).catch(() => null);
        if (added) {
          this.scanCache.set(full, {size: info.size, mtimeMs: info.mtimeMs});
          console.info("[codeintel] Automatically take over products", JSON.stringify({taskId, file: full, kind: added.kind}));
        } else if (WORK_ARTIFACT_EXT.test(full) || named) {
          // It may be a temporary failure (the library is unavailable, the file is still being written): try again after a short backoff, do not cache it as ”no need to process”
          this.scanCache.set(full, {size: info.size, mtimeMs: info.mtimeMs, retryAt: Date.now() + 60_000});
        }
      }
    };
    await walk(root, 0);
  }

  /**
   * Local git Warehouse indexed by workspace snapshot: actual content on disk packed，
   * No need origin Pull the default branch again (then the index may be another version)）。
   * Snapshot record packaging time, hash、HEAD/Branches and uncommitted changes, used to determine whether they are old when querying。
   */
  private async ingestLocalRepo(taskId: number, dir: string, signal?: AbortSignal): Promise<void> {
    const config = await readGitConfig(dir);
    if (!config) return;
    const meta = await this.gitMeta(dir);
    const fp = await this.dirFingerprint(dir, meta).catch(() => ({value: '', truncated: true}));
    // For directory identity dir_key，Version identity with hash source_key —— Only the new version has a new identity and old records can be replaced.
    const dirKey = 'snapshot:' + dir;
    const prior = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'kind'=$2 AND payload->>'dir_key'=$3 ORDER BY id DESC LIMIT 1`,
      [taskId, KIND_SOURCE, dirKey])).rows[0];
    if (prior) {
      const sameHead = String(prior.payload.git_head ?? '') === String(meta.git_head ?? '');
      // Places that are not covered by the fingerprint (the traversal is truncated) cannot be determined as ”no change” based on this.”
      if (!fp.truncated && String(prior.payload.dir_fingerprint ?? '') === fp.value) return;
      const last = Date.parse(String(prior.payload.snapshot_at ?? '')) || 0;
      const window = fp.truncated ? 30 * 60_000 : SNAPSHOT_MIN_INTERVAL_MS;
      if (sameHead && last && Date.now() - last < window) return;
      await this.patchFact(Number(prior.id), {superseded: true});
    }
    if (signal?.aborted) return;
    const captureStartedAt = new Date().toISOString();   // The file may still be changing during packaging, please note the interval.
    const packed = await withImportSlot(signal, () => this.zipTree(taskId, dir, signal)).catch(error => {
      console.error("[codeintel] Snapshot packaging failed", String(error));
      return null;
    });
    if (!packed) return;
    const zip = packed.zip;
    const info = await stat(zip).catch(() => null);
    const sha256 = await digestFile(zip).catch(() => '');
    if (!info || !sha256) return;
    const name = path.basename(dir) || 'workspace';
    await this.addFact(taskId, `Registered workspace snapshot:${name}`, {
      kind: KIND_SOURCE, source_type: 'snapshot', dir_key: dirKey,
      source_key: `${dirKey}:${sha256.slice(0, 16)}`, sha256,
      path: zip, name: `${name}.zip`, size: info.size, artifact_kind: 'zip', intent_id: 0,
      snapshot_dir: dir, snapshot_at: new Date().toISOString(),
      // What is omitted must be written clearly: cannot be read ≠ Does not exist, link/Exception path skipped and not ”full index””
      ...(packed.readErrors || packed.skippedUnsafe || packed.skippedLinks
        ? {snapshot_partial: true, snapshot_skipped_links: packed.skippedLinks,
           snapshot_skipped_paths: packed.skippedUnsafe, snapshot_read_errors: packed.readErrors}
        : {}),
      capture_started_at: captureStartedAt, capture_finished_at: new Date().toISOString(),
      capture_consistency: "zip is only guaranteed to be consistent with the packaging time; the rewritten content in the interval may correspond to the new version",
      dir_fingerprint: fp.value, dir_fingerprint_truncated: fp.truncated,
      ...meta,
    });
  }

  /** Branch、HEAD and whether there are uncommitted changes. If you can’t get it, leave it blank. Don’t make it up.。 */
  private async gitMeta(dir: string): Promise<Record<string, unknown>> {
    const git = async (args: string[]): Promise<string> =>
      (await execFileAsync('git', ['-C', dir, ...args], {timeout: 5_000, maxBuffer: 1 << 20})).stdout.trim();
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    const head = await git(['rev-parse', 'HEAD']).catch(() => '');
    const status = await git(['status', '--porcelain']).catch(() => null);
    const dirty = status !== null && status.length > 0;
    const statusDigest = status === null ? '' : createHash('sha1').update(status).digest('hex').slice(0, 16);
    return {...(branch ? {git_branch: branch} : {}), ...(head ? {git_head: head} : {}), git_dirty: dirty,
      ...(statusDigest ? {git_status_digest: statusDigest} : {})};
  }

  /**
   * Workspace Fingerprint: True HEAD/Branch, number of files, latest mtime、.git/HEAD of mtime。
   * Traversal has upper limit; mark once boundary is reached truncated，The caller can no longer assume that ”no change””。
   */
  private async dirFingerprint(dir: string, meta: Record<string, unknown> = {}): Promise<{value: string; truncated: boolean}> {
    let count = 0, truncated = false;
    // File-by-file summarization: A single future timestamp no longer obscures changes in other files
    const entries: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 8) { truncated = true; return; }
      if (count > SNAPSHOT_MAX_ENTRIES) { truncated = true; return; }
      const listing = await readdir(current, {withFileTypes: true}).catch(() => []);
      for (const entry of listing) {
        if (count++ > SNAPSHOT_MAX_ENTRIES) { truncated = true; return; }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIR.has(entry.name)) await walk(full, depth + 1);
          continue;
        }
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        entries.push(`${path.relative(dir, full)}:${info.size}:${Math.round(info.mtimeMs)}:${Math.round(info.ctimeMs)}`);
      }
    };
    await walk(dir, 0);
    const headInfo = await stat(path.join(dir, '.git', 'HEAD')).catch(() => null);
    const filesDigest = createHash('sha1').update(entries.sort().join('\n')).digest('hex');
    const value = [
      String(meta.git_head ?? ''), String(meta.git_branch ?? ''),
      String(meta.git_status_digest ?? (meta.git_dirty === true ? 'dirty' : 'clean')),
      count, Math.round(headInfo?.mtimeMs ?? 0), filesDigest,
    ].join(':');
    return {value, truncated};
  }

  /** Type the workspace into zip（Not included .git/Dependency/Constructed product), with upper volume and time limits。 */
  private async zipTree(taskId: number, dir: string, signal?: AbortSignal):
    Promise<{zip: string; skippedLinks: number; skippedUnsafe: number; readErrors: number}> {
    const outDir = path.join(this.dataDir, 'codeintel', String(taskId), 'snapshots');
    await mkdir(outDir, {recursive: true, mode: 0o700});
    const out = path.join(outDir, `snapshot-${Date.now()}.zip`);
    let zipStats = {skippedLinks: 0, skippedUnsafe: 0, readErrors: 0};
    try {
      const stats = await zipDirectory(dir, out, signal, {keepEmpty: true});
      zipStats = stats;
    } catch (error) {
      await rm(out, {force: true}).catch(() => {});
      throw error;
    }
    const info = await stat(out).catch(() => null);
    if (!info || info.size > SNAPSHOT_ZIP_MAX_BYTES) {
      await rm(out, {force: true}).catch(() => {});
      throw new Error(`Snapshot is too large or packaging fails:${dir}`);
    }
    return {zip: out, skippedLinks: zipStats.skippedLinks, skippedUnsafe: zipStats.skippedUnsafe, readErrors: zipStats.readErrors};
  }

  /** Is this task performing file-level operations (scanning, unpacking, packaging, importing?）。 */
  busy(taskId: number): boolean { return (this.busyCount.get(taskId) ?? 0) > 0; }

  private async withTaskWork<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
    this.busyCount.set(taskId, (this.busyCount.get(taskId) ?? 0) + 1);
    try { return await fn(); }
    finally {
      const left = (this.busyCount.get(taskId) ?? 1) - 1;
      if (left <= 0) this.busyCount.delete(taskId); else this.busyCount.set(taskId, left);
    }
  }

  async tick(taskId: number, signal?: AbortSignal, mode: 'full' | 'collect' = 'full'): Promise<void> {
    return await this.withTaskWork(taskId, () => this.tickInner(taskId, signal, mode));
  }

  private recovered = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * Task-independent cancellation recycling: still valid after the task ends, stops, and the host restarts。
   * Not hung on any task tick Up - That’s the gap where ”no one will deal with it after the mission is over”。
   */
  startCancelSweeper(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    const run = (): void => { void this.sweepCancels().catch(() => {}); };
    run();
    this.sweepTimer = setInterval(run, intervalMs);
    this.sweepTimer.unref?.();
  }

  private sweeping = false;

  private async sweepCancels(): Promise<void> {
    if (this.sweeping) return;          // Do not start another round before the last round is over.
    this.sweeping = true;
    try {
      const rows = (await this.pool.query(
        `SELECT DISTINCT task_id FROM exploration_nodes
          WHERE kind='fact' AND (payload->>'audit_state' = 'cancel_pending'
            OR jsonb_array_length(COALESCE(payload->'audit_cancel_queue','[]'::jsonb)) > 0)`)).rows;
      for (const row of rows) await this.retryCancels(Number(row.task_id)).catch(() => {});
      this.recovered = true;
    } finally {
      this.sweeping = false;
    }
  }

  /** First round of recovery: If the bit fails, the bit will not be set. Continue to try in the next round to avoid giving up permanently if the white box is temporarily unavailable.。 */
  async recoverPendingCancels(): Promise<void> {
    if (this.recovered) return;
    await this.sweepCancels().catch(() => {});
  }

  private async tickInner(taskId: number, signal: AbortSignal | undefined, mode: 'full' | 'collect'): Promise<void> {
    await this.recoverPendingCancels().catch(() => {});
    if(!this.options.enabled){if(this.options.baseUrl&&await this.reachable()){await this.retryCancels(taskId);await this.collect(taskId,signal);}return;}
    // After the task is finalized, only existing work will be recycled: no new analysis will be scanned, imported or dispatched.
    if (mode === 'full') {
      // Register first and then check connectivity: When the white box is temporarily unavailable, the facts will still be included in the image, and it will be automatically imported after recovery.。
      await this.scanWorkDir(taskId, signal).catch(error => console.error('[codeintel] scan:', String(error)));
      if (signal?.aborted || !await this.reachable()) return;
      await withImportSlot(signal, () => this.importPending(taskId, signal)).catch(error => console.error('[codeintel] import:', String(error)));
      if (signal?.aborted) return;
      await this.dispatchPending(taskId, signal).catch(error => console.error('[codeintel] dispatch:', String(error)));
    }
    if (signal?.aborted || !await this.reachable()) return;
    // Cancellation of recycling is a resident responsibility of the background: you cannot just wait for others to explicitly stop
    await this.retryCancels(taskId).catch(error => console.error('[codeintel] retryCancels:', String(error)));
    await this.collect(taskId, signal).catch(error => console.error('[codeintel] collect:', String(error)));
  }

  private async importPending(taskId: number, signal?: AbortSignal): Promise<void> {
    const rows = (await this.pool.query(
      `SELECT s.id, s.payload FROM exploration_nodes s
        WHERE s.task_id=$1 AND s.kind='fact' AND s.payload->>'kind'=$2
          AND COALESCE((s.payload->>'import_attempts')::int,0) < $3
          AND COALESCE(s.payload->>'superseded','false') <> 'true'
          AND NOT (COALESCE(s.payload->>'dir_key','') <> '' AND EXISTS (
            SELECT 1 FROM exploration_nodes n
             WHERE n.task_id=s.task_id AND n.kind='fact' AND n.payload->>'kind'=$2
               AND n.payload->>'dir_key' = s.payload->>'dir_key'
               AND COALESCE(n.payload->>'superseded','false') <> 'true' AND n.id > s.id))
          AND NOT EXISTS (
            SELECT 1 FROM exploration_nodes r
             WHERE r.task_id=$1 AND r.kind='fact' AND r.payload->>'kind'=$4
               AND r.payload->>'source_key' = s.payload->>'source_key')
        ORDER BY s.id LIMIT 4`, [taskId, KIND_SOURCE, MAX_IMPORT_ATTEMPTS, KIND_READY])).rows;

    for (const row of rows) {
      if (signal?.aborted) return;   // Cancellation: The retry quota will not be counted and the next round will continue.
      const payload = row.payload as Record<string, any>;
      let sourceKey = String(payload.source_key ?? '');
      const attempts = Number(payload.import_attempts ?? 0) + 1;
      const workDir = path.join(this.dataDir, 'codeintel', String(taskId), String(row.id));
      try {
        // If the task has been deleted, do not write the results again to avoid competition with cleanup.
        const stillThere = (await this.pool.query(
          'SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL', [taskId]).catch(() => null))?.rowCount === 1;
        if (!stillThere) return;
        let repoId: string, uploadSha: string | undefined, uploaded: string;
        let repackRange: {links: number; paths: number; read_errors: number} | null = null;
        if (payload.source_type === 'git') {
          repoId = (await this.client.importGit(String(payload.url), signal)).repoId;
          uploaded = 'git';
        } else {
          const local = String(payload.path ?? '');
          const kind = String(payload.artifact_kind ?? 'zip') as ArtifactKind;
          if (!await stat(local).then(s => s.isFile()).catch(() => false)) throw new Error("The artifact is no longer in the workspace:" + local);
          // Files may be overwritten between registration and upload: recalculate based on actual content to avoid mismatch between index and registration identity
          const actualSha = await digestFile(local).catch(error => {
            throw new Error("Unable to read product content for identity verification: " + String((error as Error).message));
          });
          if (payload.sha256 && actualSha !== String(payload.sha256)) {
            await this.patchFact(Number(row.id), {
              sha256: actualSha, source_key: 'sha:' + actualSha,
              content_changed_after_register: true,
              registered_sha256: String(payload.sha256),
            }).catch(() => {});
            payload.sha256 = actualSha;
            sourceKey = 'sha:' + actualSha;
          }
          await mkdir(workDir, {recursive: true, mode: 0o700});
          // First copy an immutable copy dedicated to this import: only this copy will be recognized for hashing, budgeting, and uploading.，
          // Otherwise, other worker/After downloading and rewriting, the message ”Checking is A、The message is B”。
          const stagingDir = path.join(this.dataDir, 'codeintel', String(taskId), 'imports');
          await mkdir(stagingDir, {recursive: true, mode: 0o700});
          const staged = path.join(stagingDir, `${randomUUID()}-${path.basename(local)}`);
          await copyFile(local, staged);
          try {
            const stagedSha = await digestFile(staged).catch(error => {
              throw new Error("Unable to read product copy for identity verification: " + String((error as Error).message));
            });
            if (payload.sha256 && stagedSha !== String(payload.sha256)) {
              await this.patchFact(Number(row.id), {
                sha256: stagedSha, source_key: 'sha:' + stagedSha,
                content_changed_after_register: true,
                registered_sha256: String(payload.sha256),
              }).catch(() => {});
              payload.sha256 = stagedSha;
              sourceKey = 'sha:' + stagedSha;
            }
            let upload = staged;
            // Native zip We also need to look at the expansion scale first: the white box side is directly extractall，If the platform doesn’t stop it, no one will stop it.
            if (/^(zip|jar|apk|aar|war|ear)$/i.test(kind)) {
              const budget = await inspectZipBudget(staged);
              if (budget.zip64 || !budget.complete)
                throw new Error("The compressed package structure cannot be fully parsed (possibly zip64 or the central directory is abnormal), the expansion budget cannot be guaranteed, and has been rejected: " + local);
              if (budget.entries > 200_000 || budget.totalBytes > 4 * 1024 * 1024 * 1024 || budget.maxBytes > 1024 * 1024 * 1024) {
                throw new Error(`Compressed package expansion exceeds budget (entry ${budget.entries}, total amount ${budget.totalBytes} Bytes, single file ${budget.maxBytes} bytes), import rejected: ${local}`);
              }
            }
            if (!isNative(kind)) {
              const repacked = await repackToZip(staged, kind, workDir, signal);
              upload = repacked.zip;
              uploadSha = await digestFile(upload);
              if (repacked.skippedLinks || repacked.skippedUnsafe || repacked.readErrors) {
                repackRange = {links: repacked.skippedLinks, paths: repacked.skippedUnsafe,
                  read_errors: repacked.readErrors};
              }
            }
            // Encryption wxapkg Required AppID：If given when downloading, take it with you, otherwise the white box can only be guessed from the package name.
            const appid = String(payload.wxapkg_appid ?? '').trim();
            const imported = await this.client.importZip(upload, String(payload.name ?? 'source'),
              appid || undefined, signal);
            repoId = imported.repoId;
            uploaded = uploadSha ? `repacked-zip` : kind;
          } finally {
            await rm(staged, {force: true}).catch(() => {});
          }
          await rm(workDir, {recursive: true, force: true});
        }
        const stillAlive = (await this.pool.query(
          'SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL', [taskId]).catch(() => null))?.rowCount === 1;
        if (!stillAlive) return;   // Task deleted during import: results are no longer published
        const summary = `Code index created:${payload.name ?? payload.url}`;
        const dirKey = String(payload.dir_key ?? '');
        const factId = await this.addFact(taskId, summary, {
          kind: KIND_READY, source_key: sourceKey, repo_id: repoId, source_name: String(payload.name ?? payload.url ?? ''),
          artifact_kind: String(payload.artifact_kind ?? (payload.source_type === 'git' ? 'git' : 'zip')),
          uploaded_as: uploaded, ...(uploadSha ? {upload_sha256: uploadSha} : {}),
          source_fact: Number(row.id), imported_at: new Date().toISOString(),
          // The index range must follow the ready record, otherwise the query side will not see ”This is an incomplete snapshot.””
          ...(repackRange ? {
            snapshot_partial: true,
            snapshot_skipped_links: repackRange.links,
            snapshot_skipped_paths: repackRange.paths,
            snapshot_read_errors: repackRange.read_errors,
          } : {}),
          ...(payload.snapshot_partial ? {
            snapshot_partial: true,
            snapshot_skipped_links: payload.snapshot_skipped_links ?? 0,
            snapshot_skipped_paths: payload.snapshot_skipped_paths ?? 0,
            snapshot_read_errors: payload.snapshot_read_errors ?? 0,
          } : {}),
          audit_state: this.options.audit ? 'pending' : 'skipped',
          ...(dirKey ? {dir_key: dirKey} : {}),
          // The version information must follow the readiness record, otherwise the query side will not be able to see which version it is using.
          ...(payload.snapshot_dir ? {snapshot_dir: payload.snapshot_dir, snapshot_at: payload.snapshot_at,
            dir_fingerprint: payload.dir_fingerprint, git_dirty: payload.git_dirty === true,
            ...(payload.git_branch ? {git_branch: payload.git_branch} : {}),
            ...(payload.git_head ? {git_head: payload.git_head} : {})} : {}),
        });
        if (dirKey) {
          const newer = (await this.pool.query(
            `SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2
               AND payload->>'dir_key'=$3 AND COALESCE(payload->>'superseded','false') <> 'true'
               AND id > $4 LIMIT 1`, [taskId, KIND_SOURCE, dirKey, Number(row.id)])).rowCount;
          if (newer) {
            // This version is already a historical version: keep the file but do not grab the current identity and do not replace the updated version.
            await this.patchFact(factId, {superseded: true, historical: true});
            await this.patchFact(Number(row.id), {import_state: 'done', ready_fact: factId});
            return;
          }
          // Give way to the old version in the same directory to prevent queries from seeing two versions of the code at the same time
          await this.pool.query(
            `UPDATE exploration_nodes SET payload = payload || '{"superseded":true}'::jsonb
               WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'dir_key'=$3 AND id<>$4`,
            [taskId, KIND_READY, dirKey, factId]).catch(() => undefined);
        }
        await this.patchFact(Number(row.id), {import_state: 'done', ready_fact: factId});
        // Recycling is also considered a background file operation of this task, and it must be able to be waited for when deleting.
        if (dirKey) void this.withTaskWork(taskId, () => this.pruneSnapshots(taskId, dirKey)).catch(() => {});
      } catch (error) {
        if (signal?.aborted || (error as Error)?.name === 'AbortError') {
          // User suspended/Cancellation caused by stop, not import failure: status rollback, continue after recovery
          await this.patchFact(Number(row.id), {import_state: 'registered', import_cancelled_at: new Date().toISOString()}).catch(() => {});
          return;
        }
        const message = String((error as Error).message).slice(0, 400);
        await this.patchFact(Number(row.id), {import_attempts: attempts, import_error: message,
          import_state: attempts >= MAX_IMPORT_ATTEMPTS ? 'failed' : 'retry'});
        await rm(workDir, {recursive: true, force: true}).catch(() => {});
      }
    }
  }

  private async dispatchPending(taskId: number, signal?: AbortSignal): Promise<void> {
    if (!this.options.audit) return;
    // The occupancy timeout has not been advanced to running（Process exit, write failure）→ Put back pending，Don’t let your code sources get permanently stuck in “Auditing”
    await this.pool.query(
      `UPDATE exploration_nodes SET payload = payload || jsonb_build_object('audit_state','pending')
         WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'audit_state'='claimed'
           AND COALESCE(NULLIF(payload->>'audit_claimed_at','')::timestamptz, now()) < now() - ($3::int * interval '1 millisecond')`,
      [taskId, KIND_READY, CLAIM_TTL_MS]).catch(() => undefined);
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes
        WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'audit_state'='pending'
        ORDER BY id LIMIT 2`, [taskId, KIND_READY])).rows;
    for (const row of rows) {
      const payload = row.payload as Record<string, any>;
      // Follow the same hardening path as manual submission: atomic preemption, generation, parameter persistence, and pending processing are all the same.
      // The source has been determined here, press repo_id Exact specification; using display name would be ambiguous on a source with the same name
      await this.requestAudit(taskId, String(payload.repo_id ?? ''),
        undefined, signal).catch(error => {
        console.error("[codeintel] Automatic dispatch failed", String(error));
      });
    }
  }

  private async collect(taskId: number, signal?: AbortSignal): Promise<void> {
    // Rotation: Check the items that have not been checked for the longest time first to avoid the earliest items occupying the polling window for a long time.
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes
        WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'audit_state'='running'
        ORDER BY COALESCE(NULLIF(payload->>'audit_checked_at','')::timestamptz, to_timestamp(0)) ASC, id
        LIMIT 4`, [taskId, KIND_READY])).rows;
    for (const row of rows) {
      const payload = row.payload as Record<string, any>;
      const auditTaskId = String(payload.audit_task_id ?? '');
      const startedAt = Date.parse(String(payload.audit_started_at ?? '')) || 0;
      try {
        await this.patchFact(Number(row.id), {audit_checked_at: new Date().toISOString()});
        const {status, error, counts} = await this.client.auditStatus(auditTaskId, signal);
        if (status === 'done') {
          // Only the vulnerabilities produced by this audit task are recognized; the vulnerability library is full of history and must be task_id Filter
          const findings = (await this.client.findings(String(payload.repo_id), '', 100, signal, auditTaskId))
            .filter(item => !item.task_id || String(item.task_id) === auditTaskId);
          for (const finding of findings) await this.addFindingFact(taskId, payload, finding);
          await this.patchFact(Number(row.id), {audit_state: 'done', audit_done_at: new Date().toISOString(),
            audit_findings: findings.length, ...(Object.keys(counts).length ? {audit_counts: counts} : {})});
        } else if (status === 'error' || status === 'stopped') {
          await this.patchFact(Number(row.id), {audit_state: 'failed', audit_error: (error || status).slice(0, 300)});
        } else if (startedAt && Date.now() - startedAt > this.options.auditTimeoutSeconds * 1000) {
          // Remove the external task before stopping tracking to prevent it from continuing to burn resources in the background.
          const cancelled = await this.client.cancelAudit(auditTaskId).catch(() => false);
          await this.patchFact(Number(row.id), cancelled
            ? {audit_state: 'timeout', audit_timeout_cancelled: true}
            : {audit_state: 'cancel_pending', audit_pending_task_id: auditTaskId,
               audit_cancel_error: "Audit timed out, but white box did not confirm cancellation"});
        }
      } catch (error) {
        // Single failure does not affect other code sources: write it down and continue in the next round
        await this.patchFact(Number(row.id), {audit_last_error: String((error as Error).message).slice(0, 200)}).catch(() => {});
      }
    }
  }

  /** Audit result completed as common clue fact: does not appear"White box"word，planner Verification will be sent like other leads。 */
  private async addFindingFact(taskId: number, ready: Record<string, any>, finding: WhiteboxFinding): Promise<void> {
    // Stable identity: same entry in the same audit findings Only insert the image once, retry will not insert again.
    const auditTaskId = String(ready.audit_task_id ?? '');
    const findingKey = String(finding.key ?? `${finding.file ?? ''}:${finding.lines ?? ''}:${finding.title ?? ''}`);
    const identity = `${auditTaskId}:${findingKey}`;
    const dup = (await this.pool.query(
      `SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'kind'=$2 AND payload->>'finding_key'=$3 LIMIT 1`,
      [taskId, KIND_FINDING, identity])).rowCount;
    if (dup) return;
    const category = String(finding.category ?? 'code-issue');
    const where = [finding.file, finding.lines].filter(Boolean).join(':');
    const summary = `Suspected${category}：${where || "Unknown location"} — ${String(finding.title ?? '').slice(0, 120)}`;
    const detail = [
      finding.description ? `Cause:${finding.description}` : '',
      finding.impact ? `Impact:${finding.impact}` : '',
      finding.evidence ? `Code evidence:${String(finding.evidence).slice(0, 1200)}` : '',
      finding.poc ? `Recommended verification:${String(finding.poc).slice(0, 600)}` : '',
      `Source:
Static audit of${ready.source_name ?? ''} ; this is a code-level clue and must be confirmed by a real request on a real target to be considered a vulnerability.`,
    ].filter(Boolean).join('\n');
    await this.addFact(taskId, summary, {
      kind: KIND_FINDING, confidence: 'inferred', repo_id: ready.repo_id, source_name: ready.source_name ?? '',
      category, cwe: finding.cwe ?? '', severity: finding.severity ?? '', file: finding.file ?? '',
      lines: String(finding.lines ?? ''), detail,
      finding_key: identity, audit_task_id: auditTaskId, finding_external_id: findingKey,
    });
  }

  // ---------------------------------------------------------------- Landing detection

  /** Directory snapshot (path → mtime），Just walk 3 layer, most 3000 item, enough For the working directory of worker working directory for。 */
  async snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 3 || map.size > 3000) return;
      const entries = await (await import('node:fs/promises')).readdir(current, {withFileTypes: true}).catch(() => null);
      if (!entries) return;
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const info = await stat(full).catch(() => null);
        if (info) map.set(full, info.mtimeMs);
      }
    };
    await walk(dir, 0);
    return map;
  }

  /** Bash Called after execution: find out new/Changed files are registered as artifacts; a neutral prompt is returned to the model.。 */
  async ingestChanges(taskId: number, intentId: number, dir: string, before: Map<string, number>, command: string): Promise<string[]> {
    const notes: string[] = [];
    const git = /git\s+clone\s+(\S+)/i.exec(command);
    if (git?.[1]) {
      await this.ingestGit(taskId, intentId, git[1]).catch(() => {});
      notes.push("(The platform has registered the code warehouse, and the implementation can be retrieved according to the interface later)");
    }
    const after = await this.snapshot(dir);
    for (const [file, mtime] of after) {
      if (before.get(file) === mtime) continue;
      const registered = await this.ingestFile(taskId, intentId, file).catch(() => null);
      if (registered) notes.push(`(Established
Code index for ${registered.name} : search_target_code / read_target_code / audit_target_code)`);
      if (notes.length >= 4) break;
    }
    return notes;
  }

  // ---------------------------------------------------------------- Query (give tool）

  async sources(taskId: number): Promise<ReadySource[]> {
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes
        WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2
          AND COALESCE(payload->>'superseded','false') <> 'true'
        ORDER BY id`, [taskId, KIND_READY])).rows;
    return rows.map((row: any) => ({
      factId: Number(row.id), repoId: String(row.payload.repo_id ?? ''), name: String(row.payload.source_name ?? ''),
      artifactKind: String(row.payload.artifact_kind ?? ''), sourceKey: String(row.payload.source_key ?? ''),
      auditState: String(row.payload.audit_state ?? ''), findings: Number(row.payload.audit_findings ?? 0),
    partial: row.payload.snapshot_partial === true,
    omitted: row.payload.snapshot_partial === true ? {
      links: Number(row.payload.snapshot_skipped_links ?? 0),
      paths: Number(row.payload.snapshot_skipped_paths ?? 0),
      read_errors: Number(row.payload.snapshot_read_errors ?? 0),
    } : undefined,
    }));
  }

  /**
   * Select a code to check. If there is only one source, use it directly; if there are multiple sources and they are not specified, return null，
   * The caller hands the candidate back to worker —— Do not press"Most clues"or something like that, the wrong version will be checked.。
   */
  /** Index range prompt: clearly tell the caller when it is incomplete, do not let ”not found” be regarded as ”not found in the source code””。 */
  private rangeInfo(partial: boolean | undefined, omitted?: {links: number; paths: number; read_errors: number}): Record<string, unknown> {
    if (!partial) return {};
    const bits = [
      omitted?.read_errors ? `Read failed ${omitted.read_errors} at` : '',
      omitted?.paths ? `Skip exception path ${omitted.paths} indivual` : '',
      omitted?.links ? `Skipping symbolic links ${omitted.links} indivual` : '',
    ].filter(Boolean).join('、');
    return {partial: true, omitted,
      note: `The source code index range is incomplete (${bits || "Part of the content is not included"}): If it cannot be found or read, it does not mean that it is not in the source code; if you need the complete content, please read the original file in the workspace.`};
  }

  private async pick(taskId: number, source?: string): Promise<ReadySource | null> {
    const all = await this.sources(taskId);
    if (!all.length) throw new Error("There is no target code available for the current task: you need to download the source code package/installation package first, and the platform will automatically create an index.");
    if (!source) return all.length === 1 ? all[0]! : null;
    const exact = all.find(item => item.repoId === source || item.sourceKey === source);
    if (exact) return exact;
    const needle = source.toLowerCase();
    const byName = all.filter(item => item.name.toLowerCase() === needle);
    const fuzzy = byName.length ? byName : all.filter(item => item.name.toLowerCase().includes(needle));
    if (fuzzy.length === 1) return fuzzy[0]!;
    // Multiple copies with the same name: no guess, return candidate
    if (fuzzy.length > 1) return null;
    throw new Error(`No matching code source:${source}; Available:${all.map(item => `${item.name}(${item.repoId})`).join('、')}`);
  }

  private async ambiguous(taskId: number): Promise<Record<string, unknown>> {
    const all = await this.sources(taskId);
    return {
      state: 'multiple_sources',
      // With only one id：Files with the same name can also be distinguished, otherwise worker I still choose the wrong name after choosing it.
      sources: all.map(item => ({id: item.repoId, source: item.name, artifact: item.artifactKind, audit: item.auditState,
        ...this.rangeInfo(item.partial, item.omitted)})),
      note: "There are multiple code sources for this task. Please use source to pass the above id (or unique name) to specify which one to check; first call list_target_sources to see all candidates.",
    };
  }

  /** What are the code sources for this task and which step have they reached (Register / Importing / Ready / failed), and whether the index has become stale。 */
  async describeSources(taskId: number): Promise<Record<string, unknown>> {
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes
        WHERE task_id=$1 AND kind='fact' AND payload->>'kind' IN ($2,$3)
          AND COALESCE(payload->>'superseded','false') <> 'true'
        ORDER BY id`, [taskId, KIND_SOURCE, KIND_READY])).rows;
    const readyRows = rows.filter((row: any) => row.payload.kind === KIND_READY);
    // Registration records that have been imported will no longer be counted. pending，Otherwise the same source will be counted as two
    const imported = new Set(readyRows.map((row: any) => String(row.payload.source_fact ?? '')));
    const pendingRows = rows.filter((row: any) =>
      row.payload.kind === KIND_SOURCE && !imported.has(String(row.id)) && row.payload.import_state !== 'done');

    const ready = await Promise.all(readyRows.map(async (row: any) => {
      const payload = row.payload;
      const dir = payload.snapshot_dir ? String(payload.snapshot_dir) : '';
      let stale = false;
      if (dir) {
        const stored = String(payload.dir_fingerprint ?? '');
        if (stored) {
          // Re-fetch using current working tree git information, rather than the copy saved during registration
          const meta = await this.gitMeta(dir).catch(() => ({} as Record<string, unknown>));
          const now = await this.dirFingerprint(dir, meta).catch(() => ({value: '', truncated: true}));
          // Code outside the boundary or if the fingerprint has changed is considered old: it is better to indicate that it is old than to make people think it is the latest code.
          stale = now.truncated || now.value !== stored;
        } else {
          const info = await stat(dir).catch(() => null);
          stale = !!info && info.mtimeMs > (Date.parse(String(payload.snapshot_at ?? '')) || 0);
        }
      }
      return {
        id: String(payload.repo_id ?? ''),
        source: payload.source_name, artifact: payload.artifact_kind, audit: payload.audit_state,
        findings: Number(payload.audit_findings ?? 0),
        ...(payload.snapshot_at ? {snapshot_at: payload.snapshot_at} : {}),
        ...(payload.git_head ? {git_head: String(payload.git_head).slice(0, 12)} : {}),
        ...(payload.git_branch ? {git_branch: payload.git_branch} : {}),
        ...(payload.git_dirty ? {git_dirty: true} : {}),
        ...(stale ? {stale: true, stale_note: "The workspace has changed since the snapshot, and the index may not be the latest code"} : {}),
        ...this.rangeInfo(payload.snapshot_partial === true, {
          read_errors: Number(payload.snapshot_read_errors ?? 0),
          paths: Number(payload.snapshot_skipped_paths ?? 0),
          links: Number(payload.snapshot_skipped_links ?? 0),
        }),
        hint: payload.audit_state === 'done' ? "It has been audited. There is no need to use audit_target_code unless you want to review it from another angle."
          : payload.audit_state === 'running' ? "The audit is in progress and the results will appear as clue facts"
          : payload.audit_state === 'claimed' ? "The audit is being issued, please wait."
          : payload.audit_state === 'stopped' ? "Audit has been stopped"
          : payload.audit_state === 'skipped' ? "It has not been audited yet. You can use audit_target_code to initiate it as needed."
          : payload.audit_state === 'failed' ? "The last audit failed, you can try again"
          : payload.audit_state === 'timeout' || payload.audit_state === 'unfinished'
            ? "The last audit was not completed, you can try again" : '',
      };
    }));

    const pending = pendingRows.map((row: any) => {
      const payload = row.payload;
      const state = String(payload.import_state ?? 'registered');
      return {
        artifact: String(payload.name ?? payload.snapshot_dir ?? ''),
        state,
        ...(payload.import_error ? {error: String(payload.import_error).slice(0, 200)} : {}),
        note: state === 'failed' ? "Import failed: You can obtain it in another way, or read the source code directly locally"
          : state === 'retry' ? "Import retrying"
          : "Registered, the platform builds index in the background; available when ready search_target_code / read_target_code",
      };
    });

    const note = ready.length === 0 && pending.length > 0
      ? "The code source is still being indexed in the background. You can do other things first and check later."
      : ready.length > 1 ? "There are multiple code sources, please specify by id when querying" : '';
    return {count: ready.length + pending.length, ready, pending, ...(note ? {note} : {})};
  }

  /** worker Initiative/Rerun a static audit. Return to current status。 */
  async requestAudit(taskId: number, source?: string, focus?: string, signal?: AbortSignal,
                    force = false): Promise<Record<string, unknown>> {
    const target = await this.pick(taskId, source);
    if (!target) return this.ambiguous(taskId);
    if (!await this.reachable()) throw new Error("The code analysis service is currently unavailable. Please try again later or read the source code yourself instead.");
    if (target.auditState === 'running') return {source: target.name, state: 'running', note: "The audit of this code source is already running, and the results will appear as clue facts."};
    // The pending status is determined by ”mark”：done Take after focus Failure to rerun is also pending and cannot be missed by relying on status.
    const flagRow = (await this.pool.query(
      "SELECT payload->>'audit_reconcile_needed' AS flag, payload->>'audit_focus' AS focus,"
      + " payload->>'audit_requested_focus' AS requested, payload->>'audit_request_gen' AS reqgen,"
      + " payload->>'audit_gen' AS gen FROM exploration_nodes WHERE id=$1",
      [target.factId])).rows[0];
    const reconcilePending = String(flagRow?.flag ?? '') === 'true';
    const pending = target.auditState === 'unknown' || target.auditState === 'cancel_pending' || reconcilePending;
    if (pending && !force) {
      return {source: target.name, state: target.auditState || 'unknown', pending: true,
        note: "The last submission has not been confirmed (it may have been accepted), or the last round of cancellation has not been confirmed. The default is not to resend;"
            + "If you confirm that another audit is required, set force=true. The platform will try to cancel old external tasks and resubmit them."};
    }
    // force When used to restore pending submissions, it cannot be truncated by the ”audited” early return；
    // What should be restored is**That pending commit**of focus，instead of the last successful audit focus
    // Only ”Request generation === Current generation”，requested focus is the direction of this pending submission；
    // If it is incorrect, it means that the parameters did not follow this generation. You cannot guess the old direction.
    const reqGen = String(flagRow?.reqgen ?? '');
    const curGen = String(flagRow?.gen ?? '');
    const focusRestorable = reqGen !== '' && (curGen === '' || reqGen === curGen);
    const priorFocus = focusRestorable ? String(flagRow?.requested ?? '').trim() : '';
    const effectiveFocus = (focus ?? '').trim() || (force && pending ? priorFocus : '');
    if (pending && force && !(focus ?? '').trim() && !focusRestorable) {
      return {source: target.name, state: target.auditState || 'unknown', pending: true, needs_focus: true,
        note: "The direction parameter of the pending submission this time has not been reliably placed, and I cannot guess it for you. Please specify the direction to be reviewed with focus and call it again."};
    }
    if (target.auditState === 'done' && !effectiveFocus && !(force && pending)) {
      return {source: target.name, state: 'done', findings: target.findings,
        note: `This code source has been audited (output ${target.findings} clues). Do not repeat the audit; if you really need to review it from another angle, adjust it again with focus.`};
    }
    // Background work for submitting calculation task: Delete/Can be held while stopped
    return await this.withTaskWork(taskId, async () => {
      // Atomic preemption: first push the state to claimed，Submit the talents you grabbed to avoid repeated issuance; expired claimed Can be grabbed again
      const claimed = await this.pool.query(
        `UPDATE exploration_nodes SET payload = payload || jsonb_build_object('audit_state','claimed','audit_claimed_at',$3::text,
           'audit_gen', COALESCE((payload->>'audit_gen')::int,0) + 1,
           'audit_requested_focus', $6::text,
           'audit_request_gen', COALESCE((payload->>'audit_gen')::int,0) + 1,
           'audit_stop_requested', false, 'audit_stop_gen', NULL, 'audit_reconcile_needed', false)
           WHERE id=$1 AND task_id=$2 AND kind='fact'
             AND (COALESCE(payload->>'audit_state','') <> ALL($5::text[])
               OR (payload->>'audit_state'='claimed'
                   AND COALESCE(NULLIF(payload->>'audit_claimed_at','')::timestamptz, now()) < now() - ($4::int * interval '1 millisecond')))
           RETURNING id,payload`,
        [target.factId, taskId, new Date().toISOString(), CLAIM_TTL_MS,
         force ? ['running', 'claimed', 'stopping'] : ['running', 'claimed', 'stopping', 'cancel_pending', 'unknown'],
         effectiveFocus]);
      if (!claimed.rowCount) return {source: target.name, state: 'running', note: "The audit of this code source is already running, and the results will appear as clue facts."};
      const payload = claimed.rows[0].payload as Record<string, any>;
      const gen = Number(payload.audit_gen ?? 0);
      const previousId = String(payload.audit_task_id ?? payload.audit_pending_task_id ?? '');
      // When re-running, first stop the old tasks of the previous round and clear the old ones. ID，Don’t let stop hit old tasks
      if (previousId) {
        const cancelled = await this.client.cancelAudit(previousId).catch(() => false);
        // Known ID The old task must remain a continuing responsibility: if it cannot be removed, it will be put into the queue and the background loop will keep trying.
        if (cancelled) {
          await this.patchFact(target.factId, {audit_task_id: null, audit_previous_task_id: previousId,
            audit_previous_cancelled_at: new Date().toISOString()}).catch(() => {});
        } else {
          await this.pool.query(
            `UPDATE exploration_nodes SET payload = payload || jsonb_build_object(
               'audit_task_id', NULL, 'audit_previous_task_id', $3::text,
               'audit_cancel_queue', COALESCE((
                 SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements_text(
                   COALESCE(payload->'audit_cancel_queue','[]'::jsonb) || to_jsonb($3::text)) AS value), '[]'::jsonb))
             WHERE id=$1 AND task_id=$2`,
            [target.factId, taskId, previousId]).catch(() => {});
        }
      }
      let auditTaskId: string;
      try {
        auditTaskId = (await this.client.submitAudit(target.repoId, effectiveFocus || this.options.focus, 20, signal)).taskId;
      } catch (error) {
        // The request may have been accepted by the other party, but the response is lost: it cannot be ignored and marked as pending reconciliation.
        await this.patchFact(target.factId, {audit_state: target.auditState === 'done' ? 'done' : 'unknown',
          audit_error: String((error as Error).message).slice(0, 300),
          audit_reconcile_needed: true}).catch(() => {});
        throw error;
      }
      // Put the new one first ID Dropped: Even if it is later determined to be expired, this external task can always be found and stopped.
      const stored = await this.patchFact(target.factId, {audit_task_id: auditTaskId})
        .then(() => true).catch(() => false);
      if (!stored) {
        // Cannot save ID Cannot continue: otherwise the external task will not be tracked
        const cancelled = await this.client.cancelAudit(auditTaskId).catch(() => false);
        await this.patchFact(target.factId, cancelled
          ? {audit_state: 'stopped', audit_cancel_error: "The new task ID cannot be recorded locally and has been cancelled."}
          : {audit_state: 'cancel_pending', audit_pending_task_id: auditTaskId,
             audit_cancel_error: "The new task ID cannot be recorded locally, and the cancellation is not confirmed"}).catch(() => {});
        throw new Error("Unable to record the audit task ID, an attempt has been made to revoke this submission");
      }
      // Atomic advancement to running：The generation, status, and stop flag must be established at the same time to avoid ”check and then write” being inserted by stop.
      const advanced = await this.pool.query(
        `UPDATE exploration_nodes SET payload = payload || jsonb_build_object('audit_state','running','audit_started_at',$3::text,
           'audit_pending_task_id', NULL, 'audit_cancel_error', NULL,
           'audit_stop_requested', false, 'audit_stop_gen', NULL)
           WHERE id=$1 AND task_id=$2 AND kind='fact'
             AND payload->>'audit_gen' = $4 AND payload->>'audit_state' = 'claimed'
             AND COALESCE((payload->>'audit_stop_requested')::boolean, false) = false
           RETURNING id`,
        [target.factId, taskId, new Date().toISOString(), String(gen)]);
      if (!advanced.rowCount) {
        // is stopped during the period: it will be stopped only if it can be removed; if it cannot be removed, it will remain cancel_pending，Continue can be retried, don’t lie about being revoked
        const cancelled = await this.client.cancelAudit(auditTaskId).catch(() => false);
        await this.patchFact(target.factId, cancelled
          ? {audit_state: 'stopped', audit_stopped_at: new Date().toISOString(), audit_stopped_task_id: auditTaskId}
          : {audit_state: 'cancel_pending', audit_pending_task_id: auditTaskId,
             audit_cancel_error: "The task was stopped during submission, but the white box did not confirm the cancellation."}
        ).catch(() => {});
        return {source: target.name, state: cancelled ? 'stopped' : 'cancel_pending',
          note: cancelled ? "The task has been stopped during submission, and the audit just issued has been revoked."
                          : "The task has been stopped during submission, but the white box has not confirmed the cancellation; it has been recorded as pending cancellation and will continue to be tried later."};
      }
      if (effectiveFocus) await this.patchFact(target.factId, {audit_focus: effectiveFocus}).catch(() => {});
      if (pending) {
        // Clearly tell the caller: this time it is a forced retry, and the unconfirmed external tasks in the previous round may still be running.
        return {source: target.name, state: 'running', audit_task_id: auditTaskId, forced: true,
          note: "Resubmitted by pressing force. If the last round of unconfirmed external audits has indeed been accepted, it may still be running; the platform has tried its best to cancel it, but there is no guarantee."};
      }
      return {source: target.name, state: 'running', audit_task_id: auditTaskId,
        note: "A static audit has been issued; after the run is completed, clues and facts in the form of \"suspected...\" will appear in the exploration map. Those are just clues and still need to be confirmed by actual measurements."};
    });
  }

  async search(taskId: number, pattern: string, source?: string, limit = 30, signal?: AbortSignal) {
    const target = await this.pick(taskId, source);
    if (!target) return this.ambiguous(taskId);
    const result = await this.client.search(target.repoId, pattern, Math.min(Math.max(limit, 1), 100), signal);
    const textual = result.matches.filter(match => {
      const file = String(match.path ?? '');
      if (BINARY_EXT.test(file)) return false;                 // Pure binary container
      if (match.decompiled) return true;                       // Source code decompiled by white box
      if (DECOMPILABLE_EXT.test(file)) return false;           // Undecompiled bytecode, text makes no sense
      return !looksBinaryText(String(match.text ?? ''));       // Only garbled characters are left.
    });
    return {...this.rangeInfo(target.partial, target.omitted),
      source: target.name, repo_id: target.repoId, scanned: result.scanned, truncated: result.truncated,
      matches: textual.map(match => ({path: match.path ?? '', line: match.line ?? 0,
        text: String(match.text ?? '').slice(0, 600),
        ...(String(match.text ?? '').length > 600 ? {text_truncated: true} : {}),
        ...(match.decompiled ? {decompiled: true} : {})}))};
  }

  async read(taskId: number, filePath: string, source?: string, signal?: AbortSignal, offset = 0, limit = 8000) {
    const target = await this.pick(taskId, source);
    if (!target) return this.ambiguous(taskId);
    const result = await this.client.readFile(target.repoId, filePath, signal);
    const total = result.content.length;
    const start = Math.min(Math.max(0, Math.floor(offset)), total);
    const take = Math.min(Math.max(500, Math.floor(limit)), 20000);
    const end = Math.min(total, start + take);
    const cut = end < total, sourceCut = result.truncated === true;
    return {...this.rangeInfo(target.partial, target.omitted),
      source: target.name, path: filePath, ...(result.decompiled ? {decompiled: result.decompiled} : {}),
      lines: result.lines, chars: total, offset: start, returned: end - start,
      truncated: sourceCut || cut, source_truncated: sourceCut,
      ...(sourceCut
        ? {note: `The code index service only returned the file before ${total} characters (it has its own reading upper limit), no matter how large the offset is, the back cannot be read; the complete content is required to read the original file in the workspace.`}
        : cut ? {note: `This time I gave the ${start}–${end} characters (file total ${total} character,${result.lines} line); continue reading with offset=${end}。`} : {}),
      content: result.content.slice(start, end)};
  }

  async list(taskId: number, dir = '', source?: string, signal?: AbortSignal) {
    const target = await this.pick(taskId, source);
    if (!target) return this.ambiguous(taskId);
    // When specifying a subdirectory, the white box must be returned by directory：flat The branch is traversed from the warehouse root and will be ignored. dir
    const tree = await this.client.tree(target.repoId, dir, !dir, signal);
    let treeDirs = tree.dirs ?? [];
    // For root directory flat When listing files, the white box does not return to the directory; ask again for the first-level directory，
    // Otherwise, it prompts ”List by subdirectory one by one” but there is no entry to click.。
    if (!dir && treeDirs.length === 0) {
      const rootTree = await this.client.tree(target.repoId, '', false, signal).catch(() => null);
      treeDirs = rootTree?.dirs ?? [];
    }
    const all = tree.files ?? [], total = all.length;
    const files = all.slice(0, 300).map(item => item.path);
    const dirs = treeDirs.slice(0, 100).map(item => item.path);
    const truncated = total > 300 || tree.truncated === true;
    return {...this.rangeInfo(target.partial, target.omitted),
      source: target.name, dir, dirs, files, total, truncated,
      ...(truncated ? {note: `This time only the ${files.length} indivual${dir ? `（${dir} (below)` : ''}, total ${total} ; list them layer by layer according to subdirectories, or use search_target_code to find files directly`} : {})};
  }

  /** Explicitly stop or delete tasks: stop the audit that has been submitted to the white box and mark it as no longer tracked。 */
  /** Cancel unconfirmed audits: continue trying until white box confirmation, do not pretend to have stopped。 */
  /**
   * Cancel an external audit and determine whether responsibilities should be relieved。
   * Only ”cancellation is successful” or ”final state is clearly found” will be considered completed; query failed/Empty status/Unknown status is always retained。
   */
  private async cancelOrResolve(id: string, signal?:AbortSignal): Promise<'cancelled' | 'gone' | 'pending'> {
    if (await this.client.cancelAudit(id,signal).catch(() => false)) return 'cancelled';
    const status = await this.client.auditStatus(id,signal)
      .then(result => String(result.status ?? '').trim().toLowerCase())
      .catch(() => null);
    if (status === null) return 'pending';            // Query failed ≠ Ended
    if (!status) return 'pending';                    // Don’t guess even if it’s empty
    if (['done', 'error', 'failed', 'stopped', 'stopped_by_user', 'canceled', 'cancelled',
         'timeout', 'completed', 'finished'].includes(status)) return 'gone';
    return 'pending';
  }

  private async retryCancels(taskId: number, signal?:AbortSignal): Promise<void> {
    // Known external ID But not removed（force Take over old task): Press ID Retry one by one until confirmed
    const queued = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND jsonb_array_length(COALESCE(payload->'audit_cancel_queue','[]'::jsonb)) > 0 LIMIT 10`,
      [taskId])).rows;
    for (const row of queued) {
      const list: string[] = Array.isArray(row.payload.audit_cancel_queue) ? row.payload.audit_cancel_queue : [];
      const remaining: string[] = [];
      for (const id of list) {
        const verdict = await this.cancelOrResolve(id,signal);
        if (verdict === 'cancelled') continue;
        if (verdict === 'gone') {
          console.info("[codeintel] The queue task has been confirmed to be completed and the cancellation responsibility is released.", JSON.stringify({id}));
          continue;
        }
        remaining.push(id);
      }
      const done = list.filter(id => !remaining.includes(id));
      if (done.length) {
        // Subtract from current value instead of reading remaining Overall writeback: newly added during the period ID Cannot be overwritten
        await this.pool.query(
          `UPDATE exploration_nodes SET payload = payload || jsonb_build_object(
             'audit_cancel_queue', COALESCE((
               SELECT jsonb_agg(value) FROM jsonb_array_elements_text(
                 COALESCE(payload->'audit_cancel_queue','[]'::jsonb)) AS value
               WHERE value <> ALL($3::text[])), '[]'::jsonb))
           WHERE id=$1 AND task_id=$2`,
          [Number(row.id), taskId, done]).catch(() => {});
      }
    }
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'audit_state' = 'cancel_pending' LIMIT 10`, [taskId])).rows;
    for (const row of rows) {
      const pending = String(row.payload.audit_pending_task_id ?? row.payload.audit_task_id ?? '');
      const gen = String(row.payload.audit_gen ?? '');
      if (!pending) continue;
      const verdict = await this.cancelOrResolve(pending,signal);
      if (verdict === 'pending') continue;
      const cancelled = verdict === 'cancelled';
      // Only end the cancellation of ”this generation, this external task”; if it is force Again, new audit cannot be overwritten into stopped
      const settled = await this.pool.query(
        `UPDATE exploration_nodes SET payload = payload || jsonb_build_object(
           'audit_state','stopped','audit_stopped_at',$4::text,'audit_stopped_task_id',$2,'audit_cancel_error',NULL)
           WHERE id=$1 AND kind='fact'
             AND payload->>'audit_state' = 'cancel_pending'
             AND COALESCE(payload->>'audit_pending_task_id', payload->>'audit_task_id','') = $2
             AND COALESCE(payload->>'audit_gen','') = $3
           RETURNING id`,
        [Number(row.id), pending, gen, new Date().toISOString()]);
      if (!settled.rowCount) {
        // The status has been taken over by the new generation: the old task is indeed stopped, but do not touch the new record
        console.info("[codeintel] Ignore expired cancel writebacks", JSON.stringify({taskId, factId: row.id, pending}));
      }
    }
  }

  async stopTask(taskId: number): Promise<void> {
    // Persist cancellation ownership before contacting an unavailable external service.
    await this.pool.query(
      `UPDATE exploration_nodes SET payload=payload || jsonb_build_object(
        'audit_state',CASE WHEN COALESCE(payload->>'audit_task_id',payload->>'audit_pending_task_id','')='' THEN 'stopping' ELSE 'cancel_pending' END,
        'audit_stop_requested',true,'audit_stop_gen',COALESCE((payload->>'audit_gen')::int,0),
        'audit_stop_requested_at',$2::text)
       WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$3
         AND payload->>'audit_state' IN ('running','claimed','stopping','cancel_pending')`,
      [taskId,new Date().toISOString(),KIND_READY]);
    await this.retryCancels(taskId,AbortSignal.timeout(5000)).catch(()=>{});
  }

  /**
   * Snapshot recycling: Each directory retains the two most recent copies by default; those that are in use or referenced by other facts will not be deleted.；
   * Skip deletion when the reference relationship cannot be determined. It would rather take up space than delete by mistake.。
   */
  async pruneSnapshots(taskId: number, dirKey?: string): Promise<number> {
    const rows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'source_type'='snapshot' AND COALESCE(payload->>'snapshot_pruned','false') <> 'true'
       ORDER BY id DESC`, [taskId])).rows;
    const readyRows = (await this.pool.query(
      `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact'
         AND payload->>'kind'=$2`, [taskId, KIND_READY])).rows;
    // The historical success set should contain replaced ready：Otherwise the old successful version will be treated as ”never successful” and all skipped
    const indexed = new Set(readyRows.map((row: any) => String(row.payload.source_fact ?? '')));
    const live = new Set(readyRows
      .filter((row: any) => row.payload.superseded !== true)
      .map((row: any) => String(row.payload.source_fact ?? '')));
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = String(row.payload.dir_key ?? '');
      if (dirKey && key !== dirKey) continue;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    let removed = 0;
    for (const [, list] of groups) {
      const succeeded = list.filter((row: any) => indexed.has(String(row.id)));
      const keep = new Set(succeeded.slice(0, 2).map((row: any) => Number(row.id)));
      // The version currently in use will be retained regardless of its ranking.
      for (const row of succeeded) if (live.has(String(row.id))) keep.add(Number(row.id));
      for (const row of list) {
        // The version that has not been indexed successfully (including queuing/Importing/Waiting for retry) will not move
        if (!indexed.has(String(row.id))) continue;
        if (keep.has(Number(row.id))) continue;
        const file = String(row.payload.path ?? '');
        if (!file) continue;
        if (await this.referencedAnywhere(file, Number(row.id))) continue;
        try {
          await rm(file, {force: true});
        } catch { continue; }   // If deletion fails, the retryable state will be retained.
        await this.patchFact(Number(row.id), {snapshot_pruned: true}).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  /**
   * Whether this document is cited elsewhere. Coverage: Exploration graph facts (top-level fields and text), task reports, formal vulnerability records for any task。
   * When the query fails, it will be processed as ”referenced” - it would rather not be deleted.。
   */
  private async referencedAnywhere(file: string, selfNodeId: number): Promise<boolean> {
    const name = path.basename(file);
    const probes: [string, unknown[]][] = [
      [`SELECT 1 FROM exploration_nodes WHERE id<>$1
          AND (payload->>'path'=$2 OR payload->>'snapshot_path'=$2 OR payload::text LIKE $3) LIMIT 1`,
        [selfNodeId, file, `%${name}%`]],
      [`SELECT 1 FROM task_reports WHERE markdown LIKE $1 LIMIT 1`, [`%${name}%`]],
      // Vulnerability records are always protected: this task is not excluded or leaked task_id Empty record
      [`SELECT 1 FROM findings
          WHERE evidence LIKE $1 OR detail LIKE $1 OR report LIKE $1 OR summary LIKE $1 LIMIT 1`,
        [`%${name}%`]],
    ];
    for (const [sql, params] of probes) {
      const row = await this.pool.query(sql, params).catch(() => null);
      if (!row) return true;
      if (row.rowCount) return true;
    }
    return false;
  }

  /** After the task is completely deleted, clear its index file; if there are still references elsewhere, skip it。 */
  async purgeTask(taskId: number): Promise<void> {
    const dir = path.join(this.dataDir, 'codeintel', String(taskId));
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) return;
    const needle = `%${path.join('codeintel', String(taskId))}%`;
    const probes: [string, unknown[]][] = [
      // All node types are counted as references (paths mentioned in the text of prompts, clues, and intentions are also counted), only the registration of this task itself is excluded.
      [`SELECT 1 FROM exploration_nodes WHERE task_id<>$2
          AND (payload->>'path' LIKE $1 OR payload->>'snapshot_path' LIKE $1 OR payload::text LIKE $1) LIMIT 1`,
        [needle, taskId]],
      [`SELECT 1 FROM task_reports WHERE markdown LIKE $1 LIMIT 1`, [needle]],
      [`SELECT 1 FROM findings WHERE evidence LIKE $1 OR detail LIKE $1 OR report LIKE $1 OR summary LIKE $1 LIMIT 1`, [needle]],
    ];
    for (const [sql, params] of probes) {
      const row = await this.pool.query(sql, params).catch(() => null);
      if (!row) { console.warn("[codeintel] Reference judgment failed, skipping cleanup", dir); return; }
      if (row.rowCount) { console.warn("[codeintel] There are still references, skip cleaning", dir); return; }
    }
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }

  /** Audits not completed at the end of the grace period: leave visible status, do not pretend to have collected them。 */
  async markUnfinished(taskId: number): Promise<void> {
    try {
      const rows = (await this.pool.query(
        `SELECT id,payload FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2
           AND payload->>'audit_state' IN ('running','claimed','stopping','cancel_pending')`, [taskId, KIND_READY])).rows;
      const stuck: string[] = [];
      for (const row of rows) {
        const auditTaskId = String(row.payload.audit_task_id ?? row.payload.audit_pending_task_id ?? '');
        if (!auditTaskId) continue;
        const cancelled = await this.client.cancelAudit(auditTaskId).catch(() => false);
        if (!cancelled) stuck.push(String(row.id));
      }
      // Cannot be marked as final state if it cannot be removed. cancel_pending Leave it to the background to continue
      for (const id of stuck) {
        const attempted = String((rows.find(r => String(r.id) === id)?.payload ?? {}).audit_task_id
          ?? (rows.find(r => String(r.id) === id)?.payload ?? {}).audit_pending_task_id ?? '');
        // Write back the one you just actually tried to cancel ID，instead of the old remaining in the field ID
        await this.patchFact(Number(id), {audit_state: 'cancel_pending',
          audit_pending_task_id: attempted,
          audit_cancel_error: "The task ended but the white box did not confirm the cancellation."}).catch(() => {});
      }
    } catch { /* Undo failure does not affect marking */ }
    await this.pool.query(
      `UPDATE exploration_nodes SET payload = payload || '{"audit_state":"unfinished"}'::jsonb
         WHERE task_id=$1 AND kind='fact' AND payload->>'kind'=$2 AND payload->>'audit_state' IN ('running','claimed')`,
      [taskId, KIND_READY]).catch(() => undefined);
  }
}
