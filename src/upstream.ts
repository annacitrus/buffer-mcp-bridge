import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { SafeError, redact } from "./security.js";
import { Contract, body, pointer, nonempty } from "./contract.js";
import type { Identity, Store, Account } from "./store.js";
export const BUFFER_URL = "https://mcp.buffer.com/mcp";
export interface Remote {
  catalog(): Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface UpstreamFailure extends Error {
  status?: number;
  retryAfter?: number;
}
export async function connect(key: string): Promise<Remote> {
  const client = new Client({
    name: "personal-buffer-bridge",
    version: "0.1.0",
  });
  const boundedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    if (url.origin !== new URL(BUFFER_URL).origin)
      throw new SafeError("UPSTREAM_REDIRECT_BLOCKED", 502);
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(30000),
      ]),
    });
    if (!response.ok) {
      const e = new SafeError(
        "BUFFER_HTTP_" + response.status,
        502,
      ) as UpstreamFailure;
      e.status = response.status;
      const retry = response.headers.get("retry-after");
      if (retry)
        e.retryAfter = /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Math.max(0, Date.parse(retry) - Date.now());
      throw e;
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(BUFFER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: boundedFetch,
  });
  try {
    await client.connect(transport);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    async catalog() {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const p = await client.listTools(cursor ? { cursor } : {});
        tools.push(...p.tools);
        cursor = p.nextCursor;
        if (cursor && seen.has(cursor))
          throw new SafeError("CATALOG_CURSOR_LOOP", 502);
        if (cursor) seen.add(cursor);
      } while (cursor);
      return tools;
    },
    async call(name, args) {
      return redact(
        await client.callTool({ name, arguments: args }, { timeout: 30000 }),
        [key],
      );
    },
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
export async function safeRead(
  remote: Remote,
  name: string,
  args: Record<string, unknown>,
) {
  for (let attempt = 0; ; attempt++)
    try {
      return await remote.call(name, args);
    } catch (e) {
      const failure = e as UpstreamFailure;
      if (attempt >= 2 || ![429, 502, 503, 504].includes(failure.status || 0))
        throw e;
      const wait =
        failure.retryAfter ?? 200 * 2 ** attempt + Math.random() * 100;
      if (!Number.isFinite(wait) || wait > 5000) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
}
export async function identity(
  remote: Remote,
  contract: Contract,
): Promise<Identity> {
  const s = contract.shape;
  contract.validate("get_account", {});
  const root = body(await safeRead(remote, "get_account", {})),
    account = pointer(root, s.account),
    orgs = pointer(root, s.organizations);
  if (!Array.isArray(orgs))
    throw new SafeError("UPSTREAM_ORGANIZATIONS_SHAPE", 502);
  const organizations = orgs.map((o) => ({
    id: nonempty(pointer(o, s.organizationId)),
    name: nonempty(pointer(o, s.organizationName)),
  }));
  const channels: Identity["channels"] = [];
  for (const o of organizations) {
    const properties =
      contract.tools.find((t) => t.name === "list_channels")!.inputSchema
        .properties ?? {};
    const paginated = Object.hasOwn(properties, "after");
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      // Pagination inputs are used only when present in the verified live schema.
      const args = {
        organizationId: o.id,
        ...(Object.hasOwn(properties, "first") ? { first: 100 } : {}),
        ...(after ? { after } : {}),
      };
      contract.validate("list_channels", args);
      const result = body(await safeRead(remote, "list_channels", args));
      const list = pointer(result, s.channels);
      if (!Array.isArray(list))
        throw new SafeError("UPSTREAM_CHANNELS_SHAPE", 502);
      const page = pointer(result, s.pageInfo);
      for (const ch of list)
        channels.push({
          id: nonempty(pointer(ch, s.channelId)),
          organizationId: o.id,
          name: nonempty(pointer(ch, s.channelName)),
        });
      const more = page?.hasNextPage === true || !!page?.nextCursor;
      if (more && !paginated)
        throw new SafeError("CHANNEL_PAGINATION_REQUIRES_CONTRACT_UPDATE", 502);
      after = more ? nonempty(page.nextCursor ?? page.endCursor) : undefined;
      if (after && seen.has(after))
        throw new SafeError("CHANNEL_CURSOR_LOOP", 502);
      if (after) seen.add(after);
    } while (after);
  }
  return {
    id: nonempty(pointer(account, s.accountId)),
    email: nonempty(pointer(account, s.email)),
    name: nonempty(pointer(account, s.name)),
    organizations,
    channels,
  };
}
// One lane per immutable owner/account: concurrency=1. Connections are lazy and bounded.
export class Upstreams {
  private lanes = new Map<
    string,
    { tail: Promise<unknown>; pending: number }
  >();
  private clients = new Map<
    string,
    { version: number; remote: Remote; used: number }
  >();
  private connecting = 0;
  private sweeper: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    readonly contract: Contract,
    readonly factory = connect,
    readonly maxClients = 32,
  ) {
    this.sweeper = setInterval(() => {
      for (const [k, v] of this.clients)
        if (Date.now() - v.used > 60000 && !this.lanes.get(k)?.pending) {
          this.clients.delete(k);
          void v.remote.close();
        }
    }, 30000);
    this.sweeper.unref();
  }
  async with<T>(
    owner: string,
    id: string,
    fn: (r: Remote, a: Account) => Promise<T>,
  ): Promise<T> {
    const k = owner + ":" + id;
    let lane = this.lanes.get(k);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0 };
      this.lanes.set(k, lane);
    }
    if (lane.pending >= 32) throw new SafeError("ACCOUNT_BUSY", 429);
    lane.pending++;
    const run = lane.tail
      .catch(() => {})
      .then(async () => {
        const a = await this.store.account(owner, id);
        let c = this.clients.get(k);
        if (c && c.version !== a.credential_version) {
          this.clients.delete(k);
          await c.remote.close();
          c = undefined;
        }
        if (!c) {
          if (this.clients.size + this.connecting >= this.maxClients) {
            const idle = [...this.clients].find(
              ([key]) => !this.lanes.get(key)?.pending,
            );
            if (!idle) throw new SafeError("UPSTREAM_POOL_BUSY", 503);
            this.clients.delete(idle[0]);
            await idle[1].remote.close();
          }
          this.connecting++;
          try {
            const key = this.store.key(a);
            const created = await this.factory(key);
            const remote: Remote = {
              catalog: () => created.catalog(),
              call: async (name, args) =>
                redact(await created.call(name, args), [key]),
              close: () => created.close(),
            };
            try {
              this.contract.match(await remote.catalog());
            } catch (e) {
              await remote.close();
              throw e;
            }
            c = { version: a.credential_version, remote, used: Date.now() };
            this.clients.set(k, c);
          } finally {
            this.connecting--;
          }
        }
        c.used = Date.now();
        try {
          return await fn(c.remote, a);
        } finally {
          c.used = Date.now();
        }
      });
    lane.tail = run;
    try {
      return await run;
    } finally {
      lane.pending--;
      if (!lane.pending) this.lanes.delete(k);
    }
  }
  async invalidate(owner: string, id: string) {
    const k = owner + ":" + id;
    const lane = this.lanes.get(k);
    const close = async () => {
      const c = this.clients.get(k);
      this.clients.delete(k);
      await c?.remote.close();
    };
    if (!lane) return close();
    // Queue invalidation in the same account lane, so it cannot close a new
    // connection while another request is dispatching on it.
    lane.pending++;
    const cleanup = lane.tail.catch(() => {}).then(close);
    lane.tail = cleanup;
    try {
      await cleanup;
    } finally {
      lane.pending--;
      if (!lane.pending) this.lanes.delete(k);
    }
  }
  async close() {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.lanes.values()].map((x) => x.tail));
    await Promise.allSettled(
      [...this.clients.values()].map((x) => x.remote.close()),
    );
    this.clients.clear();
  }
}
