export type LocusMode = "local" | "hosted";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when LOCUS_MODE=hosted`);
  return value;
}

const rawMode = process.env.LOCUS_MODE?.trim() || "local";
if (rawMode !== "local" && rawMode !== "hosted") {
  throw new Error("LOCUS_MODE must be either local or hosted");
}

export const locusMode: LocusMode = rawMode;
export const isHosted = locusMode === "hosted";
export const publicOrigin = isHosted ? required("LOCUS_PUBLIC_ORIGIN").replace(/\/$/, "") : null;
export const databaseUrl = isHosted ? required("DATABASE_URL") : null;
export const authSecret = isHosted ? required("BETTER_AUTH_SECRET") : null;
export const credentialEncryptionKeys = isHosted
  ? required("LOCUS_CREDENTIAL_KEYS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  : [];

if (isHosted) {
  if (!publicOrigin?.startsWith("https://")) {
    throw new Error("LOCUS_PUBLIC_ORIGIN must use https:// in hosted mode");
  }
  if (credentialEncryptionKeys.some((key) => !/^[A-Za-z0-9_-]{43}$/.test(key))) {
    throw new Error("Each LOCUS_CREDENTIAL_KEYS entry must be a base64url-encoded 32-byte key");
  }
}

// Arbitrary OpenAI-compatible URLs are intentionally unavailable in hosted mode.
// They remain fully supported in local mode, where they cannot be used as server-side SSRF.
export const hostedLocalProviderEnabled = false;
