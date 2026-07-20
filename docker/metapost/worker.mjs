import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT || 8090);
const MAX_SOURCE_BYTES = 140_000;
const MAX_SVG_BYTES = 2_000_000;
const MAX_LOG_BYTES = 24_000;
const MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.MAX_CONCURRENCY || 2)));
let active = 0;

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SOURCE_BYTES * 2) throw Object.assign(new Error("Request is too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function compile(directory) {
  return new Promise((resolve) => {
    execFile("/usr/local/bin/locus-metapost", [], {
      cwd: directory,
      timeout: 8_000,
      maxBuffer: MAX_LOG_BYTES,
      env: { HOME: "/tmp", PATH: process.env.PATH, LOCUS_WORKDIR: directory },
    }, (error, _stdout, stderr) => resolve({ error, stderr }));
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/compile") {
    json(response, 404, { error: "Not found" });
    return;
  }
  if (active >= MAX_CONCURRENCY) {
    json(response, 429, { error: "The visualization compiler is busy" });
    return;
  }

  let directory;
  active += 1;
  const startedAt = Date.now();
  try {
    const body = await readBody(request);
    if (typeof body.source !== "string" || !body.source.trim()) {
      json(response, 400, { error: "MetaPost source is required" });
      return;
    }
    if (Buffer.byteLength(body.source, "utf8") > MAX_SOURCE_BYTES) {
      json(response, 413, { error: "MetaPost source is too large" });
      return;
    }
    directory = await mkdtemp("/work/job-");
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, "figure.mp"), body.source, { mode: 0o400 });
    const result = await compile(directory);
    const log = await readFile(path.join(directory, "compiler.log"), "utf8")
      .catch(() => result.stderr || "")
      .then((value) => value.slice(-MAX_LOG_BYTES));
    if (result.error) {
      json(response, 422, { error: "MetaPost could not compile this visualization.", log });
      return;
    }
    const svg = await readFile(path.join(directory, "figure-1.svg"), "utf8");
    if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES || !svg.includes("<svg")) {
      json(response, 422, { error: "The compiler produced an invalid artifact", log });
      return;
    }
    json(response, 200, { svg, log, durationMs: Date.now() - startedAt });
  } catch (error) {
    json(response, error?.status || 500, { error: error instanceof Error ? error.message : "Compilation failed" });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    active -= 1;
  }
});

server.listen(PORT, "0.0.0.0");

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
