# Contributing

## Development setup

Use Node.js 22 or newer and Bun 1.3.14, as pinned in `.nvmrc` and `package.json`. Bun is the canonical dependency installer; this repo intentionally has no npm lockfile. Do not run `npm install` or `npm ci`; use npm only to run scripts under Node.

```bash
bun install --frozen-lockfile
npm run check
```

Use `npm run format` to apply formatting and `npm run test:coverage` to collect package coverage.

## Package releases

For user-facing changes, run `bunx changeset`, select each affected package, and choose the appropriate semver bump. Commit the generated changeset with the change. Merging to `main` opens or updates a version PR; merging that PR publishes the packages to npm. The repository needs an `NPM_TOKEN` secret with publish access for `@redhat-cloud-services`.
