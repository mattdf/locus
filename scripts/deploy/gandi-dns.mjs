import { readFile } from "node:fs/promises";
import path from "node:path";
import { deploymentConfig, projectRoot } from "./common.mjs";

const config = await deploymentConfig();
const token = process.env.GANDI_API_TOKEN
  || (await readFile(path.resolve(projectRoot, "secret/GANDI_API.txt"), "utf8")).split(/\r?\n/)[0].trim();
if (!token) throw new Error("Gandi API token is not configured");

async function gandi(pathname, options = {}) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      response = await fetch(`https://api.gandi.net/v5/livedns${pathname}`, {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  if (!response) throw lastError ?? new Error("Gandi request failed");
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Gandi ${pathname} returned ${response.status}: ${body?.message ?? "request failed"}`);
  return body;
}

const records = [
  { name: "@", type: "A", values: [config.serverIp] },
  { name: "www", type: "CNAME", values: ["locuschat.io."] },
];
for (const record of records) {
  await gandi(`/domains/locuschat.io/records/${record.name}/${record.type}`, {
    method: "PUT",
    body: JSON.stringify({ rrset_ttl: 300, rrset_values: record.values }),
  });
  console.log(`Configured ${record.name} ${record.type}`);
}

const root = await gandi("/domains/locuschat.io/records/@/A");
if (!root.rrset_values?.includes(config.serverIp)) throw new Error("Gandi did not retain the expected A record");
console.log(`locuschat.io now points to ${config.serverIp}`);
