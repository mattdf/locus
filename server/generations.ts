import type { Response } from "express";
import type { GenerationMetrics } from "../src/types.ts";
import { streamResponse, type RespondInput, type TokenUsage } from "./openai.ts";
import { calculateGenerationCost } from "./pricing.ts";

type GenerationStatus = "running" | "completed" | "stopped" | "failed";

type GenerationEvent =
  | { type: "snapshot"; content: string }
  | { type: "delta"; delta: string }
  | { type: "done"; generation: GenerationMetrics }
  | { type: "stopped"; generation: GenerationMetrics }
  | { type: "error"; error: string; generation: GenerationMetrics };

export interface GenerationJob {
  id: string;
  controller: AbortController;
  content: string;
  status: GenerationStatus;
  startedAt: number;
  provider: RespondInput["provider"];
  model: string;
  generation?: GenerationMetrics;
  error?: string;
  subscribers: Set<Response>;
}

const generations = new Map<string, GenerationJob>();
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;

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
  const event = terminalEvent(job);
  job.subscribers.forEach((response) => {
    if (event) writeEvent(response, event);
    if (!response.writableEnded) response.end();
  });
  job.subscribers.clear();

  const cleanup = setTimeout(() => {
    if (generations.get(job.id) === job) generations.delete(job.id);
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

export function getGeneration(id: string): GenerationJob | undefined {
  return generations.get(id);
}

export function createGeneration(id: string, input: RespondInput): GenerationJob {
  const existing = generations.get(id);
  if (existing) return existing;

  const job: GenerationJob = {
    id,
    controller: new AbortController(),
    content: "",
    status: "running",
    startedAt: Date.now(),
    provider: input.provider,
    model: input.model,
    subscribers: new Set(),
  };
  generations.set(id, job);
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
