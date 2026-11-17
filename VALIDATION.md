# Validation record — 2026-11-16

## Live local deployment checks — 2026-11-17

- Docker container image built successfully with the pinned Node 24 runtime.
- Both private PostgreSQL instances are healthy; bridge migrations applied successfully.
- All 17 tests passed against real PostgreSQL in an isolated temporary container. Concurrent duplicates may correctly return `pending` while the original dispatch completes; completed result replay is verified afterward with no second dispatch.
- Corrected Keycloak's required realm import filename. The owner/clients realm imported successfully and the OAuth server is running.
- Gateway configuration validated. Local issuer discovery returns the expected HTTPS issuer with introspection/revocation metadata. Management/admin and master-realm paths return 404.
- Live OAuth checks reject missing PKCE, the `plain` challenge method for this client, and an unregistered redirect URI.
- Recorded and pinned actual Node/PostgreSQL/Caddy/Keycloak image digests for the laptop deployment.
- Tailscale Funnel consent completed and the public HTTPS issuer returned 200. Authenticated introspection rejected an intentionally invalid token with `active: false`.
- Reproduced a local form failure in Chrome with dummy input. Set a same-origin referrer policy so same-origin POSTs retain their origin; strict Host/Origin and CSRF checks remain enabled. Confirmed the corrected Chrome submission reaches validation without sending a real key. Applied the policy to the main admin interface as well.
- Account labels now accept spaces while routing remains based on immutable UUIDs.

Still pending: the user's Buffer key entry and live schema mapping, owner sign-in/password change, full code/token/introspection/revocation checks, verified account registration, and the Claude connection. Public discovery has been checked from the host; final Claude-cloud connectivity is still pending. No live post write was performed.

## Optional laptop deployment update

The expanded 17-test suite passes, including exact OAuth resource/issuer/owner binding, PKCE client settings, secret generation, and rejecting invalid laptop origins. TypeScript checking and compilation pass. Docker Compose parses the laptop recipe using isolated dummy configuration; no containers were started. The local private keyring was generated and confirmed ignored by Git. The Tailscale client is not yet installed/enrolled and Docker's engine is unavailable, so Keycloak import, live OAuth, Funnel routing and Claude connectivity have not been verified. This recipe is a personal evaluation deployment and uses the documented beta/experimental Funnel/resource-indicator features.

## Original application checks

Passed locally on Windows / Node 24.12.0:

- TypeScript strict checking and compiled build.
- 15 tests, including official SDK Streamable HTTP initialization/tool calls over actual loopback HTTP.
- Mock-account tests for third-account onboarding, immutable rename, owner isolation, parallel credential routing, invalid/disabled account isolation, rotation without restart, and encrypted storage.
- Resource ownership checks, allowlist/schema-drift rejection, partial aggregate failures, pagination, and cursor-loop rejection.
- Persistent duplicate-write suppression across two bridge instances, changed-input conflicts, encrypted result replay, and ambiguous outcomes without retries. Publishing is mocked throughout.
- HTTP authentication challenge/metadata, hostile Host/Origin rejection, admin session access and logout, and CSRF protection.
- OAuth token validation for exact audience, owner, scope, expiry, revocation/active status, and not-before.
- PowerShell script parsing.
- npm vulnerability audit: zero reported vulnerabilities in the locked dependencies at validation time.
- Source scan found no Buffer/OpenAI key patterns or private-key blocks. No real credentials were supplied or generated for this project.

The live **unauthenticated** Buffer endpoint returned HTTP 401 with the expected authorization-required JSON response. This verifies reachability/authentication enforcement only.

Not performed:

- Authenticated Buffer initialization, actual schema capture, identity mapping, or two/third-account live acceptance.
- Real PostgreSQL tests (the 15-test run used pg-mem; `TEST_DATABASE_URL` enables the real database suite).
- Container build or execution: Docker Desktop's engine pipe was unavailable, including outside the sandbox.
- Real OAuth discovery/login/PKCE/consent/resource-indicator/expiry/revocation integration with a chosen provider. HTTP tests injected mock authentication; validation tests exercise token checks, not a live authorization server.
- Public HTTPS hosting, streaming proxy load tests, backup/restore drills, or end-to-end Claude connection.
- Live media compatibility or any live write.

The Dockerfile pins Node 24.22.3, verified from the official Node.js release index. Release tests must be repeated in that container. Runtime image digests are not yet pinned. This is an implementation candidate pending those release checks, not a production-ready completion claim.
