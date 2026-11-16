# Validation record — 2026-11-16

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
