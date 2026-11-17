import { randomUUID } from "node:crypto";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Store, publicAccount } from "./store.js";
import { Upstreams, identity, safeRead, type Remote } from "./upstream.js";
import { WRITES, body, pointer } from "./contract.js";
import { SafeError } from "./security.js";
const uuid = { type: "string", format: "uuid" };
const outputSchema = fromJsonSchema({
  type: "object",
  required: ["request_id", "source", "result"],
  properties: {
    request_id: uuid,
    source: { type: "object" },
    result: { type: "object" },
  },
  additionalProperties: false,
});
export class Bridge {
  constructor(
    readonly store: Store,
    readonly upstreams: Upstreams,
  ) {}
  async inventory(owner: string, filter?: string, offset = 0, limit = 50) {
    const all = filter
      ? [await this.store.account(owner, filter, false)]
      : await this.store.list(owner);
    const selected = all.slice(offset, offset + limit);
    const results: any[] = new Array(selected.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, selected.length) }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= selected.length) return;
          const a = selected[index]!;
          try {
            const data = await this.upstreams.with(owner, a.id, (r) =>
              identity(r, this.upstreams.contract),
            );
            results[index] = {
              source: publicAccount(a),
              organizations: data.organizations,
              channels: data.channels,
              pagination: { complete: true },
            };
          } catch (e) {
            results[index] = {
              source: publicAccount(a),
              error: e instanceof SafeError ? e.code : "UPSTREAM_UNAVAILABLE",
              pagination: { complete: false },
            };
          }
        }
      }),
    );
    const resources = new Map<string, Set<string>>();
    for (const row of results)
      for (const ch of row.channels || []) {
        const owners = resources.get(ch.id) || new Set<string>();
        owners.add(row.source.id);
        resources.set(ch.id, owners);
      }
    return {
      accounts: results,
      pagination: {
        offset,
        limit,
        total: all.length,
        next_offset: offset + limit < all.length ? offset + limit : null,
      },
      overlaps: [...resources]
        .filter(([, a]) => a.size > 1)
        .map(([channel_id, a]) => ({ channel_id, account_ids: [...a] })),
      overlap_scope: "current_page",
    };
  }
  async preflight(
    remote: Remote,
    tool: string,
    args: Record<string, any>,
    destination?: string,
  ) {
    const contract = this.upstreams.contract;
    const read = async (name: string, a: Record<string, unknown>) => {
      contract.validate(name, a);
      return body(await safeRead(remote, name, a));
    };
    if (args.organizationId) {
      const account = await read("get_account", {}),
        orgs = pointer(account, contract.shape.organizations);
      if (
        !Array.isArray(orgs) ||
        !orgs.some(
          (o) =>
            pointer(o, contract.shape.organizationId) === args.organizationId,
        )
      )
        throw new SafeError("ORGANIZATION_NOT_ACCESSIBLE", 403);
    }
    for (const ch of [
      ...(args.channelIds || []),
      ...(args.channelId ? [args.channelId] : []),
      ...(destination ? [destination] : []),
    ])
      await read("get_channel", { channelId: ch });
    for (const postId of [args.postId, args.draftId].filter(Boolean)) {
      const post = await read("get_post", { postId });
      if (
        destination &&
        pointer(post, contract.shape.postChannelId) !== destination
      )
        throw new SafeError("DESTINATION_MISMATCH", 403);
    }
    if (args.ideaId) throw new SafeError("IDEA_REFERENCES_NOT_APPROVED");
    if (tool === "create_post" && args.channelId !== destination)
      throw new SafeError("DESTINATION_MISMATCH");
  }
  async call(
    owner: string,
    name: string,
    input: any,
    request = randomUUID(),
  ): Promise<CallToolResult> {
    let source: Record<string, unknown> = {
      account_id: input.account_id ?? null,
    };
    let dispatched = false;
    try {
      if (name === "bridge_list_accounts")
        return this.result(
          request,
          { kind: "registry" },
          { accounts: (await this.store.list(owner)).map(publicAccount) },
        );
      if (name === "bridge_list_channels")
        return this.result(
          request,
          { kind: "aggregate" },
          await this.inventory(
            owner,
            input.account_id,
            input.offset,
            input.limit,
          ),
        );
      const tool = name.replace(/^buffer_/, "");
      const args = input.arguments;
      this.upstreams.contract.validate(tool, args);
      const a = await this.store.account(owner, input.account_id);
      source = publicAccount(a);
      const write = WRITES.has(tool);
      if (write) {
        if (!input.operation_id || !input.destination_channel_id)
          throw new SafeError("EXPLICIT_OPERATION_AND_DESTINATION_REQUIRED");
        if (tool === "create_post") {
          if (input.intent === "draft" && args.saveToDraft !== true)
            throw new SafeError("DRAFT_REQUIRES_SAVE_TO_DRAFT");
          if (
            input.intent === "publish" &&
            (args.mode !== "shareNow" || args.saveToDraft !== false)
          )
            throw new SafeError("PUBLISH_INTENT_MISMATCH");
          if (
            input.intent === "schedule" &&
            (args.saveToDraft !== false ||
              !args.mode ||
              args.mode === "shareNow")
          )
            throw new SafeError("SCHEDULE_INTENT_MISMATCH");
          if (!["draft", "publish", "schedule"].includes(input.intent))
            throw new SafeError("CREATE_INTENT_REQUIRED");
        } else if (
          input.intent !== (tool === "delete_post" ? "delete" : "edit")
        )
          throw new SafeError("WRITE_INTENT_MISMATCH");
      }
      if (write) {
        const previous = await this.store.db.query(
          "SELECT operation_id FROM write_operations WHERE owner_id=$1 AND operation_id=$2",
          [owner, input.operation_id],
        );
        if (previous.rowCount) {
          const duplicate = await this.store.beginWrite(
            owner,
            a.id,
            input.operation_id,
            tool,
            input,
          );
          return this.result(
            request,
            source,
            duplicate.result,
            duplicate.result?.upstream?.isError ||
              ["pending", "unknown"].includes(duplicate.result?.status),
          );
        }
      }
      return await this.upstreams.with(
        owner,
        a.id,
        async (remote, connectionAccount) => {
          // Resolve completed duplicates before checking resources that may have been deleted.
          // Claim only after fresh ownership checks; serialized lane prevents local races.
          if (write) {
            const old = (
              await this.store.db.query(
                "SELECT * FROM write_operations WHERE owner_id=$1 AND operation_id=$2",
                [owner, input.operation_id],
              )
            ).rows[0];
            if (old) {
              const duplicate = await this.store.beginWrite(
                owner,
                a.id,
                input.operation_id,
                tool,
                input,
              );
              return this.result(
                request,
                source,
                duplicate.result,
                duplicate.result?.upstream?.isError ||
                  duplicate.result?.status === "unknown" ||
                  duplicate.result?.status === "pending",
              );
            }
          }
          await this.preflight(
            remote,
            tool,
            args,
            input.destination_channel_id,
          );
          if (
            (await this.store.account(owner, a.id)).credential_version !==
            connectionAccount.credential_version
          )
            throw new SafeError(
              "CREDENTIAL_CHANGED_RETRY_WITH_SAME_OPERATION",
              409,
            );
          if (write) {
            const op = await this.store.beginWrite(
              owner,
              a.id,
              input.operation_id,
              tool,
              input,
            );
            if (!op.fresh)
              return this.result(
                request,
                source,
                op.result,
                op.result?.upstream?.isError ||
                  op.result?.status === "unknown" ||
                  op.result?.status === "pending",
              );
          }
          // Mandatory audit before dispatch: fail closed if the database is unavailable.
          await this.store.audit(owner, a.id, name, request, "dispatch");
          let upstream: CallToolResult;
          try {
            dispatched = true;
            upstream = write
              ? await remote.call(tool, args)
              : await safeRead(remote, tool, args);
            if (write)
              await this.store.finishWrite(owner, input.operation_id, {
                upstream,
              });
          } catch (e) {
            if (write)
              await this.store
                .unknownWrite(owner, input.operation_id)
                .catch(() => {});
            throw e;
          }
          await this.store
            .audit(
              owner,
              a.id,
              name,
              request,
              upstream.isError ? "upstream_error" : "completed",
            )
            .catch(() => {});
          return this.result(request, source, { upstream }, upstream.isError);
        },
      );
    } catch (e) {
      const code =
        e instanceof SafeError ? e.code : "UPSTREAM_OR_STORAGE_UNAVAILABLE";
      await this.store
        .audit(owner, input.account_id ?? null, name, request, code)
        .catch(() => {});
      return this.result(
        request,
        source,
        {
          error: code,
          ...(WRITES.has(name.replace(/^buffer_/, "")) && dispatched
            ? {
                status: "unknown",
                operation_id: input.operation_id,
                message:
                  "Do not automatically resend. Check Buffer for the outcome.",
              }
            : {}),
        },
        true,
      );
    }
  }
  result(
    request: string,
    source: Record<string, unknown>,
    result: any,
    isError = false,
  ): CallToolResult {
    const value = { request_id: request, source, result };
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError,
    };
  }
  server(owner: string) {
    const mcp = new McpServer({
      name: "multi-account-buffer",
      version: "0.1.0",
    });
    const register = (
      name: string,
      input: any,
      description: string,
      annotations: any,
    ) =>
      mcp.registerTool(
        name,
        {
          inputSchema: fromJsonSchema(input),
          outputSchema,
          description,
          annotations,
        },
        async (input: any) => this.call(owner, name, input),
      );
    register(
      "bridge_list_accounts",
      { type: "object", properties: {}, additionalProperties: false },
      "List verified Buffer accounts and immutable routing IDs.",
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    );
    register(
      "bridge_list_channels",
      {
        type: "object",
        properties: {
          account_id: uuid,
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
      "Read fresh channel inventory with per-account failures. Follow next_offset; overlap detection covers this page.",
      { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    );
    for (const t of this.upstreams.contract.tools) {
      const write = WRITES.has(t.name);
      register(
        "buffer_" + t.name,
        {
          ...(t.inputSchema.$schema ? { $schema: t.inputSchema.$schema } : {}),
          type: "object",
          properties: {
            account_id: uuid,
            arguments: t.inputSchema,
            ...(write
              ? {
                  operation_id: uuid,
                  destination_channel_id: { type: "string", minLength: 1 },
                  intent: {
                    type: "string",
                    enum: ["draft", "schedule", "publish", "edit", "delete"],
                  },
                }
              : {}),
          },
          required: [
            "account_id",
            "arguments",
            ...(write
              ? ["operation_id", "destination_channel_id", "intent"]
              : []),
          ],
          additionalProperties: false,
        },
        (t.description || t.name) +
          " Explicit account required. Results identify source; upstream result is nested in result.upstream." +
          (write
            ? " Select intent and destination explicitly. Reuse operation_id only for the identical request. Never retry unknown outcomes."
            : ""),
        {
          ...t.annotations,
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: !write,
          openWorldHint: true,
        },
      );
    }
    return mcp;
  }
}
