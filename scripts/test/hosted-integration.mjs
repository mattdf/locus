import pg from "pg";

const base = process.env.LOCUS_TEST_BASE_URL || "http://127.0.0.1:8790";
const origin = process.env.LOCUS_TEST_PUBLIC_ORIGIN || "https://127.0.0.1";
const bootstrapToken = process.env.LOCUS_TEST_BOOTSTRAP_TOKEN || "test-bootstrap-token";
const alice = {
  email: "alice@locus.test",
  name: "Alice",
  password: "correct-horse-battery-staple",
};
const bob = {
  email: "bob@locus.test",
  name: "Bob",
  password: "another-correct-horse-battery",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, { cookie, originHeader = true, ...options } = {}) {
  return fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(originHeader && !["GET", "HEAD"].includes(options.method || "GET") ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Real-IP": "203.0.113.10",
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
  const testIp = account.email === alice.email ? "203.0.113.11" : "203.0.113.12";
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "X-Real-IP": testIp },
    body: JSON.stringify({ email: account.email, password: account.password, rememberMe: true }),
  });
  assert(response.ok, `Sign-in failed for ${account.email}: ${JSON.stringify(await json(response))}`);
  const cookie = responseCookie(response);
  assert(cookie.includes("locus"), "Sign-in did not return a Locus session cookie");
  return cookie;
}

const health = await request("/api/health");
assert(health.ok, "Hosted liveness check failed");

const unauthenticatedWorkspace = await request("/api/workspace");
assert(unauthenticatedWorkspace.status === 401, "Workspace was available without authentication");

const bootstrap = await request("/api/setup/bootstrap", {
  method: "POST",
  body: JSON.stringify({ token: bootstrapToken, ...alice }),
});
assert(bootstrap.status === 201, `Bootstrap failed: ${JSON.stringify(await json(bootstrap))}`);

const aliceCookie = await signIn(alice);
const runtime = await json(await request("/api/runtime", { cookie: aliceCookie }));
assert(runtime.authenticated && runtime.user?.email === alice.email, "Authenticated runtime is incorrect");
const aliceId = runtime.user.id;

const invalidNameUpdate = await request("/api/auth/update-user", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ name: "   " }),
});
assert(invalidNameUpdate.status === 400, "The self-service profile endpoint accepted an empty name");
const updatedAliceName = "Alice Updated";
const updateOwnName = await request("/api/auth/update-user", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ name: `  ${updatedAliceName}  ` }),
});
assert(updateOwnName.ok, `Self-service name update failed: ${JSON.stringify(await json(updateOwnName))}`);
const renamedRuntime = await json(await request("/api/runtime", { cookie: aliceCookie }));
assert(renamedRuntime.user?.name === updatedAliceName, "Updated account name was not returned by runtime");

const selfServicePassword = "updated-correct-horse-battery-staple";
const invalidPasswordChange = await request("/api/auth/change-password", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    currentPassword: "not-the-current-password",
    newPassword: selfServicePassword,
    revokeOtherSessions: false,
  }),
});
assert(!invalidPasswordChange.ok, "Password change accepted an incorrect current password");
const changeOwnPassword = await request("/api/auth/change-password", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    currentPassword: alice.password,
    newPassword: selfServicePassword,
    revokeOtherSessions: false,
  }),
});
assert(changeOwnPassword.ok, `Self-service password change failed: ${JSON.stringify(await json(changeOwnPassword))}`);
const oldPasswordSignIn = await request("/api/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: alice.email, password: alice.password, rememberMe: true }),
});
assert(!oldPasswordSignIn.ok, "The previous password remained valid after a self-service change");
await signIn({ ...alice, password: selfServicePassword });

const createBob = await request("/api/admin/users", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ ...bob, role: "user" }),
});
assert(createBob.ok, `Admin could not create a private account: ${JSON.stringify(await json(createBob))}`);
const bobCookie = await signIn(bob);

const adminUsers = await json(await request("/api/admin/users", { cookie: aliceCookie }));
assert(adminUsers.users?.length === 2, "Admin account list did not include both private accounts");
const forbiddenAdminUsers = await request("/api/admin/users", { cookie: bobCookie });
assert(forbiddenAdminUsers.status === 403, "A non-admin account could access account management");

const aliceInitial = await json(await request("/api/workspace", { cookie: aliceCookie }));
assert(aliceInitial.revision === 0 && aliceInitial.state.chats.length === 0, "Alice did not receive a new workspace");
const now = new Date().toISOString();
const aliceSync = await request("/api/workspace/sync", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    baseRevision: 0,
    categories: [{ id: "private-category", name: "Private", createdAt: now, updatedAt: now }],
    upsertChats: [{
      id: "alice-chat",
      title: "Alice private chat",
      categoryId: "private-category",
      rootId: "alice-root",
      nodes: {
        "alice-root": {
          id: "alice-root",
          parentId: null,
          title: "Alice private chat",
          messages: [{ id: "alice-source", role: "source", content: "$x^2$", createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    }],
    activeChatId: "alice-chat",
  }),
});
assert(aliceSync.ok && (await json(aliceSync)).revision === 1, "Alice workspace sync failed");

const staleSync = await request("/api/workspace/sync", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ baseRevision: 0, activeChatId: null }),
});
assert(staleSync.status === 409, "A stale workspace write did not conflict");

const missingOrigin = await request("/api/workspace/sync", {
  method: "POST",
  cookie: aliceCookie,
  originHeader: false,
  body: JSON.stringify({ baseRevision: 1, activeChatId: null }),
});
assert(missingOrigin.status === 403, "A cookie-authenticated mutation without Origin was accepted");

const unauthenticatedShares = await request("/api/shares");
assert(unauthenticatedShares.status === 401, "Private share management was available without authentication");
const createShare = await request("/api/shares", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ chatId: "alice-chat" }),
});
const createdShare = await json(createShare);
assert(
  createShare.status === 201 && /^\/share\/[A-Za-z0-9_-]{43}$/.test(createdShare.share?.path ?? ""),
  `Could not create a shared snapshot: ${JSON.stringify(createdShare)}`,
);
const shareToken = createdShare.share.path.split("/").at(-1);
const publicSnapshot = await json(await request(`/api/public/shares/${shareToken}`));
assert(
  publicSnapshot.chat?.nodes?.["alice-root"]?.messages?.[0]?.content === "$x^2$",
  "The public snapshot did not contain the shared chat",
);
const listedShares = await json(await request("/api/shares", { cookie: aliceCookie }));
assert(listedShares.shares?.length === 1, "The owner could not list the shared snapshot");

const mutateOriginal = await request("/api/workspace/sync", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    baseRevision: 1,
    upsertChats: [{
      id: "alice-chat",
      title: "Alice private chat",
      categoryId: "private-category",
      rootId: "alice-root",
      nodes: {
        "alice-root": {
          id: "alice-root",
          parentId: null,
          title: "Alice private chat",
          messages: [{ id: "alice-source", role: "source", content: "$y^3$", createdAt: now }],
          createdAt: now,
          updatedAt: new Date(Date.now() + 1000).toISOString(),
        },
      },
      createdAt: now,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    }],
  }),
});
assert(mutateOriginal.ok, "Could not update the original after sharing");
const unchangedSnapshot = await json(await request(`/api/public/shares/${shareToken}`));
assert(
  unchangedSnapshot.chat?.nodes?.["alice-root"]?.messages?.[0]?.content === "$x^2$",
  "The public snapshot changed when its original chat changed",
);
const revokeShare = await request(`/api/shares/${createdShare.share.id}`, {
  method: "DELETE",
  cookie: aliceCookie,
});
assert(revokeShare.status === 204, "The owner could not revoke a shared snapshot");
assert(
  (await request(`/api/public/shares/${shareToken}`)).status === 404,
  "A revoked shared snapshot remained public",
);

const bobWorkspace = await json(await request("/api/workspace", { cookie: bobCookie }));
assert(bobWorkspace.revision === 0 && bobWorkspace.state.chats.length === 0, "Bob received Alice workspace data");

const dummyKey = "sk-test-hosted-isolation-000000000000";
const saveKey = await request("/api/providers/openai/api-key", {
  method: "PUT",
  cookie: aliceCookie,
  body: JSON.stringify({ apiKey: dummyKey }),
});
assert(saveKey.ok, `Alice credential save failed: ${JSON.stringify(await json(saveKey))}`);
const aliceProviders = await json(await request("/api/providers", { cookie: aliceCookie }));
const bobProviders = await json(await request("/api/providers", { cookie: bobCookie }));
assert(aliceProviders.openai.configured, "Alice's saved credential was not reported");
assert(!bobProviders.openai.configured, "Bob could see Alice's credential status");

const customKey = "custom-hosted-secret-never-returned";
const customProviderResponse = await request("/api/provider-connections", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    label: "Hosted compatible test",
    baseUrl: "https://example.com/v1",
    apiKey: customKey,
  }),
});
const customProvider = await json(customProviderResponse);
assert(customProviderResponse.status === 201 && customProvider.provider?.id, `Custom provider save failed: ${JSON.stringify(customProvider)}`);
assert(!JSON.stringify(customProvider).includes(customKey), "Custom provider response exposed its API key");
const aliceConnections = await json(await request("/api/provider-connections", { cookie: aliceCookie }));
const bobConnections = await json(await request("/api/provider-connections", { cookie: bobCookie }));
assert(aliceConnections.providers?.some((provider) => provider.id === customProvider.provider.id), "Alice's custom provider was not listed");
assert(!bobConnections.providers?.some((provider) => provider.id === customProvider.provider.id), "Bob could see Alice's custom provider");
const privateCustomProvider = await request("/api/provider-connections", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ label: "Blocked private endpoint", baseUrl: "https://127.0.0.1/v1" }),
});
assert(privateCustomProvider.status === 400, "Hosted mode accepted a private-network custom endpoint");

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const credentials = await pool.query(
      `select "ownerUserId", "provider", "credentialId",
              encode("ciphertext", 'escape') as "ciphertext"
       from "locus_provider_credentials"`,
    );
    assert(credentials.rowCount === 1, "Unexpected credential row count");
    assert(!credentials.rows[0].ciphertext.includes(dummyKey), "Provider credential was stored as plaintext");
    const customCredentials = await pool.query(
      `select "credentialId", encode("ciphertext", 'escape') as "ciphertext"
         from "locus_custom_providers"
        where "ownerUserId" = $1 and "id" = $2`,
      [aliceId, customProvider.provider.id],
    );
    assert(customCredentials.rowCount === 1, "Custom provider was not stored for its owner");
    assert(!customCredentials.rows[0].ciphertext.includes(customKey), "Custom provider key was stored as plaintext");
    const owners = await pool.query(
      `select u.email, count(c.id)::int as chats
       from "user" u left join "locus_chats" c on c."ownerUserId" = u.id
       group by u.email order by u.email`,
    );
    const counts = Object.fromEntries(owners.rows.map((row) => [row.email, row.chats]));
    assert(counts[alice.email] === 1 && counts[bob.email] === 0, "Database ownership isolation failed");

    const personalRef = `personal:${credentials.rows[0].credentialId}`;
    const customRef = `custom:${customCredentials.rows[0].credentialId}`;
    await pool.query(
      `insert into "locus_generation_jobs"
         ("ownerUserId", "id", "provider", "model", "purpose", "status",
          "credentialKind", "credentialRef", "credentialLabel", "createdAt")
       values
         ($1, 'usage-personal-current', 'openai', 'gpt-5.6-sol', 'chat', 'completed',
          'personal', $2, 'OpenAI personal key', current_timestamp),
         ($1, 'usage-custom-current', 'custom', 'custom-test', 'chat', 'completed',
          'custom', $3, 'Hosted compatible test key', current_timestamp),
         ($1, 'usage-custom-unpriced', 'custom', 'custom-test', 'chat', 'completed',
          'custom', $3, 'Hosted compatible test key', current_timestamp),
         ($1, 'usage-personal-previous', 'openai', 'gpt-5.6-sol', 'chat', 'completed',
          'personal', $2, 'OpenAI personal key', current_timestamp - interval '1 month')`,
      [aliceId, personalRef, customRef],
    );
    await pool.query(
      `insert into "locus_usage_events"
         ("ownerUserId", "generationId", "provider", "model", "inputTokens",
          "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens",
          "totalCostUsd", "credentialKind", "credentialRef", "credentialLabel", "createdAt")
       values
         ($1, 'usage-personal-current', 'openai', 'gpt-5.6-sol',
          1000, 100, 500, 200, 1500, 0.40, 'personal', $2,
          'OpenAI personal key', current_timestamp),
         ($1, 'usage-custom-current', 'custom', 'custom-test',
          300, 0, 200, 0, 500, 0.10, 'custom', $3,
          'Hosted compatible test key', current_timestamp),
         ($1, 'usage-custom-unpriced', 'custom', 'custom-test',
          200, 0, 100, 0, 300, null, 'custom', $3,
          'Hosted compatible test key', current_timestamp),
         ($1, 'usage-personal-previous', 'openai', 'gpt-5.6-sol',
          400, 0, 100, 0, 500, 0.20, 'personal', $2,
          'OpenAI personal key', current_timestamp - interval '1 month')`,
      [aliceId, personalRef, customRef],
    );
  } finally {
    await pool.end();
  }
}

const aliceUsageResponse = await request("/api/usage", { cookie: aliceCookie });
const aliceUsage = await json(aliceUsageResponse);
assert(aliceUsageResponse.ok, `Alice could not read private usage: ${JSON.stringify(aliceUsage)}`);
assert(aliceUsage.lifetime?.costUsd === 0.7, "Lifetime spending did not include all key types");
assert(aliceUsage.lifetime?.tokens === 2800, "Lifetime tokens did not include all key types");
assert(aliceUsage.months?.length === 2, "Usage was not segmented into calendar months");
assert(aliceUsage.months?.[0]?.costUsd === 0.5, "Current-month spending is incorrect");
assert(aliceUsage.credentials?.length === 2, "Current-month usage was not grouped by key");
assert(
  aliceUsage.credentials.some(
    (credential) =>
      credential.credentialKind === "custom" &&
      credential.costUsd === 0.1 &&
      credential.unpricedEvents === 1,
  ),
  "Custom-provider spending or unpriced usage was not grouped correctly",
);
assert(
  !JSON.stringify(aliceUsage).includes(dummyKey) &&
    !JSON.stringify(aliceUsage).includes(customKey),
  "Private usage response exposed an API key",
);
const bobUsageResponse = await request("/api/usage", { cookie: bobCookie });
const bobUsage = await json(bobUsageResponse);
assert(bobUsageResponse.ok, `Bob could not read private usage: ${JSON.stringify(bobUsage)}`);
assert(
  bobUsage.lifetime?.costUsd === 0 && bobUsage.credentials?.length === 0,
  "Usage endpoint crossed account ownership boundaries",
);

const metapost = await request("/api/metapost/compile", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    source: `numeric canvasWidth, canvasHeight;
pair p0, p1;
canvasWidth := 220; canvasHeight := 120;
p0 := (30,40); p1 := (190,90);
fill unitsquare xscaled canvasWidth yscaled canvasHeight withcolor locusBg;
drawarrow p0--p1 withpen pencircle scaled locusStrong withcolor locusTeal;
label(btex $\\begin{array}{c|c}x&x^2\\\\\\hline 1&1\\end{array}$ etex, (110,70)) withcolor locusInk;
setbounds currentpicture to unitsquare xscaled canvasWidth yscaled canvasHeight;`,
  }),
});
const metapostBody = await json(metapost);
assert(metapost.ok && metapostBody.svg?.includes("<svg"), `MetaPost compilation failed: ${JSON.stringify(metapostBody)}`);
assert(
  metapostBody.source?.includes("pair p[];") && !metapostBody.source?.includes("pair p0"),
  `MetaPost numeric-suffix declarations were not normalized: ${JSON.stringify(metapostBody)}`,
);

const tikz = await request("/api/tikz/compile", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    source: String.raw`\path[use as bounding box] (0,0) rectangle (5,3);
\fill[locusBg] (0,0) rectangle (5,3);
\node[locus label] at (2.5,1.5) {$\begin{aligned} f(x)&=x^2 \\ f'(x)&=2x \end{aligned}$};`,
  }),
});
const tikzBody = await json(tikz);
assert(tikz.ok && tikzBody.svg?.includes("<svg"), `TikZ compilation failed: ${JSON.stringify(tikzBody)}`);

const bobUser = adminUsers.users.find((user) => user.email === bob.email);
assert(bobUser?.id, "Bob was missing from account management");
const bobUserId = bobUser.id;
const replacementPassword = "bob-replacement-password-123";
const resetBobPassword = await request(`/api/admin/users/${bobUserId}/password`, {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({ password: replacementPassword }),
});
assert(resetBobPassword.ok, `Admin password reset failed: ${JSON.stringify(await json(resetBobPassword))}`);
assert((await request("/api/workspace", { cookie: bobCookie })).status === 401, "Password reset did not revoke existing sessions");
const replacementBob = { ...bob, password: replacementPassword };
const replacementBobCookie = await signIn(replacementBob);

const disableBob = await request(`/api/admin/users/${bobUserId}`, {
  method: "PATCH",
  cookie: aliceCookie,
  body: JSON.stringify({ disabled: true }),
});
assert(disableBob.ok, `Admin could not disable an account: ${JSON.stringify(await json(disableBob))}`);
assert((await request("/api/workspace", { cookie: replacementBobCookie })).status === 401, "Disabling an account did not revoke its sessions");
const disabledSignIn = await request("/api/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: bob.email, password: replacementPassword }),
});
assert(!disabledSignIn.ok, "A disabled account could still sign in");

const enableBob = await request(`/api/admin/users/${bobUserId}`, {
  method: "PATCH",
  cookie: aliceCookie,
  body: JSON.stringify({ disabled: false }),
});
assert(enableBob.ok, `Admin could not enable an account: ${JSON.stringify(await json(enableBob))}`);
await signIn(replacementBob);

const deleteBob = await request(`/api/admin/users/${bobUserId}`, {
  method: "DELETE",
  cookie: aliceCookie,
});
assert(deleteBob.status === 204, `Admin could not delete an account: ${JSON.stringify(await json(deleteBob))}`);
const finalUsers = await json(await request("/api/admin/users", { cookie: aliceCookie }));
assert(finalUsers.users?.length === 1 && finalUsers.users[0].email === alice.email, "Deleted account remained in account management");

console.log("Hosted integration checks passed: self-service accounts, admin accounts, auth, sharing, isolation, conflicts, CSRF, encrypted BYOK, and MetaPost");
