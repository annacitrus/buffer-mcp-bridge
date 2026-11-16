import pg from "pg";
import { configuration } from "./config.js";
import { Contract } from "./contract.js";
import { Store } from "./store.js";
import { Upstreams } from "./upstream.js";
import { Bridge } from "./bridge.js";
import { authentication } from "./auth.js";
import { application } from "./app.js";
import { SafeError } from "./security.js";
try {
  const config = configuration();
  const db = new pg.Pool({
    connectionString: config.database,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  db.on("error", () => console.error("database_connection_error"));
  await db.query("SELECT id FROM owners LIMIT 1");
  const store = new Store(db, config.vault),
    upstreams = new Upstreams(store, Contract.load(config.contract));
  const auth = await authentication(config);
  const app = application(config, store, new Bridge(store, upstreams), auth);
  const server = app.listen(config.port, "0.0.0.0", () =>
    console.info("bridge_listening"),
  );
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  const cleanup = setInterval(
    () =>
      void db
        .query("DELETE FROM web_sessions WHERE expires_at<now()")
        .catch(() => {}),
    60000,
  );
  cleanup.unref();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const force = setTimeout(() => process.exit(1), 45000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await upstreams.close();
    await db.end();
    clearTimeout(force);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
} catch (e) {
  console.error(
    e instanceof SafeError
      ? e.code
      : "startup_failed_check_private_configuration",
  );
  process.exitCode = 1;
}
