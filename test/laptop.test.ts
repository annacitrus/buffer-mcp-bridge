import { test } from "node:test";
import assert from "node:assert/strict";
import { laptopConfiguration } from "../scripts/prepare-laptop.js";
test("laptop bootstrap binds exact issuer, resource audience, owner subject and PKCE clients", () => {
  const base = "https://test-device.tail-example.ts.net";
  const a = laptopConfiguration(base),
    b = laptopConfiguration(base);
  assert.equal(a.env.PUBLIC_URL, base);
  assert.equal(a.env.OIDC_ISSUER, base + "/identity/realms/buffer-bridge");
  assert.equal(a.env.INTROSPECTION_CLIENT_ID, base + "/mcp");
  assert.equal(a.realm.users[0]!.id, a.env.OWNER_SUBJECTS);
  assert.equal(a.realm.users[0]!.credentials[0]!.temporary, true);
  const claude = a.realm.clients.find(
    (c) => c.clientId === "claude-buffer-bridge",
  )!;
  assert.deepEqual(claude.redirectUris, [
    "https://claude.ai/api/mcp/auth_callback",
  ]);
  assert.equal((claude.attributes as Record<string,string>)["pkce.code.challenge.method"], "S256");
  assert.equal(claude.directAccessGrantsEnabled, false);
  assert.equal(claude.implicitFlowEnabled, false);
  assert.equal(a.realm.registrationAllowed, false);
  assert.equal(a.realm.bruteForceProtected, true);
  assert.notEqual(a.env.DATABASE_URL, b.env.DATABASE_URL);
  assert.notEqual(a.env.OIDC_CLIENT_SECRET, b.env.OIDC_CLIENT_SECRET);
  assert.equal(
    a.credentials.claude_oauth_client_secret,
    (claude as any).secret,
  );
  assert.ok(!JSON.stringify(a).includes("BUFFER_API_KEY"));
});
test("laptop setup rejects non-HTTPS, non-Tailscale, URL credentials, paths and nonstandard ports", () => {
  for (const url of [
    "http://device.ts.net",
    "https://device.example.com",
    "https://device.ts.net/admin",
    "https://user:password@device.ts.net",
    "https://device.ts.net:8443",
    "https://device.ts.net?token=bad",
  ])
    assert.throws(() => laptopConfiguration(url));
});
