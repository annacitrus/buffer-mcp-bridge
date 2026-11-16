import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fixture, contractData } from "./fixtures.js";
import { Vault, redact, SafeError } from "../src/security.js";
import { validateToken } from "../src/auth.js";
import { safeRead, identity, Upstreams } from "../src/upstream.js";
import { Bridge } from "../src/bridge.js";
import { Contract } from "../src/contract.js";
test("AES-GCM binds ciphertext to owner/account and rotation retains old decryption", () => {
  const keys = {
    v1: randomBytes(32).toString("base64"),
    v2: randomBytes(32).toString("base64"),
  };
  const v = new Vault(keys, "v1"),
    cipher = v.seal({ key: "sensitive" }, "owner:a");
  assert.equal(v.open<any>(cipher, "owner:a").key, "sensitive");
  assert.throws(() => v.open(cipher, "owner:b"));
  assert.throws(() => v.open(cipher.slice(0, -4) + "AAAA", "owner:a"));
  assert.equal(
    new Vault(keys, "v2").open<any>(cipher, "owner:a").key,
    "sensitive",
  );
  assert.deepEqual(
    redact(
      { authorization: "Bearer xx", text: "xx", nested: { api_key: "xx" } },
      ["xx"],
    ),
    {
      authorization: "[REDACTED]",
      text: "[REDACTED]",
      nested: { api_key: "[REDACTED]" },
    },
  );
});
test("registry supports third account, immutable rename, duplicate identity, owner scoping", async () => {
  const f = await fixture();
  try {
    await f.add("c");
    assert.equal((await f.store.list(f.owner)).length, 3);
    await f.store.change(f.owner, f.a, "rename", "ugc");
    assert.equal((await f.store.account(f.owner, f.a)).alias, "ugc");
    assert.equal((await f.store.list(f.other)).length, 0);
    await assert.rejects(f.store.account(f.other, f.a));
    await assert.rejects(f.add("a"), /DUPLICATE_IDENTITY/);
    const dump = JSON.stringify(
      (await f.db.query("SELECT * FROM buffer_accounts")).rows,
    );
    assert.ok(!dump.includes("a-key"));
    const listed = await f.bridge.call(f.owner, "bridge_list_accounts", {});
    assert.ok(!JSON.stringify(listed).includes("ciphertext"));
  } finally {
    await f.close();
  }
});
test("parallel calls isolate credentials, failed/disabled accounts do not affect others; rotation without restart", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.bridge.call(f.owner, "buffer_get_account", {
          account_id: i % 2 ? f.a : f.b,
          arguments: {},
        }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const s = results[i]!.structuredContent as any;
      assert.equal(s.source.id, i % 2 ? f.a : f.b);
      assert.equal(
        s.result.upstream.structuredContent.account.id,
        i % 2 ? "a" : "b",
      );
    }
    f.faults.add("a-key");
    assert.equal(
      (
        await f.bridge.call(f.owner, "buffer_get_account", {
          account_id: f.a,
          arguments: {},
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await f.bridge.call(f.owner, "buffer_get_account", {
          account_id: f.b,
          arguments: {},
        })
      ).isError,
      false,
    );
    await f.store.change(f.owner, f.a, "disable");
    assert.equal(
      (
        await f.bridge.call(f.owner, "buffer_get_account", {
          account_id: f.a,
          arguments: {},
        })
      ).isError,
      true,
    );
    await f.store.change(f.owner, f.a, "enable");
    const current = await f.store.account(f.owner, f.a);
    await f.store.save(
      f.owner,
      "a",
      "a-new-key",
      {
        id: "a",
        email: current.verified_email,
        name: "a",
        organizations: [],
        channels: [],
      },
      f.a,
    );
    assert.equal(
      (
        await f.bridge.call(f.owner, "buffer_get_account", {
          account_id: f.a,
          arguments: {},
        })
      ).isError,
      false,
    );
    assert.ok(f.calls.some((c) => c.key === "a-new-key"));
    assert.ok(f.calls.some((c) => c.key === "a-key" && c.closed));
  } finally {
    await f.close();
  }
});
test("wrong owner, organization, channel, post, destination and unapproved tools are rejected", async () => {
  const f = await fixture();
  try {
    for (const [name, args] of [
      ["list_channels", { organizationId: "b-org" }],
      ["get_channel", { channelId: "b-channel" }],
      ["get_post", { postId: "b-post" }],
      ["unknown", {}],
    ] as const) {
      const r = await f.bridge.call(f.owner, "buffer_" + name, {
        account_id: f.a,
        arguments: args,
      });
      assert.equal(r.isError, true);
    }
    assert.equal(
      (
        await f.bridge.call(f.other, "buffer_get_account", {
          account_id: f.a,
          arguments: {},
        })
      ).isError,
      true,
    );
    const edit = await f.bridge.call(f.owner, "buffer_edit_post", {
      account_id: f.a,
      arguments: { postId: "a-post", text: "new" },
      operation_id: randomUUID(),
      intent: "edit",
      destination_channel_id: "b-channel",
    });
    assert.equal(edit.isError, true);
    assert.ok(!f.calls.some((c) => c.tool === "edit_post"));
  } finally {
    await f.close();
  }
});
test("persistent operation records suppress duplicates and conflicts, encrypt results, never resend unknown", async () => {
  const f = await fixture();
  try {
    const input = {
      account_id: f.a,
      arguments: {
        channelId: "a-channel",
        saveToDraft: true,
        text: "PRIVATE POST",
      },
      operation_id: randomUUID(),
      destination_channel_id: "a-channel",
      intent: "draft",
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.bridge.call(f.owner, "buffer_create_post", input),
      ),
    );
    assert.ok(responses.every((x) => !x.isError));
    assert.equal(f.calls.filter((c) => c.tool === "create_post").length, 1);
    const conflict = await f.bridge.call(f.owner, "buffer_create_post", {
      ...input,
      arguments: { ...input.arguments, text: "different" },
    });
    assert.equal(conflict.isError, true);
    assert.ok(
      !JSON.stringify(
        (await f.db.query("SELECT * FROM write_operations")).rows,
      ).includes("PRIVATE POST"),
    );
    f.faults.add("ambiguous");
    const uncertain = { ...input, operation_id: randomUUID() };
    const first = await f.bridge.call(f.owner, "buffer_create_post", uncertain);
    assert.equal((first.structuredContent as any).result.status, "unknown");
    const duplicate = await f.bridge.call(
      f.owner,
      "buffer_create_post",
      uncertain,
    );
    assert.equal((duplicate.structuredContent as any).result.status, "unknown");
    assert.equal(f.calls.filter((c) => c.tool === "create_post").length, 2);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM write_operations WHERE operation_id=$1",
          [uncertain.operation_id],
        )
      ).rows[0].status,
      "unknown",
    );
    assert.ok(
      !(await f.db.query("SELECT * FROM audit_events")).rows.some((r) =>
        JSON.stringify(r).includes("PRIVATE POST"),
      ),
    );
  } finally {
    await f.close();
  }
});
test("create requires explicit draft/schedule/publish semantics and never changes arguments", async () => {
  const f = await fixture();
  try {
    const r = await f.bridge.call(f.owner, "buffer_create_post", {
      account_id: f.a,
      arguments: { channelId: "a-channel", saveToDraft: false, text: "x" },
      operation_id: randomUUID(),
      destination_channel_id: "a-channel",
      intent: "draft",
    });
    assert.equal(r.isError, true);
    assert.ok(!f.calls.some((c) => c.tool === "create_post"));
  } finally {
    await f.close();
  }
});
test("aggregate reads retain partial failures and account pagination", async () => {
  const f = await fixture();
  try {
    await f.add("c");
    f.faults.add("a-key");
    const r = await f.bridge.inventory(f.owner, undefined, 0, 2);
    assert.equal(r.accounts.length, 2);
    assert.equal(r.pagination.next_offset, 2);
    assert.ok(r.accounts.some((x) => x.error));
    assert.ok(r.accounts.some((x) => x.channels));
    const next = await f.bridge.inventory(f.owner, undefined, 2, 2);
    assert.equal(next.accounts.length, 1);
    assert.equal(next.pagination.next_offset, null);
  } finally {
    await f.close();
  }
});
test("safe read honors bounded Retry-After; auth failure is never retried", async () => {
  let calls = 0;
  const remote: any = {
    async call() {
      calls++;
      if (calls < 3)
        throw Object.assign(new Error(), { status: 429, retryAfter: 1 });
      return { content: [] };
    },
  };
  await safeRead(remote, "get_account", {});
  assert.equal(calls, 3);
  calls = 0;
  remote.call = async () => {
    calls++;
    throw Object.assign(new Error(), { status: 401 });
  };
  await assert.rejects(safeRead(remote, "get_account", {}));
  assert.equal(calls, 1);
  calls = 0;
  remote.call = async () => {
    calls++;
    throw Object.assign(new Error(), { status: 429, retryAfter: 60000 });
  };
  await assert.rejects(safeRead(remote, "get_account", {}));
  assert.equal(calls, 1);
});
test("OAuth audience, owner, scope, expiry and revocation checks fail closed", () => {
  const token = {
    active: true,
    sub: "owner",
    aud: "https://bridge.test/mcp",
    scope: "mcp",
    exp: Date.now() / 1000 + 60,
  };
  assert.equal(
    validateToken(token, "https://bridge.test/mcp", ["owner"]),
    "owner",
  );
  for (const override of [
    { active: false },
    { aud: "buffer" },
    { exp: 1 },
    { scope: "openid" },
    { sub: "attacker" },
    { nbf: Date.now() / 1000 + 100 },
  ])
    assert.throws(() =>
      validateToken({ ...token, ...override }, "https://bridge.test/mcp", [
        "owner",
      ]),
    );
});
test("unknown tools never enter allowlist, schema drift blocks connection", () => {
  const c = new Contract({
    ...structuredClone(contractData),
    tools: [
      ...contractData.tools,
      { name: "publish_everything", inputSchema: { type: "object" } },
    ],
  });
  assert.equal(c.tools.length, 8);
  assert.throws(() => c.validate("publish_everything", {}), SafeError);
  const drift = structuredClone(contractData.tools);
  drift[0]!.inputSchema = {
    type: "object",
    properties: { surprise: { type: "string" } },
  };
  assert.throws(() => c.match(drift), /UPSTREAM_SCHEMA_DRIFT/);
});

test("fresh inventory follows verified pagination and rejects cursor loops or unsupported pagination", async () => {
  const data = structuredClone(contractData);
  const t = data.tools.find((t) => t.name === "list_channels")!;
  t.inputSchema.properties = {
    organizationId: { type: "string" },
    first: { type: "integer" },
    after: { type: "string" },
  };
  const c = new Contract(data);
  let reads = 0;
  const r: any = {
    async call(name: string, args: any) {
      reads++;
      const value =
        name === "get_account"
          ? {
              account: { id: "a", name: "a", email: "a@test.invalid" },
              organizations: [{ id: "org", name: "org" }],
            }
          : {
              channels: [{ id: args.after ? "two" : "one", name: "channel" }],
              pageInfo: { hasNextPage: !args.after, endCursor: "cursor" },
            };
      return { content: [], structuredContent: value };
    },
  };
  const inventory = await identity(r, c);
  assert.equal(inventory.channels.length, 2);
  assert.equal(reads, 3);
  await assert.rejects(
    identity(r, new Contract(structuredClone(contractData))),
    /CHANNEL_PAGINATION_REQUIRES_CONTRACT_UPDATE/,
  );
  r.call = async (name: string) => ({
    content: [],
    structuredContent:
      name === "get_account"
        ? {
            account: { id: "a", name: "a", email: "a@test.invalid" },
            organizations: [{ id: "org", name: "org" }],
          }
        : { channels: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
  });
  await assert.rejects(identity(r, c), /CHANNEL_CURSOR_LOOP/);
});

test("completed and ambiguous operation replay does not require an upstream connection", async () => {
  const f = await fixture();
  let offline: Upstreams | undefined;
  try {
    const input = {
      account_id: f.a,
      arguments: { channelId: "a-channel", saveToDraft: true, text: "draft" },
      operation_id: randomUUID(),
      destination_channel_id: "a-channel",
      intent: "draft",
    };
    assert.equal(
      (await f.bridge.call(f.owner, "buffer_create_post", input)).isError,
      false,
    );
    offline = new Upstreams(f.store, f.contract, async () => {
      throw new Error("upstream offline");
    });
    const second = new Bridge(f.store, offline);
    assert.equal(
      (await second.call(f.owner, "buffer_create_post", input)).isError,
      false,
    );
    const pending = { ...input, operation_id: randomUUID() };
    await f.store.beginWrite(
      f.owner,
      f.a,
      pending.operation_id,
      "create_post",
      pending,
    );
    await f.store.unknownWrite(f.owner, pending.operation_id);
    const r = await second.call(f.owner, "buffer_create_post", pending);
    assert.equal((r.structuredContent as any).result.status, "unknown");
  } finally {
    await offline?.close();
    await f.close();
  }
});

test("separate bridge instances share persistent duplicate suppression", async () => {
  const f = await fixture();
  let other: Upstreams | undefined;
  try {
    const { mock } = await import("./fixtures.js");
    other = new Upstreams(f.store, f.contract, async (key) =>
      mock(key, f.calls, f.faults),
    );
    const second = new Bridge(f.store, other);
    const input = {
      account_id: f.a,
      arguments: { channelId: "a-channel", saveToDraft: true, text: "draft" },
      operation_id: randomUUID(),
      destination_channel_id: "a-channel",
      intent: "draft",
    };
    await Promise.all([
      f.bridge.call(f.owner, "buffer_create_post", input),
      second.call(f.owner, "buffer_create_post", input),
    ]);
    assert.equal(f.calls.filter((c) => c.tool === "create_post").length, 1);
    const read = await f.bridge.call(f.owner, "buffer_get_channel", {
      account_id: f.a,
      arguments: { channelId: "a-channel" },
    });
    assert.ok(
      !JSON.stringify(read).includes("a-key"),
      "upstream echoed keys must be redacted",
    );
  } finally {
    await other?.close();
    await f.close();
  }
});
