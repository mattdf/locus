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
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
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
      `select "ownerUserId", "provider", encode("ciphertext", 'escape') as "ciphertext"
       from "locus_provider_credentials"`,
    );
    assert(credentials.rowCount === 1, "Unexpected credential row count");
    assert(!credentials.rows[0].ciphertext.includes(dummyKey), "Provider credential was stored as plaintext");
    const customCredentials = await pool.query(
      `select encode("ciphertext", 'escape') as "ciphertext" from "locus_custom_providers"
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
  } finally {
    await pool.end();
  }
}

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
label(btex input \\(x^2\\) etex, (110,70)) withcolor locusInk;
setbounds currentpicture to unitsquare xscaled canvasWidth yscaled canvasHeight;`,
  }),
});
const metapostBody = await json(metapost);
assert(metapost.ok && metapostBody.svg?.includes("<svg"), `MetaPost compilation failed: ${JSON.stringify(metapostBody)}`);
assert(
  metapostBody.source?.includes("pair p[];") && !metapostBody.source?.includes("pair p0"),
  `MetaPost numeric-suffix declarations were not normalized: ${JSON.stringify(metapostBody)}`,
);

const invalidMetaPostDelimiter = await request("/api/metapost/compile", {
  method: "POST",
  cookie: aliceCookie,
  body: JSON.stringify({
    source: `numeric canvasWidth, canvasHeight;
canvasWidth := 220; canvasHeight := 120;
fill unitsquare xscaled canvasWidth yscaled canvasHeight withcolor locusBg;
label(btex \\(x^2 etex, (110,70)) withcolor locusInk;
setbounds currentpicture to unitsquare xscaled canvasWidth yscaled canvasHeight;`,
  }),
});
const invalidMetaPostDelimiterBody = await json(invalidMetaPostDelimiter);
assert(
  invalidMetaPostDelimiter.status === 400 &&
    String(invalidMetaPostDelimiterBody.error ?? "").includes("unclosed \\("),
  `Unbalanced MetaPost inline math was not rejected: ${JSON.stringify(invalidMetaPostDelimiterBody)}`,
);

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

console.log("Hosted integration checks passed: admin accounts, auth, sharing, isolation, conflicts, CSRF, encrypted BYOK, and MetaPost");
