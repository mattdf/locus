import { closePool } from "./db.ts";
import { runMigrations } from "./migrate.ts";

runMigrations()
  .then(() => console.log("Database migrations are current"))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
