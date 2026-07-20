import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "./db.ts";

async function migrationFiles() {
  const directory = path.resolve("migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function assertMigrationsCurrent(): Promise<void> {
  const expected = await migrationFiles();
  const result = await getPool().query<{ name: string; checksum: string }>(
    "select name, checksum from locus_schema_migrations order by name",
  ).catch(() => ({ rows: [] as Array<{ name: string; checksum: string }> }));
  const applied = new Map(result.rows.map((row) => [row.name, row.checksum]));
  const missing = expected.filter((migration) => applied.get(migration.name) !== migration.checksum);
  if (missing.length) {
    throw new Error(`Database migrations are not current: ${missing.map((item) => item.name).join(", ")}`);
  }
}

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [7_604_241_719]);
    await client.query(`
      create table if not exists locus_schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default current_timestamp
      )
    `);
    for (const { name, sql, checksum } of await migrationFiles()) {
      const existing = await client.query<{ checksum: string }>(
        "select checksum from locus_schema_migrations where name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "insert into locus_schema_migrations (name, checksum) values ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [7_604_241_719]).catch(() => undefined);
    client.release();
  }
}
