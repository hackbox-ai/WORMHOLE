import {packBody, unpackBody, type PackedBody, type StorageCodec} from './codec.ts';

export const recordBodyFields = ['request_body', 'response_body', 'raw_request', 'raw_response'] as const;
export type RecordBodies = Record<(typeof recordBodyFields)[number], string | null>;
export const legacyBodyFields = [...recordBodyFields,'request_text','response_text'] as const;
export type LegacyBodies = Record<(typeof legacyBodyFields)[number],string|null>;

/** Historical aliases may differ from canonical bodies. Preserve all six exactly. */
export async function packLegacyBodies(bodies:LegacyBodies):Promise<PackedBody>{
  const strings:string[]=[],fields:Record<string,number|null>={};
  for(const field of legacyBodyFields){const text=bodies[field];if(text===null){fields[field]=null;continue;}let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text);}fields[field]=i;}
  return packBody({version:2,strings,fields});
}

/** Preserve wire bytes as strings; normalized bodies and legacy aliases are separate views.
 * Equal strings within a record are represented once before compression.
 */
export async function packRecordBodies(bodies: RecordBodies, codec?: StorageCodec): Promise<PackedBody> {
  const strings: string[] = [], fields: Record<string, number | null> = {};
  for (const field of recordBodyFields) {
    const text = bodies[field];
    if (text === null) { fields[field] = null; continue; }
    let index = strings.indexOf(text);
    if (index === -1) { index = strings.length; strings.push(text); }
    fields[field] = index;
  }
  return packBody({version: 1, strings, fields}, codec);
}

export async function expandRecordBodies(row: Record<string, any>): Promise<Record<string, any>> {
  const out = {...row};
  for (const key of ['body_storage','body_codec','body_raw_bytes','body_sha256']) delete out[key];
  if (row.body_storage == null) return out;
  if (!Buffer.isBuffer(row.body_storage) || !['identity', 'gzip', 'zstd'].includes(row.body_codec)) throw new Error('invalid recorded body codec');
  const value = await unpackBody({bytes: row.body_storage, codec: row.body_codec, rawBytes: row.body_raw_bytes, hash: row.body_sha256}) as {
    version: number; strings: unknown[]; fields: Record<string, unknown>;
  };
  if (![1,2].includes(value?.version) || !Array.isArray(value.strings) || value.strings.length > (value.version===2?6:4) || !value.strings.every(s => typeof s === 'string') || !value.fields) throw new Error('invalid recorded body format');
  for (const field of value.version===2?legacyBodyFields:recordBodyFields) {
    const index = value.fields[field];
    if (index !== null && (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= value.strings.length)) throw new Error('invalid recorded body reference');
    out[field] = index === null ? null : value.strings[Number(index)];
  }
  if(value.version===1){out.request_text = out.request_body ?? '';out.response_text = out.response_body ?? '';}
  return out;
}
