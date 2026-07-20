import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.ts";
import { isHosted } from "./config.ts";
import { query } from "./db.ts";

type ManagedUserRow = {
  id: string;
  email: string;
  name: string;
  role: string | null;
  disabled: boolean;
  createdAt: Date;
  activeSessions: number;
};

function isAdministrator(role: unknown): boolean {
  return typeof role === "string" && role.split(",").includes("admin");
}

function currentAdmin(response: express.Response): { id: string; email: string } | null {
  const user = response.locals.user as { id?: unknown; email?: unknown; role?: unknown } | undefined;
  if (
    typeof user?.id !== "string" ||
    typeof user.email !== "string" ||
    !isAdministrator(user.role)
  ) {
    return null;
  }
  return { id: user.id, email: user.email };
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

async function managedUser(userId: string): Promise<ManagedUserRow | null> {
  const result = await query<ManagedUserRow>(
    `select u."id", u."email", u."name", u."role",
            coalesce(u."banned", false) as "disabled", u."createdAt",
            count(s."id")::int as "activeSessions"
     from "user" u
     left join "session" s on s."userId" = u."id" and s."expiresAt" > current_timestamp
     where u."id" = $1
     group by u."id"`,
    [userId],
  );
  return result.rows[0] ?? null;
}

function requireAdmin(response: express.Response): { id: string; email: string } | null {
  if (!isHosted || !auth) {
    response.status(404).json({ error: "Not found" });
    return null;
  }
  const admin = currentAdmin(response);
  if (!admin) {
    response.status(403).json({ error: "Administrator access required" });
    return null;
  }
  return admin;
}

export const adminRouter = express.Router();

adminRouter.get("/users", async (_request, response) => {
  if (!requireAdmin(response)) return;
  const users = await query<ManagedUserRow>(
    `select u."id", u."email", u."name", u."role",
            coalesce(u."banned", false) as "disabled", u."createdAt",
            count(s."id")::int as "activeSessions"
     from "user" u
     left join "session" s on s."userId" = u."id" and s."expiresAt" > current_timestamp
     group by u."id"
     order by u."createdAt" asc`,
  );
  response.setHeader("Cache-Control", "no-store");
  response.json({ users: users.rows });
});

adminRouter.post("/users", async (request, response) => {
  const administrator = requireAdmin(response);
  if (!administrator || !auth) return;
  const email = typeof request.body?.email === "string"
    ? request.body.email.trim().toLowerCase()
    : "";
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const role = request.body?.role === "admin" ? "admin" : "user";
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    !name || name.length > 200 ||
    password.length < 12 || password.length > 128
  ) {
    response.status(400).json({ error: "Enter a valid email, name, and password of 12–128 characters" });
    return;
  }
  const existing = await query<{ exists: boolean }>(
    `select exists(select 1 from "user" where lower("email") = $1) as "exists"`,
    [email],
  );
  if (existing.rows[0]?.exists) {
    response.status(409).json({ error: "An account with that email already exists" });
    return;
  }
  const created = await auth.api.createUser({ body: { email, name, password, role } });
  const user = await managedUser(created.user.id);
  console.log(`[admin] ${administrator.email} created ${email} (${role})`);
  response.status(201).json({ user });
});

adminRouter.patch("/users/:userId", async (request, response) => {
  const administrator = requireAdmin(response);
  const userId = request.params.userId;
  if (!administrator) return;
  if (!validUserId(userId)) {
    response.status(400).json({ error: "Invalid account identifier" });
    return;
  }
  const target = await managedUser(userId);
  if (!target) {
    response.status(404).json({ error: "Account not found" });
    return;
  }

  const hasDisabled = typeof request.body?.disabled === "boolean";
  const hasRole = request.body?.role === "admin" || request.body?.role === "user";
  if (!hasDisabled && !hasRole) {
    response.status(400).json({ error: "Specify an account status or role" });
    return;
  }
  if (
    target.id === administrator.id &&
    ((hasDisabled && request.body.disabled) || (hasRole && request.body.role !== "admin"))
  ) {
    response.status(400).json({ error: "You cannot disable or demote your own administrator account" });
    return;
  }

  const targetRole = isAdministrator(target.role) ? "admin" : "user";
  if (hasRole && request.body.role !== targetRole) {
    await query(
      `update "user" set "role" = $2, "updatedAt" = current_timestamp where "id" = $1`,
      [target.id, request.body.role],
    );
    await query(`delete from "session" where "userId" = $1`, [target.id]);
  }
  if (hasDisabled) {
    await query(
      `update "user"
       set "banned" = $2,
           "banReason" = case when $2 then 'Disabled by administrator' else null end,
           "banExpires" = null,
           "updatedAt" = current_timestamp
       where "id" = $1`,
      [target.id, request.body.disabled],
    );
    if (request.body.disabled) {
      await query(`delete from "session" where "userId" = $1`, [target.id]);
    }
  }

  const user = await managedUser(target.id);
  console.log(`[admin] ${administrator.email} updated ${target.email}`);
  response.json({ user });
});

adminRouter.post("/users/:userId/password", async (request, response) => {
  const administrator = requireAdmin(response);
  const userId = request.params.userId;
  if (!administrator || !auth) return;
  if (!validUserId(userId)) {
    response.status(400).json({ error: "Invalid account identifier" });
    return;
  }
  if (userId === administrator.id) {
    response.status(400).json({ error: "Use a dedicated password-change flow for your own account" });
    return;
  }
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (password.length < 12 || password.length > 128) {
    response.status(400).json({ error: "Password must contain 12–128 characters" });
    return;
  }
  const target = await managedUser(userId);
  if (!target) {
    response.status(404).json({ error: "Account not found" });
    return;
  }
  await auth.api.setUserPassword({
    body: { userId, newPassword: password },
    headers: fromNodeHeaders(request.headers),
  });
  await query(`delete from "session" where "userId" = $1`, [userId]);
  console.log(`[admin] ${administrator.email} reset the password for ${target.email}`);
  response.json({ changed: true });
});

adminRouter.delete("/users/:userId", async (request, response) => {
  const administrator = requireAdmin(response);
  const userId = request.params.userId;
  if (!administrator) return;
  if (!validUserId(userId)) {
    response.status(400).json({ error: "Invalid account identifier" });
    return;
  }
  if (userId === administrator.id) {
    response.status(400).json({ error: "You cannot delete your own administrator account" });
    return;
  }
  const deleted = await query<{ email: string }>(
    `delete from "user" where "id" = $1 returning "email"`,
    [userId],
  );
  if (!deleted.rowCount) {
    response.status(404).json({ error: "Account not found" });
    return;
  }
  console.log(`[admin] ${administrator.email} deleted ${deleted.rows[0].email}`);
  response.status(204).end();
});
