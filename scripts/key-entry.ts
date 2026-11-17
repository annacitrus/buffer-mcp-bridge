import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Vault, redact, SafeError } from "../src/security.js";
import { connect } from "../src/upstream.js";

// Temporary local equivalent of the masked CLI probe. No registry/admin actions,
// no writes to Buffer, no public listener, and no credential-read endpoint.
const origin = "http://127.0.0.1:8787";
const nonceFile = "secrets/key-entry-csrf.txt";
const nonce = existsSync(nonceFile)
  ? readFileSync(nonceFile, "utf8").trim()
  : randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/.test(nonce))
  throw new Error("Invalid private setup form token.");
if (!existsSync(nonceFile))
  writeFileSync(nonceFile, nonce, { mode: 0o600, flag: "wx" });
const vault = new Vault(
  JSON.parse(readFileSync("secrets/encryption-keys.json", "utf8")),
  "v1",
);
const path = "secrets/setup-accounts.json";
const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: false,
    referrerPolicy: { policy: "same-origin" },
  }),
);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (
    req.headers.host !== "127.0.0.1:8787" ||
    (req.headers.origin && req.headers.origin !== origin)
  ) {
    writeFileSync(
      "secrets/key-entry-status.json",
      JSON.stringify({
        reason: "host_or_origin",
        host: req.headers.host,
        origin: req.headers.origin,
        site: req.headers["sec-fetch-site"],
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return res
      .status(403)
      .type("html")
      .send(
        page(
          '<h2>Use the private setup address</h2><p>Open <a href="http://127.0.0.1:8787/">the fresh local form</a> and submit from there.</p>',
        ),
      );
  }
  next();
});
app.use(
  rateLimit({
    windowMs: 60000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(express.urlencoded({ extended: false, limit: "12kb" }));
const escape = (x: string) =>
  x.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const page = (content: string) =>
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buffer Bridge — private key entry</title><style>body{font:17px system-ui;background:#f5f5ee;color:#173f35;margin:60px auto;max-width:680px;padding:24px}section{background:white;padding:28px;border-radius:15px}input{box-sizing:border-box;display:block;width:100%;padding:12px;margin:8px 0 22px;font:inherit}button{background:#174f3c;color:white;border:0;border-radius:8px;padding:13px 20px;font:inherit}p{line-height:1.5}</style><h1>Buffer Bridge setup</h1><section>' +
  content +
  "</section><p>This temporary page runs only on your laptop. No key is displayed or sent to chat.</p></html>";
app.get("/", (_req, res) =>
  res
    .type("html")
    .send(
      page(
        '<p>Enter one Buffer API key at a time. The bridge will verify it with a read-only <code>get_account</code> call and store an encrypted local copy for setup.</p><form method="post" action="/verify"><input type="hidden" name="csrf" value="' +
          nonce +
          '"><label>Account label (spaces allowed)<input name="alias" maxlength="48" required autocomplete="off"></label><label>Buffer API key<input type="password" name="key" required autocomplete="off" spellcheck="false" maxlength="4096"></label><button>Verify and save encrypted key</button></form>',
      ),
    ),
);
let busy = false;
app.post("/verify", async (req, res) => {
  if (req.headers.origin !== origin || req.body.csrf !== nonce) {
    writeFileSync(
      "secrets/key-entry-status.json",
      JSON.stringify({
        reason: req.headers.origin !== origin ? "origin" : "stale_form",
        origin: req.headers.origin,
        site: req.headers["sec-fetch-site"],
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return res
      .status(403)
      .type("html")
      .send(
        page(
          '<h2>The setup form needs refreshing</h2><p>No key was saved. Open <a href="/">a fresh form</a>, then enter it again.</p>',
        ),
      );
  }
  const { alias, key } = req.body;
  if (
    typeof alias !== "string" ||
    !/^[a-z0-9][a-z0-9 _-]{0,47}$/.test(alias) ||
    typeof key !== "string" ||
    !key ||
    key.length > 4096
  )
    return res
      .status(400)
      .send(page('<p>Enter a valid label and key.</p><a href="/">Return</a>'));
  if (busy)
    return res
      .status(429)
      .send(
        page(
          "<p>A verification is already running. Please wait and return.</p>",
        ),
      );
  busy = true;
  let remote;
  try {
    const saved: any[] = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : [];
    if (saved.some((a) => a.alias === alias))
      throw new SafeError("LABEL_ALREADY_STAGED", 409);
    remote = await connect(key);
    const tools = await remote.catalog();
    const get = tools.find((t) => t.name === "get_account");
    if (!get || !new Ajv2020({ strict: false }).compile(get.inputSchema)({}))
      throw new SafeError("LIVE_GET_ACCOUNT_SCHEMA_CHANGED");
    const account = await remote.call("get_account", {});
    if (account.isError)
      throw new SafeError("BUFFER_ACCOUNT_VERIFICATION_FAILED", 502);
    const id = randomUUID(),
      context = "local-setup:" + id;
    saved.push({
      id,
      alias,
      credential_context: context,
      credential_ciphertext: vault.seal(
        { kind: "api_key", value: key },
        context,
      ),
      tools: redact(tools, [key]),
      account: redact(account, [key]),
      verified_at: new Date().toISOString(),
    });
    writeFileSync(path, JSON.stringify(saved, null, 2), { mode: 0o600 });
    res
      .type("html")
      .send(
        page(
          "<h2>Key verified and encrypted</h2><p>Saved label: <strong>" +
            escape(alias) +
            '</strong>.</p><p>The complete live catalog was captured. No posts were created or changed.</p><p><a href="/">Enter another account key</a></p><p>After entering all your accounts, return to the chat and say <strong>keys entered</strong>.</p>',
        ),
      );
  } catch (e) {
    res
      .status(e instanceof SafeError ? e.status : 502)
      .type("html")
      .send(
        page(
          "<h2>Verification did not complete</h2><p>" +
            escape(
              e instanceof SafeError ? e.code : "BUFFER_CONNECTION_FAILED",
            ) +
            '</p><p>Check the key and account, then <a href="/">try again</a>.</p>',
        ),
      );
  } finally {
    await remote?.close().catch(() => {});
    busy = false;
  }
});
const server = app.listen(8787, "127.0.0.1", () =>
  console.log("Private masked key-entry page ready on loopback port 8787."),
);
const ttl = setTimeout(() => server.close(), 20 * 60 * 1000);
ttl.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearTimeout(ttl);
    server.close();
  });
