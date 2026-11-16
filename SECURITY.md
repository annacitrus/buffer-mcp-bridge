# Security

This project is in beta. Verify live Buffer/OAuth compatibility and deployment security before production use; see [VALIDATION.md](VALIDATION.md).

## Reporting a vulnerability

Use **Security → Advisories → Report a vulnerability** on this repository if private reporting is enabled. If unavailable, open an issue requesting a private reporting channel **without disclosing vulnerability details or sensitive data**. Wait for a private channel before sharing details.

Include the affected commit/version, impact, and a minimal reproduction using fictional accounts. Do not include API keys, tokens, keyrings, `.env`, private probe samples, or real post content. There is no guaranteed response-time SLA.

## Deployment responsibilities

Use HTTPS, owner MFA, private secret files, current runtime patches, and encrypted off-host backups. Verify OAuth audience/scope/subject checks and revocation with the deployed provider. Keep the database and encryption keyring separate. Revoke compromised Buffer keys in Buffer; removing a bridge registration does not revoke its key.
