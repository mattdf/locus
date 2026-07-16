import type { Response } from "express";
import { streamResponse, type RespondInput } from "./openai.ts";

type GenerationStatus = "running" | "completed" | "stopped" | "failed";

type GenerationEvent =
  | { type: "snapshot"; content: string }
  | { type: "delta"; delta: string }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; error: string };

export interface GenerationJob {
  id: string;
  controller: AbortController;
  content: string;
  status: GenerationStatus;
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
  if (job.status === "completed") return { type: "done" };
  if (job.status === "stopped") return { type: "stopped" };
  if (job.status === "failed") {
    return { type: "error", error: job.error ?? "The model request failed" };
  }
  return null;
}

function broadcast(job: GenerationJob, event: GenerationEvent): void {
  job.subscribers.forEach((response) => writeEvent(response, event));
}

function finish(job: GenerationJob, status: Exclude<GenerationStatus, "running">, error?: string): void {
  if (job.status !== "running") return;
  job.status = status;
  job.error = error;
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
    await streamResponse(
      input,
      (delta) => {
        if (job.status !== "running") return;
        job.content += delta;
        broadcast(job, { type: "delta", delta });
      },
      job.controller.signal,
    );
    finish(job, "completed");
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

export function abortGeneration(job: GenerationJob): boolean {
  if (job.status !== "running") return false;
  job.controller.abort();
  finish(job, "stopped");
  return true;
}
