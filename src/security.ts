import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export class SafeError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
}
export class Vault {
  constructor(
    readonly keys: Record<string, string>,
    readonly active: string,
  ) {
    if (
      !keys[active] ||
      Object.values(keys).some((k) => Buffer.from(k, "base64").length !== 32)
    )
      throw new SafeError("INVALID_KEYRING");
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12),
      c = createCipheriv(
        "aes-256-gcm",
        Buffer.from(this.keys[this.active]!, "base64"),
        iv,
      );
    c.setAAD(Buffer.from(context));
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return [
      this.active,
      iv.toString("base64url"),
      c.getAuthTag().toString("base64url"),
      data.toString("base64url"),
    ].join(".");
  }
  open<T>(value: string, context: string): T {
    const [v, iv, tag, data] = value.split(".");
    if (!v || !iv || !tag || !data || !this.keys[v])
      throw new SafeError("CREDENTIAL_DECRYPTION_FAILED", 503);
    const d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.keys[v]!, "base64"),
      Buffer.from(iv, "base64url"),
    );
    d.setAAD(Buffer.from(context));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(data, "base64url")),
        d.final(),
      ]).toString(),
    );
  }
}
export function redact<T>(value: T, secrets: string[] = []): T {
  const walk = (v: any): any =>
    typeof v === "string"
      ? secrets
          .filter(Boolean)
          .reduce((s, k) => s.split(k).join("[REDACTED]"), v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [
                k,
                /authorization|api.?key|access.?token|refresh.?token|client.?secret|credential|password/i.test(
                  k,
                )
                  ? "[REDACTED]"
                  : walk(x),
              ]),
            )
          : v;
  return walk(value);
}
export const opaque = () => randomBytes(32).toString("base64url");
