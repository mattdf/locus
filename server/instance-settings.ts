import { isHosted } from "./config.ts";
import { query } from "./db.ts";

export const DEFAULT_PDF_REPAIR_MODEL =
  process.env.PDF_REPAIR_MODEL?.trim() || "gpt-5.4-mini";

export interface PdfRepairInstanceSettings {
  model: string;
  fallbackModel: string;
  overridden: boolean;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const CACHE_TTL_MS = 5_000;

let cachedSettings: PdfRepairInstanceSettings | null = null;
let cacheExpiresAt = 0;

export function normalizePdfRepairModel(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("The PDF formatting model must be a model ID or null");
  }
  const model = value.trim();
  if (!model || model.length > 200 || !MODEL_ID_PATTERN.test(model)) {
    throw new Error(
      "Enter a valid OpenAI model ID using letters, numbers, dots, dashes, underscores, slashes, or colons",
    );
  }
  return model;
}

function resolvedSettings(override: string | null): PdfRepairInstanceSettings {
  return {
    model: override || DEFAULT_PDF_REPAIR_MODEL,
    fallbackModel: DEFAULT_PDF_REPAIR_MODEL,
    overridden: Boolean(override),
  };
}

export async function getPdfRepairInstanceSettings(): Promise<PdfRepairInstanceSettings> {
  if (!isHosted) return resolvedSettings(null);
  if (cachedSettings && cacheExpiresAt > Date.now()) return cachedSettings;
  const result = await query<{ pdfRepairModel: string | null }>(
    `select "pdfRepairModel" from "locus_instance_settings" where "id" = true`,
  );
  cachedSettings = resolvedSettings(result.rows[0]?.pdfRepairModel ?? null);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedSettings;
}

export async function updatePdfRepairInstanceSettings(
  modelValue: unknown,
  administratorUserId: string,
): Promise<PdfRepairInstanceSettings> {
  const model = normalizePdfRepairModel(modelValue);
  await query(
    `insert into "locus_instance_settings"
       ("id", "publicSignupEnabled", "pdfRepairModel", "updatedByUserId", "updatedAt")
     values (true, true, $1, $2, current_timestamp)
     on conflict ("id") do update set
       "pdfRepairModel" = excluded."pdfRepairModel",
       "updatedByUserId" = excluded."updatedByUserId",
       "updatedAt" = current_timestamp`,
    [model, administratorUserId],
  );
  cachedSettings = resolvedSettings(model);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedSettings;
}
