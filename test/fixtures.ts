// Fictional upstream responses/schemas for isolation tests. Never deploy as Buffer's contract.
import { newDb, DataType } from "pg-mem";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault, SafeError } from "../src/security.js";
import { Store } from "../src/store.js";
import { Contract, APPROVED, type ContractData } from "../src/contract.js";
import { Upstreams, type Remote } from "../src/upstream.js";
import { Bridge } from "../src/bridge.js";
export const ownerSubject = "test-owner";
const object = (properties: any = {}, required = Object.keys(properties)) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" };
export const contractData: ContractData = {
  verifiedAt: "2026-11-16T00:00:00Z",
  shape: {
    account: "/account",
    accountId: "/id",
    email: "/email",
    name: "/name",
    organizations: "/organizations",
    organizationId: "/id",
    organizationName: "/name",
    channels: "/channels",
    channelId: "/id",
    channelName: "/name",
    pageInfo: "/pageInfo",
    postChannelId: "/post/channel/id",
  },
  tools: APPROVED.map((name) => ({
    name,
    description: "Mock " + name,
    inputSchema:
      name === "get_account"
        ? object()
        : name === "list_channels" || name === "list_posts"
          ? object({ organizationId: str })
          : name === "get_channel"
            ? object({ channelId: str })
            : name === "create_post"
              ? object(
                  {
                    channelId: str,
                    saveToDraft: { type: "boolean" },
                    text: str,
                    mode: str,
                  },
                  ["channelId", "saveToDraft", "text"],
                )
              : name === "edit_post"
                ? object({ postId: str, text: str }, ["postId"])
                : object({ postId: str }),
  })),
};
export function mock(key: string, calls: any[], faults: Set<string>): Remote {
  let closed = false;
  const name = key.split("-")[0]!;
  return {
    async catalog() {
      return structuredClone(contractData.tools);
    },
    async close() {
      closed = true;
      calls.push({ key, closed: true });
    },
    async call(tool, args) {
      if (closed) throw new Error("closed");
      calls.push({ key, tool, args });
      if (faults.has(key)) throw new SafeError("INVALID_BUFFER_KEY", 401);
      if (tool === "get_channel" && args.channelId !== name + "-channel")
        return {
          isError: true,
          content: [{ type: "text", text: "forbidden" }],
        };
      if (tool === "get_post" && args.postId !== name + "-post")
        return {
          isError: true,
          content: [{ type: "text", text: "forbidden" }],
        };
      if (tool === "create_post" && faults.has("ambiguous"))
        throw new Error("socket disconnected after dispatch");
      const data =
        tool === "get_account"
          ? {
              account: { id: name, email: name + "@example.invalid", name },
              organizations: [
                { id: name + "-org", name: "Identical organization name" },
              ],
            }
          : tool === "list_channels"
            ? {
                channels: [{ id: name + "-channel", name: "channel" }],
                pageInfo: { hasNextPage: false },
              }
            : tool === "get_post"
              ? {
                  post: { id: args.postId, channel: { id: name + "-channel" } },
                }
              : { ok: true, keyUsedForTest: key };
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        _meta: { quota: { remaining: 99 } },
      };
    },
  };
}
export async function fixture() {
  let db: pg.Pool;
  let schema: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    schema = "test_" + randomUUID().replaceAll("-", "");
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await root.query("CREATE SCHEMA " + schema);
    await root.end();
    db = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c search_path=" + schema,
    });
  } else {
    const memory = newDb();
    memory.public.registerFunction({
      name: "now",
      returns: DataType.timestamptz,
      implementation: () => new Date(),
      impure: true,
    });
    const adapter = memory.adapters.createPg();
    db = new adapter.Pool() as unknown as pg.Pool;
  }
  await db.query(
    await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const vault = new Vault({ v1: randomBytes(32).toString("base64") }, "v1"),
    store = new Store(db, vault),
    owner = await store.owner(ownerSubject),
    other = await store.owner("other-owner");
  const contract = new Contract(structuredClone(contractData)),
    calls: any[] = [],
    faults = new Set<string>();
  const upstreams = new Upstreams(store, contract, async (key) =>
    mock(key, calls, faults),
  );
  const bridge = new Bridge(store, upstreams);
  const add = async (name: string) =>
    store.save(owner, name, name + "-key", {
      id: name,
      email: name + "@example.invalid",
      name,
      organizations: [{ id: name + "-org", name: "Same" }],
      channels: [
        {
          id: name + "-channel",
          name: "Channel",
          organizationId: name + "-org",
        },
      ],
    });
  const a = await add("a"),
    b = await add("b");
  const close = async () => {
    await upstreams.close();
    await db.end();
    if (schema) {
      const root = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await root.query("DROP SCHEMA " + schema + " CASCADE");
      await root.end();
    }
  };
  return {
    db,
    vault,
    store,
    owner,
    other,
    contract,
    calls,
    faults,
    upstreams,
    bridge,
    a,
    b,
    add,
    close,
  };
}
