/**
 * B04 Completion smoke: session resumed / Cancel / Four role directory isolation。
 * Run：cd pihost && WORMHOLE_CONFIG=/var/lib/wormhole/config.json node --import tsx scripts/b04-roles.ts
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db/pool.ts";
import { createHostedSession } from "../src/pi/session-host.ts";

const config = loadConfig();
const pool = createPool(config.database.dsn);
const results: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

// ── 1. Four characters（chat/mainagent/planner/worker）Directory isolation + Each account is recorded ──
const roles = [
  { kind: "chat", prompt: "You are the top-level conversation assistant." },
  { kind: "mainagent", prompt: "You are the task master Agent, responsible for communicating task progress with users." },
  { kind: "planner", prompt: "You are the planner and only output suggestions for next steps." },
  { kind: "worker", prompt: "You are the executor and only validate a single subgoal." },
];
const dirs = new Set<string>();
for (const r of roles) {
  const h = await createHostedSession(pool, config, {
    kind: r.kind,
    businessId: "role-isolation",
    systemPrompt: r.prompt,
  });
  dirs.add(h.sessionDir);
  check(`role ${r.kind} session dir`, h.sessionDir.includes(`${r.kind}-role-isolation`));
  await h.dispose();
}
check("4 roles -> 4 distinct dirs", dirs.size === 4, [...dirs].map((d) => path.basename(d)).join(", "));

// ── 2. Recovery: same (kind,businessId) Recreate = Continue the same session directory, remember the model above ──
{
  const h1 = await createHostedSession(pool, config, {
    kind: "chat",
    businessId: "resume-test",
    systemPrompt: "You are a recovery test assistant, so your answers must be brief.",
  });
  await h1.session.prompt("My password is Purple Hippo 456, remember it, I will ask you later.");
  await h1.dispose();
  const before = await readdir(h1.sessionDir);
  const h2 = await createHostedSession(pool, config, {
    kind: "chat",
    businessId: "resume-test",
    systemPrompt: "You are a recovery test assistant, so your answers must be brief.",
  });
  // SessionManager.create(dir, dir) In the same directory=Continue the latest session file (with the old WORMHOLE session-factory of
  // findLatestSessionFile+SessionManager.open The semantics are consistent, as shown by SessionManager Directory scanning implementation）
  await h2.session.prompt("What is my password? Only answer the code itself.");
  await h2.dispose();
  const ledger = await pool.query(
    `SELECT payload->'messages' AS msgs FROM business_events
     WHERE business_kind='chat' AND business_id='resume-test' AND event_type='agent_end'
     ORDER BY seq DESC LIMIT 1`
  );
  const msgs = (ledger.rows[0] as { msgs?: unknown[] })?.msgs ?? [];
  const last = JSON.stringify(msgs);
  const remembered = last.includes("Purple hippopotamus 456");
  check("resume keeps prior context", remembered, `agent_end messages ${msgs.length} Article${remembered ? ", including password" : ", without password"}`);
  check("session dir reused", h2.sessionDir === h1.sessionDir, `${before.length} files before`);
}

// ── 3. Cancel: During streaming abort，The event ledger is still intact ──
{
  const h = await createHostedSession(pool, config, {
    kind: "chat",
    businessId: "cancel-test",
    systemPrompt: "You are canceling the test assistant. Please write a long answer of about 500 words.",
  });
  let promptError: unknown = null;
  const p = h.session.prompt("Introduce the basics of network security.").catch((e: unknown) => {
    promptError = e;
  });
  await new Promise((r) => setTimeout(r, 2500));
  await h.dispose(); // dispose Internal abort
  await Promise.race([p, new Promise((r) => setTimeout(r, 10_000))]);
  const cnt = await pool.query(
    "SELECT count(*) AS n FROM business_events WHERE business_kind='chat' AND business_id='cancel-test'"
  );
  const n = Number((cnt.rows[0] as { n: string }).n);
  check("cancel: ledger still captured events", n > 0, `${n} events; promptError=${String(promptError).slice(0, 60)}`);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "[b04-roles] ALL PASS" : `[b04-roles] ${failed} FAILED`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
