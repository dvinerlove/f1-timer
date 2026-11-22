/* LIGHTS OUT dev server — static files + /f1/* proxy to livetiming.formula1.com.
   The F1 SignalR feed needs its ALB cookie and is CORS-blocked for browsers;
   proxying through our own origin solves both. Zero deps. */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
/* this host resolves IPv6-first but the route is dead — fetch would hang */
require("dns").setDefaultResultOrder("ipv4first");
require("net").setDefaultAutoSelectFamily?.(false);

const ROOT = __dirname;
const PORT = +(process.env.PORT || 8420);
const F1 = "https://livetiming.formula1.com";
const jar = new Map(); /* upstream cookies by name — ALB stickiness lives here */

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css",
  ".js": "text/javascript", ".geojson": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const collect = (r) => new Promise((res) => {
  const b = []; r.on("data", (c) => b.push(c)); r.on("end", () => res(Buffer.concat(b)));
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");

  if (u.pathname.startsWith("/f1/")) {
    try {
      const headers = {
        accept: req.headers.accept || "*/*",
        "content-type": req.headers["content-type"] || "text/plain;charset=UTF-8",
        "user-agent": "lights-out/1.0",
      };
      if (jar.size) headers.cookie =
        [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      const call = () => fetch(F1 + u.pathname.slice(3) + u.search, {
        method: req.method,
        headers,
        body: req.method === "POST" ? body : undefined,
      });
      const body = req.method === "POST" ? await collect(req) : undefined;
      /* upstream hiccups cost the whole feed — negotiate is idempotent */
      let up = await call().catch(() => null);
      if (!up) up = await call();
      for (const c of up.headers.getSetCookie?.() || []) {
        const i = c.indexOf("=");
        jar.set(c.slice(0, i).trim(), c.slice(i + 1, c.indexOf(";") >>> 0 || undefined));
      }
      const ct = up.headers.get("content-type") || "text/plain";
      res.writeHead(up.status, {
        "content-type": ct,
        "cache-control": "no-cache",
        ...(ct.includes("event-stream") ? { "x-accel-buffering": "no" } : {}),
      });
      if (up.body) for await (const chunk of up.body) res.write(chunk);
      res.end();
    } catch (e) {
      res.writeHead(502); res.end(String(e));
    }
    return;
  }

  const p = path.join(ROOT,
    decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(d);
  });
}).listen(PORT, () => console.log(`lights-out on :${PORT}`));
