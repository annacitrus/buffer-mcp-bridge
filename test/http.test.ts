import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fixture, ownerSubject } from "./fixtures.js";
import { application } from "../src/app.js";
import { SafeError } from "../src/security.js";
import { opaque } from "../src/security.js";
test("HTTP denies unauthenticated access, CSRF, hostile host/origin, and serves OAuth discovery", async () => {
  const f = await fixture();
  try {
    const config: any = { base: "http://localhost", local: true };
    const auth: any = {
      issuer: "https://issuer.example",
      async login() {
        return "https://issuer.example/authorize";
      },
      async bearer() {
        throw new SafeError("bad", 401);
      },
    };
    const app = application(config, f.store, f.bridge, auth);
    await request(app)
      .post("/mcp")
      .set("Host", "localhost")
      .send({})
      .expect(401)
      .expect("WWW-Authenticate", /resource_metadata/);
    await request(app)
      .get("/admin")
      .set("Host", "localhost")
      .expect(302)
      .expect("Location", "/auth/login");
    await request(app).get("/admin").set("Host", "evil.test").expect(403);
    await request(app)
      .get("/healthz")
      .set("Host", "localhost")
      .set("Origin", "https://evil.test")
      .expect(403);
    const metadata = await request(app)
      .get("/.well-known/oauth-protected-resource/mcp")
      .set("Host", "localhost")
      .expect(200);
    assert.equal(metadata.body.resource, "http://localhost/mcp");
    const token = await f.store.session(
      "admin",
      { csrf: "known-csrf" },
      f.owner,
      300,
    );
    const dashboard = await request(app)
      .get("/admin")
      .set("Host", "localhost")
      .set("Cookie", "bridge_session=" + token)
      .expect(200);
    assert.ok(dashboard.text.includes("a@example.invalid"));
    assert.ok(!dashboard.text.includes("a-key"));
    await request(app)
      .post("/admin/accounts/" + f.a)
      .set("Host", "localhost")
      .set("Cookie", "bridge_session=" + token)
      .set("Origin", "http://localhost")
      .type("form")
      .send({ action: "disable", csrf: "bad" })
      .expect(403);
    await request(app)
      .post("/admin/accounts/" + f.a)
      .set("Host", "localhost")
      .set("Cookie", "bridge_session=" + token)
      .set("Origin", "http://localhost")
      .type("form")
      .send({ action: "rename", alias: "ugc", csrf: "known-csrf" })
      .expect(302);
    assert.equal((await f.store.account(f.owner, f.a)).alias, "ugc");
    await request(app)
      .post("/auth/logout")
      .set("Host", "localhost")
      .set("Cookie", "bridge_session=" + token)
      .set("Origin", "http://localhost")
      .type("form")
      .send({ csrf: "known-csrf" })
      .expect(302);
    assert.equal(await f.store.getSession(token, "admin"), undefined);
  } finally {
    await f.close();
  }
});
test("official SDK initializes Streamable HTTP downstream and calls verified mock upstream wrappers", async () => {
  const f = await fixture();
  let server: any, client: Client | undefined;
  try {
    const config: any = { base: "http://127.0.0.1", local: true };
    const auth: any = {
      issuer: "https://issuer.example",
      async bearer(t: string) {
        if (t !== "bridge-test-token") throw new Error("bad");
        return ownerSubject;
      },
    };
    const app = application(config, f.store, f.bridge, auth);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    config.base = "http://127.0.0.1:" + server.address().port;
    client = new Client({ name: "acceptance-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.base + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer bridge-test-token" } },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    assert.ok(
      !tools.tools.some(
        (x) => x.name === "call_any_tool" || x.name.includes("admin"),
      ),
    );
    const r = await client.callTool({
      name: "buffer_get_account",
      arguments: { account_id: f.a, arguments: {} },
    });
    assert.equal((r.structuredContent as any).source.id, f.a);
    assert.equal(r.isError, false);
    await f.add("c");
    const accounts = await client.callTool({
      name: "bridge_list_accounts",
      arguments: {},
    });
    assert.equal((accounts.structuredContent as any).result.accounts.length, 3);
  } finally {
    await client?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
