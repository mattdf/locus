import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  abortGeneration,
  attachGenerationStream,
  createGeneration,
  getGeneration,
} from "./generations.ts";
import { getApiKeyStatus, saveApiKey } from "./openai.ts";
import { readState, writeState } from "./storage.ts";
import type {
  ContextNode,
  HighlightAnchor,
  ReasoningEffort,
  WorkspaceState,
} from "../src/types.ts";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const allowedModels = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.4",
  "gpt-5.4-mini",
]);
const allowedReasoningEfforts = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

app.use(express.json({ limit: "3mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/api-key", async (_request, response, next) => {
  try {
    response.json(await getApiKeyStatus());
  } catch (error) {
    next(error);
  }
});

app.put("/api/api-key", async (request, response, next) => {
  try {
    const apiKey = request.body?.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length < 20 || apiKey.length > 5_000) {
      response.status(400).json({ error: "Enter a valid OpenAI API key." });
      return;
    }
    response.json(await saveApiKey(apiKey));
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (_request, response, next) => {
  try {
    response.json(await readState());
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", async (request, response, next) => {
  try {
    const state = request.body as WorkspaceState;
    if (state?.version !== 1 || !Array.isArray(state.chats)) {
      response.status(400).json({ error: "Invalid workspace state" });
      return;
    }
    await writeState(state);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/respond/:requestId/stream", (request, response) => {
  const job = getGeneration(request.params.requestId);
  if (!job) {
    response.status(404).json({ error: "This response is no longer available" });
    return;
  }
  attachGenerationStream(response, job);
});

app.post("/api/respond/:requestId/abort", (request, response) => {
  const job = getGeneration(request.params.requestId);
  if (!job) {
    response.status(404).json({ error: "This response is no longer available" });
    return;
  }
  const generation = abortGeneration(job);
  if (!generation) {
    response.status(409).json({ error: `The response is already ${job.status}` });
    return;
  }
  response.json({ stopped: true, generation });
});

app.post("/api/respond", (request, response, next) => {
  try {
    const body = request.body as {
      requestId?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      customInstructions?: string;
      context?: ContextNode[];
      message?: string;
      anchor?: HighlightAnchor;
    };
    const model = body.model ?? "gpt-5.6-sol";
    const reasoningEffort = body.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh");
    const maxOutputTokens = body.maxOutputTokens ?? 50_000;
    if (!body.requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.requestId)) {
      response.status(400).json({ error: "A valid request ID is required" });
      return;
    }
    if (!allowedModels.has(model)) {
      response.status(400).json({ error: "Unsupported model" });
      return;
    }
    if (
      !allowedReasoningEfforts.has(reasoningEffort) ||
      (reasoningEffort === "max" && !model.startsWith("gpt-5.6"))
    ) {
      response.status(400).json({ error: "Unsupported reasoning effort for this model" });
      return;
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0) {
      response.status(400).json({ error: "The output-token limit must be a non-negative integer" });
      return;
    }
    if (!Array.isArray(body.context) || !body.message?.trim()) {
      response.status(400).json({ error: "Context and message are required" });
      return;
    }
    const totalCharacters = JSON.stringify(body.context).length + body.message.length;
    if (totalCharacters > 800_000) {
      response.status(413).json({ error: "This context is too large for one request" });
      return;
    }
    if ((body.customInstructions?.length ?? 0) > 30_000) {
      response.status(413).json({ error: "Custom instructions are too large" });
      return;
    }

    const job = createGeneration(body.requestId, {
      model,
      context: body.context,
      message: body.message,
      reasoningEffort,
      maxOutputTokens,
      customInstructions: body.customInstructions ?? "",
      anchor: body.anchor,
    });
    attachGenerationStream(response, job);
  } catch (error) {
    next(error);
  }
});

const dist = path.resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/*splat", (_request, response) => {
    response.sendFile(path.join(dist, "index.html"));
  });
}

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error(error);
    response.status(500).json({ error: message });
  },
);

app.listen(PORT, HOST, () => {
  console.log(`Locus API listening on http://${HOST}:${PORT}`);
});
