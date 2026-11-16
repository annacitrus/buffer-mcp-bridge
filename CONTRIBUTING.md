# Contributing

Open an issue to discuss substantial changes before implementing them. Small fixes and documentation improvements can go directly to a pull request.

## Local checks

Use Node 24 LTS and install from the lockfile:

```sh
npm ci
npm run check
npm test
npm run build
```

Tests use mock Buffer accounts by default. Use a disposable PostgreSQL database through `TEST_DATABASE_URL` when changing persistence or transaction behavior. Add meaningful regression coverage for authorization, account isolation, and write reliability changes.

## Pull requests

- Explain the problem, resulting behavior, and validation performed.
- Preserve the explicit tool allowlist, owner/account scoping, and immutable routing IDs.
- Never automatically resend an ambiguous upstream write.
- Keep `.env`, keyrings, API keys, tokens, private probe samples, and database dumps out of commits and logs.
- Do not publish test posts. Any live write validation needs separate account-owner authorization and must create only a clearly labeled draft.
- Update setup and operational documentation when behavior changes.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), rather than disclosing details in public issues.
