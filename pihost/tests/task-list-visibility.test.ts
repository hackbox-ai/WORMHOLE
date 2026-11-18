import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { TaskArchives } from "../src/domains/tasks/archives.ts";
import { ModelingService } from "../src/domains/modeling/service.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

test("test collections exclude modeling while execution, models and evidence remain addressable", async (t) => {
  const config = loadConfig();
  assert.match(new URL(config.database.dsn).pathname, /test/i, "requires a test database");
  const schema = "codex_task_visibility_" + process.pid + "_" + Date.now();
  const admin = new Pool({ connectionString: config.database.dsn });
  const dir = await mkdtemp(path.join(tmpdir(), "wormhole-task-visibility-"));
  await admin.query("CREATE SCHEMA " + schema);
  const pool = new Pool({ connectionString: config.database.dsn, options: "-c search_path=" + schema });
  const controls: {id:number;action:string}[] = [];
  const tasks = new TaskService(pool, path.join(dir, "events.jsonl"), () => {},
    (id, action) => { controls.push({id, action}); });
  const modeling = new ModelingService(pool);
  const archives = new TaskArchives(pool, path.join(dir, "archives"),
    { isTaskRunning: () => false, abortTask: () => {}, drainSide: async () => {} });
  const auth = new AuthService(pool, authKeyPath(dir));
  const ctx = { pool, config, auth, tasks, taskArchives: archives,
    taskEngine: { modeling, abort: () => {} } } as unknown as AppContext;
  const server = createServer((req, res) => { void routeRequest(req, res, ctx); });
  try {
    await runMigrations(pool);
    const category = Number((await pool.query("INSERT INTO task_categories(name) VALUES('visibility') RETURNING id")).rows[0].id);
    const ids:number[] = [];
    for (const name of ["visible test", "archived test", "deleted test"]) {
      const created = await tasks.create({ name, goal:name, queued:true });
      assert.ok(created.ok);
      ids.push(Number(created.task.id));
    }
    const [parent, archived, deleted] = ids as [number,number,number];
    await pool.query("UPDATE tasks SET category_id=$1 WHERE id=ANY($2::bigint[])", [category, ids]);
    await pool.query("UPDATE tasks SET archived=TRUE WHERE id=$1", [archived]);
    await pool.query("UPDATE tasks SET deleted_at=now() WHERE id=$1", [deleted]);
    const model = await modeling.request({ target:"https://visibility.test", task_id:parent, trigger:"initial", queued:true });
    await pool.query("UPDATE tasks SET category_id=$1 WHERE id=$2", [category, model.task_id]);
    // More modeling rows than the collection LIMIT: filtering after pagination
    // would make the real test disappear.
    const bulk = await pool.query(`INSERT INTO tasks(kind,name,goal,category_id)
      SELECT 'modeling','background model '||n,'fixture',$1 FROM generate_series(1,205) n RETURNING id`, [category]);
    const modelArchive = Number(bulk.rows[0].id);
    await pool.query("UPDATE tasks SET archived=TRUE WHERE id=$1", [modelArchive]);
    for (const id of [archived, modelArchive, deleted]) {
      await pool.query("INSERT INTO task_archives(task_id,task_name,state) VALUES($1,'visibility','ready')", [id]);
    }
    await pool.query(`INSERT INTO activity(exploration_id,kind,summary)
      SELECT exploration_id,'text',CASE WHEN kind='modeling' THEN 'MODEL_ONLY' ELSE 'TEST_ONLY' END
      FROM tasks WHERE id=ANY($1::bigint[])`, [[parent,model.task_id]]);
    await pool.query("UPDATE tasks SET status='running',queued=FALSE WHERE id=ANY($1::bigint[])", [[parent,model.task_id]]);
    const token = await auth.signTokenForTest(300);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + (server.address() as {port:number}).port;
    const request = async (url:string, method="GET") => {
      const res = await fetch(base+url, { method, headers:{ Authorization:"Bearer "+token } });
      const raw = await res.text();
      assert.equal(res.status,200, url+": "+raw.slice(0,200));
      return res.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) : raw;
    };
    await t.test("live, status-filtered and archived collections filter before LIMIT", async () => {
      for (const suffix of ["", "?status=running"]) {
        const rows = (await request("/api/tasks"+suffix)).tasks;
        assert.deepEqual(rows.map((r:any)=>Number(r.id)), [parent]);
        assert.equal(rows[0].modeling_pending, 1, "parent retains background model status");
        assert.equal(rows[0].kind, "pentest");
      }
      const rows = (await request("/api/tasks?archived=true")).tasks;
      assert.deepEqual(rows.map((r:any)=>Number(r.id)), [archived]);
      assert.deepEqual((await tasks.list({archived:null})).map(r=>Number(r.id)).sort(), [parent,archived].sort());
    });
    await t.test("category counts match visible tests", async () => {
      const categories = (await request("/api/task-categories")).categories;
      assert.equal(categories.find((r:any)=>Number(r.id)===category).task_count, 1);
    });
    await t.test("archive totals, filters and page boundaries exclude models and deleted tasks", async () => {
      const page = await request("/api/task-archives?size=1");
      assert.equal(page.total, 1);
      assert.deepEqual(page.archives.map((r:any)=>Number(r.task_id)), [archived]);
      const next = await request("/api/task-archives?size=1&page=1");
      assert.equal(next.total, 1);
      assert.deepEqual(next.archives, []);
      assert.equal((await request("/api/task-archives?q=visibility&state=ready")).total, 1);
    });
    await t.test("models, parent links and explicit execution details remain readable", async () => {
      const models = (await request("/api/business-models")).models;
      assert.ok(models.some((r:any)=>Number(r.task_id)===model.task_id));
      const linked = (await request("/api/business-models?task_id="+parent)).models;
      assert.deepEqual(linked.map((r:any)=>Number(r.task_id)), [model.task_id]);
      const detail = await request("/api/tasks/"+model.task_id);
      assert.equal(detail.kind, "modeling");
      assert.equal(Number(detail.id), model.task_id);
      assert.equal((await tasks.list({id:model.task_id,archived:null})).length, 1);
    });
    await t.test("implicit dashboard activity, graph and report select a test; explicit model access works", async () => {
      const activity = (await request("/api/exploration/activity")).items;
      assert.ok(JSON.stringify(activity).includes("TEST_ONLY"));
      assert.ok(!JSON.stringify(activity).includes("MODEL_ONLY"));
      const explicit = (await request("/api/exploration/activity?task="+model.task_id)).items;
      assert.ok(JSON.stringify(explicit).includes("MODEL_ONLY"));
      const graph = await request("/api/exploration/graph");
      assert.ok(JSON.stringify(graph).includes("visible test"));
      const report = await request("/api/report");
      assert.ok(report.includes("visible test"));
      assert.ok(!report.includes("业务建模"));
    });
    await t.test("model pause, resume, stop and retry work without adding visible test rows", async () => {
      for (const action of ["pause","resume","stop"]) {
        await request("/api/business-models/"+model.task_id+"/"+action, "POST");
        const expected = action==="pause" ? "paused" : action==="stop" ? "failed" : "running";
        assert.equal((await request("/api/business-models/"+model.task_id)).status, expected);
      }
      assert.ok(controls.some(c=>c.id===model.task_id&&c.action==="stop"));
      const response = await fetch(base+"/api/business-models/"+model.task_id+"/retry",
        {method:"POST",headers:{Authorization:"Bearer "+token}});
      assert.ok([200,201].includes(response.status), await response.text());
      const list = (await request("/api/tasks")).tasks;
      assert.deepEqual(list.map((r:any)=>Number(r.id)),[parent]);
      assert.equal((await pool.query("SELECT count(*)::int n FROM tasks")).rows[0].n, 210,
        "modeling history and retry retained, not deleted");
    });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
    await rm(dir, {recursive:true,force:true});
  }
});
