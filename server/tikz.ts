import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { metapostImageAvailable } from "./metapost.ts";

const IMAGE = process.env.METAPOST_IMAGE?.trim() || "locus-metapost:1";
const DOCKER = process.env.DOCKER_BIN?.trim() || "docker";
const SERVICE_URL = process.env.METAPOST_SERVICE_URL?.trim().replace(/\/$/, "") || null;
const MAX_SOURCE_BYTES = 100_000;
const MAX_SVG_BYTES = 2_000_000;
const MAX_LOG_BYTES = 24_000;
const HOST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_COMPILATIONS = Math.min(
  16,
  Math.max(1, Number.parseInt(process.env.METAPOST_MAX_CONCURRENCY ?? "2", 10) || 2),
);
let activeCompilations = 0;

// User code is still executed only in the isolated compiler container. This
// validation is an additional boundary that rejects TeX primitives capable of
// file access, shell/process access, macro obfuscation, or document mutation.
const FORBIDDEN_COMMAND = /\\(?:documentclass|usepackage|RequirePackage|input|include|includeonly|includegraphics|openin|openout|read|write|closein|closeout|immediate|special|catcode|csname|endcsname|expandafter|noexpand|afterassignment|aftergroup|newcommand|renewcommand|providecommand|DeclareRobustCommand|def|edef|gdef|xdef|let|futurelet|newread|newwrite|everyjob|everyeof|everypar|everymath|everydisplay|shipout|output|font|fontdimen|pdfobj|pdfxform|pdfliteral|pdfcatalog|pdfinfo|pdfmapfile|directlua|luaexec|write18|ShellEscape|tikzexternalize|tikzexternalenable|pgfimage|href|url|file|jobname|typeout|message|errmessage|show|meaning|makeatletter|makeatother)\b/i;
const ALLOWED_ENVIRONMENTS = new Set(["scope", "array"]);
const MAX_ENVIRONMENTS = 64;
const MAX_ARRAY_COLUMNS = 12;

export interface TikzCompileResult {
  svg: string;
  log: string;
  durationMs: number;
}

export class TikzCompileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly log = "",
  ) {
    super(message);
  }
}

function validateBody(source: unknown): string {
  if (typeof source !== "string" || !source.trim()) {
    throw new TikzCompileError("TikZ source is required.", 400);
  }
  const body = source.trim();
  if (Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES) {
    throw new TikzCompileError(
      `TikZ source exceeds the ${MAX_SOURCE_BYTES.toLocaleString()} byte limit.`,
      413,
    );
  }
  if (/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(body)) {
    throw new TikzCompileError(
      "TikZ source must use ASCII text and LaTeX commands for symbols.",
      400,
    );
  }
  if (body.includes("^^") || body.includes("%")) {
    throw new TikzCompileError(
      "TeX character rewriting and comments are disabled by the visualization sandbox.",
      400,
    );
  }
  const forbiddenCommand = body.match(FORBIDDEN_COMMAND)?.[0];
  if (forbiddenCommand) {
    throw new TikzCompileError(
      `The TeX command “${forbiddenCommand}” is disabled by the visualization sandbox.`,
      400,
    );
  }
  if (/\/(?:\.code|\.style|\.append style|utils\/exec)\b/i.test(body)) {
    throw new TikzCompileError(
      "Executable PGF key handlers are disabled by the visualization sandbox.",
      400,
    );
  }
  const environmentStack: string[] = [];
  let environmentCount = 0;
  for (const match of body.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    const action = match[1];
    const environment = match[2].trim();
    if (!ALLOWED_ENVIRONMENTS.has(environment)) {
      throw new TikzCompileError(
        `The TeX environment “${environment}” is disabled in TikZ figure bodies.`,
        400,
      );
    }
    if (action === "begin") {
      environmentCount += 1;
      if (environmentCount > MAX_ENVIRONMENTS) {
        throw new TikzCompileError("TikZ source contains too many nested environments.", 400);
      }
      if (environment === "array") {
        const remainder = body.slice((match.index ?? 0) + match[0].length);
        const columnSpec = remainder.match(/^\s*\{([lcr|\s]+)\}/)?.[1] ?? "";
        const columns = columnSpec.match(/[lcr]/g)?.length ?? 0;
        if (!columnSpec || columns < 1 || columns > MAX_ARRAY_COLUMNS) {
          throw new TikzCompileError(
            `TikZ array column specifications may contain only l, c, r, separators, and at most ${MAX_ARRAY_COLUMNS} columns.`,
            400,
          );
        }
      }
      environmentStack.push(environment);
      continue;
    }
    if (environmentStack.pop() !== environment) {
      throw new TikzCompileError("TikZ source has mismatched TeX environments.", 400);
    }
  }
  if (environmentStack.length) {
    throw new TikzCompileError("TikZ source has unclosed TeX environments.", 400);
  }

  let braceDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") {
      index += 1;
      continue;
    }
    if (body[index] === "{") braceDepth += 1;
    if (body[index] === "}") braceDepth -= 1;
    if (braceDepth < 0 || braceDepth > 64) {
      throw new TikzCompileError("TikZ source has invalid or excessively nested braces.", 400);
    }
  }
  if (braceDepth !== 0) {
    throw new TikzCompileError("TikZ source has unbalanced braces.", 400);
  }
  return body;
}

function wrappedSource(body: string): string {
  return String.raw`\documentclass[10pt]{article}
\usepackage{amsmath,amssymb}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,positioning,calc,fit,matrix,intersections,decorations.pathreplacing,backgrounds,patterns}
\pagestyle{empty}
\definecolor{locusBg}{HTML}{0E1013}
\definecolor{locusPanel}{HTML}{13161B}
\definecolor{locusInk}{HTML}{ECE8DF}
\definecolor{locusMuted}{HTML}{969FAD}
\definecolor{locusGuide}{HTML}{414F67}
\definecolor{locusBlue}{HTML}{468BEC}
\definecolor{locusTeal}{HTML}{45C1A8}
\definecolor{locusPurple}{HTML}{9B63E0}
\definecolor{locusOrange}{HTML}{F16728}
\tikzset{
  locus guide/.style={draw=locusGuide,line width=.55pt},
  locus line/.style={draw=locusBlue,line width=1.15pt},
  locus strong/.style={draw=locusTeal,line width=2.25pt},
  locus arrow/.style={-{Latex[length=3mm,width=2mm]},line width=1.6pt},
  locus panel/.style={fill=locusPanel,draw=locusGuide,rounded corners=2pt},
  locus label/.style={text=locusInk,font=\small,inner sep=2pt},
  locus muted/.style={text=locusMuted,font=\small,inner sep=2pt}
}
\begin{document}
\noindent
\begin{tikzpicture}[x=1cm,y=1cm]
${body}
\end{tikzpicture}
\end{document}
`;
}

async function runDocker(args: string[]): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(DOCKER, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_LOG_BYTES) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function tikzImageAvailable(): Promise<boolean> {
  return metapostImageAvailable();
}

export async function compileTikz(source: unknown): Promise<TikzCompileResult> {
  const body = validateBody(source);
  if (activeCompilations >= MAX_CONCURRENT_COMPILATIONS) {
    throw new TikzCompileError("The visualization compiler is busy. Try again in a moment.", 429);
  }
  activeCompilations += 1;
  let jobDirectory: string | null = null;
  const containerName = `locus-tikz-${randomUUID()}`;
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;

  try {
    if (SERVICE_URL) {
      const response = await fetch(`${SERVICE_URL}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: "tikz", source: wrappedSource(body) }),
        signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as {
        svg?: string;
        log?: string;
        durationMs?: number;
        error?: string;
      };
      if (!response.ok || !result.svg) {
        throw new TikzCompileError(
          result.error ?? "TikZ could not compile this visualization.",
          response.status === 429 ? 429 : response.status === 413 ? 413 : 422,
          result.log?.slice(-MAX_LOG_BYTES) ?? "",
        );
      }
      if (Buffer.byteLength(result.svg, "utf8") > MAX_SVG_BYTES) {
        throw new TikzCompileError("The compiled SVG exceeds the 2 MB artifact limit.", 413);
      }
      return {
        svg: result.svg,
        log: result.log?.slice(-MAX_LOG_BYTES) ?? "",
        durationMs: result.durationMs ?? Date.now() - startedAt,
      };
    }

    jobDirectory = await mkdtemp(path.join(tmpdir(), "locus-tikz-"));
    await chmod(jobDirectory, 0o777);
    await writeFile(path.join(jobDirectory, "figure.tex"), wrappedSource(body), {
      encoding: "utf8",
      mode: 0o444,
    });

    const args = [
      "run", "--rm", "--name", containerName,
      "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=64",
      "--memory=256m", "--memory-swap=256m", "--cpus=1",
      "--ulimit=fsize=4194304:4194304",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--user=65534:65534", "--env=HOME=/tmp",
      "--mount", `type=bind,source=${jobDirectory},target=/work`,
      "--entrypoint=/usr/local/bin/locus-tikz", IMAGE,
    ];
    const result = await Promise.race([
      runDocker(args),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void runDocker(["rm", "-f", containerName]).finally(() => {
            reject(new TikzCompileError("TikZ compilation timed out.", 422));
          });
        }, HOST_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    const compilerLog = await readFile(path.join(jobDirectory, "compiler.log"), "utf8")
      .catch(() => result.stderr)
      .then((log) => log.slice(-MAX_LOG_BYTES));
    if (result.code !== 0) {
      const unavailable = /Unable to find image|Cannot connect to the Docker daemon|executable file not found/i.test(result.stderr);
      throw new TikzCompileError(
        unavailable
          ? "The visualization compiler image is unavailable. Run: npm run metapost:build"
          : "TikZ could not compile this visualization.",
        unavailable ? 503 : 422,
        compilerLog || result.stderr,
      );
    }
    const svg = await readFile(path.join(jobDirectory, "figure.svg"), "utf8");
    if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES || !svg.includes("<svg")) {
      throw new TikzCompileError("The compiler produced an invalid SVG artifact.", 422, compilerLog);
    }
    return { svg, log: compilerLog, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof TikzCompileError) throw error;
    throw new TikzCompileError(
      error instanceof Error ? error.message : "TikZ compilation failed.",
      500,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    activeCompilations -= 1;
  }
}
