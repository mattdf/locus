import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  apiRequest,
  deploymentConfig,
  initialAdmin,
  markInitialAdminProvisioned,
  projectRoot,
} from "./common.mjs";

const config = await deploymentConfig();
const state = await readJson("deploy/.state.json");
const admin = await initialAdmin();
if (admin.provisioned) {
  console.log("Initial administrator is already provisioned");
  process.exit(0);
}

const deadline = Date.now() + 20 * 60_000;
let lastStatus = "not reachable";
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${config.domain}/api/ready`, { signal: AbortSignal.timeout(10_000) });
    lastStatus = `HTTP ${response.status}`;
    if (response.ok) break;
  } catch (error) {
    lastStatus = error instanceof Error ? error.message : "request failed";
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (Date.now() >= deadline) throw new Error(`Locus did not become ready: ${lastStatus}`);

const bootstrap = await fetch(`${config.domain}/api/setup/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: config.domain },
  body: JSON.stringify({
    token: admin.BOOTSTRAP_TOKEN,
    email: admin.EMAIL,
    name: admin.NAME,
    password: admin.PASSWORD,
  }),
  signal: AbortSignal.timeout(30_000),
});
const body = await bootstrap.json().catch(() => null);
if (!bootstrap.ok) {
  throw new Error(`Initial administrator provisioning returned ${bootstrap.status}: ${body?.error ?? "request failed"}`);
}

await markInitialAdminProvisioned();

const credentialLines = (await readFile(path.resolve(projectRoot, config.apiBaseFile), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const coolifyToken = process.env.COOLIFY_API_TOKEN || credentialLines[0];
const base = process.env.COOLIFY_API_BASE || credentialLines.find((line) => line.startsWith("http"));
if (!coolifyToken || !base) throw new Error("Coolify API token/base URL is not configured");
await apiRequest(base, coolifyToken, `/applications/${state.applicationUuid}/envs`, {
  method: "PATCH",
  body: JSON.stringify({
    key: "LOCUS_BOOTSTRAP_TOKEN",
    value: "",
    is_preview: false,
    is_literal: true,
  }),
});
console.log(`Created the initial administrator (${admin.EMAIL})`);
console.log("The one-time bootstrap token has been invalidated in Coolify");
