# Contributing

## Development setup

Use the exact Node.js version in `.nvmrc` for development and the npm version selected by Corepack from `package.json`'s `packageManager` field. Standard CI uses the same pin; published packages support Node.js 22.14+. npm is the canonical dependency installer; `package-lock.json` is authoritative and is also used by GitHub Dependency Review. Do not edit the lockfile directly.

For an unchanged dependency set:

```bash
nvm install
nvm use
npm install --global corepack@0.34.0
corepack enable npm
corepack install
npm ci
npm run check
npm run test:coverage
```

Corepack's npm shim is opt-in: plain `corepack enable` does not enable npm. Repository CI shares `.github/actions/setup-environment`, which reads the tooling checkout's `.nvmrc` and `packageManager`, uses built-in npm download caching for ordinary jobs, and disables caching for privileged jobs. Containers read the same npm pin from the manifest; no npm version is duplicated in setup commands.

When changing dependencies, run `npm install` to update `package-lock.json`, then verify a clean `npm ci` succeeds. Bun and pnpm remain supported for consumers; CI verifies packed installations with all three package managers. Run `npm run smoke:cli` and `npm run check:schemas` when changing CLI behavior or schemas. CI uses `.nvmrc` for its primary runtime and exercises Node 24 separately. Parity jobs install the full development dependency graph with `.nvmrc` before testing packed consumers on Node 22.14 and 24; development-only dependency engines do not redefine the published runtime minimum. CI enforces workspace test coverage thresholds and runs Markdown, link, spelling, dependency, and GitHub Actions security checks.

Use `npm run format` to apply formatting.

## Consumer workflow

The reusable validation and Phrase TMS workflows build `i18n-pipeline` from the called workflow's commit. Consumers do not need an npm dependency on this repository; npm consumer usage is documented for after the first release. Phrase workflows require consumer-owned config plus protected Actions secrets; never run `tms submit` or `tms reconcile` against live Phrase/GitHub resources without explicit approval. Use injected fetch implementations in tests, and update the TMS config schema fixtures whenever the consumer contract changes.
