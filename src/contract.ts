import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/client";
import { SafeError, canonical } from "./security.js";
export const APPROVED = [
  "get_account",
  "list_channels",
  "get_channel",
  "list_posts",
  "get_post",
  "create_post",
  "edit_post",
  "delete_post",
] as const;
export const WRITES = new Set(["create_post", "edit_post", "delete_post"]);
export interface Shape {
  account: string;
  accountId: string;
  email: string;
  name: string;
  organizations: string;
  organizationId: string;
  organizationName: string;
  channels: string;
  channelId: string;
  channelName: string;
  pageInfo: string;
  postChannelId: string;
}
export interface ContractData {
  verifiedAt: string;
  tools: Tool[];
  shape: Shape;
}
export function pointer(value: any, path: string): any {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new SafeError("INVALID_JSON_POINTER");
  return path
    .slice(1)
    .split("/")
    .reduce((x, k) => x?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], value);
}
export function body(result: any): any {
  if (result.isError) throw new SafeError("UPSTREAM_TOOL_ERROR", 502);
  if (result.structuredContent) return result.structuredContent;
  const blocks = result.content?.filter((x: any) => x.type === "text");
  if (blocks?.length === 1) {
    try {
      return JSON.parse(blocks[0].text);
    } catch {
      /* fail closed */
    }
  }
  throw new SafeError("UNRECOGNIZED_UPSTREAM_RESPONSE", 502);
}
export function nonempty(value: any): string {
  if (typeof value !== "string" || !value)
    throw new SafeError("UPSTREAM_SHAPE_MISMATCH", 502);
  return value;
}
export class Contract {
  readonly tools: Tool[];
  readonly shape: Shape;
  private validators = new Map<string, ReturnType<Ajv2020["compile"]>>();
  constructor(data: ContractData) {
    if (!data.verifiedAt || !Number.isFinite(Date.parse(data.verifiedAt)))
      throw new SafeError("CONTRACT_NOT_VERIFIED");
    this.tools = data.tools.filter((t) =>
      (APPROVED as readonly string[]).includes(t.name),
    );
    this.shape = data.shape;
    if (APPROVED.some((n) => !this.tools.some((t) => t.name === n)))
      throw new SafeError("APPROVED_TOOL_SCHEMA_MISSING");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as any)(ajv);
    for (const t of this.tools)
      this.validators.set(t.name, ajv.compile(t.inputSchema));
  }
  static load(path: string) {
    return new Contract(JSON.parse(readFileSync(path, "utf8")));
  }
  validate(tool: string, args: unknown) {
    const v = this.validators.get(tool);
    if (!v || !v(args)) throw new SafeError("INVALID_UPSTREAM_ARGUMENTS");
  }
  match(live: Tool[]) {
    for (const t of this.tools) {
      const now = live.find((x) => x.name === t.name);
      if (
        !now ||
        canonical(now.inputSchema) !== canonical(t.inputSchema) ||
        canonical(now.outputSchema ?? null) !==
          canonical(t.outputSchema ?? null)
      )
        throw new SafeError("UPSTREAM_SCHEMA_DRIFT", 503);
    }
  }
}
