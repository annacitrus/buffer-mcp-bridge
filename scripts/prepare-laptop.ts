import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This command only creates ignored local configuration. It does not join a
// tailnet, expose a port, create a cloud resource, or call Buffer.
const secret = () => randomBytes(32).toString("base64url");
export function laptopConfiguration(publicUrl: string) {
  const url = new URL(publicUrl);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".ts.net")
  )
    throw new Error("Expected the HTTPS origin of your own Tailscale device.");
  const base = url.origin,
    resource = base + "/mcp",
    owner = randomUUID();
  const adminSecret = secret(),
    resourceSecret = secret(),
    claudeSecret = secret(),
    ownerPassword = secret(),
    keycloakPassword = secret(),
    dbPassword = secret(),
    authPassword = secret();
  const client = (
    id: string,
    name: string,
    password: string,
    redirects: string[],
    interactive = true,
  ) => ({
    clientId: id,
    name,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    secret: password,
    standardFlowEnabled: interactive,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: redirects,
    webOrigins: [],
    attributes: { "pkce.code.challenge.method": "S256" },
    defaultClientScopes: ["profile"],
    optionalClientScopes: interactive ? ["mcp"] : [],
  });
  const resourceClient = {
    ...client(
      resource,
      "Bridge resource / introspection",
      resourceSecret,
      [],
      false,
    ),
    attributes: { resource_url: resource },
  };
  const claudeClient = {
    ...client("claude-buffer-bridge", "Claude Buffer Bridge", claudeSecret, [
      "https://claude.ai/api/mcp/auth_callback",
    ]),
    consentRequired: true,
    protocolMappers: [
      {
        name: "bridge-resource-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        config: {
          "included.client.audience": resource,
          "access.token.claim": "true",
          "id.token.claim": "false",
          "introspection.token.claim": "true",
        },
      },
    ],
  };
  const realm = {
    realm: "buffer-bridge",
    enabled: true,
    sslRequired: "external",
    registrationAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 5,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 28800,
    clients: [
      client("bridge-admin", "Bridge Admin", adminSecret, [
        base + "/auth/callback",
      ]),
      resourceClient,
      claudeClient,
    ],
    clientScopes: [
      {
        name: "profile",
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": "true" },
        protocolMappers: [],
      },
      {
        name: "mcp",
        protocol: "openid-connect",
        attributes: {
          "include.in.token.scope": "true",
          "display.on.consent.screen": "true",
          "consent.screen.text":
            "Read and manage your registered Buffer accounts using bridge tools.",
        },
        protocolMappers: [
          {
            name: "bridge-url-audience",
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            config: {
              "included.custom.audience": resource,
              "access.token.claim": "true",
              "id.token.claim": "false",
              "introspection.token.claim": "true",
            },
          },
        ],
      },
    ],
    users: [
      {
        id: owner,
        username: "owner",
        enabled: true,
        emailVerified: false,
        requiredActions: ["UPDATE_PASSWORD"],
        credentials: [
          { type: "password", value: ownerPassword, temporary: true },
        ],
      },
    ],
  };
  const env = {
    NODE_ENV: "production",
    PUBLIC_URL: base,
    PORT: "3000",
    DATABASE_URL: `postgresql://bridge:${dbPassword}@db:5432/bridge`,
    BRIDGE_DB_PASSWORD: dbPassword,
    AUTH_DB_PASSWORD: authPassword,
    KEYCLOAK_BOOTSTRAP_PASSWORD: keycloakPassword,
    OIDC_ISSUER: base + "/identity/realms/buffer-bridge",
    OIDC_CLIENT_ID: "bridge-admin",
    OIDC_CLIENT_SECRET: adminSecret,
    INTROSPECTION_CLIENT_ID: resource,
    INTROSPECTION_CLIENT_SECRET: resourceSecret,
    OWNER_SUBJECTS: owner,
    ENCRYPTION_ACTIVE_VERSION: "v1",
    ENCRYPTION_KEYS_FILE: "/run/secrets/encryption_keys",
    BUFFER_CONTRACT_FILE: "/run/secrets/buffer_contract",
  };
  const credentials = {
    warning:
      "PRIVATE: do not paste this file into chat, commit it, or upload it.",
    bridge_url: resource,
    bridge_admin: base + "/admin",
    owner_username: "owner",
    owner_temporary_password: ownerPassword,
    keycloak_management:
      "Not published. Use the Keycloak kcadm command inside the identity container for recovery/administration.",
    keycloak_admin_username: "local-admin",
    keycloak_admin_password: keycloakPassword,
    claude_oauth_client_id: "claude-buffer-bridge",
    claude_oauth_client_secret: claudeSecret,
  };
  return { env, realm, credentials };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const targets = [
      ".env.laptop",
      "secrets/laptop-realm.json",
      "secrets/laptop-access.json",
    ];
    if (targets.some(existsSync))
      throw new Error(
        "Laptop configuration already exists. Preserve it; do not regenerate client secrets over a running realm.",
      );
    if (!existsSync("secrets/encryption-keys.json"))
      throw new Error(
        "Create the private keyring first with scripts/new-keyring.ps1.",
      );
    let publicUrl = process.argv[2];
    if (!publicUrl) {
      const bin =
        process.platform === "win32"
          ? "C:\\Program Files\\Tailscale\\tailscale.exe"
          : "tailscale";
      const status = JSON.parse(
        execFileSync(bin, ["status", "--json"], {
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        }),
      );
      if (status.BackendState !== "Running" || !status.Self?.DNSName)
        throw new Error("Sign in to the Tailscale app first.");
      publicUrl = "https://" + String(status.Self.DNSName).replace(/\.$/, "");
    }
    const data = laptopConfiguration(publicUrl);
    mkdirSync("secrets", { recursive: true });
    writeFileSync(
      ".env.laptop",
      Object.entries(data.env)
        .map(([k, v]) => k + "=" + v)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    writeFileSync(
      "secrets/laptop-realm.json",
      JSON.stringify(data.realm, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    writeFileSync(
      "secrets/laptop-access.json",
      JSON.stringify(data.credentials, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      "Private laptop configuration created. No credentials printed. No service exposed.",
    );
    console.log("Runtime has not been verified. Follow deploy/LAPTOP.md.");
  } catch (e) {
    console.error(
      e instanceof Error ? e.message : "Laptop preparation failed.",
    );
    process.exitCode = 1;
  }
}
