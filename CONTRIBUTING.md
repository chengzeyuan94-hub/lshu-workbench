# Contributing

## Development setup

1. Install Node.js 24.
2. Run `./scripts/setup.sh`.
3. Start the backend with `cd backend && npm run dev`.
4. In another terminal run `cd frontend && npm run dev`.

The development frontend uses `http://127.0.0.1:3456` as its API proxy by default.

## Required checks

```bash
./scripts/privacy-check.sh
cd backend && npm test && npm run build
cd ../frontend && npm test && npm run build
```

Do not commit local databases, credentials, logs, screenshots with real content or personal absolute paths. Tests and documentation must use synthetic identities and records.

## Product constraints

- Keep external writes disabled by default.
- Do not weaken the `127.0.0.1` binding.
- New connectors must be opt-in and degrade honestly when unavailable.
- UI changes should follow `DESIGN.md` and preserve keyboard/reduced-motion behavior.
- Schema changes require migration and regression tests.
