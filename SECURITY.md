# Security policy

## Supported version

Security fixes currently target the latest `0.1.x` release.

## Local-only boundary

The backend binds to `127.0.0.1`. Do not expose it through a public reverse proxy or change it to `0.0.0.0`: v0.1 has no user authentication, CSRF protection or remote-access hardening. The local-only boundary is part of the security model.

## Reporting a vulnerability

Please open a private GitHub security advisory in the repository that publishes this package. Do not include real tokens, chat messages, calendar titles, financial records or absolute local paths in a public issue. A useful report includes the affected version, reproducible steps using synthetic data, impact and a suggested mitigation.

## Credential handling

- Store secrets only in `backend/.env.local` with mode `0600`.
- Never commit `.env.local`, `backend/data`, logs or generated archives containing runtime data.
- Rotate any credential that was pasted into an issue, log or commit.
- Run `./scripts/privacy-check.sh` on a clean source tree before packaging.

## Remote access

Adding remote access requires authentication, authorization, TLS, CSRF protection, origin validation, audit logs and a new threat model. It is out of scope for v0.1.
