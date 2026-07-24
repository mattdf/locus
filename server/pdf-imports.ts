import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { isHosted } from "./config.ts";

const SERVICE_URL = (
  process.env.PDF2MARKDOWN_SERVICE_URL?.trim() ||
  (isHosted ? "" : "http://127.0.0.1:8091")
).replace(/\/+$/, "");
const API_TOKEN =
  process.env.PDF2MARKDOWN_API_TOKEN?.trim() ||
  (isHosted ? "" : "locus-local-pdf-api");
const ADMIN_TOKEN =
  process.env.PDF2MARKDOWN_ADMIN_TOKEN?.trim() ||
  (isHosted ? "" : "locus-local-pdf-admin");
const MAX_UPLOAD_BYTES =
  Math.max(1, Number(process.env.PDF2MARKDOWN_MAX_UPLOAD_MB ?? 100)) *
  1024 *
  1024;

export interface PdfImportReservation {
  job_id: string;
  chat_id: string;
  document_id: string;
  status: "queued";
  page_count: number;
}

export interface PdfImportJob {
  job_id: string;
  chat_id: string;
  document_id: string;
  status: "queued" | "running" | "completed" | "failed";
  reserved_pages: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface PdfUsageItem {
  user_id?: string;
  key_id?: string;
  label?: string;
  fingerprint?: string;
  monthly_page_cap: number | null;
  active?: boolean;
  pages_processed: number;
  quota_pages: number;
  estimated_pages: number;
  reserved_pages: number;
  api_calls: number;
}

export interface PdfUsageSummary {
  period: string;
  pages_processed: number;
  quota_pages: number;
  estimated_pages: number;
  reserved_pages: number;
  api_calls: number;
  users: PdfUsageItem[];
  api_keys: PdfUsageItem[];
}

export class PdfImportServiceError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function configured(): boolean {
  return Boolean(SERVICE_URL && API_TOKEN && ADMIN_TOKEN);
}

function userHeaders(ownerUserId: string): HeadersInit {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    "X-PDF2Markdown-User-ID": ownerUserId,
  };
}

function adminHeaders(): HeadersInit {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function errorDetail(response: globalThis.Response): Promise<string> {
  const payload = await response.json().catch(() => null) as
    | { detail?: string; error?: string }
    | null;
  return payload?.detail || payload?.error || `PDF service returned HTTP ${response.status}`;
}

async function checkedJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  if (!SERVICE_URL) throw new PdfImportServiceError("PDF importing is not configured", 503);
  let response: globalThis.Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new PdfImportServiceError(
      `Could not reach the PDF conversion service: ${
        error instanceof Error ? error.message : "connection failed"
      }`,
      503,
    );
  }
  if (!response.ok) {
    throw new PdfImportServiceError(await errorDetail(response), response.status);
  }
  return response.json() as Promise<T>;
}

export async function pdfImportAvailable(): Promise<boolean> {
  if (!configured()) return false;
  try {
    const response = await fetch(`${SERVICE_URL}/readyz`, {
      signal: AbortSignal.timeout(2_500),
      headers: { Accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function submitPdfImport(
  request: Request,
  ownerUserId: string,
  input: { filename: string; title?: string },
): Promise<PdfImportReservation> {
  if (!SERVICE_URL || !API_TOKEN) {
    throw new PdfImportServiceError("PDF importing is not configured", 503);
  }
  const contentLength = Number(request.header("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    throw new PdfImportServiceError(
      `PDF exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit`,
      413,
    );
  }
  const parameters = new URLSearchParams({ filename: input.filename });
  if (input.title?.trim()) parameters.set("title", input.title.trim());
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      ...userHeaders(ownerUserId),
      "Content-Type": "application/pdf",
      ...(request.header("Content-Length")
        ? { "Content-Length": request.header("Content-Length")! }
        : {}),
    },
    body: request as unknown as BodyInit,
    duplex: "half",
  };
  return checkedJson<PdfImportReservation>(
    `${SERVICE_URL}/v1/imports/pdf/raw?${parameters}`,
    init,
  );
}

export async function getPdfImport(
  ownerUserId: string,
  jobId: string,
): Promise<PdfImportJob> {
  return checkedJson<PdfImportJob>(
    `${SERVICE_URL}/v1/imports/${encodeURIComponent(jobId)}`,
    { headers: userHeaders(ownerUserId), cache: "no-store" },
  );
}

function safeAssetPath(collection: string, assetPath: string): string {
  if (!["assets", "assets-hq"].includes(collection)) {
    throw new PdfImportServiceError("PDF asset not found", 404);
  }
  const segments = assetPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new PdfImportServiceError("PDF asset not found", 404);
      }
      return encodeURIComponent(segment);
    });
  if (!segments.length) throw new PdfImportServiceError("PDF asset not found", 404);
  return `${collection}/${segments.join("/")}`;
}

function locusAssetUrl(
  documentId: string,
  collection: string,
  assetPath: string,
): string {
  const encodedPath = assetPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return (
    `/api/pdf-documents/${encodeURIComponent(documentId)}/assets/` +
    `${collection}/${encodedPath}`
  );
}

export async function getPdfMarkdown(
  ownerUserId: string,
  documentId: string,
): Promise<string> {
  if (!SERVICE_URL || !API_TOKEN) {
    throw new PdfImportServiceError("PDF importing is not configured", 503);
  }
  const response = await fetch(
    `${SERVICE_URL}/v1/documents/${encodeURIComponent(documentId)}/markdown?raw=true`,
    {
      headers: userHeaders(ownerUserId),
      cache: "no-store",
    },
  ).catch((error) => {
    throw new PdfImportServiceError(
      `Could not reach the PDF conversion service: ${
        error instanceof Error ? error.message : "connection failed"
      }`,
      503,
    );
  });
  if (!response.ok) {
    throw new PdfImportServiceError(await errorDetail(response), response.status);
  }
  const markdown = await response.text();
  return markdown
    .replace(
      /(\]\(|src=["'])(assets(?:-hq)?\/)([A-Za-z0-9._/-]+)/g,
      (_match, prefix: string, collectionPrefix: string, assetPath: string) => {
        const collection = collectionPrefix.slice(0, -1);
        return `${prefix}${locusAssetUrl(documentId, collection, assetPath)}`;
      },
    );
}

export async function proxyPdfDocument(
  ownerUserId: string,
  documentId: string,
  input: { kind: "source" } | { kind: "asset"; collection: string; assetPath: string },
  response: Response,
): Promise<void> {
  if (!SERVICE_URL || !API_TOKEN) {
    throw new PdfImportServiceError("PDF importing is not configured", 503);
  }
  const suffix =
    input.kind === "source"
      ? "source"
      : safeAssetPath(input.collection, input.assetPath);
  const upstream = await fetch(
    `${SERVICE_URL}/v1/documents/${encodeURIComponent(documentId)}/${suffix}`,
    {
      headers: userHeaders(ownerUserId),
      cache: "no-store",
    },
  ).catch((error) => {
    throw new PdfImportServiceError(
      `Could not reach the PDF conversion service: ${
        error instanceof Error ? error.message : "connection failed"
      }`,
      503,
    );
  });
  if (!upstream.ok) {
    throw new PdfImportServiceError(await errorDetail(upstream), upstream.status);
  }
  for (const header of ["content-type", "content-length", "content-disposition"]) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.setHeader(
    "Cache-Control",
    input.kind === "asset" ? "private, max-age=86400, immutable" : "private, no-store",
  );
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body as never);
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

export async function getPdfUsage(period: string): Promise<PdfUsageSummary> {
  if (!SERVICE_URL || !ADMIN_TOKEN) {
    throw new PdfImportServiceError("PDF importing is not configured", 503);
  }
  return checkedJson<PdfUsageSummary>(
    `${SERVICE_URL}/v1/admin/usage?period=${encodeURIComponent(period)}`,
    { headers: adminHeaders(), cache: "no-store" },
  );
}

export async function getAccountPdfUsage(
  ownerUserId: string,
  period: string,
): Promise<{ available: boolean; period: string; usage: PdfUsageItem | null }> {
  if (!configured()) return { available: false, period, usage: null };
  try {
    const summary = await getPdfUsage(period);
    return {
      available: true,
      period,
      usage: summary.users.find((item) => item.user_id === ownerUserId) ?? null,
    };
  } catch {
    return { available: false, period, usage: null };
  }
}

export async function setPdfUserCap(
  ownerUserId: string,
  monthlyPageCap: number | null,
): Promise<{ user_id: string; monthly_page_cap: number | null }> {
  return checkedJson(
    `${SERVICE_URL}/v1/admin/users/${encodeURIComponent(ownerUserId)}/limits`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_page_cap: monthlyPageCap }),
    },
  );
}

export async function setPdfKeyCap(
  keyId: string,
  monthlyPageCap: number | null,
): Promise<{ key_id: string; monthly_page_cap: number | null }> {
  return checkedJson(
    `${SERVICE_URL}/v1/admin/api-keys/${encodeURIComponent(keyId)}/limits`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_page_cap: monthlyPageCap }),
    },
  );
}
