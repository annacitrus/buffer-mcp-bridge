# Free personal laptop setup

This optional setup runs the bridge, two isolated PostgreSQL instances, and Keycloak locally. Tailscale Personal and Funnel provide a public HTTPS hostname without buying a domain or server. There is no extra hosting/auth subscription for personal use within their free plan. Your laptop must stay on, awake, and online. Funnel and Keycloak's resource-indicators feature are beta/experimental: this is a personal evaluation deployment, not an uptime or production-readiness guarantee.

**Status:** configuration prepared; Docker, Tailscale enrollment, Buffer credentials, live OAuth, and Claude connectivity still require validation. Do not enable a public Funnel until the services and authentication are ready for that validation.

## Actions that need you

1. Open Docker Desktop and wait until the Linux engine is running. Complete any Windows/WSL prerequisites it requests. If Windows needs a restart, do that first.
2. Install Tailscale from [the official Windows download](https://tailscale.com/download/windows), sign in, and choose Personal for your own devices. You must handle any account terms, sign-in, and Windows installer/UAC prompts yourself. No paid plan is needed for this route.
3. In each separate Buffer account, open **Settings → API**, create one bridge key, and save it privately. Keys are entered into masked terminal or bridge admin forms, never chat.

## Prepare the private files

In the repository folder, create the keyring if one does not already exist:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\new-keyring.ps1
```

Then:

```powershell
npx --no-install tsx scripts/prepare-laptop.ts
```

It discovers your own device hostname through `tailscale status --json` and generates private, ignored `.env.laptop`, `secrets/laptop-realm.json`, and `secrets/laptop-access.json`. It does not expose ports or create a Tailscale account. It refuses to overwrite existing configuration. Do not print, commit, or share those files. The realm import contains randomly generated OAuth/bootstrap secrets, not Buffer keys.

Complete the read-only Buffer probe and reviewed schema mapping from [README](../README.md#verify-buffer-and-generate-a-contract). You need the resulting `config/buffer-contract.json` before the app starts. Test fixtures are not a substitute.

## Run the local services

```powershell
docker compose --env-file .env.laptop -f deploy/laptop.compose.yaml build
docker compose --env-file .env.laptop -f deploy/laptop.compose.yaml up -d db auth-db identity gateway
docker compose --env-file .env.laptop -f deploy/laptop.compose.yaml run --rm --no-deps app node dist/scripts/migrate.js
```

Keycloak imports the realm only on first startup. Its account ID is pinned as the bridge's allowed owner subject. App and Claude clients require S256 PKCE and exact callbacks. The resource client's ID equals the exact `/mcp` resource URL so audience-restricted token introspection can target it. Confirm those provider behaviors with live tests before use; no relaxation of audience checks is included.

The Keycloak management interface has no published host port. The public gateway permits only the `buffer-bridge` realm and login assets; it blocks Keycloak's admin and master-realm routes. Use Keycloak's `kcadm.sh` from inside the identity container for recovery or administration. Both databases also have no published host port.

## Enable HTTPS and verify OAuth

The first Funnel setup may require you to enable HTTPS/Funnel for your personal tailnet in Tailscale's consent screen. Only the gateway port is exposed:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg --https=443 http://127.0.0.1:8085
docker compose --env-file .env.laptop -f deploy/laptop.compose.yaml up -d app
```

Funnel publishes the gateway to the internet. Do not point it at your project folder, database, Keycloak admin port, or a different app. Leave existing Funnel configuration intact if this machine already shares another service; resolve the routing conflict before running this command.

Open `secrets/laptop-access.json` **locally in a trusted editor** to obtain the owner temporary password and URLs. At the public bridge `/admin`, sign in as `owner` and complete the required password change yourself. Add and verify the two Buffer accounts in the bridge admin UI. The Keycloak local bootstrap-admin password is for administration only, not Claude login.

Verify the public issuer discovery document, S256 enforcement, wrong-resource rejection, expiry and revocation. Confirm unauthorized MCP calls return 401. Check that `/identity/admin/` and the master realm cannot be reached at the public hostname. If any check fails, disable Funnel and diagnose locally.

## Connect Claude

At **Customize → Connectors → Add custom connector**, set the name to **Buffer Multi-Account** and the URL to the private access file's `bridge_url`. Choose OAuth **Use your own OAuth client**. The client ID and secret are in that same private file. Enter them only into Claude's connector settings, then sign in as `owner`.

Run `bridge_list_accounts` and check both identities. Test reads before allowing writes. Keep the existing Buffer Personal connector intact. Do not publish a test post.

## Availability, backups and stopping

- Closing/sleeping/restarting the laptop interrupts access until Docker and Tailscale are running again. Docker containers use restart policies; do not change laptop power settings without deciding on that tradeoff.
- Keep the Tailscale device name stable; changing its public hostname requires a deliberate OAuth/contract deployment update.
- Back up the Docker database volumes and private encryption keyring separately. Keycloak's database also holds owner credentials and sessions.
- Retain `secrets/laptop-access.json` privately until you have saved the required client credentials in an appropriate secret store. The first realm import is not a general credential-rotation mechanism.
- To stop only this gateway's public Funnel, use the documented Tailscale per-port `off` command after checking existing Funnel configuration. Do not reset unrelated sharing.
- To stop containers without deleting data: `docker compose --env-file .env.laptop -f deploy/laptop.compose.yaml stop`.

References: [Tailscale Personal pricing](https://tailscale.com/pricing), [Funnel](https://tailscale.com/docs/features/tailscale-funnel), [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [Keycloak MCP configuration](https://www.keycloak.org/securing-apps/mcp-authz-server).
