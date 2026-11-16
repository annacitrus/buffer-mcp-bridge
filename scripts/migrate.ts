import pg from "pg";
import { readFile } from "node:fs/promises";
import { required } from "../src/config.js";
const db = new pg.Pool({ connectionString: required("DATABASE_URL") });
const c = await db.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(716231)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const name = "001_initial";
  if (
    !(await c.query("SELECT name FROM schema_migrations WHERE name=$1", [name]))
      .rowCount
  ) {
    await c.query(await readFile("migrations/001_initial.sql", "utf8"));
    await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
  }
  await c.query("COMMIT");
  console.log("Migrations complete.");
} catch {
  await c.query("ROLLBACK");
  console.error("Migration failed. Check private database configuration.");
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
