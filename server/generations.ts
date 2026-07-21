import type { Response } from "express";
import type { GenerationMetrics } from "../src/types.ts";
import { streamResponse, type RespondInput, type TokenUsage } from "./openai.ts";
import { calculateGenerationCost } from "./pricing.ts";
import { isHosted } from "./config.ts";
import { query } from "./db.ts";

type GenerationStatus = "running" | "completed" | "stopped" | "failed";

type GenerationEvent =
  | { type: "snapshot"; content: string }
  | { type: "delta"; delta: string }
  | { type: "done"; generation: GenerationMetrics }
  | { type: "stopped"; generation: GenerationMetrics }
  | { type: "error"; error: string; generation: GenerationMetrics };

export interface GenerationJob {
  id: string;
  ownerUserId: string;
  controller: AbortController;
  content: string;
  status: GenerationStatus;
  startedAt: number;
  provider: RespondInput["provider"];
  providerLabel?: string;
  model: string;
  generation?: GenerationMetrics;
  error?: string;
  subscribers: Set<Response>;
  lastCheckpointAt: number;
  persistenceReady: Promise<void>;
}

const generations = new Map<string, GenerationJob>();
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_GENERATIONS = Math.max(
  1,
  Number(process.env.LOCUS_MAX_CONCURRENT_GENERATIONS ?? 3),
);

export class GenerationLimitError extends Error {}

function generationKey(ownerUserId: string, id: string): string {
  return `${ownerUserId}:${id}`;
}

function persistStarted(job: GenerationJob, input: RespondInput): Promise<void> {
  if (!isHosted) return Promise.resolve();
  return query(
    `insert into "locus_generation_jobs"
       ("ownerUserId", "id", "provider", "model", "purpose", "status")
     values ($1, $2, $3, $4, $5, 'running')
     on conflict ("ownerUserId", "id") do nothing`,
    [job.ownerUserId, job.id, job.provider, job.model, input.purpose ?? "chat"],
  ).then(() => undefined).catch(() => undefined);
}

function persistCheckpoint(job: GenerationJob): void {
  if (!isHosted) return;
  const now = Date.now();
  if (now - job.lastCheckpointAt < 2_000) return;
  job.lastCheckpointAt = now;
  void job.persistenceReady.then(() =>
    query(
      `update "locus_generation_jobs"
       set "partialContent" = $3, "updatedAt" = current_timestamp
       where "ownerUserId" = $1 and "id" = $2 and "status" = 'running'`,
      [job.ownerUserId, job.id, job.content],
    ),
  ).catch(() => undefined);
}

function persistFinished(job: GenerationJob): void {
  if (!isHosted || !job.generation) return;
  const metrics = job.generation;
  void job.persistenceReady.then(() => query(
      `update "locus_generation_jobs"
       set "status" = $3, "partialContent" = $4, "metrics" = $5::jsonb,
           "errorCode" = $6, "updatedAt" = current_timestamp, "finishedAt" = current_timestamp
       where "ownerUserId" = $1 and "id" = $2`,
      [
        job.ownerUserId,
        job.id,
        job.status,
        job.content,
        JSON.stringify(metrics),
        job.status === "failed" ? "upstream_error" : null,
      ],
    )).then(() =>
    query(
      `insert into "locus_usage_events"
         ("ownerUserId", "generationId", "provider", "model", "inputTokens",
          "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "totalCostUsd")
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        job.ownerUserId,
        job.id,
        metrics.provider,
        metrics.model,
        metrics.inputTokens,
        metrics.cachedInputTokens,
        metrics.outputTokens,
        metrics.reasoningTokens,
        metrics.totalTokens,
        metrics.totalCostUsd,
      ],
    ),
  ).catch(() => undefined);
}

function writeEvent(response: Response, event: GenerationEvent): void {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(event)}\n`);
  }
}

function terminalEvent(job: GenerationJob): GenerationEvent | null {
  if (!job.generation) return null;
  if (job.status === "completed") return { type: "done", generation: job.generation };
  if (job.status === "stopped") return { type: "stopped", generation: job.generation };
  if (job.status === "failed") {
    return {
      type: "error",
      error: job.error ?? "The model request failed",
      generation: job.generation,
    };
  }
  return null;
}

function broadcast(job: GenerationJob, event: GenerationEvent): void {
  job.subscribers.forEach((response) => writeEvent(response, event));
}

function finish(
  job: GenerationJob,
  status: Exclude<GenerationStatus, "running">,
  error?: string,
  usage?: TokenUsage | null,
): void {
  if (job.status !== "running") return;
  job.status = status;
  job.error = error;
  const estimatedCost =
    job.provider === "openai" ? calculateGenerationCost(job.model, usage) : null;
  const reportedCost = usage?.costUsd;
  job.generation = {
    durationMs: Date.now() - job.startedAt,
    provider: job.provider,
    providerLabel: job.providerLabel,
    model: job.model,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    inputCostUsd: estimatedCost?.inputCostUsd ?? null,
    outputCostUsd: estimatedCost?.outputCostUsd ?? null,
    totalCostUsd: reportedCost ?? estimatedCost?.totalCostUsd ?? null,
  };
  persistFinished(job);
  const event = terminalEvent(job);
  job.subscribers.forEach((response) => {
    if (event) writeEvent(response, event);
    if (!response.writableEnded) response.end();
  });
  job.subscribers.clear();

  const cleanup = setTimeout(() => {
    const key = generationKey(job.ownerUserId, job.id);
    if (generations.get(key) === job) generations.delete(key);
  }, COMPLETED_JOB_TTL_MS);
  cleanup.unref();
}

async function run(job: GenerationJob, input: RespondInput): Promise<void> {
  try {
    const usage = await streamResponse(
      input,
      (delta) => {
        if (job.status !== "running") return;
        job.content += delta;
        persistCheckpoint(job);
        broadcast(job, { type: "delta", delta });
      },
      job.controller.signal,
    );
    finish(job, "completed", undefined, usage);
  } catch (error) {
    if (job.controller.signal.aborted) {
      finish(job, "stopped");
      return;
    }
    finish(
      job,
      "failed",
      error instanceof Error ? error.message : "The model request failed",
    );
  }
}

export function getGeneration(ownerUserId: string, id: string): GenerationJob | undefined {
  return generations.get(generationKey(ownerUserId, id));
}

export function createGeneration(ownerUserId: string, id: string, input: RespondInput): GenerationJob {
  const key = generationKey(ownerUserId, id);
  const existing = generations.get(key);
  if (existing) return existing;
  const running = [...generations.values()].filter(
    (job) => job.ownerUserId === ownerUserId && job.status === "running",
  ).length;
  if (running >= MAX_CONCURRENT_GENERATIONS) {
    throw new GenerationLimitError(
      `At most ${MAX_CONCURRENT_GENERATIONS} model responses may run at once`,
    );
  }

  const job: GenerationJob = {
    id,
    ownerUserId,
    controller: new AbortController(),
    content: "",
    status: "running",
    startedAt: Date.now(),
    provider: input.provider,
    providerLabel: input.providerLabel,
    model: input.model,
    subscribers: new Set(),
    lastCheckpointAt: Date.now(),
    persistenceReady: Promise.resolve(),
  };
  generations.set(key, job);
  job.persistenceReady = persistStarted(job, input);
  void run(job, input);
  return job;
}

export function attachGenerationStream(response: Response, job: GenerationJob): void {
  response.status(200);
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.flushHeaders();

  writeEvent(response, { type: "snapshot", content: job.content });
  const terminal = terminalEvent(job);
  if (terminal) {
    writeEvent(response, terminal);
    response.end();
    return;
  }

  job.subscribers.add(response);
  response.on("close", () => {
    job.subscribers.delete(response);
  });
}

export function abortGeneration(job: GenerationJob): GenerationMetrics | null {
  if (job.status !== "running") return null;
  job.controller.abort();
  finish(job, "stopped");
  return job.generation ?? null;
}

export function abortOwnerGenerations(ownerUserId: string): number {
  let stopped = 0;
  for (const job of generations.values()) {
    if (job.ownerUserId !== ownerUserId || job.status !== "running") continue;
    abortGeneration(job);
    stopped += 1;
  }
  return stopped;
}
