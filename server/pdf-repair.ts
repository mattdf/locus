import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import katex from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { diff_match_patch } from "diff-match-patch";
import { normalizeMathDelimiters } from "../src/lib/markdown.ts";
import { KATEX_RENDER_OPTIONS } from "../src/lib/katex.ts";
import { isHosted } from "./config.ts";
import {
  resolveManagedCredentialDetails,
  resolvePersonalCredentialDetails,
  type ResolvedCredential,
} from "./credentials.ts";
import { query, transaction } from "./db.ts";
import {
  authorizeManagedGeneration,
  ManagedUsageLimitError,
  releaseManagedGeneration,
} from "./managed-usage.ts";
import type { TokenUsage } from "./openai.ts";
import { calculateGenerationCost } from "./pricing.ts";
import { createProviderClient } from "./providers.ts";

const PROMPT_FILE = path.resolve("PDF_REPAIR_PROMPT.md");
export const PDF_REPAIR_PROMPT_VERSION = "pdf-markdown-repair-v2";
export const PDF_REPAIR_MODEL = process.env.PDF_REPAIR_MODEL?.trim() || "gpt-5.4-mini";
const MAX_ATTEMPTS = Math.min(
  4,
  Math.max(1, Number(process.env.PDF_REPAIR_MAX_ATTEMPTS ?? 3)),
);
const MAX_OUTPUT_TOKENS = Math.max(
  1_000,
  Number(process.env.PDF_REPAIR_MAX_OUTPUT_TOKENS ?? 16_000),
);
const UPSTREAM_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.PDF_REPAIR_UPSTREAM_TIMEOUT_SECONDS ?? 90) * 1_000,
);
const INTERNAL_TOKEN =
  process.env.PDF2MARKDOWN_ADMIN_TOKEN?.trim() ||
  (isHosted ? "" : "locus-local-pdf-admin");

interface RepairEdit {
  before: string;
  after: string;
  occurrence: number;
  reason: string;
  confidence: "high" | "medium" | "low";
}

interface RepairOutput {
  edits: RepairEdit[];
  summary: string;
}

interface RepairPolicy {
  managedEnabled: boolean;
  monthlyLimitUsd: number | null;
  monthlyCostUsd: number;
}

export class PdfRepairError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = "PDF_REPAIR_FAILED",
  ) {
    super(message);
  }
}

function secureTokenMatches(candidate: string): boolean {
  if (!INTERNAL_TOKEN || !candidate) return false;
  const expected = Buffer.from(INTERNAL_TOKEN);
  const supplied = Buffer.from(candidate);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function requirePdfRepairInternalToken(request: Request, response: Response): boolean {
  const [scheme, token] = (request.header("Authorization") ?? "").split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !secureTokenMatches(token ?? "")) {
    response.status(401).json({ error: "Invalid PDF repair service token" });
    return false;
  }
  return true;
}

async function repairPolicy(ownerUserId: string): Promise<RepairPolicy> {
  if (!isHosted) {
    return { managedEnabled: true, monthlyLimitUsd: null, monthlyCostUsd: 0 };
  }
  const result = await query<{
    managedEnabled: boolean;
    monthlyLimitUsd: number | null;
    monthlyCostUsd: number;
  }>(
    `select coalesce(p."managedEnabled", true) as "managedEnabled",
            p."monthlyLimitUsd"::double precision as "monthlyLimitUsd",
            coalesce(u."monthlyCostUsd", 0)::double precision as "monthlyCostUsd"
       from (select $1::text as "ownerUserId") account
       left join "locus_pdf_repair_policies" p using ("ownerUserId")
       left join lateral (
         select sum("totalCostUsd") as "monthlyCostUsd"
           from "locus_usage_events"
          where "ownerUserId" = account."ownerUserId"
            and "purpose" = 'pdf-repair'
            and "managedCredentialId" is not null
            and "createdAt" >=
              (date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC')
       ) u on true`,
    [ownerUserId],
  );
  return result.rows[0] ?? {
    managedEnabled: true,
    monthlyLimitUsd: null,
    monthlyCostUsd: 0,
  };
}

async function repairCredential(ownerUserId: string): Promise<{
  credential: ResolvedCredential;
  policy: RepairPolicy;
}> {
  const policy = await repairPolicy(ownerUserId);
  if (policy.managedEnabled) {
    const managed = await resolveManagedCredentialDetails(ownerUserId, "openai");
    if (managed) return { credential: managed, policy };
  }
  const personal = await resolvePersonalCredentialDetails(ownerUserId, "openai");
  if (personal) return { credential: personal, policy };
  throw new PdfRepairError(
    policy.managedEnabled
      ? "PDF formatting requires an OpenAI key. Ask the administrator to assign one, or add your own OpenAI key in Providers."
      : "Administrator-funded PDF formatting is disabled for this account. Add your own OpenAI key in Providers before importing a PDF.",
    402,
    "PDF_REPAIR_KEY_REQUIRED",
  );
}

function enforceRepairCap(policy: RepairPolicy): void {
  if (
    policy.monthlyLimitUsd !== null &&
    policy.monthlyCostUsd >= policy.monthlyLimitUsd
  ) {
    throw new PdfRepairError(
      `This account has reached its $${policy.monthlyLimitUsd.toFixed(2)} monthly administrator-funded PDF formatting limit`,
      402,
      "PDF_REPAIR_LIMIT_REACHED",
    );
  }
}

function outputSchema() {
  return {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            before: { type: "string" },
            after: { type: "string" },
            occurrence: { type: "integer" },
            reason: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["before", "after", "occurrence", "reason", "confidence"],
          additionalProperties: false,
        },
      },
      summary: { type: "string" },
    },
    required: ["edits", "summary"],
    additionalProperties: false,
  } as const;
}

function nthOccurrence(source: string, needle: string, occurrence: number): number {
  if (!needle || !Number.isSafeInteger(occurrence) || occurrence < 1) return -1;
  let cursor = 0;
  for (let index = 1; index <= occurrence; index += 1) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) return -1;
    if (index === occurrence) return found;
    cursor = found + Math.max(1, needle.length);
  }
  return -1;
}

export function applyExactRepairEdits(source: string, edits: RepairEdit[]): string {
  const replacements = edits.map((edit, index) => {
    if (!edit.before) throw new PdfRepairError(`Repair edit ${index + 1} has an empty source`);
    if (edit.confidence !== "high") {
      throw new PdfRepairError(`Repair edit ${index + 1} is not high confidence`);
    }
    const start = nthOccurrence(source, edit.before, edit.occurrence);
    if (start < 0) {
      throw new PdfRepairError(`Repair edit ${index + 1} no longer matches the OCR page`);
    }
    return { start, end: start + edit.before.length, value: edit.after };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].start < replacements[index - 1].end) {
      throw new PdfRepairError("The repair model returned overlapping edits");
    }
  }
  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += source.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return output + source.slice(cursor);
}

function destinations(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1])
    .sort();
}

function contentFingerprint(markdown: string): string {
  return (markdown.match(/[\p{L}\p{N}]+/gu) ?? []).join("").toLocaleLowerCase();
}

function validateSemanticStability(source: string, candidate: string): void {
  if (candidate.includes("\0")) throw new PdfRepairError("Repair introduced an invalid byte");
  if (candidate.length > source.length * 1.4 + 500 || candidate.length < source.length * 0.6 - 500) {
    throw new PdfRepairError("Repair changed too much of the page");
  }
  if (JSON.stringify(destinations(source)) !== JSON.stringify(destinations(candidate))) {
    throw new PdfRepairError("Repair changed an image or link destination");
  }
  const before = contentFingerprint(source);
  const after = contentFingerprint(candidate);
  const differ = new diff_match_patch();
  const changes = differ.diff_levenshtein(differ.diff_main(before, after));
  const maximum = Math.max(24, Math.floor(Math.max(before.length, after.length) * 0.02));
  if (changes > maximum) {
    throw new PdfRepairError("Repair changed source content instead of only formatting");
  }
}

type MarkdownNode = { type?: string; value?: string; children?: MarkdownNode[] };

function validateKatex(markdown: string): number {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as MarkdownNode;
  let count = 0;
  const visit = (node: MarkdownNode) => {
    if ((node.type === "math" || node.type === "inlineMath") && typeof node.value === "string") {
      katex.renderToString(node.value, {
        ...KATEX_RENDER_OPTIONS,
        displayMode: node.type === "math",
        throwOnError: true,
      });
      count += 1;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return count;
}

function katexDiagnostics(markdown: string, limit = 8): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as MarkdownNode;
  const diagnostics: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (
      diagnostics.length < limit &&
      (node.type === "math" || node.type === "inlineMath") &&
      typeof node.value === "string"
    ) {
      try {
        katex.renderToString(node.value, {
          ...KATEX_RENDER_OPTIONS,
          displayMode: node.type === "math",
          throwOnError: true,
        });
      } catch (error) {
        const compact = node.value.replace(/\s+/g, " ").trim();
        diagnostics.push(
          `${node.type === "math" ? "display" : "inline"} math ${JSON.stringify(
            compact.length > 500 ? `${compact.slice(0, 497)}...` : compact,
          )}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return diagnostics;
}

function addTokenUsage(total: TokenUsage | null, current: TokenUsage | null): TokenUsage | null {
  if (!current) return total;
  if (!total) return { ...current };
  return {
    inputTokens: total.inputTokens + current.inputTokens,
    cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
    outputTokens: total.outputTokens + current.outputTokens,
    reasoningTokens: total.reasoningTokens + current.reasoningTokens,
    totalTokens: total.totalTokens + current.totalTokens,
  };
}

export function validateAndNormalizeRepair(source: string, candidate: string): {
  markdown: string;
  mathNodeCount: number;
} {
  validateSemanticStability(source, candidate);
  const normalizedSource = normalizeMathDelimiters(source, true);
  const markdown = normalizeMathDelimiters(candidate, true);
  // Existing deterministic normalization can itself make a sizeable repair
  // (for example, splitting a multiply-tagged display). Compare like with
  // like so those known-safe changes are not charged to the model's edit.
  validateSemanticStability(normalizedSource, markdown);
  return { markdown, mathNodeCount: validateKatex(markdown) };
}

function tokenUsage(response: {
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}): TokenUsage | null {
  const usage = response.usage;
  return usage
    ? {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: usage.total_tokens,
      }
    : null;
}

async function persistRepairStarted(
  ownerUserId: string,
  generationId: string,
  credential: ResolvedCredential,
): Promise<void> {
  if (!isHosted) return;
  await query(
    `insert into "locus_generation_jobs"
       ("ownerUserId", "id", "provider", "model", "purpose", "status",
        "managedCredentialId", "credentialKind", "credentialRef", "credentialLabel")
     values ($1, $2, 'openai', $3, 'pdf-repair', 'running', $4, $5, $6, $7)`,
    [
      ownerUserId,
      generationId,
      PDF_REPAIR_MODEL,
      credential.managedCredentialId ?? null,
      credential.credentialKind,
      credential.credentialRef,
      credential.credentialLabel,
    ],
  );
}

async function persistRepairFinished(input: {
  ownerUserId: string;
  generationId: string;
  credential: ResolvedCredential;
  usage: TokenUsage | null;
  status: "completed" | "failed";
  error?: string;
}): Promise<void> {
  if (!isHosted) return;
  const cost = calculateGenerationCost("openai", PDF_REPAIR_MODEL, input.usage);
  await transaction(async (client) => {
    await client.query(
      `update "locus_generation_jobs"
          set "status" = $3, "metrics" = $4::jsonb, "errorMessage" = $5,
              "updatedAt" = current_timestamp, "finishedAt" = current_timestamp
        where "ownerUserId" = $1 and "id" = $2`,
      [
        input.ownerUserId,
        input.generationId,
        input.status,
        JSON.stringify(input.usage ?? {}),
        input.error ?? null,
      ],
    );
    if (input.usage) {
      await client.query(
        `insert into "locus_usage_events"
           ("ownerUserId", "generationId", "provider", "model", "inputTokens",
            "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens",
            "totalCostUsd", "managedCredentialId", "credentialKind", "credentialRef",
            "credentialLabel", "purpose")
         values ($1, $2, 'openai', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 'pdf-repair')`,
        [
          input.ownerUserId,
          input.generationId,
          PDF_REPAIR_MODEL,
          input.usage.inputTokens,
          input.usage.cachedInputTokens,
          input.usage.outputTokens,
          input.usage.reasoningTokens,
          input.usage.totalTokens,
          cost?.totalCostUsd ?? null,
          input.credential.managedCredentialId ?? null,
          input.credential.credentialKind,
          input.credential.credentialRef,
          input.credential.credentialLabel,
        ],
      );
    }
    if (input.credential.managedCredentialId) {
      await client.query(
        `delete from "locus_managed_usage_reservations"
          where "ownerUserId" = $1 and "generationId" = $2`,
        [input.ownerUserId, input.generationId],
      );
    }
  });
}

export async function pdfRepairPreflight(ownerUserId: string): Promise<{
  available: true;
  source: "managed" | "personal";
  model: string;
}> {
  const { credential, policy } = await repairCredential(ownerUserId);
  if (credential.source === "managed") enforceRepairCap(policy);
  return {
    available: true,
    source: credential.credentialKind === "managed" ? "managed" : "personal",
    model: PDF_REPAIR_MODEL,
  };
}

export async function repairPdfMarkdownPage(input: {
  ownerUserId: string;
  jobId: string;
  documentId: string;
  pageNumber: number;
  sourceSha256: string;
  markdown: string;
  previousMarkdown?: string;
  nextMarkdown?: string;
}): Promise<{
  markdown: string;
  changed: boolean;
  editCount: number;
  mathNodeCount: number;
  summary: string;
  model: string;
  promptVersion: string;
}> {
  const { credential, policy } = await repairCredential(input.ownerUserId);
  if (credential.source === "managed") enforceRepairCap(policy);
  const generationId = `pdf-repair:${input.jobId}:${input.pageNumber}:${randomUUID()}`;
  let reserved = false;
  if (credential.managedCredentialId) {
    await authorizeManagedGeneration({
      ownerUserId: input.ownerUserId,
      generationId,
      managedCredentialId: credential.managedCredentialId,
      provider: "openai",
      model: PDF_REPAIR_MODEL,
    });
    reserved = true;
  }
  let usage: TokenUsage | null = null;
  try {
    await persistRepairStarted(input.ownerUserId, generationId, credential);
    const prompt = (await readFile(PROMPT_FILE, "utf8")).trim();
    if (!prompt) throw new PdfRepairError("PDF_REPAIR_PROMPT.md is empty");
    const client = await createProviderClient("openai", undefined, credential.apiKey);
    let working = normalizeMathDelimiters(input.markdown, true);
    validateSemanticStability(input.markdown, working);
    let feedback = katexDiagnostics(working);
    let validated: { markdown: string; mathNodeCount: number } | null = null;
    let editCount = 0;
    let summary = "";
    let lastFailure = feedback.length
      ? `KaTeX validation failed:\n- ${feedback.join("\n- ")}`
      : "No parser failure was detected; inspect for other unambiguous OCR Markdown structure defects.";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await client.responses.create({
        model: PDF_REPAIR_MODEL,
        instructions: prompt,
        input: [
          `PROMPT_VERSION: ${PDF_REPAIR_PROMPT_VERSION}`,
          `ATTEMPT: ${attempt} of ${MAX_ATTEMPTS}`,
          `PAGE_NUMBER: ${input.pageNumber}`,
          `SOURCE_SHA256: ${input.sourceSha256}`,
          `<VALIDATOR_FEEDBACK>\n${lastFailure}\n</VALIDATOR_FEEDBACK>`,
          `<PREVIOUS_PAGE_READ_ONLY>\n${input.previousMarkdown ?? ""}\n</PREVIOUS_PAGE_READ_ONLY>`,
          `<CURRENT_PAGE>\n${working}\n</CURRENT_PAGE>`,
          `<NEXT_PAGE_READ_ONLY>\n${input.nextMarkdown ?? ""}\n</NEXT_PAGE_READ_ONLY>`,
        ].join("\n\n"),
        reasoning: { effort: "low" },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: "pdf_markdown_repair",
            strict: true,
            schema: outputSchema(),
          },
        },
        store: false,
      }, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      usage = addTokenUsage(usage, tokenUsage(response));
      if (response.status !== "completed" || !response.output_text) {
        lastFailure = response.status === "incomplete"
          ? `The previous response stopped early: ${response.incomplete_details?.reason ?? "unknown reason"}`
          : "The previous response contained no usable output.";
        continue;
      }
      try {
        const parsed = JSON.parse(response.output_text) as RepairOutput;
        if (!Array.isArray(parsed.edits) || typeof parsed.summary !== "string") {
          throw new PdfRepairError("The repair model returned an invalid edit set");
        }
        const acceptedEdits = parsed.edits.filter((edit) => edit.confidence === "high");
        const candidate = applyExactRepairEdits(working, acceptedEdits);
        validateSemanticStability(input.markdown, candidate);
        editCount += acceptedEdits.length;
        summary = parsed.summary;
        try {
          validated = validateAndNormalizeRepair(input.markdown, candidate);
          working = validated.markdown;
          break;
        } catch (error) {
          working = normalizeMathDelimiters(candidate, true);
          feedback = katexDiagnostics(working);
          lastFailure = [
            `The previous edit set was applied but still failed validation: ${
              error instanceof Error ? error.message : String(error)
            }`,
            ...(feedback.length ? ["Remaining KaTeX failures:", ...feedback.map((item) => `- ${item}`)] : []),
            "Return a new exact edit set against the CURRENT_PAGE below, which includes accepted prior fixes.",
          ].join("\n");
        }
      } catch (error) {
        lastFailure = [
          `The previous edit set could not be applied safely: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "Every before value must be copied verbatim from CURRENT_PAGE, with the correct occurrence.",
        ].join("\n");
      }
    }
    if (!validated) {
      throw new PdfRepairError(`PDF repair remained invalid after ${MAX_ATTEMPTS} attempts: ${lastFailure}`);
    }
    await persistRepairFinished({
      ownerUserId: input.ownerUserId,
      generationId,
      credential,
      usage,
      status: "completed",
    });
    return {
      markdown: validated.markdown,
      changed: validated.markdown !== input.markdown,
      editCount,
      mathNodeCount: validated.mathNodeCount,
      summary,
      model: PDF_REPAIR_MODEL,
      promptVersion: PDF_REPAIR_PROMPT_VERSION,
    };
  } catch (error) {
    await persistRepairFinished({
      ownerUserId: input.ownerUserId,
      generationId,
      credential,
      usage,
      status: "failed",
      error: error instanceof Error ? error.message : "PDF repair failed",
    }).catch(() => undefined);
    if (reserved) {
      await releaseManagedGeneration(input.ownerUserId, generationId).catch(() => undefined);
    }
    throw error;
  }
}

export function pdfRepairHttpError(error: unknown): PdfRepairError {
  if (error instanceof PdfRepairError) return error;
  if (error instanceof ManagedUsageLimitError) {
    return new PdfRepairError(error.message, error.status, error.code);
  }
  return new PdfRepairError(error instanceof Error ? error.message : "PDF repair failed");
}
