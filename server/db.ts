import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { databaseUrl, isHosted } from "./config.ts";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!isHosted || !databaseUrl) {
    throw new Error("PostgreSQL is only available in hosted mode");
  }
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}
export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, values);
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
