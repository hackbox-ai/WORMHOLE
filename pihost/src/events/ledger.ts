/**
 * B07 Event ledger (including supplementary writing of dead letters, second round of review reinforcement）：
 * - DB Write failed → Event band event_uid Implementation DLQ File。
 * - backfillDeadLetters Use ”atomic rename ”Take it away and then replenish it” prevents concurrent addition and clearing from overwriting each other.：
 *   First DLQ rename into .pending（Afterwards, new dead letters are appended to the new file) and will be deleted after all are stored successfully.
 *   .pending；If storage fails, add the content back DLQ，Retry next round。event_uid Unique index guarantee
 *   Complement idempotent（ON CONFLICT DO NOTHING）。
 * - startBackfillLoop：Regular rewriting during service running period（DB Dead letters are automatically stored in the database after recovery）。
 */
import { appendFile, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface LedgerRow {
  business_kind: string;
  business_id: string;
  event_type: string;
  payload: unknown;
}

export interface DeadLetter extends LedgerRow {
  event_uid: string;
  ts: string;
}

// Match JSON escapes as units so a literal "\u0000" remains ordinary text.
// Serializing first preserves Date, Buffer and custom toJSON behavior.
function postgresJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\(?:u0000|.)/g, escape =>
    escape === "\\u0000" ? "\\ufffd" : escape,
  );
}

function postgresText(value: string): string {
  return value.replaceAll("\0", "\uFFFD");
}

/** Back true=Persisted；false=Enter DLQ（Can be rewritten） */
export async function appendEvent(pool: Pool, dlqPath: string, row: LedgerRow): Promise<boolean> {
  return appendEvents(pool,dlqPath,[row]);
}

/** One ordered SQL insert; each event keeps its own replay/dedup identity. */
export async function appendEvents(pool:Pool,dlqPath:string,rows:LedgerRow[]):Promise<boolean>{
  if(!rows.length)return true;
  const dead:DeadLetter[]=rows.map(row=>({...row,event_uid:randomUUID(),ts:new Date().toISOString()}));
  try {
    await pool.query(
      `INSERT INTO business_events (business_kind,business_id,event_type,payload,event_uid,ts)
       SELECT e->>'business_kind',e->>'business_id',e->>'event_type',COALESCE(e->'payload','{}'::jsonb),e->>'event_uid',(e->>'ts')::timestamptz
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(e,ord)
       ORDER BY x.ord ON CONFLICT(event_uid) DO NOTHING`,
      [postgresJson(dead)],
    );
    return true;
  } catch (err) {
    console.error(`[ledger] DB write failed, falling to DLQ (${rows.length} events）:`, err);
    try {
      await mkdir(path.dirname(dlqPath), { recursive: true });
      await appendFile(dlqPath, dead.map(postgresJson).join('\n')+'\n');
    } catch (dlqErr) {
      throw new Error(`[ledger] DLQ write also failed: ${dlqErr}`);
    }
    return false;
  }
}

/** Idempotent complement DLQ；Return the number of additional entries。rename Remove anti-concurrency override。 */
export async function backfillDeadLetters(pool: Pool, dlqPath: string): Promise<number> {
  // A crash after rename leaves .pending; include these on every retry. Keep a
  // failed file intact instead of append+unlink, which loses it if append fails.
  const prefix=path.basename(dlqPath)+'.';
  const pending=(await readdir(path.dirname(dlqPath)).catch(err=>{if(err.code==='ENOENT')return [];throw err;})).filter(f=>f.startsWith(prefix)&&f.endsWith('.pending')).map(f=>path.join(path.dirname(dlqPath),f));
  if(existsSync(dlqPath)){
    const moved=`${dlqPath}.${randomUUID()}.pending`;
    try{await rename(dlqPath,moved);pending.push(moved);}catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}
  }
  let n = 0;
  for(const pendingPath of pending){
    let raw:string;try{raw=await readFile(pendingPath,'utf8');}catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')continue;throw err;}
    const lines=raw.split('\n').filter(l=>l.trim());
    for (const line of lines) {
      const dead = JSON.parse(line) as DeadLetter;
      const r = await pool.query(
        `INSERT INTO business_events (business_kind, business_id, event_type, payload, event_uid, ts)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_uid) DO NOTHING`,
        [
          postgresText(dead.business_kind), postgresText(dead.business_id),
          postgresText(dead.event_type), postgresJson(dead.payload ?? {}),
          postgresText(dead.event_uid), dead.ts,
        ],
      );
      n += r.rowCount ?? 0;
    }
    await unlink(pendingPath).catch(err=>{if(err.code!=='ENOENT')throw err;});
  }
  return n;
}

/** Regular rewriting during runtime（DB Dead letters are automatically stored after recovery); return to the stop function。 */
export function startBackfillLoop(pool: Pool, dlqPath: string, intervalMs = 60_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await backfillDeadLetters(pool, dlqPath);
      if (n > 0) console.log(`[ledger] Supplementary writing of dead letters ${n} Article`);
    } catch (err) {
      console.error("[ledger] Complementary writing is temporarily unavailable (DB not restored?):", err);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
