/**
 * Static front-end service。
 * From /opt/wormhole/web Reading files; path crossing protection；SPA fallback to 404.html。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import path from "node:path";

const DIST = process.env.WORMHOLE_WEB_DIST ?? "/opt/wormhole/web";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function serveStatic(_req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  if (rel.includes("..")) {
    res.writeHead(400); res.end(); return;
  }
  const abs = path.join(DIST, rel);
  if (!abs.startsWith(DIST + path.sep) && abs !== DIST) {
    res.writeHead(400); res.end(); return;
  }
  let target = abs;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // SPA fallback：Try <path>/index.html → 404.html
    const asDir = path.join(abs, "index.html");
    if (existsSync(asDir)) {
      target = asDir;
    } else {
      target = path.join(DIST, "404.html");
      if (!existsSync(target)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
    }
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(target).pipe(res);
}
