<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.cashsdk.com/brand/wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://assets.cashsdk.com/brand/wordmark.svg">
  <img alt="CashSDK" src="https://assets.cashsdk.com/brand/wordmark.svg" width="360">
</picture>

### Subscriptions and access for web apps and Chrome extensions.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

> **Generally available.** Version `1.0.0` is on npm, including the extension module. Checkout
> started by the SDK, your own Stripe Checkout, access reads and the Stripe customer portal work
> in Sandbox and Production. Compiled GitHub release archives are also available. Before you take
> real payments, follow [Go live with Stripe](https://docs.cashsdk.com/sdk/go-live).

| Package | Use it for |
| --- | --- |
| [`cashsdk-web`](packages/cashsdk-web) | The browser: the signed-in customer, their access, offerings, checkout |
| [`cashsdk-web/extension`](packages/cashsdk-web) | Chrome MV3 popup, side panel and service worker sessions, access and hosted billing actions |
| [`cashsdk-react`](packages/cashsdk-react) | React 18 and 19 hooks on top of `cashsdk-web` |
| [`cashsdk-node`](packages/cashsdk-node) | Your backend: customer sessions, access checks, webhook signatures |

```sh
npm install cashsdk-web cashsdk-node
```

For React, also install `cashsdk-react`. All three packages carry verified
registry signatures and build provenance. Archives and checksums remain available in the
[release](https://github.com/CashSDK/cashsdk-web/releases/tag/v1.0.0).

## How it fits together

1. Your backend signs the customer in, then calls `createWebSession` with `cashsdk-node` and a
   server key. It returns a short-lived session for that one customer and that one origin.
2. The browser gets that session from your backend and reads the customer's access with
   `cashsdk-web`. It never holds a server key.
3. A purchase goes to the provider's hosted checkout. Access follows from the provider's
   signed events, never from the return to your page.
4. Your backend checks access again before it serves anything paid for.

The full guide is at [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web).
`examples/web-basic` is a complete application, with sign-in, checkout and a protected resource.
`examples/chrome-extension` bundles the extension module locally and preserves checkout attempts
when its popup or service worker restarts.

## Requirements

Browsers with `fetch`, `AbortController` and ES2022. Node.js 20.19+ or 22.12+ for your backend
and for server rendering. The packages are ES modules with TypeScript declarations, and on those
Node.js versions a CommonJS backend can `require` them too. `cashsdk-web` has no dependencies.

## Development

```sh
pnpm install
pnpm build && pnpm lint && pnpm test
pnpm verify    # packs all three, installs the tarballs into an empty project, imports them
```

An export containing `cashsdk-candidate.json` is a local review build. Its packages are private,
use a source-hashed candidate version and cannot pass the release workflow. Install the files
under `artifacts/` for local verification. A normal release must be rebuilt from committed source.

This repository is published from the CashSDK monorepo, where the platform the packages talk to
is developed. Issues and pull requests are welcome here; accepted changes are applied there and
published back. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
