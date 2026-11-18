/** Independent compressed frames: exact source JSONL, bounded memory, seq range reads.
 * This writer never deletes database rows. manifest.json is the completion marker.
 */
import {mkdir, open, readFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {compress, decompress, sha256, MAX_BODY_BYTES, type StorageCodec} from './codec.ts';

export interface ArchiveBlock {
  file: string; firstSeq: string; lastSeq: string; rows: number;
  rawBytes: number; storedBytes: number; rawHash: string; storedHash: string;
}
export interface ArchiveManifest {
  format: 'wormhole-event-archive'; version: 1; codec: StorageCodec; level: number | null;
  createdAt: string; source: Record<string, unknown>; rows: number; rawBytes: number;
  storedBytes: number; rawHash: string; compressionMs: number; blocks: ArchiveBlock[];
}
const sequence = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('invalid archive sequence');
  return BigInt(value);
};
export function lineSequence(line: string): string {
  const value = JSON.parse(line) as {seq?: unknown};
  sequence(value.seq);
  return value.seq as string;
}
async function exclusiveWrite(file: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class EventArchiveWriter {
  private lines: Buffer[] = [];
  private pendingBytes = 0;
  private pendingFirst = '';
  private pendingLast = '';
  private previous = 0n;
  private digest = createHash('sha256');
  private finished = false;
  readonly manifest: ArchiveManifest;
  private constructor(readonly directory: string, codec: StorageCodec, source: Record<string, unknown>, readonly blockBytes: number, level?: number) {
    this.manifest = {format: 'wormhole-event-archive', version: 1, codec, level: level ?? null, source,
      createdAt: new Date().toISOString(), rows: 0, rawBytes: 0, storedBytes: 0, rawHash: '', compressionMs: 0, blocks: []};
  }
  static async create(directory: string, codec: StorageCodec, source: Record<string, unknown> = {}, blockBytes = 4 * 1024 * 1024, level?: number): Promise<EventArchiveWriter> {
    if (!Number.isSafeInteger(blockBytes) || blockBytes < 1024 || blockBytes > MAX_BODY_BYTES / 2) throw new Error('invalid archive block size');
    await mkdir(directory, {mode: 0o700}); // refuse an existing/incomplete destination
    return new EventArchiveWriter(directory, codec, source, blockBytes, level);
  }
  async append(line: string): Promise<void> {
    if (this.finished) throw new Error('archive already finished');
    if (line.includes('\n') || line.includes('\r')) throw new Error('archive record must be one JSON line');
    const seq = lineSequence(line), number = sequence(seq);
    if (number <= this.previous) throw new Error('archive sequences must strictly increase');
    const bytes = Buffer.from(line + '\n');
    if (bytes.length > MAX_BODY_BYTES) throw new Error('archive event exceeds maximum size');
    if (this.pendingBytes && this.pendingBytes + bytes.length > this.blockBytes) await this.flush();
    if (!this.pendingFirst) this.pendingFirst = seq;
    this.pendingLast = seq; this.previous = number;
    this.lines.push(bytes); this.pendingBytes += bytes.length;
    this.digest.update(bytes); this.manifest.rows++; this.manifest.rawBytes += bytes.length;
    if (this.pendingBytes >= this.blockBytes) await this.flush();
  }
  private async flush(): Promise<void> {
    if (!this.lines.length) return;
    const raw = Buffer.concat(this.lines, this.pendingBytes), started = performance.now();
    const compressed = await compress(raw, this.manifest.codec, this.manifest.level ?? undefined);
    this.manifest.compressionMs += performance.now() - started;
    const file = String(this.manifest.blocks.length).padStart(8, '0') + '.frame';
    await exclusiveWrite(path.join(this.directory, file), compressed);
    this.manifest.blocks.push({file, firstSeq: this.pendingFirst, lastSeq: this.pendingLast, rows: this.lines.length,
      rawBytes: raw.length, storedBytes: compressed.length, rawHash: sha256(raw), storedHash: sha256(compressed)});
    this.manifest.storedBytes += compressed.length;
    this.lines = []; this.pendingBytes = 0; this.pendingFirst = ''; this.pendingLast = '';
  }
  async finish(): Promise<ArchiveManifest> {
    if (this.finished) throw new Error('archive already finished');
    await this.flush();
    this.manifest.rawHash = this.digest.digest('hex');
    await exclusiveWrite(path.join(this.directory, 'manifest.json'), JSON.stringify(this.manifest, null, 2) + '\n');
    this.finished = true;
    return this.manifest;
  }
}

export async function readArchiveManifest(directory: string): Promise<ArchiveManifest> {
  const filename = path.join(directory, 'manifest.json'), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('invalid archive manifest file');
  const m = JSON.parse(await readFile(filename, 'utf8')) as ArchiveManifest;
  if (m.format !== 'wormhole-event-archive' || m.version !== 1 || !['identity', 'gzip', 'zstd'].includes(m.codec) || !Array.isArray(m.blocks)) throw new Error('unsupported archive format');
  let previous = 0n, rows = 0, rawBytes = 0, storedBytes = 0;
  const names = new Set<string>();
  for (const b of m.blocks) {
    if (!/^\d{8}\.frame$/.test(b.file) || names.has(b.file)) throw new Error('invalid archive frame path');
    names.add(b.file);
    if (sequence(b.firstSeq) <= previous || sequence(b.lastSeq) < sequence(b.firstSeq)) throw new Error('invalid archive ranges');
    previous = sequence(b.lastSeq);
    if (![b.rows, b.rawBytes, b.storedBytes].every(n => Number.isSafeInteger(n) && n > 0) || b.rawBytes > MAX_BODY_BYTES || b.storedBytes > MAX_BODY_BYTES + 1024 * 1024) throw new Error('invalid archive frame size');
    if (!/^[a-f0-9]{64}$/.test(b.rawHash) || !/^[a-f0-9]{64}$/.test(b.storedHash)) throw new Error('invalid archive checksum');
    rows += b.rows; rawBytes += b.rawBytes; storedBytes += b.storedBytes;
  }
  if (m.rows !== rows || m.rawBytes !== rawBytes || m.storedBytes !== storedBytes || !/^[a-f0-9]{64}$/.test(m.rawHash)) throw new Error('invalid archive totals');
  return m;
}

async function readFrame(directory:string,m:ArchiveManifest,b:ArchiveBlock):Promise<Buffer>{
  const file=path.join(directory,b.file),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==b.storedBytes)throw new Error('invalid archive frame file');
  const bytes=await readFile(file);
  if(sha256(bytes)!==b.storedHash)throw new Error('archive stored checksum mismatch');
  const raw=await decompress(bytes,m.codec,b.rawBytes);
  if(sha256(raw)!==b.rawHash)throw new Error('archive raw checksum mismatch');
  return raw;
}

/** Verify exact restored bytes/counts without JSON-parsing every repeated snapshot.
 * Full row parsing/order validation remains in readEventArchive when rows are used.
 */
export async function verifyEventArchive(directory:string):Promise<{rows:number;rawHash:string}>{
  const m=await readArchiveManifest(directory),digest=createHash('sha256');let rows=0;
  for(const b of m.blocks){
    const raw=await readFrame(directory,m,b);digest.update(raw);
    if(raw.at(-1)!==10)throw new Error('archive frame missing newline');
    let at=-1,count=0;while((at=raw.indexOf(10,at+1))!==-1)count++;
    if(count!==b.rows)throw new Error('archive row count mismatch');
    const first=raw.subarray(0,raw.indexOf(10)).toString('utf8');
    const last=raw.subarray(raw.lastIndexOf(10,raw.length-2)+1,raw.length-1).toString('utf8');
    if(lineSequence(first)!==b.firstSeq||lineSequence(last)!==b.lastSeq)throw new Error('archive frame boundary mismatch');
    rows+=count;
  }
  const rawHash=digest.digest('hex');
  if(rows!==m.rows||rawHash!==m.rawHash)throw new Error('archive full checksum mismatch');
  return {rows,rawHash};
}

export async function* readEventArchive(directory: string, options: {fromSeq?: string; toSeq?: string} = {}): AsyncGenerator<string> {
  const m = await readArchiveManifest(directory), from = options.fromSeq ? sequence(options.fromSeq) : 0n;
  const to = options.toSeq ? sequence(options.toSeq) : undefined;
  if (to !== undefined && to < from) throw new Error('invalid requested archive range');
  const full = !options.fromSeq && !options.toSeq, digest = createHash('sha256');
  for (const b of m.blocks) {
    if (sequence(b.lastSeq) < from || (to !== undefined && sequence(b.firstSeq) > to)) continue;
    const raw = await readFrame(directory,m,b);
    if (full) digest.update(raw);
    const text = raw.toString('utf8');
    if (!text.endsWith('\n')) throw new Error('archive frame missing newline');
    const lines = text.slice(0, -1).split('\n');
    if (lines.length !== b.rows) throw new Error('archive row count mismatch');
    let previous = 0n;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!, seq = sequence(lineSequence(line));
      if (seq <= previous || (i === 0 && String(seq) !== b.firstSeq) || (i === lines.length - 1 && String(seq) !== b.lastSeq)) throw new Error('archive row sequence mismatch');
      previous = seq;
      if (seq >= from && (to === undefined || seq <= to)) yield line;
    }
  }
  if (full && digest.digest('hex') !== m.rawHash) throw new Error('archive full checksum mismatch');
}

/** Random lookup for globally interleaved worker streams. Cache raw frames, not
 * decoded object graphs or suspended generators; eviction is bounded by bytes.
 */
export class ArchiveRowReader {
  private frames=new Map<string,{raw:Buffer;offsets:Map<string,[number,number]>}>();
  private manifests=new Map<string,{manifest:ArchiveManifest;bytes:number}>();
  private manifestBytes=0;
  readonly stats={framesRead:0,hits:0,residentBytes:0,peakResidentBytes:0};
  constructor(readonly byteBudget=32*1024**2,readonly frameLimit=16,readonly manifestBudget=8*1024**2){
    if(!Number.isSafeInteger(byteBudget)||byteBudget<1024||byteBudget>MAX_BODY_BYTES||!Number.isSafeInteger(frameLimit)||frameLimit<1||frameLimit>128)throw new Error('invalid archive cache budget');
  }
  private evict(){const key=this.frames.keys().next().value;if(key===undefined)return;this.stats.residentBytes-=this.frames.get(key)!.raw.length;this.frames.delete(key);}
  private async manifest(directory:string,expected:string){
    if(!/^[a-f0-9]{64}$/.test(expected))throw new Error('missing archive manifest checksum');
    const key=directory+'\0'+expected,hit=this.manifests.get(key);
    if(hit){this.manifests.delete(key);this.manifests.set(key,hit);return hit.manifest;}
    const file=path.join(directory,'manifest.json'),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024**2)throw new Error('invalid archive manifest file');
    if(sha256(await readFile(file))!==expected)throw new Error('cold manifest checksum mismatch');
    const manifest=await readArchiveManifest(directory),bytes=info.size*4;
    while(this.manifests.size&&(this.manifests.size>=16||this.manifestBytes+bytes>this.manifestBudget)){
      const oldest=this.manifests.keys().next().value!;this.manifestBytes-=this.manifests.get(oldest)!.bytes;this.manifests.delete(oldest);
    }
    if(bytes<=this.manifestBudget){this.manifests.set(key,{manifest,bytes});this.manifestBytes+=bytes;}return manifest;
  }
  async read(directory:string,expected:string,seq:string):Promise<string>{
    const number=sequence(seq),manifest=await this.manifest(directory,expected);
    let low=0,high=manifest.blocks.length;
    while(low<high){const mid=(low+high)>>>1;if(sequence(manifest.blocks[mid]!.lastSeq)<number)low=mid+1;else high=mid;}
    const block=manifest.blocks[low];if(!block||number<sequence(block.firstSeq))throw new Error('cold event missing during export');
    const key=directory+'\0'+expected+'\0'+block.file;let frame=this.frames.get(key);
    if(frame){this.stats.hits++;this.frames.delete(key);this.frames.set(key,frame);}
    else{
      while(this.frames.size&&(this.frames.size>=this.frameLimit||this.stats.residentBytes+block.rawBytes>this.byteBudget))this.evict();
      const raw=await readFrame(directory,manifest,block),offsets=new Map<string,[number,number]>();this.stats.framesRead++;
      let start=0,count=0,previous=0n,first='';
      while(start<raw.length){const end=raw.indexOf(10,start);if(end<0)throw new Error('archive frame missing newline');
        // Source SQL JSON places ts/seq first. The fallback handles other valid
        // archive writers, without accepting nested payload.seq as the identity.
        const prefix=raw.subarray(start,Math.min(end,start+256)).toString('utf8');
        const match=/^\s*\{\s*(?:"ts"\s*:\s*"[^"\\]*"\s*,\s*)?"seq"\s*:\s*"([1-9]\d*)"/.exec(prefix);
        const id=match?.[1]??lineSequence(raw.subarray(start,end).toString('utf8')),value=sequence(id);
        if(value<=previous)throw new Error('archive row sequence mismatch');previous=value;if(!first)first=id;
        offsets.set(id,[start,end]);count++;start=end+1;
      }
      if(count!==block.rows||first!==block.firstSeq||String(previous)!==block.lastSeq)throw new Error('archive frame boundary mismatch');
      frame={raw,offsets};
      if(raw.length<=this.byteBudget){this.frames.set(key,frame);this.stats.residentBytes+=raw.length;this.stats.peakResidentBytes=Math.max(this.stats.peakResidentBytes,this.stats.residentBytes);}
    }
    const range=frame.offsets.get(seq);if(!range)throw new Error('cold event missing during export');
    return frame.raw.subarray(range[0],range[1]).toString('utf8');
  }
  clear(){this.frames.clear();this.manifests.clear();this.manifestBytes=0;this.stats.residentBytes=0;}
}
