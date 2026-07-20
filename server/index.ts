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
import {
  clearProviderApiKey,
  getProviderStatuses,
  listProviderModels,
  normalizeLocalBaseUrl,
  saveProviderApiKey,
} from "./providers.ts";
import { readState, writeState } from "./storage.ts";
import {
  compileMetaPost,
  MetaPostCompileError,
  metapostImageAvailable,
} from "./metapost.ts";
import { isProviderId } from "../src/lib/providers.ts";
import type {
  ContextNode,
  HighlightAnchor,
  ProviderId,
  ReasoningEffort,
  WorkspaceState,
} from "../src/types.ts";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const allowedReasoningEfforts = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

app.use(express.json({ limit: "100mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/metapost/status", async (_request, response) => {
  response.json({ available: await metapostImageAvailable() });
});

app.post("/api/metapost/compile", async (request, response, next) => {
  try {
    response.json(await compileMetaPost(request.body?.source));
  } catch (error) {
    if (error instanceof MetaPostCompileError) {
      if (error.status === 429) response.setHeader("Retry-After", "2");
      response.status(error.status).json({ error: error.message, log: error.log });
      return;
    }
    next(error);
  }
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

app.get("/api/providers", async (_request, response, next) => {
  try {
    response.json(await getProviderStatuses());
  } catch (error) {
    next(error);
  }
});

app.put("/api/providers/:provider/api-key", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    const apiKey = request.body?.apiKey;
    if (!isProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 5_000) {
      response.status(400).json({ error: "Enter an API key" });
      return;
    }
    response.json(await saveProviderApiKey(provider, apiKey));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/providers/:provider/api-key", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    if (!isProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    response.json(await clearProviderApiKey(provider));
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers/:provider/models", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    if (!isProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    if (provider === "openai") {
      response.status(400).json({ error: "OpenAI models are built into the model picker" });
      return;
    }
    const localBaseUrl =
      provider === "local"
        ? normalizeLocalBaseUrl(String(request.query.baseUrl ?? ""))
        : undefined;
    response.json({ models: await listProviderModels(provider, localBaseUrl) });
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
      provider?: ProviderId;
      localBaseUrl?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      customInstructions?: string;
      context?: ContextNode[];
      message?: string;
      anchor?: HighlightAnchor;
      purpose?: "chat" | "definition" | "visualization";
    };
    const provider = body.provider ?? "openai";
    const model = body.model?.trim() ?? "gpt-5.6-sol";
    const reasoningEffort = body.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh");
    const maxOutputTokens = body.maxOutputTokens ?? 50_000;
    if (!body.requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.requestId)) {
      response.status(400).json({ error: "A valid request ID is required" });
      return;
    }
    if (!isProviderId(provider)) {
      response.status(400).json({ error: "Unsupported provider" });
      return;
    }
    if (!model || model.length > 300 || /[\r\n]/.test(model)) {
      response.status(400).json({ error: "Enter a valid model ID" });
      return;
    }
    if (
      !allowedReasoningEfforts.has(reasoningEffort) ||
      (provider === "openai" && reasoningEffort === "max" && !model.startsWith("gpt-5.6"))
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
      provider,
      localBaseUrl:
        provider === "local"
          ? normalizeLocalBaseUrl(body.localBaseUrl ?? "")
          : undefined,
      model,
      context: body.context,
      message: body.message,
      reasoningEffort,
      maxOutputTokens,
      customInstructions: body.customInstructions ?? "",
      anchor: body.anchor,
      purpose: body.purpose === "visualization" ? "visualization" : body.purpose === "definition" ? "definition" : "chat",
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
