import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "./auth.ts";
import { adminRouter } from "./admin-routes.ts";
import { adminAccessRouter } from "./admin-access-routes.ts";
import { accessRouter } from "./access-routes.ts";
import { getAccessPolicy } from "./access.ts";
import {
  publicSharesRouter,
  readPublicShareMetadata,
  sharesRouter,
} from "./shares.ts";
import { sharedPageHtml } from "./social-meta.ts";
import { closePool, getPool, query } from "./db.ts";
import { isHosted, locusMode, publicOrigin } from "./config.ts";
import {
  abortGeneration,
  attachGenerationStream,
  createGeneration,
  GenerationLimitError,
  getGeneration,
  abortOwnerGenerations,
} from "./generations.ts";
import {
  authorizeManagedGeneration,
  clearManagedUsageReservations,
  ManagedUsageLimitError,
  releaseManagedGeneration,
} from "./managed-usage.ts";
import {
  clearCredential,
  credentialStatuses,
  resolveCredential,
  saveCredential,
} from "./credentials.ts";
import {
  compileMetaPost,
  MetaPostCompileError,
  metapostImageAvailable,
} from "./metapost.ts";
import { compileTikz, TikzCompileError, tikzImageAvailable } from "./tikz.ts";
import { assertMigrationsCurrent } from "./migrate.ts";
import { listProviderModels } from "./providers.ts";
import {
  createCustomProvider,
  deleteCustomProvider,
  listProviderConnections,
  resolveProviderConnection,
  updateCustomProvider,
} from "./provider-connections.ts";
import { readState, writeState } from "./storage.ts";
import {
  readHostedWorkspace,
  syncHostedWorkspace,
  WorkspaceConflictError,
  type WorkspaceSyncInput,
} from "./workspaces.ts";
import { accountUsage } from "./usage.ts";
import {
  getAccountPdfUsage,
  getPdfImport,
  getPdfMarkdown,
  pdfImportAvailable,
  PdfImportServiceError,
  proxyPdfDocument,
  submitPdfImport,
} from "./pdf-imports.ts";
import { isBuiltInProviderId } from "../src/lib/providers.ts";
import type {
  ContextNode,
  HighlightAnchor,
  ReasoningEffort,
  WorkspaceState,
} from "../src/types.ts";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? (isHosted ? "0.0.0.0" : "127.0.0.1");
const LOCAL_OWNER = "local";
const trustedHostname = publicOrigin ? new URL(publicOrigin).hostname : null;
const allowedReasoningEfforts = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type AuthUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
};

app.disable("x-powered-by");
if (isHosted) app.set("trust proxy", 1);

app.use((request, response, next) => {
  const requestId = request.header("X-Request-ID")?.slice(0, 128) || randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-ID", requestId);
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isHosted ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: isHosted
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: "no-referrer" },
}));

app.use("/share", (_request, response, next) => {
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/ready", async (_request, response) => {
  try {
    if (isHosted) {
      await getPool().query("select 1");
      await assertMigrationsCurrent();
    }
    if (!(await metapostImageAvailable())) throw new Error("Compiler unavailable");
    response.json({ ok: true });
  } catch {
    response.status(503).json({ ok: false });
  }
});

app.get("/api/runtime", async (request, response, next) => {
  try {
    if (!isHosted || !auth) {
      response.json({ mode: "local", authenticated: true, localProviderEnabled: true });
      return;
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    const policy = await getAccessPolicy();
    const suspended = Boolean(session?.user?.banned);
    if (suspended && session?.user) {
      await query(`delete from "session" where "userId" = $1`, [session.user.id]);
      abortOwnerGenerations(session.user.id);
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({
      mode: "hosted",
      authenticated: Boolean(session?.user) && !suspended,
      suspended,
      signupMode: policy.signupMode,
      localProviderEnabled: false,
      user: session?.user && !suspended
        ? { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

if (isHosted && auth) {
  app.all("/api/auth/*splat", toNodeHandler(auth));
}

app.use(express.json({ limit: isHosted ? "32mb" : "100mb" }));
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: isHosted ? 300 : 10_000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (request) => request.path === "/health" || request.path === "/ready",
}));

if (isHosted) {
  app.use((request, response, next) => {
    if (!request.path.startsWith("/api/") || request.path === "/api/health" || request.path === "/api/ready") {
      next();
      return;
    }
    if (trustedHostname && request.hostname !== trustedHostname) {
      response.status(421).json({ error: "Misdirected request" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.header("Origin");
      if (origin !== publicOrigin) {
        response.status(403).json({ error: "Untrusted request origin" });
        return;
      }
    }
    next();
  });
}

app.use("/api/access", accessRouter);

function matchesBootstrapToken(candidate: unknown): boolean {
  const expected = process.env.LOCUS_BOOTSTRAP_TOKEN?.trim();
  if (!expected || typeof candidate !== "string" || candidate.length > 512) return false;
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

app.post("/api/setup/bootstrap", async (request, response, next) => {
  try {
    if (!isHosted || !auth || !matchesBootstrapToken(request.body?.token)) {
      response.status(404).json({ error: "Not found" });
      return;
    }
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !name || name.length > 200 ||
      password.length < 12 || password.length > 128
    ) {
      response.status(400).json({ error: "Invalid initial account" });
      return;
    }
    const users = await query<{ count: string }>(`select count(*)::text as "count" from "user"`);
    if (Number(users.rows[0]?.count ?? 0) !== 0) {
      response.status(409).json({ error: "Locus has already been initialized" });
      return;
    }
    const created = await auth.api.createUser({
      body: {
        email,
        name,
        password,
        role: "admin",
        data: { emailVerified: true },
      },
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({ created: true, email: created.user.email });
  } catch (error) {
    next(error);
  }
});

// Capability URLs are intentionally readable without a Locus session. They
// expose only immutable, server-created snapshots and cannot be enumerated.
app.use("/api/public/shares", publicSharesRouter);

app.use("/api", async (request, response, next) => {
  if (
    ["/health", "/ready", "/runtime", "/setup/bootstrap"].includes(request.path) ||
    request.path.startsWith("/auth/") ||
    request.path.startsWith("/access/")
  ) {
    next();
    return;
  }
  if (!isHosted || !auth) {
    response.locals.ownerUserId = LOCAL_OWNER;
    next();
    return;
  }
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session?.user) {
      response.status(401).json({ error: "Sign in required" });
      return;
    }
    const account = await query<{ suspended: boolean }>(
      `select coalesce("banned", false) as "suspended" from "user" where "id" = $1`,
      [session.user.id],
    );
    if (account.rows[0]?.suspended) {
      await query(`delete from "session" where "userId" = $1`, [session.user.id]);
      abortOwnerGenerations(session.user.id);
      response.status(403).json({ error: "This account is suspended", code: "ACCOUNT_SUSPENDED" });
      return;
    }
    response.locals.ownerUserId = session.user.id;
    response.locals.user = session.user satisfies AuthUser;
    next();
  } catch (error) {
    next(error);
  }
});

function owner(response: express.Response): string {
  return String(response.locals.ownerUserId || LOCAL_OWNER);
}

app.use("/api/admin", adminRouter);
app.use("/api/admin/access", adminAccessRouter);
app.use("/api/shares", sharesRouter);

app.get("/api/usage", async (request, response, next) => {
  try {
    if (!isHosted) {
      response.status(404).json({ error: "Account usage is available in hosted mode" });
      return;
    }
    const month = typeof request.query.month === "string" ? request.query.month : undefined;
    const usage = await accountUsage(owner(response), month);
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ...usage,
      pdf: await getAccountPdfUsage(
        owner(response),
        usage.selectedMonth,
      ),
    });
  } catch (error) {
    if (error instanceof Error && /valid month/i.test(error.message)) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/pdf-imports/status", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ available: await pdfImportAvailable() });
});

app.post("/api/pdf-imports", async (request, response, next) => {
  try {
    if (request.is("application/pdf") !== "application/pdf") {
      response.status(415).json({ error: "Upload a PDF file" });
      return;
    }
    const filename =
      typeof request.query.filename === "string"
        ? request.query.filename.trim()
        : "";
    const title =
      typeof request.query.title === "string"
        ? request.query.title.trim()
        : undefined;
    if (!filename || filename.length > 255 || /[/\\\0\r\n]/.test(filename)) {
      response.status(400).json({ error: "Enter a valid PDF filename" });
      return;
    }
    if (title && title.length > 200) {
      response.status(400).json({ error: "PDF title is too long" });
      return;
    }
    const imported = await submitPdfImport(
      request,
      owner(response),
      { filename, title },
    );
    response.status(202).json({
      job_id: imported.job_id,
      chat_id: imported.chat_id,
      document_id: imported.document_id,
      status: imported.status,
      page_count: imported.page_count,
    });
  } catch (error) {
    if (error instanceof PdfImportServiceError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/pdf-imports/:jobId", async (request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await getPdfImport(owner(response), request.params.jobId));
  } catch (error) {
    if (error instanceof PdfImportServiceError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/pdf-documents/:documentId/markdown", async (request, response, next) => {
  try {
    response.setHeader("Cache-Control", "private, no-store");
    response.type("text/markdown").send(
      await getPdfMarkdown(owner(response), request.params.documentId),
    );
  } catch (error) {
    if (error instanceof PdfImportServiceError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/pdf-documents/:documentId/source", async (request, response, next) => {
  try {
    await proxyPdfDocument(
      owner(response),
      request.params.documentId,
      { kind: "source" },
      response,
    );
  } catch (error) {
    if (error instanceof PdfImportServiceError && !response.headersSent) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get(
  "/api/pdf-documents/:documentId/assets/:collection/*assetPath",
  async (request, response, next) => {
    try {
      const parameter = request.params.assetPath;
      const assetPath = Array.isArray(parameter)
        ? parameter.join("/")
        : String(parameter ?? "");
      await proxyPdfDocument(
        owner(response),
        request.params.documentId,
        {
          kind: "asset",
          collection: request.params.collection,
          assetPath,
        },
        response,
      );
    } catch (error) {
      if (error instanceof PdfImportServiceError && !response.headersSent) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

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

app.get("/api/tikz/status", async (_request, response) => {
  response.json({ available: await tikzImageAvailable() });
});

app.post("/api/tikz/compile", async (request, response, next) => {
  try {
    response.json(await compileTikz(request.body?.source));
  } catch (error) {
    if (error instanceof TikzCompileError) {
      if (error.status === 429) response.setHeader("Retry-After", "2");
      response.status(error.status).json({ error: error.message, log: error.log });
      return;
    }
    next(error);
  }
});

app.get("/api/api-key", async (_request, response, next) => {
  try {
    response.json((await credentialStatuses(owner(response))).openai);
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
    response.json(await saveCredential(owner(response), "openai", apiKey));
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers", async (_request, response, next) => {
  try {
    response.json(await credentialStatuses(owner(response)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/provider-connections", async (_request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json({ providers: await listProviderConnections(owner(response)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/provider-connections", async (request, response, next) => {
  try {
    const provider = await createCustomProvider({
      ownerUserId: owner(response),
      label: typeof request.body?.label === "string" ? request.body.label : "",
      baseUrl: typeof request.body?.baseUrl === "string" ? request.body.baseUrl : "",
      apiKey: typeof request.body?.apiKey === "string" ? request.body.apiKey : undefined,
    });
    response.status(201).json({ provider });
  } catch (error) {
    if (error instanceof Error) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.patch("/api/provider-connections/:providerId", async (request, response, next) => {
  try {
    const provider = await updateCustomProvider({
      ownerUserId: owner(response),
      id: request.params.providerId,
      label: typeof request.body?.label === "string" ? request.body.label : "",
      baseUrl: typeof request.body?.baseUrl === "string" ? request.body.baseUrl : "",
      ...(request.body && Object.hasOwn(request.body, "apiKey")
        ? { apiKey: typeof request.body.apiKey === "string" ? request.body.apiKey : null }
        : {}),
    });
    if (!provider) {
      response.status(404).json({ error: "Custom provider not found" });
      return;
    }
    response.json({ provider });
  } catch (error) {
    if (error instanceof Error) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.delete("/api/provider-connections/:providerId", async (request, response, next) => {
  try {
    if (!await deleteCustomProvider(owner(response), request.params.providerId)) {
      response.status(404).json({ error: "Custom provider not found" });
      return;
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/provider-connections/:providerId/models", async (request, response, next) => {
  try {
    const provider = await resolveProviderConnection(owner(response), request.params.providerId);
    if (!provider) {
      response.status(404).json({ error: "Provider not found" });
      return;
    }
    if (provider.kind === "openai") {
      response.status(400).json({ error: "OpenAI models are built into the model picker" });
      return;
    }
    response.json({
      models: await listProviderModels(provider.kind, provider.baseUrl, provider.apiKey),
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/providers/:provider/api-key", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    const apiKey = request.body?.apiKey;
    if (!isBuiltInProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 5_000) {
      response.status(400).json({ error: "Enter an API key" });
      return;
    }
    response.json(await saveCredential(owner(response), provider, apiKey));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/providers/:provider/api-key", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    if (!isBuiltInProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    response.json(await clearCredential(owner(response), provider));
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers/:provider/models", async (request, response, next) => {
  try {
    const provider = request.params.provider;
    if (!isBuiltInProviderId(provider)) {
      response.status(404).json({ error: "Unknown provider" });
      return;
    }
    if (provider === "openai") {
      response.status(400).json({ error: "OpenAI models are built into the model picker" });
      return;
    }
    const credential = await resolveCredential(owner(response), provider);
    response.json({ models: await listProviderModels(provider, undefined, credential ?? undefined) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (_request, response, next) => {
  try {
    if (isHosted) {
      response.status(404).json({ error: "Use the hosted workspace endpoint" });
      return;
    }
    response.json(await readState());
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", async (request, response, next) => {
  try {
    if (isHosted) {
      response.status(404).json({ error: "Use the hosted workspace endpoint" });
      return;
    }
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

app.get("/api/workspace", async (_request, response, next) => {
  try {
    if (!isHosted) {
      response.status(404).json({ error: "Hosted workspace storage is disabled" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json(await readHostedWorkspace(owner(response)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspace/sync", async (request, response, next) => {
  try {
    if (!isHosted) {
      response.status(404).json({ error: "Hosted workspace storage is disabled" });
      return;
    }
    const revision = await syncHostedWorkspace(owner(response), request.body as WorkspaceSyncInput);
    response.json({ revision });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      response.status(409).json({ error: error.message, revision: error.currentRevision });
      return;
    }
    next(error);
  }
});

app.get("/api/respond/:requestId/stream", (request, response) => {
  const job = getGeneration(owner(response), request.params.requestId);
  if (!job) {
    response.status(404).json({ error: "This response is no longer available" });
    return;
  }
  attachGenerationStream(response, job);
});

app.post("/api/respond/:requestId/abort", (request, response) => {
  const job = getGeneration(owner(response), request.params.requestId);
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

app.post("/api/respond", async (request, response, next) => {
  try {
    const body = request.body as {
      requestId?: string;
      provider?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      customInstructions?: string;
      context?: ContextNode[];
      message?: string;
      anchor?: HighlightAnchor;
      purpose?: "chat" | "definition" | "visualization" | "rewrite";
      visualizationEngine?: "metapost" | "tikz";
    };
    const provider = body.provider ?? "openai";
    const model = body.model?.trim() ?? "gpt-5.6-sol";
    const reasoningEffort = body.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh");
    const maxOutputTokens = body.maxOutputTokens ?? 50_000;
    if (!body.requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.requestId)) {
      response.status(400).json({ error: "A valid request ID is required" });
      return;
    }
    if (typeof provider !== "string" || provider.length > 200) {
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

    const ownerUserId = owner(response);
    const existingJob = getGeneration(ownerUserId, body.requestId);
    if (existingJob) {
      attachGenerationStream(response, existingJob);
      return;
    }
    const connection = await resolveProviderConnection(ownerUserId, provider);
    if (!connection) {
      response.status(400).json({ error: "The selected provider no longer exists" });
      return;
    }
    if (!connection.apiKey && connection.kind !== "custom") {
      response.status(400).json({ error: `Add an API key for ${connection.label} in Providers` });
      return;
    }
    if (connection.managedCredentialId) {
      await authorizeManagedGeneration({
        ownerUserId,
        generationId: body.requestId,
        managedCredentialId: connection.managedCredentialId,
        provider: connection.kind,
        model,
      });
    }
    let job: ReturnType<typeof createGeneration>;
    try {
      job = createGeneration(
        ownerUserId,
        body.requestId,
        {
          provider: connection.kind,
          providerLabel: connection.label,
          baseUrl: connection.baseUrl,
          model,
          context: body.context,
          message: body.message,
          reasoningEffort,
          maxOutputTokens,
          customInstructions: body.customInstructions ?? "",
          anchor: body.anchor,
          purpose:
            body.purpose === "visualization"
              ? "visualization"
              : body.purpose === "definition"
                ? "definition"
                : body.purpose === "rewrite"
                  ? "rewrite"
                  : "chat",
          visualizationEngine:
            body.purpose === "visualization" && body.visualizationEngine === "tikz"
              ? "tikz"
              : "metapost",
          apiKey: connection.apiKey,
        },
        {
          ...(connection.managedCredentialId
            ? { managedCredentialId: connection.managedCredentialId }
            : {}),
          credentialKind: connection.credentialKind ?? "provider",
          credentialRef:
            connection.credentialRef ?? `provider:${connection.id}`,
          credentialLabel: connection.credentialLabel ?? connection.label,
        },
      );
    } catch (error) {
      if (connection.managedCredentialId) {
        await releaseManagedGeneration(ownerUserId, body.requestId).catch(() => undefined);
      }
      throw error;
    }
    attachGenerationStream(response, job);
  } catch (error) {
    if (error instanceof GenerationLimitError) {
      response.status(429).json({ error: error.message });
      return;
    }
    if (error instanceof ManagedUsageLimitError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  }
});

const dist = path.resolve("dist");
if (existsSync(dist)) {
  const applicationDocument = readFileSync(path.join(dist, "index.html"), "utf8");
  app.get("/service-worker.js", (_request, response) => {
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.setHeader("Service-Worker-Allowed", "/");
    response.sendFile(path.join(dist, "service-worker.js"));
  });
  app.use(express.static(dist, { index: false, maxAge: isHosted ? "1h" : 0 }));
  const sendApplication = (_request: express.Request, response: express.Response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(path.join(dist, "index.html"));
  };
  app.get("/", sendApplication);
  app.get("/share/:token", async (request, response, next) => {
    try {
      const metadata = await readPublicShareMetadata(request.params.token);
      if (!metadata) {
        response.status(404);
        sendApplication(request, response);
        return;
      }
      const origin = publicOrigin ?? `${request.protocol}://${request.get("host")}`;
      const url = new URL(`/share/${request.params.token}`, origin).toString();
      response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
      response.type("html").send(sharedPageHtml(applicationDocument, { ...metadata, url }));
    } catch (error) {
      next(error);
    }
  });
  app.get("/*splat", sendApplication);
}

app.use((
  error: unknown,
  _request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  const requestId = String(response.locals.requestId ?? "unknown");
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (isHosted) console.error(`[${requestId}] ${message}`);
  else console.error(error);
  response.status(500).json({ error: isHosted ? "Unexpected server error" : message, requestId });
});

async function start(): Promise<void> {
  if (isHosted) {
    await assertMigrationsCurrent();
    await clearManagedUsageReservations();
    await query(
      `update "locus_generation_jobs"
       set "status" = 'failed', "errorCode" = 'server_restart',
           "finishedAt" = current_timestamp, "updatedAt" = current_timestamp
       where "status" = 'running'`,
    );
  }
  const server = app.listen(PORT, HOST, () => {
    console.log(`Locus ${locusMode} server listening on http://${HOST}:${PORT}`);
  });
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; stopping new requests`);
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void start().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
