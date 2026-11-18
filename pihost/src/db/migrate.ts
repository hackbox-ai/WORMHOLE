import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/**
 * Minimalist migration executor: apply in file name order migrations/*.sql，with schema_migrations
 * Table deduplication。B03 If you need to roll back the script after the data dictionary is finalized/Version table re-evolution, stage A Keep first
 * Apply database idempotently by version at startup schema。
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Advisory lock: Service startup and test process may execute migration concurrently
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('pihost_migrations'))");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount && done.rowCount > 0) continue;
      const sql = readFileSync(path.join(dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        // A concurrent process inserted a record with the same name first → Consider applied
        if ((err as {code?:string;constraint?:string}).code==='23505' &&
            (err as {constraint?:string}).constraint==='schema_migrations_pkey') continue;
        throw new Error(`[migrate] ${file} Failure: ${err}`);
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('pihost_migrations'))");
    lock.release();
  }
}
