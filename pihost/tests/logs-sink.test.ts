/**
 * F20 回归：日志三端点+ server.getLogs/getLogsHistory/streamLogs。
 * 覆盖：ring since/limit 增量+cursor、DB 反向分页 has_more、SSE 回放+实时+ping、
 * console 捕获 level/tag 解析、DB 写失败不吞（stderr 报告、行保留 db_id=0）、重启恢复语义。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService } from "../src/auth/service.ts";
import { routeRequest } from "../src/api/server.ts";
import { logSink,LogSink,parseLog,streamLogs } from "../src/domains/observability/logsink.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const suffix = `${process.pid}_${Date.now()}`;
const schema = `f20_${suffix}`;
const admin = new Pool({ connectionString: config.database.dsn });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn, options: `-c search_path=${schema}` });
await runMigrations(pool);
const auth = new AuthService(pool, `/tmp/${schema}.key`);
const token = (await auth.init("f20-logs-fixture-123")).token!;
const ctx = { pool, config, auth } as never;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

logSink.install();
// 预置 DB 历史（模拟前次运行持久化的行）
await pool.query("INSERT INTO server_logs (level, tag, text) VALUES ('info','boot','历史行A'),('warn','db','历史行B'),('error','api','历史行C')");
await logSink.attach(pool);
// attach 后 console 输出进入 ring+DB（本测试进程内全局捕获）
console.log("[f20test] 普通信息");
console.warn("[f20test] warn 警告事项");
console.error("[f20test] 错误失败");

async function api(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test("F20：/api/logs ring 增量——attach 恢复历史 + console 捕获行 + level/tag 解析", async () => {
  const first = await api("/api/logs");
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.json.items));
  const texts = first.json.items.map((i: any) => i.text);
  assert.ok(texts.some((t: string) => t.includes("历史行A")), "DB 历史恢复进 ring");
  assert.ok(texts.some((t: string) => t.includes("错误失败")), "console.error 捕获");
  const err = first.json.items.find((i: any) => i.text.includes("错误失败"));
  assert.equal(err.level, "error"); assert.equal(err.tag, "f20test");
  const warn = first.json.items.find((i: any) => i.text.includes("警告事项"));
  assert.equal(warn.level, "warn");
  // since 增量：只返回 cursor 之后的行
  const cursor = first.json.cursor;
  console.log("[f20test] 增量后行");
  await new Promise((r) => setTimeout(r, 100));
  const delta = await api(`/api/logs?since=${cursor}`);
  assert.ok(delta.json.items.every((i: any) => i.seq > cursor), "since 过滤");
  assert.ok(delta.json.items.some((i: any) => i.text.includes("增量后行")));
});

test("F20：/api/logs/history 反向分页 has_more + db_id", async () => {
  await logSink.flush();
  const page1 = await api("/api/logs/history?limit=2");
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.has_more, true, "满页即有更多");
  assert.ok(page1.json.items.every((i: any) => typeof i.db_id === "number" && i.db_id > 0), "db_id 携带");
  assert.ok(page1.json.items[0].db_id < page1.json.items[1].db_id,'原版每页最旧在前');
  const before = page1.json.items[0].db_id;
  const page2 = await api(`/api/logs/history?before=${before}&limit=2`);
  assert.ok(page2.json.items.every((i: any) => i.db_id < before), "before 反向");
  const empty = await api("/api/logs/history?before=1&limit=200");
  assert.ok(empty.json.items.length === 0 || empty.json.items.every((i: any) => i.db_id < 1));
  assert.equal(empty.json.has_more, false);
  assert.deepEqual((await api('/api/logs/history?limit=0')).json,{items:[],has_more:true},'显式零值与缺参不同');
  const invalid=await api('/api/logs/history?limit=-1');assert.equal(invalid.status,500);assert.match(invalid.json.error,/^db: /);
  assert.equal((await api('/api/logs?since=999999999')).json.items,null,'原版无增量为 nil slice');
});

test("F20：/api/logs/stream 回放 + 实时", async () => {
  const ac = new AbortController();
  const resp = await fetch(`${base}/api/logs/stream?since=0`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = resp.body!.getReader();
  const seen: string[] = [];
  const deadline = Date.now() + 3000;
  console.log("[f20test] 流式实时行");
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 800)).catch(() => ({ done: true, value: undefined }) as never)]);
    if (!chunk || (chunk as any).done) break;
    seen.push(Buffer.from((chunk as any).value).toString("utf8"));
    if (seen.join("").includes("流式实时行")) break;
  }
  ac.abort();
  const body = seen.join("");
  assert.ok(/data: /.test(body), "data: 帧");
  assert.ok(body.includes("历史行") || body.includes("console") || body.includes("f20test"), "回放含历史/实时行");
  assert.ok(body.includes("流式实时行"), "订阅期间的新行实时推送");
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await logSink.stop();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('F20：空 ring 立即返回 SSE headers，真实 ping、游标重连不重播',async()=>{
 const sink=new LogSink(),s=createServer((req,res)=>streamLogs(req,res,sink,20));
 await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(s.address() as {port:number}).port}`;
 const abort=new AbortController();
 try{const response=await fetch(url,{signal:abort.signal}),reader=response.body!.getReader();assert.equal(response.status,200);
  const first=await reader.read();assert.equal(Buffer.from(first.value!).toString(),': ping\n\n');
  sink.add(parseLog('[sse] new'));let body='';while(!body.includes('new')){const chunk=await reader.read();body+=Buffer.from(chunk.value!).toString();}
  const line=JSON.parse(body.split('\n').find(l=>l.startsWith('data: '))!.slice(6));assert.equal(line.seq,1);abort.abort();
  const nextAbort=new AbortController();const next=await fetch(url+'?since=1',{signal:nextAbort.signal});const ping=await next.body!.getReader().read();assert.equal(Buffer.from(ping.value!).toString(),': ping\n\n','重连不重播 seq≤cursor');nextAbort.abort();
 }finally{abort.abort();s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));await sink.stop();}
});

test('F20：DB 断链保留 ring 并报告、下一行可恢复落库；进程重建恢复历史',async()=>{
 const errors:string[]=[],sink=new LogSink(message=>errors.push(message));let insert=0;
 const broken={query:async(sql:string)=>{if(sql.startsWith('SELECT'))return {rows:[]};if(insert++===0)throw new Error('fixture connection lost');return {rows:[{id:91}]};}} as unknown as Pool;
 await sink.attach(broken);sink.add(parseLog('[db] first'));sink.add(parseLog('[db] second'));await sink.flush();
 const lines=sink.recent(0,10).lines!;assert.equal(lines[0]!.db_id,undefined);assert.equal(lines[1]!.db_id,91);assert.match(errors[0]!,/db write:.*fixture connection lost/);await sink.stop();
 const restored=new LogSink();await logSink.flush();await restored.attach(pool);assert.ok(restored.recent(0,100).lines!.some(l=>l.text==='历史行A'&&l.db_id));await restored.stop();
});

test('F20：慢订阅者容量256保留先到行，退订阻止残留推送；console 支持格式、Error/循环对象/BigInt',async()=>{
 const sink=new LogSink(),seen:number[]=[];const unsubscribe=sink.subscribe(l=>{seen.push(l.seq);});
 for(let i=0;i<300;i++)sink.add(parseLog('burst '+i));await new Promise(r=>setImmediate(r));assert.equal(seen.length,256);assert.equal(seen.at(-1),256);
 unsubscribe();unsubscribe();sink.add(parseLog('after unsubscribe'));await new Promise(r=>setImmediate(r));assert.equal(seen.length,256);
 sink.install();const circular:any={};circular.self=circular;
 try{console.log('[fmt] value=%d',7);console.log('[fmt] error payload',new Error('fixture error'),circular,1n);
  const captured=sink.recent(300,10).lines!;assert.ok(captured.some(l=>l.text==='[fmt] value=7'));assert.ok(captured.some(l=>l.level==='error'&&l.text.includes('fixture error')&&l.text.includes('1n')));
 }finally{await sink.stop();}
});
