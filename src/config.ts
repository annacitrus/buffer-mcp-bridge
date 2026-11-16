import { readFileSync } from "node:fs";
import { Vault, SafeError } from "./security.js";
export function required(name: string): string {
  const file = process.env[name + "_FILE"];
  const v = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!v) throw new SafeError("MISSING_" + name, 503);
  return v;
}
export function configuration() {
  const base = new URL(required("PUBLIC_URL"));
  const local =
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1"].includes(base.hostname);
  if (base.protocol !== "https:" && !local)
    throw new SafeError("HTTPS_REQUIRED");
  if (base.pathname !== "/" || base.search || base.hash)
    throw new SafeError("PUBLIC_URL_MUST_BE_ORIGIN");
  const issuer = required("OIDC_ISSUER");
  if (!issuer.startsWith("https://"))
    throw new SafeError("OIDC_HTTPS_REQUIRED");
  return {
    base: base.origin,
    local,
    port: Number(process.env.PORT || 3000),
    database: required("DATABASE_URL"),
    issuer,
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
    introspectionId: required("INTROSPECTION_CLIENT_ID"),
    introspectionSecret: required("INTROSPECTION_CLIENT_SECRET"),
    subjects: required("OWNER_SUBJECTS")
      .split(",")
      .map((s) => s.trim()),
    vault: new Vault(
      JSON.parse(readFileSync(required("ENCRYPTION_KEYS_FILE"), "utf8")),
      required("ENCRYPTION_ACTIVE_VERSION"),
    ),
    contract: process.env.BUFFER_CONTRACT_FILE || "config/buffer-contract.json",
  };
}
export type Config = ReturnType<typeof configuration>;
