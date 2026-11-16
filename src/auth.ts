import * as oidc from "openid-client";
import type { Config } from "./config.js";
import { SafeError } from "./security.js";
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
}
export interface Authentication {
  issuer: string;
  login(state: LoginState): Promise<string>;
  callback(url: URL, state: LoginState): Promise<string>;
  bearer(token: string): Promise<string>;
}
export function validateToken(
  t: any,
  audience: string,
  subjects: string[],
): string {
  const audiences = Array.isArray(t.aud) ? t.aud : [t.aud];
  if (
    t.active !== true ||
    typeof t.exp !== "number" ||
    t.exp <= Date.now() / 1000 ||
    !audiences.includes(audience) ||
    !String(t.scope || "")
      .split(" ")
      .includes("mcp") ||
    typeof t.sub !== "string" ||
    !subjects.includes(t.sub) ||
    t.nbf > Date.now() / 1000
  )
    throw new SafeError("INVALID_ACCESS_TOKEN", 401);
  return t.sub;
}
export async function authentication(config: Config): Promise<Authentication> {
  const admin = await oidc.discovery(
    new URL(config.issuer),
    config.clientId,
    config.clientSecret,
  );
  const introspection = await oidc.discovery(
    new URL(config.issuer),
    config.introspectionId,
    config.introspectionSecret,
  );
  const metadata = admin.serverMetadata();
  if (
    metadata.issuer !== config.issuer ||
    !metadata.introspection_endpoint ||
    !metadata.revocation_endpoint ||
    !metadata.code_challenge_methods_supported?.includes("S256")
  )
    throw new SafeError("OAUTH_PROVIDER_REQUIREMENTS_NOT_MET", 503);
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.introspection_endpoint,
    metadata.revocation_endpoint,
  ])
    if (!endpoint?.startsWith("https://"))
      throw new SafeError("OAUTH_ENDPOINT_HTTPS_REQUIRED", 503);
  return {
    issuer: config.issuer,
    async login(s) {
      return oidc.buildAuthorizationUrl(admin, {
        redirect_uri: config.base + "/auth/callback",
        response_type: "code",
        scope: "openid",
        state: s.state,
        nonce: s.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(s.verifier),
        code_challenge_method: "S256",
      }).href;
    },
    async callback(url, s) {
      const tokens = await oidc.authorizationCodeGrant(admin, url, {
        pkceCodeVerifier: s.verifier,
        expectedState: s.state,
        expectedNonce: s.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !config.subjects.includes(claims.sub))
        throw new SafeError("OWNER_NOT_ALLOWED", 403);
      return claims.sub;
    },
    async bearer(token) {
      return validateToken(
        await oidc.tokenIntrospection(introspection, token, {
          token_type_hint: "access_token",
        }),
        config.base + "/mcp",
        config.subjects,
      );
    },
  };
}
