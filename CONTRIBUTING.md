# Contributing

## Development setup

Use Node.js 22 or newer and Bun 1.3.14, as pinned in `.nvmrc` and `package.json`. Bun is the canonical dependency installer; `bun.lock` is authoritative. Bun also generates `yarn.lock` as a mirror for GitHub Dependency Review; do not edit that file directly. This repository has no npm lockfile. Do not run `npm install` or `npm ci`; use npm only to run scripts under Node.

For an unchanged dependency set:

```bash
bun install --frozen-lockfile
npm run check
npm run test:coverage
```

When changing dependencies, run `bun install` to update `bun.lock`, then `bun install --yarn` to refresh `yarn.lock`. Run `npm run smoke:cli` and `npm run check:schemas` when changing CLI behavior or schemas. CI exercises Node 22 and 24, enforces workspace test coverage thresholds, and runs Markdown, link, spelling, dependency, and GitHub Actions security checks.

Use `npm run format` to apply formatting.

## Consumer workflow

The reusable validation workflow builds `frontend-i18n` from the called workflow's commit and exposes it to the consumer's validation script. Consumers do not need an npm dependency on this repository; workspace packages are not published to npm.
