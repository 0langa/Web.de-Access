# Web.de Access — Current Status

_Last verified: 2026-08-05_

## Current source state

- The latest released source tag is `v0.2.7` (`226140b`). Check local and
  remote branch heads live before release work.
- `package.json`, `package-lock.json`, and the three provider manifests use
  version `0.2.7`.
- The lockfile uses `@modelcontextprotocol/sdk` `^1.30.0` and scoped overrides
  for its vulnerable transitive packages. A fresh production audit reports zero
  vulnerabilities.
- Credentials remain outside the repository in the operating-system credential
  store. The server fails closed for legacy password environment variables and
  plugin-local `.env` credentials.

## Verification commands

| Command | Verifies |
| --- | --- |
| `npm run check` | MCP server syntax |
| `npm test` | 13 offline security, configuration, manifest, and public-safety tests |
| `npm run security:scan` | No legacy credential files or unexpected secret references |
| `npm audit --omit=dev --audit-level=high` | Production dependency advisory gate |

`.github/workflows/ci.yml` runs the offline checks above on Windows for every
push and pull request. It deliberately uses `npm ci --ignore-scripts` and does
not execute live mailbox operations.

## Maintenance boundaries

- `npm run smoke` uses stored credentials and touches a real mailbox; run it
  only with an authorized profile.
- `npm run e2e:email` sends a real message. It is excluded from CI and normal
  source maintenance.
- Keep provider manifests and their shared skill path in sync; tests enforce the
  current layout and secret-free public files.

## Next action

For a source or dependency change, run the verification commands above before
committing. A tag, GitHub release, marketplace publication, or client update is
a separate delivery decision.
