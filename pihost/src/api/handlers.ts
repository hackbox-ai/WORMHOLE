import type { ServerResponse } from "node:http";
import {readFileSync} from 'node:fs';
import type { AppContext } from "./server.ts";
const version=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;

export async function getHealth(res: ServerResponse, ctx: AppContext): Promise<void> {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    await ctx.pool.query("SELECT 1");
    checks.db = "ok";
  } catch (err) {
    checks.db = `fail: ${err}`;
    ok = false;
  }
  try {
    const pi = (await import("@earendil-works/pi-coding-agent")) as { VERSION?: string };
    checks.pi = pi.VERSION ? `ok (${pi.VERSION})` : "ok (VERSION not exported)";
  } catch (err) {
    checks.pi = `fail: ${err}`;
    ok = false;
  }
  res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      status: ok ? "ok" : "degraded",
      service: "wormhole-pihost",
      version,
      uptime_s: Math.floor((Date.now() - ctx.startedAt) / 1000),
      checks,
    }),
  );
}

