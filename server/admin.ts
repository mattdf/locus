import { auth } from "./auth.ts";
import { closePool, query } from "./db.ts";
import { isHosted } from "./config.ts";
import { assertMigrationsCurrent } from "./migrate.ts";

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

async function main(): Promise<void> {
  if (!isHosted || !auth) throw new Error("Admin commands require LOCUS_MODE=hosted");
  await assertMigrationsCurrent();
  const command = process.argv[2];
  if (command === "create-user") {
    const email = argument("email")?.toLowerCase();
    const name = argument("name");
    const password = process.env.LOCUS_ADMIN_PASSWORD;
    const role = argument("role") === "admin" ? "admin" : "user";
    if (!email || !name || !password) {
      throw new Error("Usage: LOCUS_ADMIN_PASSWORD=... npm run admin -- create-user --email ... --name ... [--role admin]");
    }
    const created = await auth.api.createUser({
      body: { email, name, password, role, data: { emailVerified: true } },
    });
    console.log(`Created ${created.user.email} (${role})`);
    return;
  }
  if (command === "disable-user") {
    const email = argument("email")?.toLowerCase();
    if (!email) throw new Error("Usage: npm run admin -- disable-user --email ...");
    const result = await query<{ id: string }>(
      `update "user" set "banned" = true, "banReason" = 'Disabled by administrator', "updatedAt" = current_timestamp
       where lower("email") = $1 returning "id"`,
      [email],
    );
    if (!result.rowCount) throw new Error("User not found");
    await query(`delete from "session" where "userId" = $1`, [result.rows[0].id]);
    console.log(`Disabled ${email} and revoked its sessions`);
    return;
  }
  if (command === "list-users") {
    const users = await query<{ email: string; name: string; role: string | null; banned: boolean | null }>(
      `select "email", "name", "role", "banned" from "user" order by "createdAt"`,
    );
    users.rows.forEach((user) => console.log(`${user.email}\t${user.role ?? "user"}\t${user.banned ? "disabled" : "active"}\t${user.name}`));
    return;
  }
  throw new Error("Commands: create-user, disable-user, list-users");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
