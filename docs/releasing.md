# npm releases

Release preparation for [the npm release ticket](https://issues.redhat.com/browse/RHCLOUD-52111) does not publish packages. Publication is a separate maintainer action after review and merge.

## One-time administrator setup

An npm scope administrator must configure a GitHub Actions trusted publisher for **each** package, `@redhat-cloud-services/eslint-plugin-i18n` and `@redhat-cloud-services/i18n-pipeline`:

- Organization: `RedHatInsights`; repository: `i18n-tooling`.
- Workflow filename: `release.yml` (not its full path).
- Environment: `npm-release`.
- Allow publishing in the trusted publisher settings.

If npm requires a package to exist before adding its trusted publisher, arrange a supervised first publish with the scope administrator, plugin first and CLI second. Do not put a bootstrap token in this workflow. Configure trusted publishing afterward and remove bootstrap credentials. This preparation task performs neither that publish nor any administrator changes.

Create the GitHub environment `npm-release` with required maintainer reviewers, prevent self-review, and disable administrator bypass where available. Restrict deployment refs to selected tags matching `v*`. For resuming, dispatch the workflow from the existing release tag so the environment tag restriction and trusted publisher identity match. Keep the existing immutable `v*` tag ruleset and maintainer/admin creation restriction. The environment needs no secrets.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for setup and current platform requirements. This workflow uses GitHub-hosted runners, Node 24, a pinned npm version, and `id-token: write`. It does not configure an npm authentication token. An unprivileged preflight copies the eligibility policy and its SemVer helper from protected `origin/main` into a temporary directory; it installs no candidate dependencies and runs no candidate build scripts. Only a successful preflight enables the publishing job and its OIDC permission. Protected `main`, immutable release tags, and reviewers checking the workflow definition remain the trust boundary.

## Prepare and release

1. In a feature worktree, run `node scripts/set-version.mjs <version>`. It changes both package versions and the CLI's exact plugin dependency, refuses invalid SemVer and downgrades, and leaves lockfiles untouched. Equal versions are allowed for the first release or retry. Use npm-compatible release versions; npm rejects versions containing build metadata.
2. Run `bun install`, then `bun install --yarn`. Bun 1.3.14 owns `bun.lock`; Yarn is the generated mirror. The new FormatJS peer also requires this refresh before the first release. Never install repository dependencies with npm.
3. Run `npm run check`, `npm run test:coverage`, `npm run check:schemas`, `npm run check:markdown`, and `npm run smoke:cli`. Inspect `npm pack --dry-run` in each package. Commit version/lockfile preparation locally before parity testing; a dirty checkout is rejected. Build a local parity image from this commit with `podman build -f Containerfile --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t localhost/i18n-tooling:parity .`, then run `npm run test:pack-parity -- --pm npm --image localhost/i18n-tooling:parity --container-engine podman` with network access for installation. Repeat for `--pm bun` and `--pm pnpm`. The image runs non-root with a read-only filesystem and no network; all six fixtures in both modes must match the packed CLI's exit code and six result files. CI builds the same-commit image and tests all three installers on Node 22.14 and 24, including packed ESM import and CommonJS require.
4. Open a reviewed PR containing package metadata and refreshed lockfiles, then merge it into `main`. Wait for `Core validation`, `Code quality`, and `Security checks` to succeed on the exact commit to release. CI runs on branch pushes and pull requests, not release-tag pushes, so creating the tag does not queue newer checks that race release preflight.
5. A maintainer creates and pushes the immutable `v<version>` tag pointing at that commit. For example, `v0.1.0` matches package version `0.1.0`. Approve the `npm-release` environment deployment.

The preflight checks out the tag with full history but executes only the policy loaded from protected `main`. The eligibility script requires the triggering event ref and SHA to match that tag and checkout (so npm provenance names the actual release commit), the tag to match both versions, the CLI dependency to equal the plugin version exactly, the tagged commit to be reachable from `origin/main`, and the newest run of every required aggregate check to have completed successfully for that commit. The publishing job verifies its checkout against the preflight's approved SHA before installing frozen dependencies and running `npm run check`. The preflight queries the GitHub Checks API using the workflow token with read permission. Missing, pending, skipped, or failed checks refuse the release.

The plugin is published before the CLI. Each package's exact version is checked with `npm view`; existing versions are skipped. Only an npm `E404` permits publication after a failed lookup; other registry errors stop the workflow. The final smoke check installs both exact published versions with scripts disabled, runs the CLI version command, and verifies signatures.

## Resume and verify

If a release fails after the plugin was published, fix the operational cause and dispatch `release.yml` from the same tag, setting its required `tag` input to that tag. The dispatch ref and input must both be that tag; a different ref or event SHA is rejected. Existing versions are skipped, including after a smoke-check failure. Never move a tag or replace published bytes. If code changes are required, make a new version and tag through the normal PR process.

Trusted publishing automatically attaches provenance to public packages. Inspect each package version on npm for its provenance link and confirm it names this repository, the tagged commit, and `release.yml`. In a fresh directory, install both exact versions with `--ignore-scripts`, run `i18n-pipeline version` through the installed binary, and run `npm audit signatures`. See [npm provenance verification](https://docs.npmjs.com/generating-provenance-statements/).

Published versions cannot be rolled back in place. For a defective release, publish a reviewed corrective version; consumers may temporarily pin their previous known-good version.
