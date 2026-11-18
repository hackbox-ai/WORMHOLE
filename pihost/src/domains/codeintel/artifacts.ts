/** Product identification and repackaging: answer only two questions - what is it, and how to make the white box eat。 */
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {lstat, mkdir, open, readdir, rm, stat} from 'node:fs/promises';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

export type ArtifactKind =
  | 'zip' | 'jar' | 'apk' | 'wxapkg' | 'gobinary' | 'pe' | 'elfbin' | 'macho'
  | 'tar' | 'gzip' | 'bzip2' | 'xz' | 'zstd';

/** White box can be eaten directly, no need to repackage。 */
const NATIVE = new Set<ArtifactKind>(['zip', 'jar', 'apk', 'wxapkg', 'gobinary', 'pe', 'elfbin', 'macho']);
export const isNative = (kind: ArtifactKind): boolean => NATIVE.has(kind);

async function head(file: string, bytes: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const {bytesRead} = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function digestFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Only look at head features, do not read the entire file；Go Binary extra scan ahead 2MB Find buildinfo。 */
export async function detect(file: string, filename = path.basename(file)): Promise<ArtifactKind | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size < 2) return null;
  const name = filename.toLowerCase();
  const head1024 = await head(file, 1024);
  if (head1024.length < 2) return null;

  if (head1024.subarray(0, 6).toString('latin1') === 'V1MMWX' || name.endsWith('.wxapkg')) return 'wxapkg';
  // IPA also zip，But the white box cannot parse iOS，handed over REA；Naked Mach-O Same reason。
  if (name.endsWith('.ipa')) return 'macho';
  if (head1024[0] === 0x50 && head1024[1] === 0x4b) {
    if (name.endsWith('.apk') || name.endsWith('.xapk') || name.endsWith('.apks')) return 'apk';
    if (/\.(jar|war|ear)$/.test(name)) return 'jar';
    return 'zip';
  }
  const magic = head1024.readUInt32BE(0);
  const thinMacho = magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe;
  const fatMacho = (magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf) && !name.endsWith('.class');
  if (thinMacho || fatMacho) return 'macho';
  const isElf = head1024[0] === 0x7f && head1024[1] === 0x45 && head1024[2] === 0x4c && head1024[3] === 0x46;
  const isPe = head1024[0] === 0x4d && head1024[1] === 0x5a;
  if (isElf || isPe) {
    const wide = await head(file, 2 * 1024 * 1024);
    if (wide.includes(Buffer.from('Go build ID:')) || wide.includes(Buffer.from('.go.buildinfo'))) return 'gobinary';
    return isElf ? 'elfbin' : 'pe';
  }
  if (head1024[0] === 0x1f && head1024[1] === 0x8b) return 'gzip';
  if (head1024.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
  if (head1024[0] === 0xfd && head1024[1] === 0x37 && head1024[2] === 0x7a && head1024[3] === 0x58) return 'xz';
  if (head1024[0] === 0x28 && head1024[1] === 0xb5 && head1024[2] === 0x2f && head1024[3] === 0xfd) return 'zstd';
  if (head1024.length >= 262 && head1024.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
}

/** The upper limit of unpacking time and volume: Malformed packages cannot drag the host to death.。 */
const execFileAsync = promisify(execFile);
const UNPACK_TIMEOUT_MS = 10 * 60_000;
const UNPACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function run(command: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, {cwd, stdio: 'ignore', ...(signal ? {signal} : {})});
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, UNPACK_TIMEOUT_MS);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Start with tar Calculate the expansion volume in the list: know whether it will exceed the disk before writing to avoid the disk being filled up first。 */
/**
 * Read tar List。ok=false means ”Not at all tar”（Handle single file path）；
 * ok=true But bytes=null means confirm yes tar But the volume cannot be calculated - this cannot be released。
 */
async function declaredTarBytes(file: string, signal?: AbortSignal): Promise<{ok: boolean; bytes: number | null}> {
  try {
    const {stdout} = await execFileAsync('tar', ['-tvf', file], {timeout: 60_000, maxBuffer: 64 << 20, ...(signal ? {signal} : {})});
    let total = 0, sawLine = false;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const size = Number(parts[2]);
      if (!Number.isFinite(size)) return {ok: true, bytes: null};
      sawLine = true;
      total += size;
    }
    return sawLine ? {ok: true, bytes: total} : {ok: false, bytes: null};
  } catch { return {ok: false, bytes: null}; }
}

/** Count the directory volume with an upper limit: return immediately if the upper limit is exceeded, without full traversal。 */
async function dirBytes(dir: string, limit: number): Promise<number> {
  let total = 0, cut = false;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 32) { cut = true; return; }
    if (total > limit) { cut = true; return; }
    const entries = await readdir(current, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (total > limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      const info = await stat(full).catch(() => null);
      if (info) total += info.size;
    }
  };
  await walk(dir, 0);
  return cut ? limit + 1 : total;   // When the traversal is truncated, it is treated as ”over limit” and cannot be fine by default.
}

const SINGLE: Partial<Record<ArtifactKind, [string, string[]]>> = {
  gzip: ['gunzip', ['-c']],
  bzip2: ['bunzip2', ['-c']],
  xz: ['xz', ['-dc']],
  zstd: ['zstd', ['-dc']],
};

/** Native zip Expansion budget before uploading: total decompression, single file, number of entries。 */
const ZIP_UNPACK_LIMITS = {entries: 200_000, totalBytes: 4 * 1024 * 1024 * 1024, singleFile: 1024 * 1024 * 1024};

/**
 * Read only the central directory, estimate the size after decompression。
 * The purpose is to zip Stop the ”packet explosion” before handing it over to the white box, instead of waiting for it to fill up the disk。
 */
export async function inspectZipBudget(file: string): Promise<{entries: number; totalBytes: number; maxBytes: number; zip64: boolean; complete: boolean}> {
  const info = await stat(file);
  const tailSize = Math.min(info.size, 70 * 1024);
  const handle = await open(file, 'r');
  try {
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, info.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid zip (end of central directory not found)");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      return {entries: count, totalBytes: -1, maxBytes: -1, zip64: true, complete: false};
    }
    if (cdSize > 64 * 1024 * 1024) {
      return {entries: count, totalBytes: -1, maxBytes: -1, zip64: true, complete: false};
    }
    const readSize = cdSize;
    const cd = Buffer.alloc(readSize);
    const {bytesRead} = await handle.read(cd, 0, readSize, cdOffset);
    if (bytesRead !== readSize) return {entries: count, totalBytes: -1, maxBytes: -1, zip64: false, complete: false};
    let pos = 0, entries = 0, total = 0, max = 0;
    while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
      const uncompSize = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      if (uncompSize === 0xffffffff) return {entries, totalBytes: -1, maxBytes: -1, zip64: true, complete: false};
      entries++;
      total += uncompSize;
      max = Math.max(max, uncompSize);
      if (entries > ZIP_UNPACK_LIMITS.entries) return {entries, totalBytes: total, maxBytes: max, zip64: false, complete: false};
      if (total > ZIP_UNPACK_LIMITS.totalBytes) return {entries, totalBytes: total, maxBytes: max, zip64: false, complete: false};
      pos += 46 + nameLen + extraLen + commentLen;
    }
    // After consumption and the number of entries is equal to EOCD Consistency is complete; prefix resolution cannot be used as a security check
    const complete = pos === cdSize && entries === count;
    return {entries, totalBytes: complete ? total : -1, maxBytes: complete ? max : -1, zip64: false, complete};
  } finally {
    await handle.close();
  }
}

/** Directories skipped during packaging: dependencies, cache、VCS Metadata and Products。 */
const ZIP_SKIP_DIRS = new Set(['node_modules', '.git', 'bower_components', 'vendor',
                               'dist', 'build', 'target', '.venv', 'venv', '__pycache__',
                               '.cache', '.npm', '.pnpm-store']);
const ZIP_MAX_ENTRIES = 200_000;
const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ZIP_TIMEOUT_MS = 120_000;

/**
 * Type the directory into zip。
 * Key Constraints：**Symbolic links not followed**——Symbolic links only remember the link itself and never bring in the contents of files outside the tree.。
 * Set an upper limit based on the number of entries and total bytes at the same time. If the limit is exceeded, it will fail directly and no semi-finished product will be generated.。
 */
export async function zipDirectory(root: string, out: string, signal?: AbortSignal,
                                   options: {exclude?: Set<string>; keepEmpty?: boolean; excludeArchives?: boolean} = {}): Promise<{files: number; skippedLinks: number; skippedUnsafe: number; readErrors: number}> {
  const files: string[] = [];
  const exclude = options.exclude ?? ZIP_SKIP_DIRS;
  const keepEmpty = options.keepEmpty === true;
  const excludeArchives = options.excludeArchives !== false;   // Snapshots are excluded by default, and full repackaging is retained by default.
  let skippedLinks = 0, skippedUnsafe = 0, readErrors = 0, total = 0;
  const base = path.resolve(root);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error("The directory level is too deep and packaging has been refused: " + root);
    if (signal?.aborted) throw new Error("Canceled");
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => {
      readErrors += 1;      // Cannot read ≠ Does not exist: must be visible to the upper level
      return [];
    });
    for (const entry of entries) {
      if (files.length >= ZIP_MAX_ENTRIES) throw new Error(`Packaging entries exceed the upper limit ${ZIP_MAX_ENTRIES}`);
      // zip -@ Read file name by line: any first-level name band CR/LF will split one line into two lines, which is equivalent to rewriting the path。
      // It must be stopped before entering the directory, otherwise the newline of the parent directory will be entered into the list along with the child file.。
      if (/[\r\n]/.test(entry.name)) { skippedUnsafe++; continue; }
      const full = path.join(dir, entry.name);
      const info = await lstat(full).catch(() => { readErrors += 1; return null; });
      if (!info) continue;
      if (info.isSymbolicLink()) { skippedLinks++; continue; }     // Do not follow nor package the link itself
      if (info.isDirectory()) {
        if (!exclude.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size === 0 && !keepEmpty) continue;
      if (excludeArchives && /\.(zip|tar|tgz|gz|bz2|xz|zst|7z)$/i.test(entry.name)) continue;   // Snapshot does not cover the archive with another layer

      total += info.size;
      if (total > ZIP_MAX_BYTES) throw new Error(`The package content exceeds the upper limit ${ZIP_MAX_BYTES} Bytes`);
      const rel = path.relative(base, full);
      if (/[\r\n]/.test(rel)) { skippedUnsafe++; continue; }   // Bottom line: go through the complete relative path again
      files.push(rel);
    }
  };
  await walk(base, 0);
  if (!files.length) throw new Error("There are no packable files in the directory: " + root);
  await rm(out, {force: true});
  await new Promise<void>((resolve, reject) => {
    const child = spawn('zip', ['-q', '-y', '-@', out], {
      cwd: base, stdio: ['pipe', 'ignore', 'ignore'], ...(signal ? {signal} : {}),
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { child.kill('SIGKILL'); } catch {} reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("zip packaging timeout")), ZIP_TIMEOUT_MS);
    child.once('error', error => finish(error as Error));
    child.once('close', code => code === 0 ? finish() : finish(new Error("zip packaging failed code=" + code)));
    // zip Write pipe meeting when exiting early EPIPE：This is Writable Error, not hanging on child on，
    // If not caught, it will become unprocessed by the host process. error。
    child.stdin?.on('error', error => finish(error as Error));
    child.stdin?.end(files.join('\n') + '\n');
  });
  return {files: files.length, skippedLinks, skippedUnsafe, readErrors};
}

/** Unpack the non-native format and re-type it into zip。Back zip Path; error thrown on failure。 */
export async function repackToZip(file: string, kind: ArtifactKind, workDir: string, signal?: AbortSignal)
  : Promise<{zip: string; skippedLinks: number; skippedUnsafe: number; readErrors: number}> {
  const stage = path.join(workDir, 'unpacked');
  await rm(stage, {recursive: true, force: true});
  await mkdir(stage, {recursive: true});

  const name = path.basename(file);
  const probe = await declaredTarBytes(file, signal);
  if (probe.ok) {
    // Confirm Yes tar：If you can’t calculate the volume, you won’t understand. Avoid filling the disk first and then discovering that it is over the limit.
    if (probe.bytes === null) {
      await rm(stage, {recursive: true, force: true});
      throw new Error(`The tar manifest cannot be parsed, and unpacking has been refused to avoid filling up the disk: ${name}`);
    }
    if (probe.bytes > UNPACK_MAX_BYTES) {
      await rm(stage, {recursive: true, force: true});
      throw new Error(`After unfolding the package, approx. ${probe.bytes} Bytes, upper limit exceeded ${UNPACK_MAX_BYTES}, not unpacked: ${name}`);
    }
    if (!await run('tar', ['-xf', file, '-C', stage], undefined, signal)) {
      await rm(stage, {recursive: true, force: true});
      throw new Error("Unpacking failed, possibly encrypted or damaged package: " + name);
    }
  } else if (kind === 'tar') {
    await rm(stage, {recursive: true, force: true});
    throw new Error("The tar package is damaged or the manifest cannot be read: " + name);
  } else {
    // Ordinary single file compression: streaming disk, counting while writing
    const single = SINGLE[kind];
    if (!single) throw new Error("Unpacking tool missing: " + kind);
    const target = path.join(stage, name.replace(/\.(gz|bz2|xz|zst|tgz)$/i, '') || 'payload');
    const ok = await new Promise<boolean>(resolve => {
      const child = spawn(single[0], [...single[1], file], {stdio: ['ignore', 'pipe', 'ignore'], ...(signal ? {signal} : {})});
      const sink = createWriteStream(target);
      let written = 0, settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); sink.destroy(); finish(false); }, UNPACK_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > UNPACK_MAX_BYTES) { child.kill('SIGKILL'); sink.destroy(); finish(false); return; }
        if (!sink.write(chunk)) child.stdout.pause();
      });
      sink.on('drain', () => child.stdout.resume());
      sink.on('error', () => { child.kill('SIGKILL'); finish(false); });
      child.once('error', () => { sink.destroy(); finish(false); });
      child.once('close', code => { sink.end(() => finish(code === 0)); });
    });
    if (!ok) throw new Error("Unpacking failed, possibly encrypted or damaged package: " + name);
  }

  const unpacked = await dirBytes(stage, UNPACK_MAX_BYTES);
  if (unpacked > UNPACK_MAX_BYTES) {
    await rm(stage, {recursive: true, force: true});
    throw new Error(`The volume after unpacking exceeds the upper limit (${UNPACK_MAX_BYTES} bytes), import aborted: ${name}`);
  }

  const zipPath = path.join(workDir, 'package.zip');
  // The product repackage is ”completely retained” and the exclusion policy of the workspace snapshot is not applied. Empty files must also be retained.
  const range = await zipDirectory(stage, zipPath, signal, {exclude: new Set(), keepEmpty: true, excludeArchives: false});
  await rm(stage, {recursive: true, force: true});
  return {zip: zipPath, ...range};
}
