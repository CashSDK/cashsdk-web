# Contributing

Thank you for helping. Before you open a pull request:

1. `pnpm install`, then `pnpm build && pnpm lint && pnpm test && pnpm verify`. All four must pass.
2. Keep the three packages at one version. They are released together.
3. Keep `cashsdk-web` free of runtime dependencies and of anything that only exists in Node.js.
   It must import safely during server rendering, with no `window` or `document` at load time.
4. Never add a way for browser code to hold a server key or choose which customer it is.
5. Add a test for the behaviour you change.

These packages are developed in the CashSDK monorepo and published here. A merged change is
applied there and comes back with the next release, so the history of this repository is
rewritten on each release. Please keep that in mind before depending on a commit hash.
