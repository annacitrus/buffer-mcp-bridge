import pg from "pg";
import { configuration } from "../src/config.js";
const config = configuration(),
  db = new pg.Pool({ connectionString: config.database }),
  c = await db.connect();
try {
  await c.query("BEGIN");
  await c.query(
    "LOCK TABLE buffer_accounts,write_operations,web_sessions IN EXCLUSIVE MODE",
  );
  for (const a of (await c.query("SELECT * FROM buffer_accounts")).rows) {
    const context = `credential:${a.owner_id}:${a.id}`;
    await c.query(
      "UPDATE buffer_accounts SET credential_ciphertext=$2,encryption_key_version=$3,credential_version=credential_version+1 WHERE id=$1",
      [
        a.id,
        config.vault.seal(
          config.vault.open(a.credential_ciphertext, context),
          context,
        ),
        config.vault.active,
      ],
    );
  }
  for (const op of (
    await c.query(
      "SELECT * FROM write_operations WHERE result_ciphertext IS NOT NULL",
    )
  ).rows) {
    const context = `operation:${op.owner_id}:${op.operation_id}`;
    await c.query(
      "UPDATE write_operations SET result_ciphertext=$3 WHERE owner_id=$1 AND operation_id=$2",
      [
        op.owner_id,
        op.operation_id,
        config.vault.seal(
          config.vault.open(op.result_ciphertext, context),
          context,
        ),
      ],
    );
  }
  for (const session of (await c.query("SELECT * FROM web_sessions")).rows) {
    const context = `session:${session.id_hash}`;
    await c.query("UPDATE web_sessions SET ciphertext=$2 WHERE id_hash=$1", [
      session.id_hash,
      config.vault.seal(
        config.vault.open(session.ciphertext, context),
        context,
      ),
    ]);
  }
  await c.query("COMMIT");
  console.log(
    "All encrypted records rotated. Retain old keys for existing backups.",
  );
} catch {
  await c.query("ROLLBACK");
  console.error(
    "Rotation rolled back. Preserve old keyring and inspect database availability.",
  );
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
