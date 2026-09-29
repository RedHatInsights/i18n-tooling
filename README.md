# i18n Tooling

Shared product-UI internationalization tooling for HCC and other Red Hat frontend applications.

## Why this repository

`hcc-i18n` is the architecture and workflow initiative. This repository is the reusable implementation layer, named simply `i18n-tooling` because it may serve more than one frontend product:

- ESLint rules for ICU MessageFormat source and locale-catalog invariants.
- A Node.js/TypeScript catalog-adapter package and CLI.
- Reusable GitHub Actions workflows.
- Shared schemas and test fixtures for locale catalogs and backend-error contracts.

HCC is the first consumer; tooling should not make every future consumer pretend to be HCC.

## Initial packages

| Package                                     | Role                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redhat-cloud-services/eslint-plugin-i18n` | ESLint rules for message IDs, source catalogs, and ICU-oriented source checks.                                                                                       |
| `@redhat-cloud-services/i18n-pipeline`      | Node.js package with the normalized catalog model, FormatJS and keyed ICU JSON adapters, adapter plugin loading, ICU syntax validation, and the `frontend-i18n` CLI. |
| `.github/workflows/`                        | Repository CI and reusable consumer validation.                                                                                                                      |

The TypeScript packages target Node.js 22+. Bun 1.3.14 manages workspace dependencies, while package code and the CLI run under Node.js. Framework extraction and compilation remain in each consumer's native tooling.

## Design rules

- ICU MessageFormat remains normative for every catalog adapter. Built-in adapters parse patterns with FormatJS's official `@formatjs/icu-messageformat-parser`.
- Initial built-ins target FormatJS descriptor/compiled JSON and keyed ICU JSON for service errors.
- Catalog-format adapters stay separate from TMS-provider adapters.
- Teams extend formats through installed Node packages, stable adapter IDs, and adapter-specific JSON options. GitHub `uses` references are not dynamic.
- Canonical locale catalogs remain repository-owned; TMS is a translation workspace, never a runtime dependency.
- Provider-specific Phrase/APC/webhook behavior belongs behind a future TMS-provider interface.
- English `detail` is fallback for backend errors; the English source catalog is fallback for UI messages.
- i18next, Lingui, and Django PO conversion are future adapters, not part of this POC slice.

## Terminology

- **Message ID** — Stable identifier used by application code to refer to the same translatable message across locales.
- **Locale catalog** — Repository-owned set of messages for one locale, keyed by message ID. Here, catalogs are JSON files, not ICU resource bundles.
- **Source catalog** — Canonical catalog for English source messages; also the fallback for missing or unavailable translations.
- **Target catalog** — Locale catalog containing translations of the source messages.
- **ICU MessageFormat pattern** — Syntax for message arguments, number/date formatting, and plural/select logic. It describes how messages are formatted, not how locale data is stored.
- **ICU resource bundle** — ICU's native locale-aware data container and lookup/fallback model. It is distinct from this repository's JSON locale catalogs.
- **ICU message catalog** — ICU's separate POSIX-style `ucat` API. Avoid this label for our JSON catalogs.
- **TMS (translation management system)** — Workspace for translation work; it is not a runtime dependency or source of truth.

## Repository layout

```text
.github/workflows/       Reusable consumer workflows
packages/
  eslint-plugin-i18n/    Workspace ESLint plugin
  i18n-pipeline/         Workspace Node.js/TypeScript module and CLI
schemas/                 Shared machine-readable contracts
docs/                    Architecture and consumer guidance
```

## Local development

Use Node.js 22 or newer and Bun 1.3.14. Bun is the canonical dependency installer; `bun.lock` is authoritative, while Bun generates `yarn.lock` as a mirror for GitHub Dependency Review. Do not run `npm install` or `npm ci`; use npm only to run scripts under Node:

```bash
bun install --frozen-lockfile
bun install --yarn
npm run check
```

CI tests Node 22 and 24 in separate typecheck, test, and build jobs. It also checks coverage thresholds, source-built CLI behavior, schemas, reusable workflow behavior, and GitHub Actions security.

The package CLI is compiled to Node-compatible ESM:

```bash
npm run build --workspace @redhat-cloud-services/i18n-pipeline
node packages/i18n-pipeline/dist/cli.js version
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and consumer workflow guidance.

## Shared validation workflow

The reusable `i18n-validate.yml` workflow checks out tooling source at the called workflow's commit, builds the CLI and ESLint plugin, checks consumer source message IDs against the configured catalog, then runs the consumer's validation script with `frontend-i18n` available. The source glob defaults to `src/**/*.{js,jsx,ts,tsx}` and can be overridden with `source-glob`; include files that declare reusable messages too. The ESLint check rejects missing catalog entries, missing or dynamic inline IDs, and opaque descriptor expressions. Declare reusable descriptors with `defineMessages` so their IDs are checked at the definition. Consumers do not need an npm dependency on this repository, and this repository does not publish workspace packages to npm.

## Consumer examples

`rbac-ui` keeps its native FormatJS extraction/compile script and selects the matching catalog adapter:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      package-manager: bun
      validation-command: i18n:validate # consumer script runs FormatJS extraction/compilation and frontend-i18n check
      catalog-adapter: formatjs-json
      catalog-path: locales/translation-template.json
      catalog-role: source
      catalog-locale: en
```

Replace `<reviewed-commit-sha>` with a reviewed commit SHA. The reusable workflow checks out the consumer repository and `i18n-tooling` at the exact commit of the called workflow (`job.workflow_sha`). It installs consumer dependencies with the selected package manager and the tooling workspace with Bun, builds the CLI and ESLint plugin, then lints the configured source glob against `catalog-path` before running the consumer script with `npm run` under Node.js. The rule recognizes FormatJS `formatMessage`, `defineMessage(s)`, and `<FormattedMessage>` forms; IDs must be static and present in the catalog. The consumer script can call `frontend-i18n validate` for one catalog or `frontend-i18n check` for a source/target pair; catalog settings arrive through `I18N_CATALOG_*` environment variables. Neither package needs npm publication. Pinning the reusable workflow pins the CLI and rule source too.

## Phrase TMS round trip

The reusable Phrase workflows submit one validated source catalog and reconcile completed target jobs into ordinary locale-specific pull requests:

- `.github/workflows/phrase-submit.yml` exposes `workflow_call` for manual source submission.
- `.github/workflows/phrase-reconcile.yml` exposes `workflow_call` for scheduled or manual reconciliation.
- `frontend-i18n tms submit --config <path>` validates and submits the pinned source revision. The PR base defaults to the pushed or dispatched branch; pull-request and tag runs must pass `--base-ref` (reusable-workflow input `base-ref`).
- `frontend-i18n tms reconcile --config <path>` reads durable batch state, waits for each locale's final Phrase workflow step to reach `COMPLETED`, downloads and validates the target catalog, and opens or updates one PR per locale.

Consumer configuration follows [the Phrase TMS config schema](schemas/phrase-tms-config.schema.json). For copyable caller/config examples and a test of the per-locale-to-runtime-data handoff, see the [Phrase consumer integration example](docs/phrase-consumer-integration.md):

```json
{
  "provider": "phrase",
  "project": { "uid": "<phrase-project-uid>", "region": "us" },
  "state": { "branch": "i18n-tms-state" },
  "sourceCatalog": {
    "path": "locales/translation-template.json",
    "adapter": "formatjs-json",
    "locale": "en",
    "importSettingsUid": "<phrase-import-settings-uid>"
  },
  "targetAdapter": "formatjs-json",
  "targetLocales": [
    {
      "phraseLocale": "fr",
      "repositoryLocale": "fr",
      "outputPath": "locales/fr.json"
    }
  ],
  "completionPolicy": { "default": "per-locale" }
}
```

Set `sourceCatalog.importSettingsUid` or `useProjectFileImportSettings` when the Phrase project requires a particular import format. `sourceCatalog.filename` defaults to the source path's basename. `project.region` selects the Platform OAuth and TMS API hosts (`eu` or `us`).

Phrase credentials come from one of two secret sets. The CLI chooses by **which secret names are set**; it never inspects a value to guess its kind, so a value stored under the wrong name is sent with the wrong login flow and Phrase rejects it:

- **Service Account (preferred for automation):** `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`, used with the OAuth client-credentials grant. A Phrase organization admin creates the account under Organization Settings → Service Accounts; the secret is shown once. The account is not tied to a person, but it cannot own projects, and job creation by a service account still needs one verified test job in the target project.
- **User token:** `PHRASE_PLATFORM_API_TOKEN`, a Platform API token from Settings → Profile → Access tokens, exchanged for a short-lived access token. It carries that user's full permissions, expires after two years, and stops working if the user is deactivated.

Selection rules (unset reusable-workflow secrets arrive empty and count as not set):

| Secrets set                                 | Result                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Both service-account secrets, no user token | Service account                                                  |
| User token only                             | User token                                                       |
| Both kinds                                  | Fails before any request; the error says which secrets to remove |
| Only one service-account secret             | Fails before any request                                         |
| None                                        | Fails before any request                                         |

Each `tms` run logs the chosen kind, for example `Phrase auth: service account (PHRASE_SERVICE_ACCOUNT_CLIENT_ID/_SECRET)`, never the value. If Phrase rejects the credentials, the error names the kind that was tried, for example `Phrase Platform OAuth returned HTTP 401 for the service account credentials`. To switch from the user token to a service account, add both service-account secrets and delete `PHRASE_PLATFORM_API_TOKEN` in the same change.

Put the secrets in a protected Actions environment and pass that environment as the reusable-workflow `environment` input. A caller may instead map repository/organization secrets to the same workflow-call secret names (GitHub secret names are case-insensitive). The CLI rejects credential-like keys (for example `apiToken`, `api_key`, `clientSecret`) anywhere in the config so tokens cannot enter batch-state files; the JSON schema does not enforce this. GitHub PR and state operations use the run's `GITHUB_TOKEN`, with `contents: write` and (for reconciliation) `pull-requests: write`; no personal GitHub token is used.

A consumer owns the trigger and pins the reusable workflow to a reviewed commit. Example manual caller:

```yaml
on:
  workflow_dispatch:
jobs:
  submit:
    uses: RedHatInsights/i18n-tooling/.github/workflows/phrase-submit.yml@<reviewed-commit-sha>
    with:
      config-path: .github/i18n/phrase-tms.json
      environment: phrase-pilot
    permissions:
      contents: write
```

Put the Phrase secrets in the consumer's `phrase-pilot` Actions environment; the called job binds to that environment. If using repository/organization secrets instead, explicitly map them, for example `secrets: { PHRASE_SERVICE_ACCOUNT_CLIENT_ID: ${{ secrets.<id-name> }}, PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET: ${{ secrets.<secret-name> }} }`—never use `secrets: inherit`. The consumer's reconciliation caller should use the same `environment` and grant `contents: write` plus `pull-requests: write`; a schedule belongs in that consumer repository and runs from its default branch only.

Batch state is stored on the configured state branch under `.github/i18n-state/batches/` (the GitHub contents API lists at most 1,000 records per directory). A batch is keyed by repository, PR base, exact source bytes, and the Phrase-facing settings (project, region, filename, import settings, target languages). The source commit is not part of the key, so re-dispatching or pushing unrelated commits never creates a second Phrase job for unchanged source; repository-side mapping changes (output paths, adapters, completion policy) are adopted by the existing batch. The workflow refuses ambiguous job-creation retries, supersedes stale source batches, and never auto-merges translation PRs. Reconciliation currently supports one final job part per catalog and locale. `COMPLETED` on the final workflow step is the success signal; `DELIVERED` is not treated as completion.

Batch phases: `creating` → `importing` → `ready` → `completed`, or `failed`/`superseded`. `completed`, `failed`, and `superseded` batches are not reconciled again. Reconciliation also resumes `importing` batches whose submit run timed out. Each locale is reported once when it fails; `tms reconcile` exits non-zero only for new failures or transient `retrying` errors, and an error in one batch never blocks the others. An `all-locales` target fails as soon as any other locale in its batch fails, because it can never become releasable. A PR that was closed without merging fails that locale permanently; reopen the PR or delete its branch and resubmit.

A `failed` batch blocks resubmission of the same source. After fixing the cause in Phrase, run `tms submit --retry-failed` (reusable-workflow input `retry-failed: true`) to create a new job. Resubmitting source that was `superseded` and has become current again revives the existing batch instead of creating a new job. Superseded batches are never cancelled in Phrase automatically, since that would discard translator work; cancel stale jobs in Phrase if they should not continue.

Submission and reconciliation use separate concurrency groups, so a queued reconcile cannot cancel a pending submission. They may run at the same time: state writes are compare-and-swap on the state file, and a write rejected only because the branch head moved is retried. Both jobs time out after 30 minutes; each Phrase request times out after 60 seconds and each GitHub request after 30 seconds.

**Manual recovery for an ambiguous submission:** Do not rerun an `unknown`/stalled `creating` batch blindly. Inspect the exact Phrase project and job. If the job exists, edit only its JSON record (`<state.directory>/<batch-key>.json` on the configured state branch): preserve its key/config/source fields, add the verified `importAsyncRequestId` and complete `jobs` array (`uid`, `targetLang`, and `workflowLevel` for every job part), and set `phase` to `importing`. Rerun `tms submit` to resume import polling without creating another job. Delete only that exact state record if authoritative Phrase inspection confirms no job was created; then retry. If the remote outcome is uncertain, stop. No recovery CLI exists yet.

**GitHub Actions caveat:** PRs opened with `GITHUB_TOKEN` can trigger `pull_request` workflows for `opened`, `synchronize`, or `reopened`, but GitHub holds those runs for maintainer approval. Do not assume generated PRs will have automatically running/passing consumer checks; see [GitHub's token-trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). This implementation deliberately does not replace `GITHUB_TOKEN` with a PAT or auto-merge PRs.

The reusable workflows are generic; they do not add `rbac-ui` configuration or schedule wiring. Live Phrase job creation and secret setup remain explicit acceptance steps.

A service can validate its service-owned keyed ICU JSON catalog the same way:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      package-manager: npm
      validation-command: i18n:validate
      catalog-adapter: icu-json
      catalog-path: i18n/en.json
      catalog-role: source
      catalog-locale: en
```

Run the CLI directly with explicit options or use workflow environment settings. `check` compares source and target message IDs and named ICU arguments, including arguments nested inside plural/select branches:

```bash
frontend-i18n validate \
  --adapter icu-json \
  --catalog i18n/en.json \
  --role source \
  --locale en

frontend-i18n check \
  --source locales/translation-template.json \
  --target locales/fr.json \
  --target-locale fr

frontend-i18n convert \
  --source locales/translation-template.json \
  --source-adapter formatjs-json \
  --target-adapter icu-json \
  --output i18n/en.json \
  --locale en
```

### Add a custom catalog adapter

Install a package that default-exports an object implementing `CatalogAdapter`, then map its stable ID in the consumer's `package.json`:

```json
{
  "dependencies": {
    "@acme/i18n-adapter-yaml": "^1.0.0"
  },
  "i18nTooling": {
    "catalogAdapters": {
      "acme-yaml": "@acme/i18n-adapter-yaml"
    }
  }
}
```

The plugin implements `read(document, context) -> Catalog` and `write(catalog, context) -> JSON-compatible document`. `context` provides locale, source/target role, and options from the optional JSON `catalog-config` path. The configured ID must match the plugin's exported `id`. Custom modules are installed by the consumer; workflow inputs never select package names or shell code.

See [the architecture guide](docs/architecture.md) for the normalized model and the separation between framework, catalog-format, and TMS-provider integrations.
