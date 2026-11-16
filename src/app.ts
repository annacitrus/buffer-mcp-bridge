import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { parseCookie } from "cookie";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./config.js";
import type { Authentication, LoginState } from "./auth.js";
import { Store, type Identity } from "./store.js";
import { Bridge } from "./bridge.js";
import { connect, identity } from "./upstream.js";
import { opaque, SafeError } from "./security.js";
import * as ui from "./admin.js";
import { randomUUID } from "node:crypto";
export function application(
  config: Config,
  store: Store,
  bridge: Bridge,
  auth: Authentication,
) {
  const app = express();
  app.disable("x-powered-by");
  // Direct HTTP is allowed only for loopback development; production terminates TLS at Caddy.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'"],
          formAction: ["'self'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity: config.local ? false : undefined,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.host !== new URL(config.base).host)
      return res.sendStatus(403);
    if (req.headers.origin && req.headers.origin !== config.base)
      return res.sendStatus(403);
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      await store.db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get("/style.css", (_req, res) => res.type("css").send(ui.stylesheet));
  const metadata = {
    resource: config.base + "/mcp",
    authorization_servers: [auth.issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "Multi-account Buffer bridge",
  };
  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    (_req, res) => res.json(metadata),
  );
  const limiter = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.use(["/mcp", "/auth", "/admin"], limiter);
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  const cookieName = config.local ? "bridge_session" : "__Host-bridge_session";
  const loginName = config.local ? "bridge_login" : "__Host-bridge_login";
  const cookieOptions = {
    httpOnly: true,
    secure: !config.local,
    sameSite: "lax" as const,
    path: "/",
  };
  app.get("/", (_req, res) => res.redirect("/admin"));
  app.get("/auth/login", async (_req, res) => {
    const state: LoginState = {
      state: opaque(),
      nonce: opaque(),
      verifier: opaque(),
    };
    const ticket = await store.session("login", state);
    res.cookie(loginName, ticket, { ...cookieOptions, maxAge: 600000 });
    res.redirect(await auth.login(state));
  });
  app.get("/auth/callback", async (req, res) => {
    const ticket = parseCookie(req.headers.cookie || "")[loginName];
    if (!ticket) throw new SafeError("LOGIN_SESSION_REQUIRED", 401);
    const state = await store.getSession<LoginState>(ticket, "login", true);
    res.clearCookie(loginName, cookieOptions);
    if (!state) throw new SafeError("LOGIN_EXPIRED", 401);
    const subject = await auth.callback(
        new URL(req.originalUrl, config.base),
        state.data,
      ),
      owner = await store.owner(subject);
    const session = await store.session(
      "admin",
      { csrf: opaque() },
      owner,
      28800,
    );
    res.cookie(cookieName, session, { ...cookieOptions, maxAge: 28800000 });
    res.redirect("/admin");
  });
  app.use(["/admin", "/auth/logout"], async (req, res, next) => {
    const id = parseCookie(req.headers.cookie || "")[cookieName];
    const session = id
      ? await store.getSession<{ csrf: string }>(id, "admin")
      : undefined;
    if (!session) return res.redirect("/auth/login");
    res.locals.owner = session.owner;
    res.locals.csrf = session.data.csrf;
    res.locals.session = id;
    if (
      req.method === "POST" &&
      (req.headers.origin !== config.base ||
        req.body.csrf !== session.data.csrf)
    )
      throw new SafeError("CSRF_REJECTED", 403);
    next();
  });
  app.post("/auth/logout", async (_req, res) => {
    await store.dropSession(res.locals.session);
    res.clearCookie(cookieName, cookieOptions);
    res.redirect("/");
  });
  app.get("/admin", async (_req, res) =>
    res
      .type("html")
      .send(ui.dashboard(await store.list(res.locals.owner), res.locals.csrf)),
  );
  app.get("/admin/add", async (req, res) => {
    const replace =
      typeof req.query.replace === "string"
        ? await store.account(res.locals.owner, req.query.replace, false)
        : undefined;
    res.type("html").send(ui.addForm(res.locals.csrf, replace));
  });
  app.post("/admin/verify", async (req, res) => {
    const { alias, api_key: key, replace } = req.body;
    if (
      typeof alias !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(alias) ||
      typeof key !== "string" ||
      !key ||
      key.length > 4096
    )
      throw new SafeError("INVALID_FORM");
    if (replace) await store.account(res.locals.owner, replace, false);
    const remote = await connect(key);
    let verified: Identity;
    try {
      bridge.upstreams.contract.match(await remote.catalog());
      verified = await identity(remote, bridge.upstreams.contract);
    } finally {
      await remote.close();
    }
    if (
      replace &&
      (await store.account(res.locals.owner, replace, false))
        .buffer_account_id !== verified.id
    )
      throw new SafeError("ROTATION_IDENTITY_MISMATCH", 409);
    const duplicate = (await store.list(res.locals.owner)).find(
      (a) => a.buffer_account_id === verified.id,
    );
    const ticket = await store.session(
      "onboarding",
      {
        alias,
        key,
        identity: verified,
        replace: duplicate?.id || replace || null,
      },
      res.locals.owner,
    );
    res
      .type("html")
      .send(
        ui.preview(
          verified,
          alias,
          ticket,
          res.locals.csrf,
          duplicate,
          replace,
        ),
      );
  });
  app.post("/admin/save", async (req, res) => {
    const ticket = typeof req.body.ticket === "string" ? req.body.ticket : "";
    const pending = await store.getSession<{
      alias: string;
      key: string;
      identity: Identity;
      replace: string | null;
    }>(ticket, "onboarding", true);
    if (!pending || pending.owner !== res.locals.owner)
      throw new SafeError("ONBOARDING_EXPIRED");
    const p = pending.data;
    if ((req.body.replace || null) !== p.replace)
      throw new SafeError("INVALID_REPLACEMENT");
    const id = await store.save(
      res.locals.owner,
      p.alias,
      p.key,
      p.identity,
      p.replace || undefined,
    );
    await bridge.upstreams.invalidate(res.locals.owner, id);
    await store.audit(
      res.locals.owner,
      id,
      "admin_save",
      randomUUID(),
      "completed",
    );
    res.redirect("/admin");
  });
  app.post("/admin/accounts/:id", async (req, res) => {
    if (req.body.action === "remove" && req.body.confirmation !== "REMOVE")
      throw new SafeError("REMOVAL_CONFIRMATION_REQUIRED");
    await store.change(
      res.locals.owner,
      req.params.id,
      req.body.action,
      req.body.alias,
    );
    await bridge.upstreams.invalidate(res.locals.owner, req.params.id);
    await store.audit(
      res.locals.owner,
      req.params.id,
      "admin_" + req.body.action,
      randomUUID(),
      "completed",
    );
    res.redirect("/admin");
  });
  app.all("/mcp", async (req, res) => {
    const header = req.headers.authorization;
    let subject: string;
    try {
      if (!header?.startsWith("Bearer ") || header.length > 16384)
        throw new SafeError("TOKEN_REQUIRED", 401);
      subject = await auth.bearer(header.slice(7));
    } catch {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
      );
      return res.status(401).json({ error: "invalid_token" });
    }
    const owner = await store.owner(subject);
    const handler = createMcpHandler(() => bridge.server(owner));
    await toNodeHandler(handler)(req, res, req.body);
  });
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const code = error instanceof SafeError ? error.code : "REQUEST_FAILED";
      if (!res.headersSent)
        res
          .status(error instanceof SafeError ? error.status : 500)
          .type("html")
          .send(
            ui.page(
              "Request could not complete",
              "<p>" +
                code.replace(/[^a-zA-Z0-9_-]/g, "") +
                '</p><p><a href="/admin">Return to accounts</a></p>',
            ),
          );
    },
  );
  return app;
}
