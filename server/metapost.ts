import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const IMAGE = process.env.METAPOST_IMAGE?.trim() || "locus-metapost:1";
const DOCKER = process.env.DOCKER_BIN?.trim() || "docker";
const SERVICE_URL = process.env.METAPOST_SERVICE_URL?.trim().replace(/\/$/, "") || null;
const MAX_SOURCE_BYTES = 100_000;
const MAX_SVG_BYTES = 2_000_000;
const MAX_LOG_BYTES = 24_000;
const MAX_TEX_LABELS = 128;
const MAX_TEX_LABEL_BYTES = 4_096;
const MAX_TOTAL_TEX_BYTES = 32_000;
const HOST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_COMPILATIONS = Math.min(
  16,
  Math.max(1, Number.parseInt(process.env.METAPOST_MAX_CONCURRENCY ?? "2", 10) || 2),
);
let activeCompilations = 0;

const FORBIDDEN_SOURCE =
  /\b(?:beginfig|endfig|end|input|btex|etex|verbatimtex|write|readfrom|closefrom|scantokens|runscript|special|externalfigure|fontmapfile|fontmapline)\b/i;

const SAFE_TEX_COMMANDS = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi",
  "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "det", "dim",
  "ker", "max", "min", "sup", "inf", "lim", "gcd", "arg", "deg", "hom", "Pr",
  "operatorname",
  "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigcup", "bigcap",
  "bigvee", "bigwedge", "le", "leq", "ge", "geq", "ne", "neq", "approx",
  "leqslant", "geqslant", "lesssim", "gtrsim", "lessapprox", "gtrapprox", "ll", "gg",
  "sim", "simeq", "equiv", "cong", "asymp", "doteq", "propto", "prec", "succ",
  "preceq", "succeq", "in", "notin", "ni", "subset", "subseteq", "supset", "supseteq",
  "parallel", "perp", "mid", "models", "bowtie", "smile", "frown", "colon", "not",
  "iff", "implies", "impliedby", "therefore", "because", "pm", "mp", "times",
  "div", "cdot", "ast", "star", "circ", "bullet", "cap", "cup", "setminus",
  "smallsetminus", "complement", "wedge", "vee", "oplus", "ominus", "otimes", "odot",
  "circledast", "leftarrow", "rightarrow", "leftrightarrow", "Leftarrow", "Rightarrow",
  "Leftrightarrow", "longleftarrow", "longrightarrow", "longleftrightarrow", "Longleftarrow",
  "Longrightarrow", "Longleftrightarrow", "mapsto", "longmapsto", "hookleftarrow",
  "hookrightarrow", "leftharpoonup", "leftharpoondown", "rightharpoonup", "rightharpoondown",
  "rightleftharpoons", "rightsquigarrow", "leadsto", "multimap", "to", "gets", "uparrow",
  "downarrow", "infty", "partial", "nabla", "ell", "hbar",
  "imath", "jmath", "Re", "Im", "wp", "emptyset", "varnothing", "forall", "exists",
  "neg", "top", "bot", "angle", "triangle", "triangleleft", "triangleright", "aleph",
  "beth", "prime", "dagger", "ddagger", "dots", "ldots", "cdots", "vdots", "ddots",
  "langle", "rangle", "lvert", "rvert", "vert", "Vert", "lfloor", "rfloor", "lceil",
  "rceil", "backslash", "frac", "dfrac", "tfrac", "binom", "dbinom", "tbinom",
  "sqrt", "overline", "underline", "overbrace", "underbrace", "vec", "overrightarrow",
  "overleftarrow", "hat", "widehat", "bar", "dot", "ddot", "tilde", "widetilde",
  "mathrm", "mathbf", "boldsymbol", "mathit", "mathsf", "mathtt", "mathcal", "mathbb",
  "mathfrak", "text",
  "textnormal", "textbf", "textit", "textrm", "textsf", "texttt", "left", "right",
  "big", "Big", "bigg", "Bigg", "displaystyle", "textstyle", "scriptstyle",
  "scriptscriptstyle", "phantom", "vphantom", "hphantom", "smash", "limits",
  "nolimits", "overset", "underset", "stackrel", "boxed", "pmod", "mod", "bmod",
  "mathop", "mathrel", "mathbin", "mathord",
  "quad", "qquad",
]);

const SAFE_TEX_SYMBOL_COMMANDS = new Set([",", ";", ":", "!", "{", "}", "|", "_", " "]);

interface InspectedSource {
  executable: string;
  texLabels: string[];
}

function inspectSource(source: string): InspectedSource {
  let code = "";
  const texLabels: string[] = [];
  let inString = false;
  let inComment = false;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (inComment) {
      if (character === "\n" || character === "\r") {
        inComment = false;
        code += character;
      } else {
        code += " ";
      }
      index += 1;
      continue;
    }

    if (inString) {
      if (character === '"') inString = false;
      code += character === "\n" || character === "\r" ? character : " ";
      index += 1;
      continue;
    }

    if (character === "%") {
      inComment = true;
      code += " ";
    } else if (character === '"') {
      inString = true;
      code += " ";
    } else if (
      source.slice(index, index + 4).toLowerCase() === "btex" &&
      !/[A-Za-z]/.test(source[index - 1] ?? "") &&
      !/[A-Za-z]/.test(source[index + 4] ?? "")
    ) {
      const labelStart = index + 4;
      const terminator = /\betex\b/i.exec(source.slice(labelStart));
      if (!terminator || terminator.index == null) {
        throw new MetaPostCompileError("A TeX label is missing its closing etex marker.", 400);
      }
      const labelEnd = labelStart + terminator.index;
      const blockEnd = labelEnd + terminator[0].length;
      texLabels.push(source.slice(labelStart, labelEnd));
      code += " ".repeat(blockEnd - index);
      index = blockEnd;
      continue;
    } else {
      code += character;
    }
    index += 1;
  }

  return { executable: code, texLabels };
}

function validateTexLabel(label: string, labelIndex: number): void {
  const displayIndex = labelIndex + 1;
  if (Buffer.byteLength(label, "utf8") > MAX_TEX_LABEL_BYTES) {
    throw new MetaPostCompileError(
      `TeX label ${displayIndex} exceeds the ${MAX_TEX_LABEL_BYTES.toLocaleString()} byte limit.`,
      413,
    );
  }
  if (/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(label)) {
    throw new MetaPostCompileError(
      `TeX label ${displayIndex} must use ASCII text and LaTeX commands for symbols.`,
      400,
    );
  }
  if (label.includes("%") || label.includes("^^") || /[&#~]/.test(label)) {
    throw new MetaPostCompileError(
      `TeX label ${displayIndex} contains syntax that is disabled by the visualization sandbox.`,
      400,
    );
  }

  for (const match of label.matchAll(/\\([A-Za-z]+|.)/g)) {
    const command = match[1];
    const safe = /^[A-Za-z]+$/.test(command)
      ? SAFE_TEX_COMMANDS.has(command)
      : SAFE_TEX_SYMBOL_COMMANDS.has(command);
    if (!safe) {
      throw new MetaPostCompileError(
        `The TeX command “\\${command}” in label ${displayIndex} is not allowed by the visualization sandbox.`,
        400,
      );
    }
  }

  let braceDepth = 0;
  let mathDelimiters = 0;
  for (let index = 0; index < label.length; index += 1) {
    const character = label[index];
    if (character === "\\") {
      if (/[A-Za-z]/.test(label[index + 1] ?? "")) {
        while (/[A-Za-z]/.test(label[index + 1] ?? "")) index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > 32) {
        throw new MetaPostCompileError(`TeX label ${displayIndex} is nested too deeply.`, 400);
      }
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        throw new MetaPostCompileError(`TeX label ${displayIndex} has unbalanced braces.`, 400);
      }
    } else if (character === "$") {
      mathDelimiters += 1;
    }
  }
  if (braceDepth !== 0) {
    throw new MetaPostCompileError(`TeX label ${displayIndex} has unbalanced braces.`, 400);
  }
  if (mathDelimiters % 2 !== 0) {
    throw new MetaPostCompileError(`TeX label ${displayIndex} has an unclosed math delimiter.`, 400);
  }
}

export interface MetaPostCompileResult {
  svg: string;
  log: string;
  durationMs: number;
}

export class MetaPostCompileError extends Error {
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
    throw new MetaPostCompileError("MetaPost source is required.", 400);
  }
  const body = source.trim();
  if (Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES) {
    throw new MetaPostCompileError(
      `MetaPost source exceeds the ${MAX_SOURCE_BYTES.toLocaleString()} byte limit.`,
      413,
    );
  }
  if (/[^\u0009\u000a\u000d\u0020-\uffff]/u.test(body)) {
    throw new MetaPostCompileError("MetaPost source contains unsupported control characters.", 400);
  }
  const inspected = inspectSource(body);
  if (inspected.texLabels.length > MAX_TEX_LABELS) {
    throw new MetaPostCompileError(
      `A visualization may contain at most ${MAX_TEX_LABELS} TeX labels.`,
      413,
    );
  }
  const totalTexBytes = inspected.texLabels.reduce(
    (total, label) => total + Buffer.byteLength(label, "utf8"),
    0,
  );
  if (totalTexBytes > MAX_TOTAL_TEX_BYTES) {
    throw new MetaPostCompileError(
      `TeX labels exceed the ${MAX_TOTAL_TEX_BYTES.toLocaleString()} byte total limit.`,
      413,
    );
  }
  inspected.texLabels.forEach(validateTexLabel);

  const forbidden = inspected.executable.match(FORBIDDEN_SOURCE)?.[0];
  if (forbidden) {
    throw new MetaPostCompileError(
      `The MetaPost primitive “${forbidden}” is disabled by the visualization sandbox.`,
      400,
    );
  }
  return body;
}

function wrappedSource(body: string): string {
  return `outputformat := "svg";
outputtemplate := "%j-%c.svg";
prologues := 3;

verbatimtex
%&latex
\\documentclass[10pt]{article}
\\usepackage{amsmath,amssymb}
\\pagestyle{empty}
\\begin{document}
etex

color locusBg, locusPanel, locusInk, locusMuted, locusGuide;
color locusBlue, locusTeal, locusPurple, locusOrange;
locusBg := (0.055, 0.061, 0.073);
locusPanel := (0.075, 0.086, 0.105);
locusInk := (0.925, 0.910, 0.875);
locusMuted := (0.590, 0.625, 0.680);
locusGuide := (0.255, 0.315, 0.405);
locusBlue := (0.275, 0.545, 0.925);
locusTeal := (0.270, 0.755, 0.660);
locusPurple := (0.610, 0.390, 0.880);
locusOrange := (0.945, 0.405, 0.155);

numeric locusThin, locusMedium, locusStrong;
locusThin := 0.55;
locusMedium := 1.15;
locusStrong := 2.25;
defaultfont := "cmr10";
defaultscale := 1.05;

beginfig(1);
${body}
endfig;
end.
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

export async function metapostImageAvailable(): Promise<boolean> {
  if (SERVICE_URL) {
    try {
      const response = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
  try {
    const result = await runDocker(["image", "inspect", IMAGE]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function compileMetaPost(source: unknown): Promise<MetaPostCompileResult> {
  const body = validateBody(source);
  if (activeCompilations >= MAX_CONCURRENT_COMPILATIONS) {
    throw new MetaPostCompileError(
      "The visualization compiler is busy. Try again in a moment.",
      429,
    );
  }
  activeCompilations += 1;
  let jobDirectory: string | null = null;
  const containerName = `locus-metapost-${randomUUID()}`;
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;

  try {
    if (SERVICE_URL) {
      const response = await fetch(`${SERVICE_URL}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: wrappedSource(body) }),
        signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as {
        svg?: string;
        log?: string;
        durationMs?: number;
        error?: string;
      };
      if (!response.ok || !result.svg) {
        throw new MetaPostCompileError(
          result.error ?? "MetaPost could not compile this visualization.",
          response.status === 429 ? 429 : response.status === 413 ? 413 : 422,
          result.log?.slice(-MAX_LOG_BYTES) ?? "",
        );
      }
      if (Buffer.byteLength(result.svg, "utf8") > MAX_SVG_BYTES) {
        throw new MetaPostCompileError("The compiled SVG exceeds the 2 MB artifact limit.", 413);
      }
      return {
        svg: result.svg,
        log: result.log?.slice(-MAX_LOG_BYTES) ?? "",
        durationMs: result.durationMs ?? Date.now() - startedAt,
      };
    }

    jobDirectory = await mkdtemp(path.join(tmpdir(), "locus-metapost-"));
    await chmod(jobDirectory, 0o777);
    await writeFile(path.join(jobDirectory, "figure.mp"), wrappedSource(body), {
      encoding: "utf8",
      mode: 0o444,
    });

    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--ulimit=fsize=4194304:4194304",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--user=65534:65534",
      "--env=HOME=/tmp",
      "--mount",
      `type=bind,source=${jobDirectory},target=/work`,
      "--entrypoint=/usr/local/bin/locus-metapost",
      IMAGE,
    ];

    const result = await Promise.race([
      runDocker(args),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void runDocker(["rm", "-f", containerName]).finally(() => {
            reject(new MetaPostCompileError("MetaPost compilation timed out.", 422));
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
      const unavailable = /Unable to find image|Cannot connect to the Docker daemon|executable file not found/i.test(
        result.stderr,
      );
      throw new MetaPostCompileError(
        unavailable
          ? `The MetaPost compiler image is unavailable. Run: npm run metapost:build`
          : "MetaPost could not compile this visualization.",
        unavailable ? 503 : 422,
        compilerLog || result.stderr,
      );
    }

    const svg = await readFile(path.join(jobDirectory, "figure-1.svg"), "utf8");
    if (!svg.startsWith("<?xml") && !svg.includes("<svg")) {
      throw new MetaPostCompileError("The compiler did not produce a valid SVG document.", 422, compilerLog);
    }
    if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
      throw new MetaPostCompileError("The compiled SVG exceeds the 2 MB artifact limit.", 413, compilerLog);
    }
    return { svg, log: compilerLog, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof MetaPostCompileError) throw error;
    const message = error instanceof Error ? error.message : "MetaPost compilation failed";
    throw new MetaPostCompileError(message, 500);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (jobDirectory) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    activeCompilations -= 1;
  }
}
