/** Lossless, bounded body compression. Codec is persisted with every object. */
import * as zlib from 'node:zlib';
import {createHash} from 'node:crypto';

export type StorageCodec = 'identity' | 'gzip' | 'zstd';
export const MAX_BODY_BYTES = 256 * 1024 * 1024;
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Compressor = (bytes: Uint8Array, options: Record<string, unknown>, callback: (error: Error | null, result: Buffer) => void) => void;
const native = zlib as unknown as Record<string, Compressor | undefined>;
export function hasZstd(): boolean { return typeof native.zstdCompress === 'function' && typeof native.zstdDecompress === 'function'; }

export async function compress(bytes: Buffer, codec: StorageCodec, level?: number): Promise<Buffer> {
  if (bytes.length > MAX_BODY_BYTES) throw new Error('storage body exceeds maximum size');
  if (codec === 'identity') return bytes;
  const fn = codec === 'gzip' ? native.gzip : native.zstdCompress;
  if (!fn) throw new Error(`storage codec unavailable: ${codec}`);
  const options = codec === 'gzip' ? {level: level ?? 6} : {params: {[String((zlib.constants as unknown as Record<string, number>).ZSTD_c_compressionLevel)]: level ?? 3}};
  return new Promise((resolve, reject) => fn(bytes, options, (error, result) => error ? reject(error) : resolve(result)));
}

export async function decompress(bytes: Buffer, codec: StorageCodec, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_BODY_BYTES) throw new Error('invalid storage length');
  let result: Buffer;
  if (codec === 'identity') result = bytes;
  else {
    const fn = codec === 'gzip' ? native.gunzip : native.zstdDecompress;
    if (!fn) throw new Error(`storage codec unavailable: ${codec}`);
    result = await new Promise<Buffer>((resolve, reject) => fn(bytes, {maxOutputLength: Math.max(1, expectedBytes)}, (error, value) => error ? reject(error) : resolve(value)));
  }
  if (result.length !== expectedBytes) throw new Error('storage length mismatch');
  return result;
}

export interface PackedBody { codec: StorageCodec; rawBytes: number; hash: string; bytes: Buffer }
export async function packBody(value: unknown, preferred: StorageCodec = hasZstd() ? 'zstd' : 'gzip'): Promise<PackedBody> {
  const raw = Buffer.from(JSON.stringify(value));
  const compressed = raw.length >= 1024 ? await compress(raw, preferred) : raw;
  const useCompressed = compressed.length + 32 < raw.length;
  return {codec: useCompressed ? preferred : 'identity', rawBytes: raw.length, hash: sha256(raw), bytes: useCompressed ? compressed : raw};
}
export async function unpackBody(body: PackedBody): Promise<unknown> {
  const raw = await decompress(body.bytes, body.codec, body.rawBytes);
  if (sha256(raw) !== body.hash) throw new Error('storage checksum mismatch');
  return JSON.parse(raw.toString('utf8'));
}
