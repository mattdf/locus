import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function readTrimmed(relativePath) {
  return (await readFile(path.resolve(projectRoot, relativePath), "utf8")).trim();
}

export async function readJson(relativePath) {
  return JSON.parse(await readFile(path.resolve(projectRoot, relativePath), "utf8"));
}

export async function deploymentConfig() {
  const relativePath = process.env.LOCUS_DEPLOY_CONFIG || "secret/DEPLOYMENT_TARGET.json";
  try {
    return await readJson(relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Deployment config is missing. Copy deploy/coolify.example.json to ${relativePath} and fill it in.`,
      );
    }
    throw error;
  }
}

export async function writeJson(relativePath, value) {
  const target = path.resolve(projectRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}

export function base64url(bytes) {
  return randomBytes(bytes).toString("base64url");
}

export async function deploymentEnvironment() {
  const relativePath = "secret/DEPLOYMENT_ENV.txt";
  const target = path.resolve(projectRoot, relativePath);
  try {
    const entries = Object.fromEntries(
      (await readFile(target, "utf8"))
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    if (entries.POSTGRES_PASSWORD && entries.BETTER_AUTH_SECRET && entries.LOCUS_CREDENTIAL_KEYS) {
      return entries;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const postgresPassword = base64url(32);
  const entries = {
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_URL: `postgresql://locus:${postgresPassword}@postgres:5432/locus`,
    BETTER_AUTH_SECRET: base64url(48),
    LOCUS_CREDENTIAL_KEYS: base64url(32),
  };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  await chmod(target, 0o600);
  return entries;
}

export async function postmarkServerToken() {
  const fromEnvironment = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;

  const target = path.resolve(projectRoot, "secret/POSTMARK_API.txt");
  const lines = (await readFile(target, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const assignment = lines.find((line) => /^POSTMARK_SERVER_TOKEN\s*=/i.test(line));
  if (assignment) return assignment.slice(assignment.indexOf("=") + 1).trim();

  const labelIndex = lines.findIndex((line) => /server.*(?:api|token)|(?:api|token).*server/i.test(line));
  const token = labelIndex >= 0 ? lines[labelIndex + 1] : lines.at(-1);
  if (!token || token.length < 20 || /\s/.test(token)) {
    throw new Error("Postmark Server API token is not configured in secret/POSTMARK_API.txt");
  }
  return token;
}

function parseEnvironmentFile(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export async function initialAdmin() {
  const target = path.resolve(projectRoot, "secret/INITIAL_ADMIN.txt");
  try {
    const entries = parseEnvironmentFile(await readFile(target, "utf8"));
    if (entries.EMAIL && entries.NAME && entries.PASSWORD && entries.BOOTSTRAP_TOKEN) {
      return { ...entries, provisioned: entries.PROVISIONED === "true" };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = {
    EMAIL: process.env.LOCUS_INITIAL_ADMIN_EMAIL || "admin@locuschat.io",
    NAME: process.env.LOCUS_INITIAL_ADMIN_NAME || "Locus Admin",
    PASSWORD: base64url(24),
    BOOTSTRAP_TOKEN: base64url(48),
    PROVISIONED: "false",
  };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return { ...entries, provisioned: false };
}

export async function markInitialAdminProvisioned() {
  const admin = await initialAdmin();
  const target = path.resolve(projectRoot, "secret/INITIAL_ADMIN.txt");
  const entries = {
    EMAIL: admin.EMAIL,
    NAME: admin.NAME,
    PASSWORD: admin.PASSWORD,
    BOOTSTRAP_TOKEN: admin.BOOTSTRAP_TOKEN,
    PROVISIONED: "true",
  };
  await writeFile(target, `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}

export async function apiRequest(base, token, pathname, options = {}) {
  const response = await fetch(`${base.replace(/\/$/, "")}${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.errors ? `${data?.message ?? "Validation failed"}: ${JSON.stringify(data.errors)}` : data?.message ?? data?.error ?? "request failed";
    throw new Error(`${options.method ?? "GET"} ${pathname} returned ${response.status}: ${detail}`);
  }
  return data;
}
