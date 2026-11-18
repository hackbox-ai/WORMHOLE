/**
 * F03 冷归档专项：队列→归档→ready→恢复→任务回归→删除，包校验/状态机/错误分支。
 * +  状态机。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService } from "../src/auth/service.ts";
import { routeRequest } from "../src/api/server.ts";
import { TaskArchives, startArchiveWorker } from "../src/domains/tasks/archives.ts";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const suffix = `arch_${process.pid}_${Date.now()}`;
const schema = `t_${suffix}`;
const admin = new Pool({ connectionString: config.database.dsn });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn, options: `-c search_path=${schema}` });
await runMigrations(pool);
const auth = new AuthService(pool, `/tmp/${schema}.key`);
const token = (await auth.init("archive-fixture-123456")).token!;
const dataDir = `/tmp/${schema}-data`;
const archives = new TaskArchives(pool, dataDir, { isTaskRunning: () => false, abortTask: () => {}, drainSide: async () => {} });
const ctx = { pool, config, auth, taskArchives: archives, taskEngine: { isDeleting: () => false, isRunning: () => false } } as never;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function api(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const stopWorker = startArchiveWorker(archives);

test("F03 冷归档全链：queue→archive→ready→恢复→任务回归→包删除", async () => {
  const task = (await pool.query("INSERT INTO tasks (name,goal,status) VALUES ('冷归档','g','done') RETURNING id")).rows[0] as { id: number };
  const taskId = Number(task.id);
  await pool.query("INSERT INTO exploration_nodes (task_id,kind,title,state) VALUES ($1,'intent','i1','done')", [taskId]);
  await pool.query("INSERT INTO findings (task_id,name,severity) VALUES ($1,'f1','high')", [taskId]);
  await pool.query("INSERT INTO llm_usage (model,task_id,input_tokens,output_tokens) VALUES ('m',$1,10,20)", [taskId]);
  const q = await api(`/api/tasks/${taskId}/archive`, "POST");
  assert.equal(q.status, 202, JSON.stringify(q.json));
  const archiveId = q.json.id;
  // 等 worker 完成
  let ready: any = null;
  for (let i = 0; i < 100 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ready = (await api(`/api/task-archives/${archiveId}`)).json;
    if (ready && ready.state === "archive_failed") throw new Error("归档失败: " + ready.error);
    if (ready && ready.state === "ready") break;
    ready = null;
  }
  assert.ok(ready && ready.state === "ready", `最终状态 ${JSON.stringify(ready)}`);
  assert.ok(ready.sha256 && ready.compressed_size > 0 && ready.original_size > 0);
  assert.equal(ready.data_counts.exploration_nodes, 1);
  assert.equal(ready.data_counts.findings, 1);
  // 包存在且校验和正确
  const packagePath = (await pool.query('SELECT archive_path FROM task_archives WHERE id=$1',[archiveId])).rows[0].archive_path;
  assert.ok(existsSync(packagePath), '归档包必须存在');
  assert.equal(createHash('sha256').update(await readFile(packagePath)).digest('hex'),ready.sha256,'真实包字节校验和');
  // 数据库已压缩：负载行清空、任务软归档
  const n1 = (await pool.query("SELECT count(*)::int AS n FROM exploration_nodes WHERE task_id=$1", [taskId])).rows[0].n;
  const nf = (await pool.query("SELECT count(*)::int AS n FROM findings WHERE task_id=$1", [taskId])).rows[0].n;
  assert.equal(n1, 0, "意图行已压缩");
  assert.equal(nf, 1, "发现行跨任务保留（原 schema 刻意不设外键：任务删除后统计仍保留）");
  const t = (await pool.query("SELECT archived FROM tasks WHERE id=$1", [taskId])).rows[0];
  assert.equal(t.archived, true, "任务软归档");
  // 恢复
  const rs = await api(`/api/task-archives/${archiveId}/restore`, "POST");
  assert.equal(rs.status, 202);
  let restored: any = null;
  for (let i = 0; i < 100 && !restored; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const g = (await api(`/api/task-archives/${archiveId}`)).json;
    if (g?.state === "restore_failed") throw new Error("恢复失败: " + g.error);
    if (!g || g.error === '归档不存在') { restored = {consumed:true}; break; }
  }
  assert.ok(restored, "恢复完成消费归档元数据");
  const r1 = (await pool.query("SELECT count(*)::int AS n FROM exploration_nodes WHERE task_id=$1", [taskId])).rows[0].n;
  const rf = (await pool.query("SELECT count(*)::int AS n FROM findings WHERE task_id=$1", [taskId])).rows[0].n;
  const rt = (await pool.query("SELECT archived, name FROM tasks WHERE id=$1", [taskId])).rows[0];
  assert.equal(r1, 1, "意图行恢复");
  assert.equal(rf, 1, "发现行恢复");
  assert.equal(rt.archived, false, "任务去归档");
  assert.equal(rt.name, "冷归档");
  assert.equal(existsSync(packagePath),false,'成功恢复后包消费');
  // 再归档后删除归档
  const requeued = await api(`/api/tasks/${taskId}/archive`, 'POST');
  assert.equal(requeued.status,202);
  const secondId=requeued.json.id;
  for(let i=0;i<100;i++){const item=await archives.get(secondId);if(item?.state==='ready')break;await new Promise(r=>setTimeout(r,100));}
  const del = await api(`/api/task-archives/${secondId}`, "DELETE");
  assert.equal(del.status, 202);
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 200));
    gone = (await api(`/api/task-archives/${secondId}`)).status === 404;
  }
  assert.ok(gone, "归档行删除");
});

test("F03 冷归档错误分支：404/重复 409/列表筛选", async () => {
  assert.equal((await api("/api/tasks/999999/archive", "POST")).status, 404);
  const task2 = (await pool.query("INSERT INTO tasks (name,goal,status) VALUES ('a2','g','done') RETURNING id")).rows[0] as { id: number };
  const first = await api(`/api/tasks/${task2.id}/archive`, "POST");
  assert.equal(first.status, 202);
  const dup = await api(`/api/tasks/${task2.id}/archive`, "POST");
  assert.equal(dup.status, 409, "进行中的归档任务重复排队 → 409");
  const list = await api("/api/task-archives?q=a2");
  assert.ok(list.json.archives.length >= 1, "按名称筛选");
  const byState = await api("/api/task-archives?state=archive_queued");
  assert.ok(Array.isArray(byState.json.archives));
});

after(async () => {
  await stopWorker();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});
