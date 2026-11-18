/**
 * B04 Smoke：Pi Session Host Minimum closed loop evidence。
 * Create hosted session → Send true prompt → Waiting for convergence → Verify event ledger and mapping table。
 * Run：cd pihost && node --import tsx scripts/b04-smoke.ts
 */
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db/pool.ts";
import { createHostedSession } from "../src/pi/session-host.ts";

const config = loadConfig();
const pool = createPool(config.database.dsn);

const hosted = await createHostedSession(pool, config, {
  kind: "conversation",
  businessId: "smoke-1",
  systemPrompt: "You are WORMHOLE pihost's B04 smoke test session. Please answer briefly in Chinese and do not use any tools.",
});

console.log(`[b04] session created: ${hosted.sessionId} @ ${hosted.sessionDir}`);

console.log("[b04] sending prompt...");
await hosted.session.prompt("Hello, please introduce yourself in one sentence.");
console.log("[b04] prompt turn completed");

await hosted.dispose();

const events = await pool.query(
  "SELECT event_type, count(*) AS n FROM business_events WHERE business_kind='conversation' AND business_id='smoke-1' GROUP BY 1 ORDER BY 1",
);
console.log("[b04] event ledger by type:");
for (const row of events.rows) {
  console.log(`    ${row.event_type}: ${row.n}`);
}

const sample = await pool.query(
  `SELECT seq, event_type, payload FROM business_events
   WHERE business_kind='conversation' AND business_id='smoke-1' AND event_type IN ('agent_end','agent_settled')
   ORDER BY seq DESC LIMIT 1`
);
if (sample.rows.length > 0) {
  const row = sample.rows[0] as { seq: number; event_type: string; payload: unknown };
  const text = JSON.stringify(row.payload);
  console.log(`[b04] last ${row.event_type} (seq=${row.seq}): ${text.slice(0, 400)}`);
}

const map = await pool.query(
  "SELECT pi_session_id, work_dir FROM pi_session_map WHERE business_kind='conversation' AND business_id='smoke-1'"
);
console.log("[b04] pi_session_map:", JSON.stringify(map.rows[0]));

const total = await pool.query("SELECT count(*) AS n FROM business_events");
console.log(`[b04] business_events total rows: ${(total.rows[0] as { n: string }).n}`);
console.log("[b04] SMOKE OK");
await pool.end();
