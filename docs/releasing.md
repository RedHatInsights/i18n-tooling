# npm releases

`release.yml` publishes both packages with one shared version through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no token). It runs only on `v*` tags.

## One-time setup

- An npm scope administrator configures a trusted publisher for **each** package, `@redhat-cloud-services/eslint-plugin-i18n` and `@redhat-cloud-services/i18n-pipeline`: repository `RedHatInsights/i18n-tooling`, workflow `release.yml`, environment `npm-release`. If npm requires a package to exist first, arrange a supervised first publish (plugin, then CLI) and remove any bootstrap credentials afterwards.
- Create the GitHub environment `npm-release` with required maintainer reviewers, no self-review, deployments restricted to `v*` tags, and no secrets. Keep the immutable `v*` tag ruleset.

## Release

1. In a feature worktree, set the version and the CLI's exact plugin dependency, then refresh the lockfile:

   ```bash
   npm version <version> --workspaces --no-git-tag-version --no-workspaces-update
   npm pkg set "dependencies.@redhat-cloud-services/eslint-plugin-i18n=<version>" -w packages/i18n-pipeline
   npm install
   ```

2. Commit, then run the checks and pack parity against a same-commit image:

   ```bash
   npm run check && npm run test:coverage
   podman build -f Containerfile --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t localhost/i18n-tooling:parity .
   npm run test:pack-parity -- --pm npm --image localhost/i18n-tooling:parity --container-engine podman
   ```

3. Merge the reviewed PR. Wait for `Core validation`, `Code quality` and `Security checks` to succeed on that `main` commit.
4. Push the tag `v<version>` on that commit and approve the `npm-release` deployment.

Before installing anything, the job runs `scripts/release-check.mjs` from protected `origin/main`. It refuses the release unless the tag equals `v<version>` for both packages, the CLI depends on exactly that plugin version, the commit is reachable from `origin/main`, and the newest run of each required check succeeded for that commit. It then runs `npm run check`, publishes the plugin and then the CLI, skipping versions already on the registry, and smoke-installs both with `npm audit signatures`.

## Resume and verify

If a release fails part-way, fix the operational cause and dispatch `release.yml` from the same tag; published versions are skipped. Never move a tag or replace published bytes; code changes need a new version.

Check each version's provenance on npm names this repository, the tagged commit and `release.yml`. Published versions cannot be rolled back; publish a corrective version instead.
