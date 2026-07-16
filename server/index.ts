import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { getApiKeyStatus, saveApiKey, streamResponse } from "./openai.ts";
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

app.post("/api/respond", async (request, response, next) => {
  try {
    const body = request.body as {
      model?: string;
      reasoningEffort?: ReasoningEffort;
      customInstructions?: string;
      context?: ContextNode[];
      message?: string;
      anchor?: HighlightAnchor;
    };
    const model = body.model ?? "gpt-5.6-sol";
    const reasoningEffort = body.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh");
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

    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.flushHeaders();

    try {
      await streamResponse({
        model,
        context: body.context,
        message: body.message,
        reasoningEffort,
        customInstructions: body.customInstructions ?? "",
        anchor: body.anchor,
      }, (delta) => {
        response.write(`${JSON.stringify({ type: "delta", delta })}\n`);
      });
      response.write(`${JSON.stringify({ type: "done" })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The model request failed";
      response.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    } finally {
      response.end();
    }
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
