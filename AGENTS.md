# AGENTS.md

Three npm packages, released together at one version: `packages/cashsdk-web` (browser, no
dependencies), `packages/cashsdk-react` (React bindings) and `packages/cashsdk-node` (server).

- `pnpm install`, then `pnpm build && pnpm lint && pnpm test && pnpm verify` before any change is done.
- Tests use Node's built-in runner against the built `dist/`, so build first.
- `cashsdk-web` must not touch `window`, `document` or storage at import time, and must not
  depend on anything. Customer ids only ever come from sessions the merchant's backend issues.
- Writes need an idempotency key and are never retried by the SDK on its own.
- Releases: bump all three `version` fields, then push a tag `v<version>`. `.github/workflows/release.yml`
  publishes with npm trusted publishing. Never publish from a laptop.
- Writing style: no em dashes. Short sentences, plain words.
