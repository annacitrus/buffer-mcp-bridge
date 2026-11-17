# Buffer MCP Bridge

A self-hosted MCP server that connects Claude and other compatible clients to multiple separate Buffer accounts through one connector URL.

Register accounts in an authenticated web interface, then select an immutable account ID for each tool call. Adding a second, third, or later account requires neither another connector nor a redeployment. Existing Buffer subscriptions and channels stay separate.

**Status: beta.** The application builds and has a 19-test suite. A laptop deployment has verified authenticated Buffer initialization, live tool schemas, three separate account identities and channel inventories, PostgreSQL, container execution, and OAuth discovery. End-to-end Claude authorization and live writes still require verification. The server requires a reviewed live Buffer contract before it starts; fictional test fixtures are not a production contract. See [validation status](VALIDATION.md).

## Features

- One Streamable HTTP endpoint at `/mcp`.
- PostgreSQL account registry with editable aliases and immutable routing IDs.
- Masked account onboarding with verified identities, organizations, and channels.
- Isolated upstream credentials, clients, sessions, and connection lifecycles per account.
- AES-256-GCM encryption for credentials, web sessions, and saved write results.
- OAuth/OIDC authentication, PKCE admin login, and per-request MCP token introspection.
- An explicit tool allowlist, fresh resource checks, and persistent write duplicate suppression.
- Docker configuration, migrations, HTTPS reverse proxy, and backup/key-rotation guidance.

## Architecture

```text
Claude / compatible MCP client
             |
   OAuth authorization provider
             |
      HTTPS /mcp endpoint          HTTPS /admin
             |                         |
      Owner + account router ----- Account registry
             |                         |
   Isolated upstream clients       PostgreSQL
        /      |      \
   Buffer A Buffer B Buffer N
```

Bridge authentication is independent of Buffer authentication. Client access tokens are never sent to Buffer, and Buffer keys are never returned to the MCP client.

## Requirements

For a no-subscription-cost personal evaluation on a Windows laptop, see [the laptop setup guide](deploy/LAPTOP.md). It uses Docker, local Keycloak/PostgreSQL, and Tailscale Funnel. The laptop must stay online; the recipe still needs live integration validation.

For mock tests: Git, npm, and Node.js 24 LTS (24.12.0 or later within the 24.x line). HTTP tests require localhost networking.

For a running deployment: a Buffer API key for each account, PostgreSQL, an HTTPS OAuth/OIDC provider supporting PKCE and token introspection, and an always-on Node host. Remote Claude connections also require a public HTTPS domain on port 443. Docker Desktop with Linux containers can run the local database. You can clone and test before setting up keys or hosting.

## Contents

- [Install and test](#install-and-test)
- [Verify Buffer and generate a contract](#verify-buffer-and-generate-a-contract)
- [PostgreSQL and runtime settings](#postgresql-and-runtime-settings)
- [OAuth provider setup](#oauth-provider-setup)
- [Configuration reference](#configuration-reference)
- [Managing accounts](#add-rename-rotate-disable-remove)
- [MCP tools](#mcp-contract-and-resource-checks)
- [Writes](#writes)
- [Deployment and operations](#deployment-and-operations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Install and test

Clone the repository, then install dependencies and run the local checks. These commands work in PowerShell as well as macOS/Linux terminals:

```powershell
git clone https://github.com/annacitrus/buffer-mcp-bridge.git
cd buffer-mcp-bridge
node --version
npm ci
npm run check
npm test
npm run build
```

Use Node **24 LTS**, at least 24.12.0; update to its current security patch before deployment. Dependencies are pinned exactly in `package.json` and `package-lock.json`. Official SDK v2 is the current stable line; its per-request HTTP handler also supports the legacy MCP initialize handshake. The test suite uses an in-memory PostgreSQL emulator unless `TEST_DATABASE_URL` is configured. HTTP tests need permission to bind and connect to loopback.

## Verify Buffer and generate a contract

1. Sign into the intended Buffer account at [Buffer](https://publish.buffer.com/). Open **Settings → API**, create an API key, and copy it. Repeat later in the other Buffer account. Keep the accounts separate.
2. In PowerShell in this project folder, run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\new-keyring.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\probe.ps1
   ```

   `Bypass` applies only to that child PowerShell process; it does not change your saved execution policy. The first script restricts the secrets-directory Windows ACL and creates the encryption keyring. The second prompts for the Buffer key with hidden input; paste **only into that terminal prompt**, then press Enter. It clears its child-process environment on exit. Avoid terminal recording during setup.

3. The probe performs authenticated Streamable HTTP initialization, follows every tool-catalog cursor, validates `get_account` against its actual input schema, and displays the account response in your private terminal. Enter an organization ID from that response when prompted. The probe validates the live `list_channels` input schema and calls it. It never calls a mutation.
4. It writes `config/catalog.json` (schemas) and `secrets/probe-private.json` (private account/channel samples). If initialization fails, it prints a sanitized status and does not switch APIs or transports. An HTTP status is preserved when available. No key is written to the report.
5. Before running the full server, review those actual response shapes. Copy `config/shape.example.json` to `secrets/shape.json`, and replace its JSON pointers with paths from the actual responses. The example records shapes observed on 2026-11-17; **verify them against your own live responses** before use. `account`, `organizations`, `channels`, `pageInfo`, and `postChannelId` are relative to each tool's `structuredContent` or parsed single JSON text block; identity field pointers are relative to the selected account/organization/channel object. Verify `postChannelId` using an authorized **read-only** `get_post` response before enabling edit/delete workflows. Do not use an organization name to identify an account.
6. Rerun:

   ```powershell
   $env:BUFFER_SHAPE_FILE = '.\secrets\shape.json'
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\probe.ps1
   Remove-Item Env:BUFFER_SHAPE_FILE
   ```

   This checks identity/inventory extraction using fresh reads and writes `config/buffer-contract.json`. Review every allowlisted input/output schema and write behavior before accepting it. Missing schemas or live schema drift block calls. Complete the mapping review before starting the server. When requesting integration assistance, share only the **schema catalog** with private metadata removed, never the private report.

An alternative is a private key file referenced by `BUFFER_API_KEY_FILE`; the probe reads it without echoing the key. The admin UI later accepts API keys through masked HTTPS forms, so no key file is required for ongoing use. Buffer documents the endpoint and bearer-key authentication in its [connection guide](https://developers.buffer.com/guides/integrations/other-ai-tools.html).

## PostgreSQL and runtime settings

Use Docker Desktop with Linux containers for the local database, or supply an existing PostgreSQL connection. Container and real-database verification are part of the release checklist in [VALIDATION.md](VALIDATION.md).

1. Open **Docker Desktop** from the Windows Start menu. Wait for its engine to report running. If it asks to install/enable WSL 2, follow Docker Desktop's setup and restart Windows as directed.
2. Copy `.env.example` to `.env`. Generate a database password privately (for example in a password manager), replace `POSTGRES_PASSWORD`, and use the same password in `DATABASE_URL`; URL-encode special characters in the URL. Keep the file private.
3. Start the database and apply migrations:

   ```powershell
   # Copy .env.example to .env once, then edit it before continuing.
   # Do not overwrite an existing configured .env.
   docker compose up -d db
   npm run migrate
   ```

4. Run the same tests against a **disposable test database**, not your production database. In a trusted editor, create the ignored file `secrets/test.env` with a `TEST_DATABASE_URL` entry containing that database's private connection URL. Then run:

   ```powershell
   node --env-file=secrets/test.env --import tsx --test test/bridge.test.ts test/http.test.ts
   ```

   Each fixture creates a random isolated schema and drops only that exact schema afterward. The database login must be allowed to create schemas. This checks real SQL/transactions and unique constraints, beyond the emulator. Multi-process concurrent write claims also require live validation before deployment.

5. After configuring the OAuth provider and contract, run `npm run dev`. Open `http://localhost:3000/admin`. Local HTTP works only in development on localhost/127.0.0.1. Buffer key onboarding should be performed at the final HTTPS URL. There is no authentication bypass or default password.

## OAuth provider setup

OAuth is delegated to an external maintained OIDC authorization server. `openid-client` handles discovery and the admin authorization-code flow, including S256 PKCE, state, nonce, code exchange and ID-token validation. MCP tokens are **introspected on every request**, with active/revocation, expiry, subject allowlist, scope, and exact `/mcp` audience checks. Bridge tokens are never sent to Buffer. The bridge publishes RFC 9728 protected-resource metadata and a `WWW-Authenticate` discovery challenge.

Use an issuer supporting discovery, authorization code + PKCE S256, RFC 8707 resource indicators, RFC 7662 introspection, and revocation. The issuer and all its endpoints must use HTTPS, even while the app is local. The issuer must use a consistent public `sub` identifier for the owner across the admin and Claude clients. Unrelated, pairwise client subjects will not identify the same registry owner.

Configure these three clients at your chosen provider:

| Client                 | Configuration                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge-admin`         | Confidential web client; code flow only; require S256 PKCE; exact redirect `https://YOUR_DOMAIN/auth/callback` (add `http://localhost:3000/auth/callback` only for local testing); no wildcard redirects; secret kept on bridge |
| `bridge-resource`      | Confidential resource/introspection client authorized to introspect tokens for this API; no interactive redirect or password grant                                                                                              |
| `claude-buffer-bridge` | Pre-registered Claude OAuth client; code flow only; require S256; redirect exactly `https://claude.ai/api/mcp/auth_callback`; use a client secret if required by provider                                                       |

Register the protected resource as **`https://YOUR_DOMAIN/mcp`**, define the scope **`mcp`**, grant it to the Claude client, and ensure the scope is included in the token's `scope` field. Authorization/token requests containing that exact resource must issue tokens whose `aud` includes that exact string. Reject unknown resources. Ensure introspection returns `active`, `sub`, `exp`, `aud`, and `scope`; allow the resource client to introspect that audience. Keep access-token lifetime short, for example five minutes. Enable owner MFA. Disable public self-registration and unsolicited dynamic client registration for personal use.

In `.env`, fill `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `INTROSPECTION_CLIENT_ID`, `INTROSPECTION_CLIENT_SECRET`, and `OWNER_SUBJECTS` with the owner's exact provider user ID. Keep client secrets private.

Provider configuration depends on the chosen service. Keycloak has an official [MCP setup guide](https://www.keycloak.org/securing-apps/mcp-authz-server), but currently labels its RFC 8707 feature experimental. Do not assume an arbitrary Keycloak instance satisfies this deployment's production requirements. If using it for an evaluation, configure resource registration, audience mapping and introspection permissions from that guide and the current [introspection documentation](https://www.keycloak.org/securing-apps/oidc-layers); explicitly test wrong-resource rejection. A production provider must pass the acceptance flow below before launch.

Admin sessions are server-side encrypted records, with an HttpOnly SameSite cookie and an eight-hour maximum lifetime. Logout deletes the local session; it does not log you out of the identity provider. For immediate admin revocation, remove the owner's `web_sessions` records as well as revoking the provider session. MCP revocation is checked each request without a token cache. Keep provider/reverse-proxy logs from retaining callback query parameters, headers, tokens or form bodies.

## Configuration reference

Copy `.env.example` once for local development, or `.env.production.example` for production metadata. Edit values locally; do not commit the resulting files.

| Variable                                                 | Purpose                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                               | `development` locally; `production` on the host                              |
| `PUBLIC_URL`                                             | Exact external origin, with no path; the audience is this origin plus `/mcp` |
| `PORT`                                                   | Internal listener port, default `3000`                                       |
| `DATABASE_URL`                                           | PostgreSQL connection URL                                                    |
| `POSTGRES_PASSWORD`                                      | Local Compose password; not read by the app                                  |
| `OIDC_ISSUER`                                            | Exact HTTPS issuer from provider discovery                                   |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                   | Confidential admin client                                                    |
| `INTROSPECTION_CLIENT_ID`, `INTROSPECTION_CLIENT_SECRET` | Resource/introspection client                                                |
| `OWNER_SUBJECTS`                                         | Comma-separated exact allowed owner subjects, not emails                     |
| `ENCRYPTION_KEYS_FILE`                                   | Private JSON keyring path                                                    |
| `ENCRYPTION_ACTIVE_VERSION`                              | Active keyring entry, for example `v1`                                       |
| `BUFFER_CONTRACT_FILE`                                   | Reviewed contract path; default `config/buffer-contract.json`                |
| `BRIDGE_DOMAIN`                                          | Caddy/Compose hostname without scheme                                        |

Secret-file alternatives are `DATABASE_URL_FILE`, `OIDC_CLIENT_SECRET_FILE`, and `INTROSPECTION_CLIENT_SECRET_FILE`. Production Compose mounts them explicitly. Probe-only settings are `BUFFER_API_KEY_FILE` and `BUFFER_SHAPE_FILE`; `TEST_DATABASE_URL` selects the disposable real test database.

### macOS / Linux keyring and probe

Use a private directory and refuse to overwrite an existing keyring:

```sh
umask 077
mkdir -p secrets
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync("secrets/encryption-keys.json", JSON.stringify({v1:randomBytes(32).toString("base64")}), {mode:0o600,flag:"wx"});'
```

Save the Buffer key in `secrets/buffer-api.key` using a trusted editor, then restrict it and run the read-only probe. Never pass the key itself as a command argument.

```sh
chmod 600 secrets/buffer-api.key
BUFFER_API_KEY_FILE=./secrets/buffer-api.key npm run probe
# After reviewing the mapping in secrets/shape.json:
BUFFER_API_KEY_FILE=./secrets/buffer-api.key BUFFER_SHAPE_FILE=./secrets/shape.json npm run probe
```

## Add, rename, rotate, disable, remove

Sign in to `/admin` using the allowed owner identity. Choose **Add Buffer account**, enter an alias and key, inspect the verified identity plus full organization/channel inventory, and save. A duplicate Buffer identity offers replacement of the existing registration. Rotation verifies that the key still belongs to that exact identity. Renaming changes only the alias. Disable/enable and credential replacement increment the credential version; the next call reloads it and closes any old cached connection. Removal deletes the credential and inventory, clears pending onboarding secrets for that owner and closes this process's upstream client. Other replicas reject new requests using their fresh registry lookup and release idle cached connections within 90 seconds; an already-dispatched upstream call cannot be canceled reliably.

**Adding a third account:** repeat Add → Verify → Save. It appears immediately in `bridge_list_accounts` on the existing connector; no redeployment, new tool names, or Claude reconnect is needed. Registry size has no two-account limit. The default pool holds up to 32 active upstream connections with lazy acquisition/idle eviction, a 32-request queue per account, and aggregate read concurrency of four. Those are resource bounds, not an account limit.

Deleting the bridge's credential does **not** revoke the API key at Buffer or delete any Buffer account/channel/post. Revoke a key separately in Buffer Settings → API. Encrypted copies may remain in retained backups until the backup retention period ends.

## MCP contract and resource checks

The constant catalog has `bridge_list_accounts`, `bridge_list_channels` and eight wrappers: `buffer_get_account`, `buffer_list_channels`, `buffer_get_channel`, `buffer_list_posts`, `buffer_get_post`, `buffer_create_post`, `buffer_edit_post`, `buffer_delete_post`. The contract is generated from the authenticated catalog and intersected with that explicit allowlist. Unknown tools are never registered. Account management has no model-callable endpoint.

```json
{
  "account_id": "IMMUTABLE_BRIDGE_UUID",
  "arguments": { "organizationId": "BUFFER_ORGANIZATION_ID" }
}
```

Every wrapper requires an immutable owner-scoped `account_id`. Input JSON schemas come from the reviewed catalog. Each new upstream connection compares live input/output schemas with it. Organization references are checked against a fresh `get_account`; channel and post references use same-account `get_channel` / `get_post` reads. Buffer remains authoritative. No stale inventory entry grants access. `ideaId` references are rejected because no idea-ownership tool is approved. `draftId` is checked as a post reference. No failure triggers a fallback account.

Results follow the published wrapper output schema: `{request_id, source, result}`. `result.upstream` contains upstream content, structured content, `isError`, and metadata. Top-level MCP `isError` mirrors upstream errors. Named secret fields and exact in-memory keys are redacted. Successful write results are encrypted at rest so replay does not put post bodies into plaintext operation rows. Audits record only owner/account/tool/request/outcome, without arguments or post content.

`bridge_list_channels` accepts `account_id`, `offset`, and `limit` (maximum 100). Follow `pagination.next_offset` until null. It reports failures per account and overlap IDs for the current account page; combine pages to detect overlaps across all accounts. It never claims a failed inventory is complete. Raw list wrappers preserve Buffer's pagination. Inventory follows `after` cursors and uses `first:100` only when those inputs exist in the verified schema, with cursor-loop detection. The reviewed `pageInfo` pointer must identify `hasNextPage`/`endCursor` or `nextCursor`. If the response advertises another page but the verified input schema lacks pagination, that account returns `CHANNEL_PAGINATION_REQUIRES_CONTRACT_UPDATE`, rather than presenting truncated inventory as complete. Other pagination shapes require an explicit reviewed adapter update.

## Writes

Writes also require a UUID `operation_id`, an explicit `destination_channel_id`, and `intent`. Create accepts `draft`, `schedule`, or `publish`; edit requires `edit`; delete requires `delete`. Destination is checked against the create channel or fresh existing-post channel. For create:

| Intent     | Required arguments                                                     |
| ---------- | ---------------------------------------------------------------------- |
| `draft`    | `saveToDraft: true`                                                    |
| `publish`  | `saveToDraft: false`, `mode: "shareNow"`                               |
| `schedule` | `saveToDraft: false`, an explicit supported mode other than `shareNow` |

Arguments are forwarded without rewriting publishing intent. Writes carry non-read-only/destructive annotations. Do not approve writes on the assumption they are drafts: inspect intent and arguments. **All publishing tests in this repository use mocks. No live write has been performed or authorized.** Any future live validation must receive separate user authorization and create only a clearly labeled draft.

Before dispatch, PostgreSQL atomically claims `(owner, operation_id)`, binding account, tool, and the canonical normalized entire wrapper input hash. An identical completed duplicate returns the prior result with a new request ID. Changed arguments, tool, destination, intent or account are rejected. A concurrent pending operation is reported as unresolved and is never sent again. Network interruption or persistence uncertainty marks the operation `unknown`; stale pending records become unknown after two minutes when inspected again. Never automatically resubmit an unknown outcome, even after restart. Inspect Buffer, then decide manually whether a distinct operation is needed. This is duplicate suppression, **not exactly-once publishing**. Reads retry only HTTP 429/502/503/504, at most twice, honoring Retry-After up to five seconds; longer waits are surfaced instead. Mutations are not retried.

Media inputs are forwarded to Buffer as documented asset arguments; the bridge does not fetch arbitrary media URLs. Supported asset formats, network-specific restrictions, draft behavior and upload requirements must be confirmed from live schemas before use. See Buffer's [tool and media documentation](https://developers.buffer.com/guides/integrations/mcp.html); no compatibility claim is based on the fictional test fixtures.

## Deployment and operations

The production Compose file is a self-hosting template for a Linux container host. Hosting, domain, OAuth, and backup services are not bundled. Confirm provider compatibility and costs before provisioning resources. This is a long-running Node/PostgreSQL service; static-only hosting is insufficient.

Use a Linux container host with an always-on service, PostgreSQL persistence/backups, outbound HTTPS to Buffer/OIDC, and inbound HTTPS on 443. Disable buffering for streaming responses; allow at least 120-second requests. Use one app replica initially. For more replicas, account-specific concurrency limits are per process; PostgreSQL uniqueness still arbitrates operation claims. Add a shared limiter before using multiple replicas under load.

1. Copy `.env.production.example` to `.env.production` and fill only its non-secret metadata. Set DNS for `BRIDGE_DOMAIN` to the chosen host. Permit ports 80 (certificate/redirect) and 443. Set `PUBLIC_URL=https://YOUR_DOMAIN` and the OAuth redirects/audience to match. Do not copy development database/password variables into this production file.
2. Put `db-password`, the matching URL `postgresql://bridge:ENCODED_PASSWORD@db:5432/bridge` in `database-url`, and the two OAuth secrets in the named files under `secrets/`. The master keyring lives in `secrets/encryption-keys.json`, separately from the database. The Compose file mounts these as secrets; `_FILE` variables override environment values. On Linux, ensure only the deployment operator and container UID 1000 can read app secret files. Compose file-secret mode/ownership can follow host bind-mount permissions; verify from the non-root container before launch.
3. The Node image is pinned to `24.22.3-bookworm-slim`, verified against the Node.js release index on 2026-11-16. Pin its immutable image digest, plus verified PostgreSQL/Caddy image digests after pulling, before release. Dependency and image version tags are pinned; immutable image digests must be selected for your release. Run tests in the pinned container runtime as well.
4. Build, migrate, then start:

   ```sh
   docker compose --env-file .env.production -f compose.production.yaml build
   docker compose --env-file .env.production -f compose.production.yaml up -d db
   docker compose --env-file .env.production -f compose.production.yaml run --rm app node dist/scripts/migrate.js
   docker compose --env-file .env.production -f compose.production.yaml up -d
   ```

   Caddy provides automatic public HTTPS and flushes reverse-proxy output; see [Caddy HTTPS](https://caddyserver.com/docs/automatic-https). Access logging stays off to protect OAuth callback codes. PostgreSQL has no published production port. The application runs as non-root with a read-only filesystem, drops capabilities, and accepts only the configured Host/Origin.

5. Check `/healthz` and `/readyz`; neither returns account information. Readiness checks PostgreSQL. Provider availability is validated at startup, but provider/Buffer outages are isolated to authentication/tool calls. Collect only sanitized health/outcome telemetry.

Migrations use a transaction and advisory lock, with a migration ledger. Graceful shutdown stops intake, drains HTTP requests, closes upstream connections and the database; there is a 45-second final bound. Make rolling upgrades quiescent when rotating master keys. Load test actual host/proxy streaming behavior before treating it as production.

### Backups, recovery and encryption rotation

Schedule daily `pg_dump -Fc` backups and encrypt/store them off-host with a documented retention policy (for example 14 days). Use the host's scheduler or managed PostgreSQL backup service; no scheduler has been installed by this project. Back up the keyring to a separate secret store. A database backup without its historical keyring cannot recover credentials or saved write results. Back up Caddy's `/data` volume as well; it contains TLS keys. Never put any of these backups in source control.

Example Linux backup (run through a private backup job; do not log its environment):

```sh
docker compose --env-file .env.production -f compose.production.yaml exec -T db pg_dump -U bridge -d bridge -Fc > bridge.dump
```

Restore into a **new** PostgreSQL database using `pg_restore --no-owner --no-acl`, restore the matching keyring separately, apply migrations, then run read-only verification before changing traffic. Keep write operation records on restore: deleting them can permit duplicate publishing. After recovery from an old snapshot, treat operations dispatched since that snapshot as potentially unknown and reconcile them in Buffer before writes resume. Practice restores before relying on a backup.

To rotate encryption keys: securely add a new random 32-byte base64 key under `v2` while retaining `v1`; distribute that combined keyring, set `ENCRYPTION_ACTIVE_VERSION=v2`, stop app traffic, and run `npm run rotate-encryption` (or `node dist/scripts/rotate-encryption.js` in the container). It re-encrypts credentials, saved operation results, and web sessions transactionally. Restart using the combined keyring and new active version. Retain old keys until all corresponding backups expire. The version bump invalidates cached upstream credentials. Buffer API-key rotation is a separate admin action and requires no app restart.

### Claude connection and release verification

After HTTPS, provider and two real accounts are verified:

1. In Claude, open **Customize → Connectors → Add custom connector**. Set the URL to `https://YOUR_DOMAIN/mcp`.
2. Choose OAuth sign-in and **Use your own OAuth client**. Enter the pre-registered `claude-buffer-bridge` client ID and its secret only in Claude's settings. Claude documents this mode and the exact callback in its [connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
3. Sign in as the allowed owner, call `bridge_list_accounts`, and check both verified Buffer identities. Add the third account in `/admin` and call the same tool without reconnecting.
4. Verify the provider's discovery, consent, S256 enforcement (reject missing/wrong verifier), exact redirect checks, resource binding (reject wrong resource/audience), expiry and revocation. Confirm a revoked MCP token returns 401 and cannot call tools. Verify another provider user cannot access the admin interface or tools.
5. Repeat parallel read isolation, wrong-account references, disabled/expired key isolation, credential rotation, partial failures, inventory pagination and overlap checks against real accounts. Do not perform live publishing tests.

Claude connects from Anthropic's infrastructure on public port 443, so localhost alone cannot satisfy acceptance. Verify the provider flow, real PostgreSQL suite, container build, two/third-account live tests, media/schema mapping, and public Claude connection for every deployment before treating it as production-ready.

## Source references

Reviewed 2026-11-16: [Buffer key scope](https://developers.buffer.com/guides/authentication.html), [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [SDK HTTP integration](https://ts.sdk.modelcontextprotocol.io/v2/serving/express), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [openid-client](https://github.com/panva/openid-client), [Docker secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [PostgreSQL lifecycle](https://www.postgresql.org/support/versioning/). Provider and transport compatibility must still be verified in the actual deployment.

## Troubleshooting

| Symptom                                       | Check                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Docker cannot connect to its engine           | Start Docker Desktop, select Linux containers, and complete WSL 2 setup.                                                 |
| Server fails before listening                 | Fill required settings, migrate PostgreSQL, and generate the reviewed live contract. Errors are intentionally sanitized. |
| Buffer returns HTTP 401                       | Check the selected account's key and revocation state; never substitute another account.                                 |
| `UPSTREAM_SCHEMA_DRIFT`                       | Probe again, review changes, and deliberately update the contract.                                                       |
| Response-shape errors                         | Correct the reviewed JSON pointers using private live samples.                                                           |
| `CHANNEL_PAGINATION_REQUIRES_CONTRACT_UPDATE` | Review the actual pagination schema and update the adapter; the inventory is incomplete.                                 |
| `OAUTH_PROVIDER_REQUIREMENTS_NOT_MET`         | Check discovery, S256, introspection, revocation, and HTTPS endpoints.                                                   |
| MCP returns 401                               | Check exact audience, `mcp` scope, allowed subject, expiry/active status, and introspection permission.                  |
| Admin login loops                             | Check callback registration, issuer, owner subject, cookie origin, and client secret.                                    |
| `CSRF_REJECTED`                               | Use the configured origin and a current authenticated session.                                                           |
| Claude cannot connect                         | Check public HTTPS on 443, DNS/firewall access, and streaming proxy behavior.                                            |
| `OPERATION_ID_CONFLICT`                       | Do not reuse an operation ID for a changed request.                                                                      |
| Write is pending or unknown                   | Inspect Buffer manually; never automatically resend.                                                                     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and pull-request guidelines. Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). This project is independent of Buffer and Anthropic.
