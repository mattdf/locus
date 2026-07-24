import pg from "pg";

const base = process.env.LOCUS_TEST_BASE_URL || "http://127.0.0.1:8791";
const origin = process.env.LOCUS_TEST_PUBLIC_ORIGIN || "https://127.0.0.1";
const databaseUrl = process.env.DATABASE_URL;
const bootstrapToken = process.env.LOCUS_TEST_BOOTSTRAP_TOKEN || "test-bootstrap-token";
const managedApiKey = "sk-test-managed-key-never-returned-to-user";
const administrator = {
  email: "admin@access.test",
  name: "Access Admin",
  password: "correct-horse-battery-staple",
};
const invitee = {
  email: "invitee@access.test",
  name: "Invited User",
  password: "another-correct-horse-battery",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, { cookie, ...options } = {}) {
  return fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(!["GET", "HEAD"].includes(options.method || "GET") ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Real-IP": "203.0.113.20",
      ...options.headers,
    },
  });
}

async function json(response) {
  return response.json().catch(() => ({}));
}

function responseCookie(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function signIn(account) {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: account.email, password: account.password, rememberMe: true }),
  });
  assert(response.ok, `Sign-in failed: ${JSON.stringify(await json(response))}`);
  return responseCookie(response);
}

assert(databaseUrl, "DATABASE_URL is required for the access-control integration test");

const bootstrap = await request("/api/setup/bootstrap", {
  method: "POST",
  body: JSON.stringify({ token: bootstrapToken, ...administrator }),
});
assert(bootstrap.status === 201, `Bootstrap failed: ${JSON.stringify(await json(bootstrap))}`);
const adminCookie = await signIn(administrator);

const directSignup = await request("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({ ...invitee, callbackURL: "/" }),
});
assert(!directSignup.ok, "The unmanaged Better Auth signup endpoint remained enabled");

const initialAccess = await json(await request("/api/admin/access", { cookie: adminCookie }));
assert(initialAccess.policy?.publicSignupEnabled === true, "Public signup was not enabled by default");

const waitlistMode = await request("/api/admin/access/settings", {
  method: "PATCH",
  cookie: adminCookie,
  body: JSON.stringify({ publicSignupEnabled: false }),
});
assert(waitlistMode.ok, `Could not enable waitlist mode: ${JSON.stringify(await json(waitlistMode))}`);

const blockedPublicSignup = await request("/api/access/signup", {
  method: "POST",
  body: JSON.stringify(invitee),
});
assert(blockedPublicSignup.status === 403, "Public signup remained available in waitlist mode");

const waitlist = await request("/api/access/waitlist", {
  method: "POST",
  body: JSON.stringify({ email: invitee.email, name: invitee.name }),
});
assert(waitlist.status === 201, `Could not join waitlist: ${JSON.stringify(await json(waitlist))}`);

const createKey = await request("/api/admin/access/managed-credentials", {
  method: "POST",
  cookie: adminCookie,
  body: JSON.stringify({
    label: "Test managed key",
    provider: "openai",
    apiKey: managedApiKey,
    monthlyLimitUsd: 5,
  }),
});
const createdKey = await json(createKey);
assert(createKey.status === 201 && createdKey.credential?.id, `Could not create managed key: ${JSON.stringify(createdKey)}`);
assert(createdKey.credential.monthlyLimitUsd === 5, "Managed key monthly limit was not persisted");
assert(!JSON.stringify(createdKey).includes(managedApiKey), "Managed key creation response exposed plaintext");

const createInvite = await request("/api/admin/access/invites", {
  method: "POST",
  cookie: adminCookie,
  body: JSON.stringify({
    email: invitee.email,
    expiresInDays: 7,
    managedCredentialId: createdKey.credential.id,
    accountMonthlyLimitUsd: 1,
  }),
});
const createdInvite = await json(createInvite);
assert(createInvite.status === 201 && createdInvite.url, `Could not create invite: ${JSON.stringify(createdInvite)}`);
assert(createdInvite.invite?.accountMonthlyLimitUsd === 1, "Invite account budget was not persisted");
const inviteToken = new URL(createdInvite.url).searchParams.get("invite");
assert(inviteToken?.length === 43, "Invite URL did not contain a strong capability token");

const publicInvite = await json(await request(`/api/access/invites/${inviteToken}`));
assert(
  publicInvite.invite?.email === invitee.email && publicInvite.invite?.managedProvider === "openai",
  "Public invite metadata was incorrect",
);
assert(!JSON.stringify(publicInvite).includes(managedApiKey), "Public invite metadata exposed the managed key");

const signup = await request("/api/access/signup", {
  method: "POST",
  body: JSON.stringify({ ...invitee, inviteToken }),
});
const signupResult = await json(signup);
assert(signup.status === 201, `Invite signup failed: ${JSON.stringify(signupResult)}`);
assert(signupResult.verificationRequired === false, "Invite signup unexpectedly required email verification");
assert((await request(`/api/access/invites/${inviteToken}`)).status === 404, "Used invite remained reusable");

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const stored = await pool.query(
    `select encode(c."ciphertext", 'escape') as "ciphertext", encode(i."tokenHash", 'hex') as "tokenHash",
            a."ownerUserId", u."emailVerified"
       from "locus_managed_credentials" c
       join "locus_invites" i on i."managedCredentialId" = c."id"
       join "locus_user_managed_credentials" a on a."managedCredentialId" = c."id"
       join "user" u on u."id" = a."ownerUserId"
      where c."id" = $1`,
    [createdKey.credential.id],
  );
  assert(stored.rowCount === 1, "Managed credential was not assigned to the invited account");
  assert(stored.rows[0].emailVerified === true, "Invited account was not marked email-verified");
  assert(!stored.rows[0].ciphertext.includes(managedApiKey), "Managed credential was stored as plaintext");
  assert(!stored.rows[0].tokenHash.includes(inviteToken), "Raw invite token was stored in the database");
  await pool.query(
    `insert into "locus_generation_jobs"
       ("ownerUserId", "id", "provider", "model", "purpose", "status",
        "managedCredentialId", "finishedAt")
     values ($1, 'tracked-managed-generation', 'openai', 'gpt-5.6-sol', 'chat',
             'completed', $2, current_timestamp)`,
    [stored.rows[0].ownerUserId, createdKey.credential.id],
  );
  await pool.query(
    `insert into "locus_usage_events"
       ("ownerUserId", "generationId", "provider", "model", "inputTokens",
        "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens",
        "totalCostUsd", "managedCredentialId", "credentialKind", "credentialRef",
        "credentialLabel")
     values ($1, 'tracked-managed-generation', 'openai', 'gpt-5.6-sol',
             1000, 100, 500, 200, 1500, 0.25, $2, 'managed', $3, $4)`,
    [
      stored.rows[0].ownerUserId,
      createdKey.credential.id,
      `managed:${createdKey.credential.id}`,
      createdKey.credential.label,
    ],
  );
} finally {
  await pool.end();
}

const inviteeCookie = await signIn(invitee);
const providers = await json(await request("/api/providers", { cookie: inviteeCookie }));
assert(providers.openai?.configured && providers.openai?.source === "managed", "Invitee did not receive managed provider access");
assert(!JSON.stringify(providers).includes(managedApiKey), "Provider status exposed the managed key");

const usageAccess = await json(await request("/api/admin/access", { cookie: adminCookie }));
const trackedCredential = usageAccess.managedCredentials?.find(
  (credential) => credential.id === createdKey.credential.id,
);
assert(trackedCredential?.monthlyCostUsd === 0.25, "Managed-key monthly cost was not aggregated");
assert(trackedCredential?.monthlyTokens === 1500, "Managed-key token use was not aggregated");
assert(trackedCredential?.lifetimeCostUsd === 0.25, "Managed-key lifetime cost was not aggregated");

const usersBeforeLimits = await json(await request("/api/admin/users", { cookie: adminCookie }));
const trackedInvitee = usersBeforeLimits.users?.find((user) => user.email === invitee.email);
assert(trackedInvitee?.managedMonthlyCostUsd === 0.25, "Per-account managed cost was not aggregated");
assert(trackedInvitee?.managedMonthlyTokens === 1500, "Per-account managed tokens were not aggregated");
assert(trackedInvitee?.managedCredentialCount === 1, "Managed-key assignment was not summarized");
assert(trackedInvitee?.managedMonthlyLimitUsd === 1, "Invite account budget was not applied");
assert(trackedInvitee?.monthlyCostUsd === 0.25, "All-key account cost was not aggregated");
assert(trackedInvitee?.monthlyTokens === 1500, "All-key account tokens were not aggregated");

const inviteeUsageResponse = await request("/api/usage", { cookie: inviteeCookie });
const inviteeUsage = await json(inviteeUsageResponse);
assert(inviteeUsageResponse.ok, `Invitee could not read private usage: ${JSON.stringify(inviteeUsage)}`);
assert(inviteeUsage.lifetime?.costUsd === 0.25, "Private lifetime cost total is incorrect");
assert(inviteeUsage.months?.[0]?.costUsd === 0.25, "Private monthly cost total is incorrect");
assert(
  inviteeUsage.credentials?.[0]?.credentialLabel === createdKey.credential.label &&
    inviteeUsage.credentials?.[0]?.credentialKind === "managed",
  "Private per-key usage breakdown is incorrect",
);
assert(
  !JSON.stringify(inviteeUsage).includes(managedApiKey),
  "Private usage response exposed a managed API key",
);

const setAccountLimit = await request(
  `/api/admin/users/${encodeURIComponent(trackedInvitee.id)}`,
  {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ managedMonthlyLimitUsd: 0.25 }),
  },
);
assert(setAccountLimit.ok, `Could not set the account budget: ${JSON.stringify(await json(setAccountLimit))}`);
const blockedByAccount = await request("/api/respond", {
  method: "POST",
  cookie: inviteeCookie,
  body: JSON.stringify({
    requestId: "account-budget-blocked-0001",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    maxOutputTokens: 1000,
    context: [],
    message: "This must be rejected before making an upstream request.",
  }),
});
const blockedByAccountBody = await json(blockedByAccount);
assert(
  blockedByAccount.status === 402 &&
    blockedByAccountBody.code === "ACCOUNT_MONTHLY_LIMIT_REACHED",
  `Account budget was not enforced: ${JSON.stringify(blockedByAccountBody)}`,
);

const clearAccountLimit = await request(
  `/api/admin/users/${encodeURIComponent(trackedInvitee.id)}`,
  {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ managedMonthlyLimitUsd: null }),
  },
);
assert(clearAccountLimit.ok, "Could not clear the account budget");
const setKeyLimit = await request(
  `/api/admin/access/managed-credentials/${encodeURIComponent(createdKey.credential.id)}`,
  {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ monthlyLimitUsd: 0.25 }),
  },
);
assert(setKeyLimit.ok, `Could not set the managed-key budget: ${JSON.stringify(await json(setKeyLimit))}`);
const blockedByKey = await request("/api/respond", {
  method: "POST",
  cookie: inviteeCookie,
  body: JSON.stringify({
    requestId: "key-budget-blocked-000001",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    maxOutputTokens: 1000,
    context: [],
    message: "This must also be rejected before making an upstream request.",
  }),
});
const blockedByKeyBody = await json(blockedByKey);
assert(
  blockedByKey.status === 402 &&
    blockedByKeyBody.code === "KEY_MONTHLY_LIMIT_REACHED",
  `Managed-key budget was not enforced: ${JSON.stringify(blockedByKeyBody)}`,
);
const restoreKeyLimit = await request(
  `/api/admin/access/managed-credentials/${encodeURIComponent(createdKey.credential.id)}`,
  {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ monthlyLimitUsd: 5 }),
  },
);
assert(restoreKeyLimit.ok, "Could not restore the managed-key budget");

const customKey = "hosted-custom-key-never-exposed";
const createCustom = await request("/api/provider-connections", {
  method: "POST",
  cookie: inviteeCookie,
  body: JSON.stringify({ label: "Compatible test", baseUrl: "https://example.com/v1", apiKey: customKey }),
});
const createdCustom = await json(createCustom);
assert(createCustom.status === 201 && createdCustom.provider?.id, `Could not create hosted custom provider: ${JSON.stringify(createdCustom)}`);
assert(!JSON.stringify(createdCustom).includes(customKey), "Custom provider response exposed plaintext key");
const customConnections = await json(await request("/api/provider-connections", { cookie: inviteeCookie }));
assert(customConnections.providers?.some((provider) => provider.id === createdCustom.provider.id), "Custom provider was not listed");
assert(!JSON.stringify(customConnections).includes(customKey), "Custom provider listing exposed plaintext key");
const blockedPrivate = await request("/api/provider-connections", {
  method: "POST",
  cookie: inviteeCookie,
  body: JSON.stringify({ label: "Private target", baseUrl: "https://127.0.0.1/v1" }),
});
assert(blockedPrivate.status === 400, "Hosted custom provider accepted a private-network target");
const customPool = new pg.Pool({ connectionString: databaseUrl });
try {
  const storedCustom = await customPool.query(
    `select encode("ciphertext", 'escape') as "ciphertext" from "locus_custom_providers" where "id" = $1`,
    [createdCustom.provider.id],
  );
  assert(storedCustom.rowCount === 1, "Custom provider was not persisted");
  assert(!storedCustom.rows[0].ciphertext.includes(customKey), "Custom provider key was stored as plaintext");
} finally {
  await customPool.end();
}

const revokeKey = await request(
  `/api/admin/access/managed-credentials/${encodeURIComponent(createdKey.credential.id)}`,
  { method: "DELETE", cookie: adminCookie },
);
assert(revokeKey.status === 204, "Managed key could not be revoked");
const providersAfterRevoke = await json(await request("/api/providers", { cookie: inviteeCookie }));
assert(!providersAfterRevoke.openai?.configured, "Revoked managed key remained usable");

const users = await json(await request("/api/admin/users", { cookie: adminCookie }));
const inviteeUser = users.users?.find((user) => user.email === invitee.email);
assert(inviteeUser?.id, "Invited account was not listed for administration");
const suspend = await request(`/api/admin/users/${encodeURIComponent(inviteeUser.id)}`, {
  method: "PATCH",
  cookie: adminCookie,
  body: JSON.stringify({ disabled: true }),
});
assert(suspend.ok, "Invited account could not be suspended");
const suspendedRequest = await request("/api/workspace", { cookie: inviteeCookie });
assert([401, 403].includes(suspendedRequest.status), "Suspended session retained workspace access");
const suspendedSignIn = await request("/api/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: invitee.email, password: invitee.password, rememberMe: true }),
});
assert(!suspendedSignIn.ok, "Suspended account could create a new session");

console.log("Access-control integration checks passed: waitlist, verification-free invites, managed-key cost tracking and budgets, revocation, non-disclosure, and suspension");
