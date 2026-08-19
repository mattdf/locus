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
import {
  getPdfRepairInstanceSettings,
} from "./instance-settings.ts";

const PROMPT_FILE = path.resolve("PDF_REPAIR_PROMPT.md");
export const PDF_REPAIR_PROMPT_VERSION = "pdf-markdown-repair-v4";
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
const MAX_CONCURRENT_REPAIR_REQUESTS = Math.min(
  32,
  Math.max(1, Number(process.env.PDF_REPAIR_MAX_CONCURRENT_REQUESTS ?? 8)),
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

let activeRepairRequests = 0;
const repairSlotWaiters: Array<(release: () => void) => void> = [];

function releaseRepairSlot(): void {
  const next = repairSlotWaiters.shift();
  if (next) {
    next(releaseRepairSlot);
    return;
  }
  activeRepairRequests = Math.max(0, activeRepairRequests - 1);
}

function acquireRepairSlot(): Promise<() => void> {
  if (activeRepairRequests < MAX_CONCURRENT_REPAIR_REQUESTS) {
    activeRepairRequests += 1;
    return Promise.resolve(releaseRepairSlot);
  }
  return new Promise((resolve) => repairSlotWaiters.push(resolve));
}

export interface PdfRepairContextPage {
  pageNumber: number;
  markdown: string;
  layoutCandidates?: PdfRepairLayoutCandidate[];
}

export interface PdfRepairLayoutCandidate {
  content: string;
  type: string;
  align: "left" | "center" | "right";
  verticalRegion: "top" | "bottom";
  top: number;
  bottom: number;
}

interface RepairFurnitureCandidate {
  before: string;
  occurrence: number;
  kind: "header" | "footer";
  align: "left" | "center" | "right";
  row: number;
  row_index: number;
  row_size: number;
  confidence: "high" | "medium" | "low";
}

export interface PdfRunningFurnitureItem {
  content: string;
  align: "left" | "center" | "right";
  row: number;
  row_index: number;
  row_size: number;
  block_index: number;
}

export interface PdfRunningFurniture {
  headers: PdfRunningFurnitureItem[];
  footers: PdfRunningFurnitureItem[];
}

interface RepairOutput {
  edits: RepairEdit[];
  runningFurniture: RepairFurnitureCandidate[];
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
      runningFurniture: {
        type: "array",
        items: {
          type: "object",
          properties: {
            before: { type: "string" },
            occurrence: { type: "integer" },
            kind: { type: "string", enum: ["header", "footer"] },
            align: { type: "string", enum: ["left", "center", "right"] },
            row: { type: "integer" },
            row_index: { type: "integer" },
            row_size: { type: "integer" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: [
            "before",
            "occurrence",
            "kind",
            "align",
            "row",
            "row_index",
            "row_size",
            "confidence",
          ],
          additionalProperties: false,
        },
      },
      summary: { type: "string" },
    },
    required: ["edits", "runningFurniture", "summary"],
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

interface MarkdownBoundaryBlock {
  content: string;
  start: number;
  end: number;
}

function markdownBoundaryBlocks(source: string): MarkdownBoundaryBlock[] {
  const blocks: MarkdownBoundaryBlock[] = [];
  const expression = /(?:^|\n[ \t]*\n)([\s\S]*?)(?=\n[ \t]*\n|$)/g;
  for (const match of source.matchAll(expression)) {
    const raw = match[1] ?? "";
    const leading = raw.length - raw.trimStart().length;
    const content = raw.trim();
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(raw) + leading;
    blocks.push({ content, start, end: start + content.length });
  }
  return blocks;
}

function safeFurnitureBlock(content: string): boolean {
  if (!content || content.length > 500) return false;
  if (/```|~~~|!\[[^\]]*\]\(|<img\b|^\s*\|/im.test(content)) return false;
  if (/^\s*\$\$[\s\S]*\$\$\s*$/.test(content)) return false;
  return true;
}

function occurrenceAt(source: string, block: MarkdownBoundaryBlock): number {
  let occurrence = 0;
  let cursor = 0;
  while (cursor <= block.start) {
    const found = source.indexOf(block.content, cursor);
    if (found < 0 || found > block.start) break;
    occurrence += 1;
    if (found === block.start) return occurrence;
    cursor = found + Math.max(1, block.content.length);
  }
  return Math.max(1, occurrence);
}

function printedPageNumber(content: string): number | null {
  const match = /^(?:\*\*)?(\d{1,4})(?:\*\*)?$/.exec(content.trim());
  return match ? Number(match[1]) : null;
}

function plausibleRunningTitle(content: string): boolean {
  const normalized = content.replace(/[*_`#]/g, "").trim();
  if (!safeFurnitureBlock(content) || normalized.length < 3 || normalized.length > 180) {
    return false;
  }
  if (/\n|[.!?;:]$/.test(normalized)) return false;
  const words = normalized.split(/\s+/);
  return words.length >= 2 && words.length <= 20 && /\p{L}/u.test(normalized);
}

interface RunningHeaderPair {
  pageNumber: number;
  printedNumber: number;
  blocks: [MarkdownBoundaryBlock, MarkdownBoundaryBlock];
  title: string;
}

function runningHeaderPair(page: PdfRepairContextPage): RunningHeaderPair | null {
  const blocks = markdownBoundaryBlocks(page.markdown).slice(0, 2);
  if (blocks.length !== 2) return null;
  const numbers = blocks.map((block) => printedPageNumber(block.content));
  const numberIndex = numbers[0] !== null ? 0 : numbers[1] !== null ? 1 : -1;
  if (numberIndex < 0 || numbers[1 - numberIndex] !== null) return null;
  const title = blocks[1 - numberIndex].content;
  if (!plausibleRunningTitle(title)) return null;
  return {
    pageNumber: page.pageNumber,
    printedNumber: numbers[numberIndex]!,
    blocks: blocks as [MarkdownBoundaryBlock, MarkdownBoundaryBlock],
    title,
  };
}

export function inferRepeatedRunningFurniture(
  source: string,
  pageNumber: number,
  contextPages: PdfRepairContextPage[],
): RepairFurnitureCandidate[] {
  const pairs = contextPages
    .map(runningHeaderPair)
    .filter((pair): pair is RunningHeaderPair => pair !== null)
    .sort((left, right) => left.pageNumber - right.pageNumber);
  const current = pairs.find((pair) => pair.pageNumber === pageNumber);
  if (!current || pairs.length < 3) return [];

  const consecutive = pairs.every((pair, index) => {
    if (index === 0) return true;
    const previous = pairs[index - 1];
    return (
      pair.printedNumber - previous.printedNumber ===
      pair.pageNumber - previous.pageNumber
    );
  });
  if (!consecutive) return [];

  const titleCounts = new Map<string, number>();
  for (const pair of pairs) {
    const title = pair.title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  if (Math.max(...titleCounts.values()) < 2) return [];

  return current.blocks.map((block, index) => ({
    before: block.content,
    occurrence: occurrenceAt(source, block),
    kind: "header" as const,
    align: index === 0 ? "left" as const : "right" as const,
    row: 0,
    row_index: index,
    row_size: 2,
    confidence: "high" as const,
  }));
}

export function validateRunningFurniture(
  source: string,
  candidates: RepairFurnitureCandidate[],
): PdfRunningFurniture {
  const blocks = markdownBoundaryBlocks(source);
  const boundarySize = Math.min(4, blocks.length);
  const headers = new Set(blocks.slice(0, boundarySize).map((block) => block.start));
  const footers = new Set(blocks.slice(-boundarySize).map((block) => block.start));
  const accepted: Array<RepairFurnitureCandidate & { start: number; block_index: number }> = [];

  for (const candidate of candidates) {
    if (candidate.confidence !== "high" || !safeFurnitureBlock(candidate.before)) continue;
    if (
      !Number.isSafeInteger(candidate.occurrence) || candidate.occurrence < 1 ||
      !Number.isSafeInteger(candidate.row) || candidate.row < 0 || candidate.row > 8 ||
      !Number.isSafeInteger(candidate.row_index) || candidate.row_index < 0 ||
      !Number.isSafeInteger(candidate.row_size) || candidate.row_size < 1 ||
      candidate.row_size > 8 || candidate.row_index >= candidate.row_size
    ) continue;
    const start = nthOccurrence(source, candidate.before, candidate.occurrence);
    const block = blocks.find(
      (item) => item.start === start && item.content === candidate.before,
    );
    if (!block) continue;
    const allowed = candidate.kind === "header" ? headers : footers;
    if (!allowed.has(start)) continue;
    if (accepted.some((item) => item.start === start)) continue;
    accepted.push({ ...candidate, start, block_index: blocks.indexOf(block) });
  }

  const mapItem = (
    item: RepairFurnitureCandidate & { block_index: number },
  ): PdfRunningFurnitureItem => ({
    content: item.before,
    align: item.align,
    row: item.row,
    row_index: item.row_index,
    row_size: item.row_size,
    block_index: item.block_index,
  });
  return {
    headers: accepted
      .filter((item) => item.kind === "header")
      .sort((left, right) => left.start - right.start)
      .map(mapItem),
    footers: accepted
      .filter((item) => item.kind === "footer")
      .sort((left, right) => left.start - right.start)
      .map(mapItem),
  };
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
  model: string,
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
      model,
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
  model: string;
  error?: string;
}): Promise<void> {
  if (!isHosted) return;
  const cost = calculateGenerationCost("openai", input.model, input.usage);
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
          input.model,
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
  const [{ credential, policy }, settings] = await Promise.all([
    repairCredential(ownerUserId),
    getPdfRepairInstanceSettings(),
  ]);
  if (credential.source === "managed") enforceRepairCap(policy);
  return {
    available: true,
    source: credential.credentialKind === "managed" ? "managed" : "personal",
    model: settings.model,
  };
}

interface PdfRepairPageInput {
  ownerUserId: string;
  jobId: string;
  documentId: string;
  pageNumber: number;
  sourceSha256: string;
  markdown: string;
  previousMarkdown?: string;
  nextMarkdown?: string;
  contextPages?: PdfRepairContextPage[];
  layoutCandidates?: PdfRepairLayoutCandidate[];
}

interface PdfRepairPageResult {
  markdown: string;
  changed: boolean;
  editCount: number;
  mathNodeCount: number;
  summary: string;
  furniture: PdfRunningFurniture;
  model: string;
  promptVersion: string;
}

async function repairPdfMarkdownPageUnlocked(
  input: PdfRepairPageInput,
): Promise<PdfRepairPageResult> {
  const [{ credential, policy }, settings] = await Promise.all([
    repairCredential(input.ownerUserId),
    getPdfRepairInstanceSettings(),
  ]);
  const model = settings.model;
  if (credential.source === "managed") enforceRepairCap(policy);
  const generationId = `pdf-repair:${input.jobId}:${input.pageNumber}:${randomUUID()}`;
  let reserved = false;
  if (credential.managedCredentialId) {
    await authorizeManagedGeneration({
      ownerUserId: input.ownerUserId,
      generationId,
      managedCredentialId: credential.managedCredentialId,
      provider: "openai",
      model,
    });
    reserved = true;
  }
  let usage: TokenUsage | null = null;
  try {
    await persistRepairStarted(input.ownerUserId, generationId, credential, model);
    const prompt = (await readFile(PROMPT_FILE, "utf8")).trim();
    if (!prompt) throw new PdfRepairError("PDF_REPAIR_PROMPT.md is empty");
    const client = await createProviderClient("openai", undefined, credential.apiKey);
    let working = normalizeMathDelimiters(input.markdown, true);
    validateSemanticStability(input.markdown, working);
    let feedback = katexDiagnostics(working);
    let validated: { markdown: string; mathNodeCount: number } | null = null;
    let editCount = 0;
    let summary = "";
    let furniture: PdfRunningFurniture = { headers: [], footers: [] };
    let lastFailure = feedback.length
      ? `KaTeX validation failed:\n- ${feedback.join("\n- ")}`
      : "No parser failure was detected; inspect for other unambiguous OCR Markdown structure defects.";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await client.responses.create({
        model,
        instructions: prompt,
        input: [
          `PROMPT_VERSION: ${PDF_REPAIR_PROMPT_VERSION}`,
          `ATTEMPT: ${attempt} of ${MAX_ATTEMPTS}`,
          `PAGE_NUMBER: ${input.pageNumber}`,
          `SOURCE_SHA256: ${input.sourceSha256}`,
          `<VALIDATOR_FEEDBACK>\n${lastFailure}\n</VALIDATOR_FEEDBACK>`,
          `<FIVE_PAGE_CONTEXT_READ_ONLY>\n${(
            input.contextPages?.length
              ? input.contextPages
                  .filter((page) => page.pageNumber !== input.pageNumber)
                  .map((page) => [
                    `--- PDF PAGE ${page.pageNumber} ---`,
                    page.markdown,
                    page.layoutCandidates?.length
                      ? `LAYOUT CANDIDATES: ${JSON.stringify(page.layoutCandidates)}`
                      : "",
                  ].filter(Boolean).join("\n"))
                  .join("\n\n")
              : [
                  input.previousMarkdown
                    ? `--- PREVIOUS PDF PAGE ---\n${input.previousMarkdown}`
                    : "",
                  input.nextMarkdown
                    ? `--- NEXT PDF PAGE ---\n${input.nextMarkdown}`
                    : "",
                ].filter(Boolean).join("\n\n")
          )}\n</FIVE_PAGE_CONTEXT_READ_ONLY>`,
          `<CURRENT_PAGE_LAYOUT_CANDIDATES>\n${JSON.stringify(
            input.layoutCandidates ??
              input.contextPages?.find((page) => page.pageNumber === input.pageNumber)
                ?.layoutCandidates ??
              [],
          )}\n</CURRENT_PAGE_LAYOUT_CANDIDATES>`,
          `<CURRENT_PAGE>\n${working}\n</CURRENT_PAGE>`,
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
        if (
          !Array.isArray(parsed.edits) ||
          !Array.isArray(parsed.runningFurniture) ||
          typeof parsed.summary !== "string"
        ) {
          throw new PdfRepairError("The repair model returned an invalid edit set");
        }
        const acceptedEdits = parsed.edits.filter((edit) => edit.confidence === "high");
        const candidate = applyExactRepairEdits(working, acceptedEdits);
        validateSemanticStability(input.markdown, candidate);
        editCount += acceptedEdits.length;
        summary = parsed.summary;
        try {
          validated = validateAndNormalizeRepair(input.markdown, candidate);
          const repeatedFurniture = inferRepeatedRunningFurniture(
            validated.markdown,
            input.pageNumber,
            input.contextPages ?? [],
          );
          furniture = validateRunningFurniture(
            validated.markdown,
            // A consecutive printed-page sequence plus an alternating title
            // is stronger alignment evidence than a coordinate-free model
            // guess. Put that narrow deterministic result first; exact-block
            // deduplication still lets the model supply every other case.
            [...repeatedFurniture, ...parsed.runningFurniture],
          );
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
      model,
    });
    return {
      markdown: validated.markdown,
      changed: validated.markdown !== input.markdown,
      editCount,
      mathNodeCount: validated.mathNodeCount,
      summary,
      furniture,
      model,
      promptVersion: PDF_REPAIR_PROMPT_VERSION,
    };
  } catch (error) {
    await persistRepairFinished({
      ownerUserId: input.ownerUserId,
      generationId,
      credential,
      usage,
      status: "failed",
      model,
      error: error instanceof Error ? error.message : "PDF repair failed",
    }).catch(() => undefined);
    if (reserved) {
      await releaseManagedGeneration(input.ownerUserId, generationId).catch(() => undefined);
    }
    throw error;
  }
}

export async function repairPdfMarkdownPage(
  input: PdfRepairPageInput,
): Promise<PdfRepairPageResult> {
  const release = await acquireRepairSlot();
  try {
    return await repairPdfMarkdownPageUnlocked(input);
  } finally {
    release();
  }
}

export function pdfRepairHttpError(error: unknown): PdfRepairError {
  if (error instanceof PdfRepairError) return error;
  if (error instanceof ManagedUsageLimitError) {
    return new PdfRepairError(error.message, error.status, error.code);
  }
  return new PdfRepairError(error instanceof Error ? error.message : "PDF repair failed");
}
