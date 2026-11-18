import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {TrafficStore} from '../src/domains/traffic/store.ts';
import { TrafficRuntime } from "../src/domains/traffic/runtime.ts";
import { TrafficFlow } from "../src/domains/traffic/flow.ts";
import { bindTargetRoute } from "../src/domains/traffic/network.ts";
import { ReverseProxies } from "../src/domains/reverse/proxy.ts";
import { registerBusinessTools } from "../src/domains/tools/business.ts";
import { assembleTools } from "../src/domains/tools/assembly.ts";
import {
	registerCheckTools,
	seedCheckTools,
} from "../src/domains/traffic/check-tools.ts";
import type { ToolContext } from "../src/domains/tools/gate.ts";
const ADAPTER = `export function encodeRequest({body}){return {headers:{'content-type':'application/json'},body:JSON.stringify({cipher:Buffer.from(body).toString('base64')})};}export function decodeResponse({body}){const x=JSON.parse(body.toString());return {headers:{'content-type':'application/json'},body:Buffer.from(x.cipher,'base64')};}`;
test("worker flow: host adapter -> MITM -> HTTP/HTTPS, task correlation and shared checks", async () => {
	const base = loadConfig(),
		schema = "flow_" + process.pid + "_" + Date.now(),
		admin = new Pool({ connectionString: base.database.dsn });
	await admin.query("CREATE SCHEMA " + schema);
	const pool = new Pool({
			connectionString: base.database.dsn,
			options: "-c search_path=" + schema,
		}),
		dir = await mkdtemp(path.join(tmpdir(), "wormhole-flow-"));
	let proxies: ReverseProxies | undefined, traffic: TrafficRuntime | undefined;
	const seen: { url: string; body: any; internal: boolean }[] = [];
	const handler = async (req: any, res: any) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		seen.push({
			url: req.url,
			body: raw,
			internal: !!req.headers["x-wormhole-capture-context"],
		});
		res.setHeader("content-type", "application/json");
		const out = JSON.stringify({
			cipher: Buffer.from(
				JSON.stringify({
					ok: true,
					input: JSON.parse(Buffer.from(raw.cipher, "base64").toString()),
				}),
			).toString("base64"),
		});
		res.setHeader("content-encoding", "gzip");
		res.end(gzipSync(out));
	};
	const target = createServer(handler);
	await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
	let secure: ReturnType<typeof httpsServer> | undefined;
	try {
		await runMigrations(pool);
		const t = Number(
			(
				await pool.query(
					"WITH e AS(INSERT INTO explorations(goal) VALUES('flow') RETURNING id) INSERT INTO tasks(name,goal,status,exploration_id) SELECT 'flow','flow','running',e.id FROM e RETURNING id",
				)
			).rows[0].id,
		);
		const createIntent = async () =>
			Number(
				(
					await pool.query(
						"INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,state) SELECT id,exploration_id,'intent','check','running' FROM tasks WHERE id=$1 RETURNING id",
						[t],
					)
				).rows[0].id,
			);
		const intent = await createIntent(),
			second = await createIntent(),
			cwd = path.join(dir, "workspace/tasks", String(t), "i" + intent);
		await mkdir(cwd, { recursive: true });
		await writeFile(path.join(cwd, "adapter.mjs"), ADAPTER);
		traffic = new TrafficRuntime(dir, {
			get: () => ({ trafficCapture: true, globalProxy: "" }),
		} as any);
		await traffic.start();
		bindTargetRoute(() => traffic!.route());
		const flow = new TrafficFlow(pool, traffic.store);
		traffic.store.onCapture = (id, x) => flow.ingest(id, x);
		registerCheckTools(flow);
		await seedCheckTools(pool);
		proxies = new ReverseProxies(pool, dir);
		registerBusinessTools({
			trafficFlow: flow,
			reverseProxies: proxies,
			assets: { upsertSource: async () => ({ ok: true, status: 200 }) },
			findings: { record: async () => ({}) },
		});
		const ctx: ToolContext = {
			businessKind: "worker",
			businessId: "task-" + t,
			taskId: t,
			intentId: intent,
			agentKey: "worker",
			cwd,
		};
		const tools = await assembleTools(pool, ["http_request"], ctx, {});
		const call = async (p: any) =>
			JSON.parse(
				(await tools[0]!.execute("flow-" + Date.now(), p)).content[0].text,
			);
		const url =
			"http://127.0.0.1:" + (target.address() as any).port + "/secure";
		const p = await proxies.start(ctx, {
			script_path: "adapter.mjs",
			url,
			method: "POST",
			usage: "test",
		});
		const baseline = await call({
			url,
			method: "POST",
			body: '{"id":1}',
			headers: { "content-type": "application/json" },
			proxy: p.proxy_url,
		});
		assert.equal(baseline.status, 200);
		assert.deepEqual(JSON.parse(baseline.body), { ok: true, input: { id: 1 } });
		assert.ok(baseline.capture_id && baseline.wire_capture_id);
		assert.notEqual(baseline.capture_id, baseline.wire_capture_id);
		const plain = traffic.store.readEvidence(baseline.capture_id),
			wire = traffic.store.readEvidence(baseline.wire_capture_id);
		assert.equal(plain.context?.requestId, wire.context?.requestId);
		assert.equal(plain.context?.taskId, t);
		assert.equal(wire.context?.view, "wire");
		assert.deepEqual(JSON.parse(plain.reqBody.toString()), { id: 1 });
		assert.ok(JSON.parse(wire.reqBody.toString()).cipher);
		assert.equal(seen[0]!.internal, false);
		assert.equal(plain.reqHead.includes("x-wormhole-capture-context"), false);
		assert.equal(wire.reqHead.includes("x-wormhole-capture-context"), false);
		const candidates = await flow.list(t);
		assert.equal(candidates.length, 1);
		assert.deepEqual(candidates[0]!.parameters, ["json:id"]);
		const claimed = await flow.claim(ctx, {
			endpoint_id: Number(candidates[0]!.id),
			parameter: "json:id",
			check_type: "input_validation",
		});
		assert.equal(claimed.claimed, true);
		await call({
			url,
			method: "POST",
			body: '{"id":2}',
			headers: { "content-type": "application/json" },
			proxy: p.proxy_url,
			check_id: claimed.check_id,
		});
		await flow.complete(ctx, {
			check_id: claimed.check_id,
			status: "negative",
			summary: "id=1/2 均正确回显；受控场景未观察到异常",
		});
		const duplicate = await flow.claim(
			{ ...ctx, intentId: second },
			{
				endpoint_id: Number(candidates[0]!.id),
				parameter: "json:id",
				check_type: "input_validation",
			},
		);
		assert.equal(duplicate.claimed, false);
		assert.equal(duplicate.existing.status, "negative");
		assert.equal(
			(await flow.list(t))[0]!.observations,
			1,
			"check traffic never becomes a new candidate",
		);
		assert.equal(seen.length, 2, "duplicate claimant sends no request");
		await assert.rejects(() =>
			flow.claim(
				{ ...ctx, taskId: t + 100 },
				{
					endpoint_id: Number(candidates[0]!.id),
					parameter: "json:id",
					check_type: "input_validation",
				},
			),
		);
		const cert = path.join(dir, "ca.pem"),
			key = path.join(dir, "key.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ stdio: "ignore" },
		);
		secure = httpsServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			handler,
		);
		await new Promise<void>((r) => secure!.listen(0, "127.0.0.1", r));
		const httpsUrl =
				"https://127.0.0.1:" + (secure.address() as any).port + "/secure",
			sp = await proxies.start(ctx, {
				script_path: "adapter.mjs",
				url: httpsUrl,
				method: "POST",
				usage: "TLS",
			});
		const httpsReply = await call({
			url: httpsUrl,
			method: "POST",
			body: '{"id":3}',
			headers: { "content-type": "application/json" },
			proxy: sp.proxy_url,
		});
		assert.equal(httpsReply.status, 200, httpsReply.body);
		assert.ok(httpsReply.wire_capture_id);
		assert.equal(seen.at(-1)!.internal, false);
		const fact = Number(
			(
				await pool.query(
					"INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,state) SELECT id,exploration_id,'fact','new controlled evidence','confirmed' FROM tasks WHERE id=$1 RETURNING id",
					[t],
				)
			).rows[0].id,
		);
		const recheck = await flow.claim(ctx, {
			endpoint_id: Number(candidates[0]!.id),
			parameter: "json:id",
			check_type: "input_validation",
			new_evidence_id: fact,
		});
		assert.equal(
			recheck.claimed,
			true,
			"new confirmed evidence permits a separate recheck without losing the old result",
		);
		assert.equal(
			(await flow.list(t))
				.find((e) => String(e.id) === String(candidates[0]!.id))!
				.checks.filter((c: any) => c.type === "input_validation").length,
			2,
		);
		await assert.rejects(
			() =>
				flow.claim(ctx, {
					endpoint_id: Number(candidates[0]!.id),
					parameter: "json:id",
					check_type: "input_validation",
					new_evidence_id: 999999,
				}),
			/事实或发现/,
		);
		const race = await Promise.all([
			flow.claim(ctx, {
				endpoint_id: Number(candidates[0]!.id),
				parameter: "json:id",
				check_type: "authorization",
			}),
			flow.claim(
				{ ...ctx, intentId: second },
				{
					endpoint_id: Number(candidates[0]!.id),
					parameter: "json:id",
					check_type: "authorization",
				},
			),
		]);
		assert.equal(
			race.filter((x) => x.claimed).length,
			1,
			"only one Worker wins a concurrent check claim",
		);
		const winner = race[0]!.claimed ? ctx : { ...ctx, intentId: second },
			winning = race.find((x) => x.claimed)!;
		await assert.rejects(
			() =>
				flow.request(winner, winning.check_id!, url, "POST", {
					authorization: "Bearer other-fixture-session",
				}),
			/身份/,
		);
		for (let i = 0; i < 30; i++)
			await flow.request(winner, winning.check_id!, url, "POST",{},String(p.proxy_id));
		await assert.rejects(
			() => flow.request(winner, winning.check_id!, url, "POST",{},String(p.proxy_id)),
			/30/,
		);
		await assert.rejects(
			() =>
				flow.complete(winner, {
					check_id: winning.check_id,
					status: "negative",
					summary: "no evidence",
				}),
			/没有/,
		);

    traffic.store.onCapture=undefined;
    const recovered=await call({url,method:'POST',body:'{"id":4}',headers:{'content-type':'application/json'},proxy:p.proxy_url});
    assert.ok(traffic.store.pendingFlow(t).includes(recovered.capture_id));
    await flow.list(t);assert.ok(!traffic.store.pendingFlow(t).includes(recovered.capture_id),'persisted observation is recovered without another wire request');
    traffic.store.onCapture=(id,x)=>flow.ingest(id,x);
		const beforeToggle = seen.length;
		const originalRoute = traffic.route();
		bindTargetRoute(() => ({ ...originalRoute, proxy: "http://127.0.0.1:9" }));
		await assert.rejects(
			() => call({ url, method: "POST", body: "{}", proxy: p.proxy_url }),
			/配置已变化/,
		);
		assert.equal(
			seen.length,
			beforeToggle,
			"route changes fail before any network request",
		);
		bindTargetRoute(() => traffic!.route());
		await pool.query("UPDATE tasks SET paused=true WHERE id=$1", [t]);
		await proxies.stopTask(t);
		await assert.rejects(
			() => call({ url, method: "POST", body: "{}", proxy: p.proxy_url }),
			/登记|运行/,
		);
		const total = seen.length;
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(
			seen.length,
			total,
			"capture and candidate listing never run background probes",
		);
		await flow.drain();
	} finally {
		bindTargetRoute(null);
		await proxies?.stopAll();
		await traffic?.close();
		target.closeAllConnections();
		await new Promise<void>((r) => target.close(() => r()));
		if (secure) {
			secure.closeAllConnections();
			await new Promise<void>((r) => secure!.close(() => r()));
		}
		await pool.end();
		await admin.query("DROP SCHEMA " + schema + " CASCADE");
		await admin.end();
		await rm(dir, { recursive: true, force: true });
	}
});

test('capture index upgrade preserves legacy records and scopes full bodies',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wormhole-flow-upgrade-'));let store=new TrafficStore(dir);
 try{
  const body=Buffer.alloc(300_000,97),id=store.record({url:'http://fixture.invalid/items/1',method:'GET',status:200,contentType:'text/plain',requestType:'',reqHead:'GET /items/1',respHead:'HTTP 200',reqBody:Buffer.alloc(0),respBody:body,context:{taskId:7,requestId:'owned',view:'wire'}});
  const evidence=store.readEvidence(id);assert.ok(evidence.resp_hash);assert.equal(store.hasBlob(7,evidence.resp_hash),true);assert.equal(store.hasBlob(8,evidence.resp_hash),false);
  store.db.exec("UPDATE exchanges SET context='' WHERE id='"+id+"'");store.close();store=new TrafficStore(dir);
  assert.equal(store.count(),1);assert.deepEqual(store.readEvidence(id).respBody,body);
  assert.equal(store.search('fixture.invalid','','',0,10,7).length,0,'legacy records stay readable globally but are never assigned to another task');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
