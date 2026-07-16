# Esbla

Esbla is a tenant-aware business platform implemented as a modular monolith.

This repository contains public runtime source only. Private product planning,
research archives, prompts, and the Esbla planning database do not belong here.

The supported toolchain is Node.js 24 and pnpm 11.7.0. Browser validation also
requires local PostgreSQL binaries discoverable through `pg_config` and the
full bundled Playwright Chromium browser.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --dir scripts/test/browser-tooling --ignore-workspace install --frozen-lockfile
pnpm --dir scripts/test/browser-tooling --ignore-workspace exec playwright install --no-shell chromium
pnpm run test:browser
pnpm run ci
pnpm dev
```

Current posture: runtime foundation only. No production, deployment, provider,
money-movement, or regulatory-compliance claim is made.
