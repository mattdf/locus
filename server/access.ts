import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { publicOrigin } from "./config.ts";
import { query, transaction } from "./db.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AccessError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AccessPolicy {
  publicSignupEnabled: boolean;
  signupMode: "public" | "waitlist";
}

export interface PublicInvite {
  valid: boolean;
  email: string | null;
  expiresAt: Date | null;
  managedProvider: string | null;
  managedCredentialLabel: string | null;
}

export interface InviteSummary {
  id: string;
  email: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  usedAt: Date | null;
  usedByEmail: string | null;
  managedCredentialId: string | null;
  managedCredentialLabel: string | null;
  managedProvider: string | null;
  managedCredentialRevokedAt: Date | null;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  status: "waiting" | "invited" | "registered";
  createdAt: Date;
  updatedAt: Date;
}

type CreatedAccount = { id: string; email: string };

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new AccessError(400, "INVALID_EMAIL", "Enter a valid email address");
  }
  return email;
}

function inviteHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function assertInviteToken(token: string): void {
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    throw new AccessError(404, "INVITE_NOT_FOUND", "This invite is invalid or no longer available");
  }
}

function inviteUsable(row: {
  revokedAt: Date | null;
  usedAt: Date | null;
  expiresAt: Date | null;
}): boolean {
  return !row.revokedAt && !row.usedAt && (!row.expiresAt || row.expiresAt.getTime() > Date.now());
}

export async function getAccessPolicy(): Promise<AccessPolicy> {
  const result = await query<{ publicSignupEnabled: boolean }>(
    `select "publicSignupEnabled" from "locus_instance_settings" where "id" = true`,
  );
  const publicSignupEnabled = result.rows[0]?.publicSignupEnabled ?? true;
  return {
    publicSignupEnabled,
    signupMode: publicSignupEnabled ? "public" : "waitlist",
  };
}

export async function updateAccessPolicy(
  publicSignupEnabled: boolean,
  administratorUserId: string,
): Promise<AccessPolicy> {
  await query(
    `insert into "locus_instance_settings" ("id", "publicSignupEnabled", "updatedByUserId", "updatedAt")
     values (true, $1, $2, current_timestamp)
     on conflict ("id") do update set
       "publicSignupEnabled" = excluded."publicSignupEnabled",
       "updatedByUserId" = excluded."updatedByUserId",
       "updatedAt" = current_timestamp`,
    [publicSignupEnabled, administratorUserId],
  );
  return getAccessPolicy();
}

export async function publicInvite(token: string): Promise<PublicInvite> {
  assertInviteToken(token);
  const result = await query<{
    email: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    usedAt: Date | null;
    managedProvider: string | null;
    managedCredentialLabel: string | null;
    managedCredentialRevokedAt: Date | null;
  }>(
    `select i."email", i."expiresAt", i."revokedAt", i."usedAt",
            c."provider" as "managedProvider", c."label" as "managedCredentialLabel",
            c."revokedAt" as "managedCredentialRevokedAt"
       from "locus_invites" i
       left join "locus_managed_credentials" c on c."id" = i."managedCredentialId"
      where i."tokenHash" = $1`,
    [inviteHash(token)],
  );
  const row = result.rows[0];
  if (!row || !inviteUsable(row)) {
    throw new AccessError(404, "INVITE_NOT_FOUND", "This invite is invalid or no longer available");
  }
  return {
    valid: true,
    email: row.email,
    expiresAt: row.expiresAt,
    managedProvider: row.managedCredentialRevokedAt ? null : row.managedProvider,
    managedCredentialLabel: row.managedCredentialRevokedAt ? null : row.managedCredentialLabel,
  };
}

export async function joinWaitlist(input: { email: string; name: string }): Promise<void> {
  const email = normalizedEmail(input.email);
  const name = input.name.trim();
  if (!name || name.length > 200) throw new AccessError(400, "INVALID_NAME", "Enter your name");
  const policy = await getAccessPolicy();
  if (policy.publicSignupEnabled) {
    throw new AccessError(409, "SIGNUP_OPEN", "Public signup is currently open; create an account instead");
  }
  await query(
    `insert into "locus_waitlist_entries" ("id", "email", "name")
     values ($1, $2, $3)
     on conflict ((lower("email"))) do update set
       "name" = excluded."name",
       "updatedAt" = current_timestamp`,
    [randomUUID(), email, name],
  );
}

export async function listWaitlist(): Promise<WaitlistEntry[]> {
  const result = await query<WaitlistEntry>(
    `select "id", "email", "name", "status", "createdAt", "updatedAt"
       from "locus_waitlist_entries"
      order by case "status" when 'waiting' then 0 when 'invited' then 1 else 2 end, "createdAt" asc`,
  );
  return result.rows;
}

export async function removeWaitlistEntry(id: string): Promise<boolean> {
  const result = await query(`delete from "locus_waitlist_entries" where "id" = $1`, [id]);
  return Boolean(result.rowCount);
}

export async function listInvites(): Promise<InviteSummary[]> {
  const result = await query<InviteSummary>(
    `select i."id", i."email", i."createdAt", i."expiresAt", i."revokedAt", i."usedAt",
            u."email" as "usedByEmail", i."managedCredentialId",
            c."label" as "managedCredentialLabel", c."provider" as "managedProvider",
            c."revokedAt" as "managedCredentialRevokedAt"
       from "locus_invites" i
       left join "user" u on u."id" = i."usedByUserId"
       left join "locus_managed_credentials" c on c."id" = i."managedCredentialId"
      order by i."createdAt" desc`,
  );
  return result.rows;
}

export async function createInvite(input: {
  administratorUserId: string;
  email?: string;
  expiresInDays?: number | null;
  managedCredentialId?: string | null;
}): Promise<{ invite: InviteSummary; url: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const email = input.email?.trim() ? normalizedEmail(input.email) : null;
  const expiresInDays = input.expiresInDays ?? 7;
  if (
    expiresInDays !== null &&
    (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)
  ) {
    throw new AccessError(400, "INVALID_EXPIRY", "Invite expiry must be between 1 and 365 days");
  }
  const managedCredentialId = input.managedCredentialId?.trim() || null;
  if (managedCredentialId) {
    const credential = await query<{ active: boolean }>(
      `select ("revokedAt" is null) as "active" from "locus_managed_credentials" where "id" = $1`,
      [managedCredentialId],
    );
    if (!credential.rows[0]?.active) {
      throw new AccessError(400, "INVALID_MANAGED_KEY", "Choose an active managed API key");
    }
  }
  await transaction(async (client) => {
    await client.query(
      `insert into "locus_invites"
         ("id", "tokenHash", "email", "managedCredentialId", "createdByUserId", "expiresAt")
       values ($1, $2, $3, $4, $5,
         case when $6::integer is null then null else current_timestamp + make_interval(days => $6) end)`,
      [id, inviteHash(token), email, managedCredentialId, input.administratorUserId, expiresInDays],
    );
    if (email) {
      await client.query(
        `update "locus_waitlist_entries"
            set "status" = 'invited', "updatedAt" = current_timestamp
          where lower("email") = $1 and "status" <> 'registered'`,
        [email],
      );
    }
  });
  const invite = (await listInvites()).find((candidate) => candidate.id === id);
  if (!invite) throw new Error("The invite was created but could not be loaded");
  return { invite, url: `${publicOrigin}/?invite=${encodeURIComponent(token)}` };
}

export async function revokeInvite(id: string, administratorUserId: string): Promise<boolean> {
  return transaction(async (client) => {
    const result = await client.query<{ email: string | null }>(
      `update "locus_invites"
          set "revokedAt" = current_timestamp, "revokedByUserId" = $2
        where "id" = $1 and "revokedAt" is null and "usedAt" is null
        returning "email"`,
      [id, administratorUserId],
    );
    const email = result.rows[0]?.email;
    if (email) {
      await client.query(
        `update "locus_waitlist_entries" w
            set "status" = 'waiting', "updatedAt" = current_timestamp
          where lower(w."email") = lower($1) and w."status" = 'invited'
            and not exists (
              select 1 from "locus_invites" i
               where lower(i."email") = lower($1) and i."usedAt" is null and i."revokedAt" is null
                 and (i."expiresAt" is null or i."expiresAt" > current_timestamp)
            )`,
        [email],
      );
    }
    return Boolean(result.rowCount);
  });
}

async function lockedInvite(client: PoolClient, token: string) {
  assertInviteToken(token);
  const result = await client.query<{
    id: string;
    email: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    usedAt: Date | null;
    managedCredentialId: string | null;
    managedProvider: string | null;
    managedCredentialRevokedAt: Date | null;
  }>(
    `select i."id", i."email", i."expiresAt", i."revokedAt", i."usedAt", i."managedCredentialId",
            c."provider" as "managedProvider", c."revokedAt" as "managedCredentialRevokedAt"
       from "locus_invites" i
       left join "locus_managed_credentials" c on c."id" = i."managedCredentialId"
      where i."tokenHash" = $1
      for update of i`,
    [inviteHash(token)],
  );
  const invite = result.rows[0];
  if (!invite || !inviteUsable(invite)) {
    throw new AccessError(404, "INVITE_NOT_FOUND", "This invite is invalid or no longer available");
  }
  return invite;
}

export async function registerAccount(input: {
  email: string;
  inviteToken?: string;
  createAccount: () => Promise<CreatedAccount>;
}): Promise<CreatedAccount> {
  const email = normalizedEmail(input.email);
  let createdUserId: string | null = null;
  try {
    return await transaction(async (client) => {
      if (input.inviteToken) {
        const invite = await lockedInvite(client, input.inviteToken);
        if (invite.email && invite.email.toLowerCase() !== email) {
          throw new AccessError(403, "INVITE_EMAIL_MISMATCH", "This invite is for a different email address");
        }
        const created = await input.createAccount();
        createdUserId = created.id;
        await client.query(
          `update "locus_invites"
              set "usedAt" = current_timestamp, "usedByUserId" = $2
            where "id" = $1`,
          [invite.id, created.id],
        );
        if (
          invite.managedCredentialId &&
          invite.managedProvider &&
          !invite.managedCredentialRevokedAt
        ) {
          await client.query(
            `insert into "locus_user_managed_credentials"
               ("ownerUserId", "provider", "managedCredentialId", "assignedByInviteId")
             values ($1, $2, $3, $4)
             on conflict ("ownerUserId", "provider") do update set
               "managedCredentialId" = excluded."managedCredentialId",
               "assignedByInviteId" = excluded."assignedByInviteId",
               "createdAt" = current_timestamp`,
            [created.id, invite.managedProvider, invite.managedCredentialId, invite.id],
          );
        }
        await client.query(
          `update "locus_waitlist_entries"
              set "status" = 'registered', "updatedAt" = current_timestamp
            where lower("email") = $1`,
          [email],
        );
        return created;
      }

      const policy = await client.query<{ publicSignupEnabled: boolean }>(
        `select "publicSignupEnabled" from "locus_instance_settings" where "id" = true for update`,
      );
      if (!(policy.rows[0]?.publicSignupEnabled ?? true)) {
        throw new AccessError(403, "PUBLIC_SIGNUP_DISABLED", "Public signup is closed; join the waitlist or use an invite link");
      }
      const created = await input.createAccount();
      createdUserId = created.id;
      await client.query(
        `update "locus_waitlist_entries"
            set "status" = 'registered', "updatedAt" = current_timestamp
          where lower("email") = $1`,
        [email],
      );
      return created;
    });
  } catch (error) {
    if (createdUserId) {
      await query(`delete from "user" where "id" = $1`, [createdUserId]).catch(() => undefined);
    }
    throw error;
  }
}
