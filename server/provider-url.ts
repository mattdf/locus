import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isHosted } from "./config.ts";

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? blockedIpv4(mapped) : false;
}

function blockedAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? blockedIpv4(address) : version === 6 ? blockedIpv6(address) : true;
}

export function normalizeProviderBaseUrl(raw: string): string {
  if (raw.length > 2_000) throw new Error("The endpoint URL is too long");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid OpenAI-compatible endpoint URL");
  }
  const allowedProtocol = isHosted ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol);
  if (!allowedProtocol) {
    throw new Error(isHosted ? "Hosted custom endpoints must use HTTPS" : "The endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Put endpoint credentials in the API key field, not the URL");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export async function assertSafeProviderBaseUrl(raw: string): Promise<string> {
  const normalized = normalizeProviderBaseUrl(raw);
  if (!isHosted) return normalized;
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Custom endpoints must resolve to a public HTTPS host");
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address))) {
    throw new Error("Custom endpoints must resolve only to public network addresses");
  }
  return normalized;
}

export function guardedProviderFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url;
    await assertSafeProviderBaseUrl(url);
    const response = await fetch(input, { ...init, redirect: isHosted ? "error" : init?.redirect });
    return response;
  };
}
