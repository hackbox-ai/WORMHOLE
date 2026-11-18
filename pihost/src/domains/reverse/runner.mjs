/** Host-owned network runner. The adapter supplies transforms, never a listener. */
import http from "node:http";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { checkServerIdentity } from "node:tls";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
const adapter = await import(pathToFileURL(process.argv[2]).href);
if (
	typeof adapter.encodeRequest !== "function" ||
	typeof adapter.decodeResponse !== "function"
)
	throw new Error("Adapter must export encodeRequest and decodeResponse");
const scope = JSON.parse(process.env.WORMHOLE_REVERSE_PROXY_SCOPE),
	route = JSON.parse(process.env.WORMHOLE_REVERSE_UPSTREAM || "{}");
const internal = "x-wormhole-capture-context",
	hop = new Set([
		"host",
		"connection",
		"proxy-connection",
		"proxy-authorization",
		"transfer-encoding",
		internal,
	]);
const clean=headers=>Object.fromEntries(Object.entries(headers||{}).filter(([k])=>!hop.has(k.toLowerCase())).map(([k,v])=>[k.toLowerCase(),v]));
async function bytes(stream, limit) {
	const chunks = [];
	let size = 0;
	for await (const c of stream) {
		size += c.length;
		if (size > limit) throw new Error("The proxy message exceeds the size limit");
		chunks.push(c);
	}
	return Buffer.concat(chunks);
}
const server = http.createServer(async (req, res) => {
	let upstream, agent;
	try {
		const url = new URL(req.url),
			a = scope.path.split("/"),
			b = url.pathname.split("/");
		if (
			url.origin !== scope.origin ||
			req.method !== scope.method ||
			a.length !== b.length ||
			!a.every((v, i) => (v.startsWith(":") ? !!b[i] : v === b[i]))
		) {
			res.writeHead(403);
			res.end("The interface is not within the proxy scope");
			return;
		}
		const body = await bytes(req, 2 * 1024 * 1024);
		const encoded = await adapter.encodeRequest({
			url: url.href,
			method: req.method,
			headers: clean(req.headers),
			body: body.toString("utf8"),
			bodyBytes: body,
		});
		if (!encoded || !("body" in encoded))
			throw new Error("encodeRequest must return body and optional headers");
		const wire = Buffer.from(encoded.body),
			headers = {
				...clean(req.headers),
				...clean(encoded.headers),
				"content-length": String(wire.length),
			};
		if (req.headers[internal]) headers[internal] = req.headers[internal];
		const tls = route.caFile
			? {
					ca: readFileSync(route.caFile),
					checkServerIdentity: (_host, cert) =>
						checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ""), cert),
				}
			: {};
		if (route.proxy) {
			const p = new URL(route.proxy);
			agent = p.protocol.startsWith("socks")
				? new SocksProxyAgent(p)
				: url.protocol === "https:"
					? new HttpsProxyAgent(p, tls)
					: new HttpProxyAgent(p);
		}
		const cancel = () => {
			if (!res.writableEnded) upstream?.destroy(new Error("Call canceled"));
		};
		res.once("close", cancel);
		const reply = await new Promise((resolve, reject) => {
			upstream = (url.protocol === "https:" ? https : http).request(
				url,
				{ method: req.method, headers, agent, ...tls },
				resolve,
			);
			upstream.once("error", reject);
			upstream.setTimeout(20_000, () =>
				upstream.destroy(new Error("Upstream request timed out")),
			);
			upstream.end(wire);
		});
		const wireBody = await bytes(reply, 8 * 1024 * 1024);
		const encoding = String(
				reply.headers["content-encoding"] || "",
			).toLowerCase(),
			options = { maxOutputLength: 8 * 1024 * 1024 };
		const entity =
			encoding === "gzip"
				? gunzipSync(wireBody, options)
				: encoding === "deflate"
					? inflateSync(wireBody, options)
					: encoding === "br"
						? brotliDecompressSync(wireBody, options)
						: wireBody;
		const decoded = await adapter.decodeResponse({
			url: url.href,
			method: req.method,
			status: reply.statusCode,
			headers: clean(reply.headers),
			body: entity.toString("utf8"),
			bodyBytes: entity,
		});
		if (!decoded || !("body" in decoded))
			throw new Error("decodeResponse must return body and optional headers");
		if (
			decoded.decoded === false &&
			Number(reply.statusCode) >= 200 &&
			Number(reply.statusCode) < 300
		)
			throw new Error(
				"The adapter reports that the response is not decrypted. Please correct the decodeResponse and then restart with replace=true. It cannot be regarded as a successful reverse engineering.",
			);
		const plain = Buffer.from(decoded.body),
			out = {
				...clean(reply.headers),
				...clean(decoded.headers),
				"content-length": String(plain.length),
			};
		delete out["content-encoding"];
		res.writeHead(reply.statusCode || 502, out);
		res.end(plain);
	} catch (error) {
		if (!res.headersSent) {
			res.writeHead(502);
			res.end("Reverse adaptation failed:" + error.message);
		} else res.destroy(error);
	} finally {
		agent?.destroy();
	}
});
server.listen(Number(process.env.WORMHOLE_REVERSE_PROXY_PORT), "127.0.0.1");
