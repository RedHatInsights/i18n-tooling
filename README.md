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

| Package                                     | Role                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@redhat-cloud-services/eslint-plugin-i18n` | ESLint rules for message IDs, source catalogs, and ICU-oriented source checks.                                                                                                                   |
| `@redhat-cloud-services/i18n-pipeline`      | Node.js package with the normalized catalog model, FormatJS and keyed ICU JSON adapters, adapter plugin loading, adapter-owned text codecs, generated-catalog sync, and the `i18n-pipeline` CLI. |
| `.github/workflows/`                        | Repository CI and reusable consumer validation.                                                                                                                                                  |

The TypeScript packages target Node.js 22.14+. Corepack selects the npm version declared in `package.json` to manage workspace dependencies, while package code and the CLI run under Node.js. Framework extraction and compilation remain in each consumer's native tooling.

## Design rules

- ICU MessageFormat remains normative for every catalog adapter. Built-in adapters parse patterns with FormatJS's official `@formatjs/icu-messageformat-parser`.
- Initial built-ins target FormatJS descriptor/compiled JSON and keyed ICU JSON for service errors.
- Catalog-format adapters stay separate from TMS-provider adapters.
- Teams extend formats through installed Node packages and stable adapter IDs. Custom adapters may own text parsing/serialization and receive adapter-specific JSON options; GitHub `uses` references are not dynamic.
- Canonical locale catalogs remain repository-owned; TMS is a translation workspace, never a runtime dependency.
- Provider-specific Phrase/APC/webhook behavior belongs behind a future TMS-provider interface.
- English `detail` is fallback for backend errors; the English source catalog is fallback for UI messages.
- i18next, Lingui, and Django PO conversion are future adapters, not part of this POC slice.

## Terminology

- **Message ID** — Stable identifier used by application code to refer to the same translatable message across locales.
- **Locale catalog** — Repository-owned set of messages for one locale, keyed by message ID. Its serialized file format is adapter-defined; it is distinct from an ICU resource bundle.
- **Source catalog** — Canonical catalog for English source messages; also the fallback for missing or unavailable translations.
- **Target catalog** — Locale catalog containing translations of the source messages.
- **ICU MessageFormat pattern** — Syntax for message arguments, number/date formatting, and plural/select logic. It describes how messages are formatted, not how locale data is stored.
- **ICU resource bundle** — ICU's native locale-aware data container and lookup/fallback model. It is distinct from this repository's locale catalogs.
- **ICU message catalog** — ICU's separate POSIX-style `ucat` API. Avoid this label for our locale catalogs.
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

Use the exact Node.js development version in `.nvmrc` and the npm version selected by Corepack from `package.json`'s `packageManager` field. Published packages support Node.js 22.14+. npm is the canonical dependency installer; `package-lock.json` is authoritative and is also used by GitHub Dependency Review. Use `npm ci` for unchanged dependencies and `npm install` when updating dependencies:

```bash
nvm install
npm install --global corepack@0.34.0
corepack enable npm
corepack install
npm ci
npm run check
```

CI tests Node from `.nvmrc` and Node 24 in separate typecheck, test, and build jobs. It also checks coverage thresholds, source-built CLI behavior, schemas, reusable workflow behavior, packed installs, and GitHub Actions security.

The package CLI is compiled to Node-compatible ESM:

```bash
npm run build --workspace @redhat-cloud-services/i18n-pipeline
node packages/i18n-pipeline/dist/cli.js version
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and consumer workflow guidance.

## Shared validation workflow

The reusable `i18n-validate.yml` workflow checks out tooling source at the called workflow's commit, builds the CLI and ESLint plugin, and checks consumer source message IDs against the configured catalog. The source glob defaults to `src/**/*.{js,jsx,ts,tsx}` and can be overridden with `source-glob`; include files that declare reusable messages too. The ESLint check rejects missing catalog entries, missing or dynamic inline IDs, and opaque descriptor expressions. Declare reusable descriptors with `defineMessages` so their IDs are checked at the definition. The same step runs `eslint-plugin-formatjs` ICU rules: invalid ICU, plurals without `other`, a hard-coded `1` in a `one` branch, and plural offsets fail; inline tags, sentence fragments, `{count}` instead of `#`, multiple plurals, and selectors with more than 20 combinations are warnings. Set `validation-config` to run `i18n-pipeline validate-project` directly, including generated-catalog sync, without a consumer validation script. `validation-command` remains the backward-compatible fallback when no config is supplied. Non-JavaScript consumers can set `catalog-only: true` to skip consumer dependency installation and source lint; this mode requires `validation-config` and still checks catalog validity and generated-file sync. Consumers do not need an npm dependency on this repository, and npm installation will be available after the first release.

## Consumer examples

To onboard a new consumer, start with the [consumer onboarding checklist](docs/consumer-onboarding.md). It is written so a person or a coding agent can follow it step by step.

## Onboarding skill

The `i18n-onboarding` skill inspects a repository and drives `i18n-pipeline` to add catalog validation and optional Phrase, Konflux, and FEO localization. It works in Claude Code, Codex CLI, opencode, and Pi. Until the first npm release it needs `I18N_PIPELINE_CLI` to point at a locally built `packages/i18n-pipeline/dist/cli.js`:

```bash
git clone https://github.com/RedHatInsights/i18n-tooling.git ~/src/i18n-tooling
cd ~/src/i18n-tooling && npm ci --ignore-scripts && npm run build
export I18N_PIPELINE_CLI=~/src/i18n-tooling/packages/i18n-pipeline/dist/cli.js
```

Instead of exporting the variable, you can put the CLI on `PATH`, for example `ln -s ~/src/i18n-tooling/packages/i18n-pipeline/dist/cli.js ~/bin/i18n-pipeline`. To update it, run `git pull` and the build again. The pull request validation workflow and the i18n hub build the CLI from source themselves, so only local runs need this step.

Install it for all four harnesses with one command:

```bash
npx skills add RedHatInsights/i18n-tooling -g -s i18n-onboarding -a claude-code -a codex -a opencode -a pi -y
```

This writes one copy to `~/.agents/skills/i18n-onboarding/` (read by Codex CLI, opencode, and Pi) and links it into `~/.claude/skills/` for Claude Code. Drop `-g` to install into the current repository instead (`.agents/skills/` and `.claude/skills/`). Update with `npx skills update -g -y`.

Alternatives:

- **Claude Code plugin:** `/plugin marketplace add RedHatInsights/i18n-tooling`, then `/plugin install i18n-onboarding@i18n-tooling`. Update with `/plugin marketplace update i18n-tooling`.
- **Without third-party tools:** clone this repository and symlink `skills/i18n-onboarding` into `~/.agents/skills/` and `~/.claude/skills/`.

Then ask the agent to onboard the repository to i18n tooling. The skill inspects first, asks one set of questions (tracks, Jira tickets, branch layout, how far to go, Phrase mode), and then runs the selected tracks. For Phrase, the default is registering the repository in the central i18n hub (the `RedHatInsights/i18n-hub` repository, not public), which holds the Phrase credential and the key of the i18n GitHub App, [`hcc-i18n-tms-sync`](https://github.com/apps/hcc-i18n-tms-sync). A `RedHatInsights` organization owner installs that App on each hub consumer; the skill requests it in the hub registration PR. In that mode the repository gets no Phrase callers or secrets. The alternative is standalone: the repository runs its own callers, using its own GitHub App or, as a fallback, `GITHUB_TOKEN`.

`rbac-ui` can declare its FormatJS extraction/compile outputs and catalog checks without a custom validation script:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      package-manager: npm
      validation-config: .github/i18n/catalog-validation.json
      catalog-adapter: formatjs-json
      catalog-path: locales/translation-template.json
      catalog-role: source
      catalog-locale: en
```

Replace `<reviewed-commit-sha>` with a reviewed commit SHA. The reusable workflow checks out the consumer repository and `i18n-tooling` at the exact commit of the called workflow (`job.workflow_sha`). Its default Node.js runtime comes from the tooling `.nvmrc`; consumers can override it with `node-version`. It installs consumer dependencies with the selected package manager (npm by default; Bun and pnpm are also supported) and the tooling workspace with npm, builds the CLI and ESLint plugin, then lints the configured source glob against `catalog-path`. The rule recognizes FormatJS `formatMessage`, `defineMessage(s)`, and `<FormattedMessage>` forms; IDs must be static and present in the catalog. With `validation-config`, the workflow runs the shared `validate-project` command directly. Its config names source/target files and adapters and can run native generators into temporary output files to verify checked-in catalogs are current. See the [catalog validation example](examples/phrase-consumer/.github/i18n/catalog-validation.json) and [config schema](schemas/catalog-validation-config.schema.json). Without that input, the workflow runs `validation-command` through the selected consumer package manager's `run` command; simple consumers can also use `i18n-pipeline validate` or `i18n-pipeline check` directly with `I18N_CATALOG_*` settings. The reusable workflow does not require npm publication. Pinning the reusable workflow pins the CLI and rule source too.

A Python service can validate contract-generated catalogs without installing application dependencies or linting JavaScript:

```yaml
jobs:
  i18n-catalog:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      catalog-only: true
      validation-config: .github/i18n/catalog-validation.json
```

The config should generate the English ICU catalog from the checked-in OpenAPI contract, then validate it and any delivered target locales.

## FEO Frontend template localization

`i18n-pipeline feo extract --template deploy/frontend.yaml --output deploy/locales/translation-template.json` creates a FormatJS-style source JSON catalog from `Frontend` objects in an OpenShift Template. Stable keys mirror YAML fields, using item IDs rather than array indexes: `searchEntries.<id>.*`, `bundleSegments.<bundleId>.<segmentId>.navItems.<id>[.routes.<id>...].*`, `serviceTiles.<section>.<group>.<id>.*`, and `module.defaultDocumentTitle`.

Key components (`id`, `section`, `group`, `bundleId`, and `segmentId`) may contain dot-separated segments. Each segment must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`; empty segments and segments starting with `_` or `-` are rejected. Every key written to `spec.locales` is limited to 256 characters. For multiple Frontend objects, that limit excludes the catalog prefix `objects.<metadata.name>.spec.`.

Each search `alt_title` alias uses the key `searchEntries.<id>.alt_title.<slug>`. The slug lowercases the English alias, replaces each run of characters outside `[a-z0-9]` with `-`, then trims leading and trailing `-`; an empty slug fails extraction. Aliases with the same slug share one catalog key and translation. The first alias in document order supplies the default message, and its description lists the other aliases that share the key. A pipe has no special meaning and is allowed in an alias. Consumers rebuilding the alias list in English order use the shared translation for every alias with that slug; without a translation, each alias keeps its own English text. No separator joins the messages; use one message per item for any future translatable list too.

Missing IDs fail extraction; nav items or routes with `segmentRef` produce no keys. Items with colliding catalog or runtime keys are rejected even when the colliding fields are empty. English and non-text fields stay hand-edited. With multiple Frontend objects, catalog keys gain an `objects.<metadata.name>.spec.` prefix (names must be present and unique); inlining removes that prefix so each Frontend's `spec.locales` keeps the local keys above. Single-Frontend keys stay unprefixed. Keys are written in code-unit order, so the output does not depend on the machine's locale. Adding a second Frontend therefore changes existing catalog IDs; re-extract and migrate translations to the new IDs. To migrate legacy aliases, re-extract the source, remove unsuffixed `alt_title` keys from locale files, translate each distinct alias-slug key, then re-inline each locale.

`i18n-pipeline feo inline --template deploy/frontend.yaml --source deploy/locales/translation-template.json --target deploy/locales/zh-CN.json --locale zh-CN` writes only `objects[].spec.locales.zh-CN` into existing YAML, preserving other fields and comments. It rejects stale English source and unknown or empty translations. Add `--check` to either command for CI drift detection without writing. Missing translations are omitted for downstream English fallback. FEO locale ids must be canonical BCP 47 limited to language, script and region (`fr`, `ja`, `zh-CN`, `zh-Hant-TW`, `es-419`) other than `en`, the Frontend operator's rule; `zh-cn` is rejected with a `use "zh-CN"` hint, and so are deprecated aliases such as `iw` (`use "he"`), which the operator accepts but locale resolution never looks up. Inlining under a canonical id consolidates existing blocks spelled differently, such as `zh-cn`, into that canonical block. Configs reject more than 32 locales (the per-Frontend limit), and inlining refuses to add a 33rd block or write more than 2048 keys to a locale. English source catalogs may contain more messages because translations can be partial. A translation over 4096 characters (counted as Unicode code points) is omitted like a missing one, so only that message falls back to English, and `feo inline`, `validate-project` and Phrase locale PRs report it as a warning. These commands do not need Phrase, credentials, or GitHub workflows; the Frontend CRD, operator, publisher, and Chrome overlay are separate work.

Project validation can run these checks from a `feo` config section. List every target locale up front in `locales`, mapped to repository-relative locale files. A listed locale is checked as soon as its file or a `spec.locales` block in any Frontend object exists; if neither exists yet, validation skips the missing file with a warning. A template block without its locale file remains an error, as does a template locale block that is not listed. Validation compares the committed source catalog byte-for-byte with extraction output, then compares each delivered locale with inlining from its locale file. Source drift points to `feo extract`; locale drift points to `feo inline`. The validator reports template, JSON, and translation errors without writing consumer files.

## Frontend template handoff

Phrase locale PRs can include the Frontend template. The i18n-hub test-consumer pilot verified this handoff on 2026-10-16.

With `"frontendTemplate": { "path": "deploy/frontend.yaml", "generateSourceCatalog": true }` in the Phrase consumer config (each `repositoryLocale` must then be a canonical FEO locale id such as `zh-CN`; `phraseLocale` keeps Phrase's own code, such as `zh_cn`. A config written with `zh-cn` fails to load until it is renamed; batches already in flight keep their recorded branches and PRs, and their YAML is inlined under the canonical id), submission generates the source JSON from the pinned YAML, and reconciliation generates it from the pinned and current YAML. The source file need not be committed; `sourceCatalog.path` supplies its logical repository-relative location, while `sourceCatalog.filename` (for example `<repository-name>.feo.en.json`) names the upload in Phrase. The pinned catalog digest must match at each step; a change to English messages supersedes the batch. Reconciliation opens one draft PR per configured locale with that locale's JSON and validation findings. The corresponding `spec.locales.<repositoryLocale>` change is included only after the locale passes validation against the pinned source. The YAML update is limited to `objects[].spec.locales.<repositoryLocale>`; re-export starts from YAML at the locale branch head so unrelated branch metadata stays intact, while stale-English checks use the current base. This optional Phrase integration sits on top of the Phrase-independent `feo` CLI; it does not add automatic Phrase submission.

## Phrase TMS round trip

The reusable Phrase workflows submit one validated source catalog and reconcile completed target jobs into draft locale-specific pull requests:

- `.github/workflows/phrase-submit.yml` exposes `workflow_call` for source submission on merge or by hand.
- `.github/workflows/phrase-reconcile.yml` exposes `workflow_call` for scheduled or manual reconciliation.
- `i18n-pipeline tms submit --config <path>` validates and submits the pinned source revision. The PR base defaults to the pushed or dispatched branch; direct CLI runs for pull-request and tag events must pass `--base-ref`. The reusable-workflow `base-ref` input is used only when `repository` targets another repository.
- `i18n-pipeline tms reconcile --config <path>` reads durable batch state, waits for each locale's final Phrase workflow step to reach `COMPLETED`, downloads and validates the target catalog, and opens one draft PR per locale, even when translation validation fails. The PR description has a concise findings status line; a 🌐 Translation check comment contains the error and warning tables. The first export posts a report, and a later export posts another when the findings, batch, or final job change. Invalid catalogs remain reviewable; if parsing fails, the downloaded bytes are preserved, and generated Frontend YAML is not updated until validation succeeds. The PR description and report warn that any retained YAML locale block may reflect an earlier valid export and must not be merged alongside the invalid catalog. Later runs re-export each still-open PR from that same final Phrase job and update its existing branch. Fix a translation in Phrase and the same PR follows on the next run. Phrase jobs remain `COMPLETED`; reconciliation does not post Phrase comments or change job status. New locale PRs are always drafts, and tooling never marks them ready automatically. An invalid re-export converts an existing ready PR back to draft before writing its content; adoption after interrupted creation follows the same rule, including a raced PR creation. Valid adoption leaves a ready PR ready. Before updating invalid content on an existing branch without a recorded PR, tooling establishes or adopts its draft PR first. A draft-conversion failure is a delivery failure and prevents the branch update. Require consumer validation checks in branch protection: a draft is a review signal, not a substitute for required checks.

### Where is my translation?

Submit runs when a merge changes the caller's configured source paths, or when the submit workflow is dispatched. Reconcile runs on the caller's schedule. The [example caller](examples/phrase-consumer/.github/workflows/phrase-reconcile.yml) uses `23 6,14 * * 1-5`, which is 06:23 and 14:23 UTC on weekdays. Repositories managed by a central hub follow that hub's schedule; see the runbook in the `RedHatInsights/i18n-hub` README (an internal repository) for its process. Translations finished in Phrase appear on the next reconcile run. Maintainers can start one sooner with `workflow_dispatch`.

Start with the Actions run summary. Submit shows whether it created a batch or reused one for unchanged source, plus the short source commit, job count, locales, and Phrase project link. Reconcile shows each batch's source and submission time, then one row per locale with its final Phrase job, pull request, recorded assignees, and validation finding counts. Open the Phrase job or locale PR from its link. Detailed errors and warnings are in the PR's 🌐 Translation check comment; the summary table only shows their counts. A warning alert means a locale PR has translation errors: fix the translation in Phrase, keep its jobs **Completed**, and the next sync updates the same PR. Tooling-created locale PRs are drafts; review them before merging. As a last resort, inspect the batch record on the state branch at `<state.branch>:<state.directory>/<key>.json`.

| Outcome               | Meaning and next step                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`             | Phrase is still translating. Reconcile checks again on its next run; the final workflow step must be `COMPLETED`.                                                                                                    |
| `retrying`            | A temporary issue will be retried on the next run. `Phrase has not yet exposed the new jobs; the next run continues this batch` means wait for the next run.                                                         |
| `failed`              | A pipeline step failed. Inspect the job log and fix the Phrase job or configuration before retrying. If the message says `No Phrase job was created for this batch; voided after 15 minutes`, dispatch submit again. |
| `invalid-translation` | A locale PR was delivered with translation errors. Fix the translation in Phrase, keep the final jobs `COMPLETED`, and reconcile updates the same PR. The PR comment contains the findings.                          |
| `pr-created`          | Review the draft locale PR. Its validation findings are shown in the summary and in the 🌐 Translation check comment.                                                                                                |
| `superseded`          | Newer source was submitted. Follow the newer batch; the old Phrase jobs are not cancelled automatically.                                                                                                             |

Ambiguous recovery reports `Phrase returned candidate jobs with missing or invalid recovery metadata.`, `Phrase jobs exist for this batch, but no creation-time group matches its pending locales.`, or `More than one Phrase creation-time group matches this batch.` It then lists `Candidate jobs grouped by creation time: <candidates>.` and says `Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.` Check those candidates before rerunning.

Locale PR titles follow `i18n(<repositoryLocale>): Phrase translation update for <source path>`. The source path is `sourceCatalog.path`, except generated-source Frontend configs use `frontendTemplate.path`.

Central hubs that use one shared Phrase credential across consumer repositories can set the optional
`expected-phrase-project` and `expected-source-filename` workflow inputs to pin each config to its
reviewed project UID and effective source filename; reconciliation also rejects mismatched batch
records and Phrase job filenames before downloading translations or creating PRs. The filename pin
separates consumers only if every pinned source filename is unique within the Phrase project and is
never reused by any job, including jobs created outside the hub; use repository-qualified names such
as `<repository-name>.feo.en.json` for generated FEO catalogs and `<repository-name>.ui.en.json` for
app catalogs. The hub's consumer list rejects duplicate filenames between hub
consumers, but cannot detect filename reuse by jobs created outside the hub.

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

- **User token (required for submit):** `PHRASE_PLATFORM_API_TOKEN`, a Platform API token from Settings → Profile → Access tokens, exchanged for a short-lived access token. It carries that user's full permissions, expires after two years, and stops working if the user is deactivated. A person's token may serve real consumers until a dedicated technical user exists; then replace it with a technical-user token scoped to the business unit that owns the Phrase project (projects, templates, translation memories and term bases), with the Project Manager role and without user-management or global-settings rights.
- **Service Account:** `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`, used with the OAuth client-credentials grant. A Phrase organization admin creates the account under Organization Settings → Service Accounts; the secret is shown once. Its bot user [cannot create jobs or projects](https://support.phrase.com/hc/en-us/articles/29488404284316-Service-Accounts), so `tms submit` cannot use it. `tms reconcile` only reads jobs and downloads targets; whether a service account may do that is not verified.

Do-not-translate terms are planned for Phrase term bases; see [RHCLOUD-51839](https://issues.redhat.com/browse/RHCLOUD-51839).

Selection rules (unset reusable-workflow secrets arrive empty and count as not set):

| Secrets set                                 | Result                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Both service-account secrets, no user token | Service account                                                  |
| User token only                             | User token                                                       |
| Both kinds                                  | Fails before any request; the error says which secrets to remove |
| Only one service-account secret             | Fails before any request                                         |
| None                                        | Fails before any request                                         |

Each `tms` run logs the chosen kind, for example `Phrase auth: service account (PHRASE_SERVICE_ACCOUNT_CLIENT_ID/_SECRET)`, never the value. If Phrase rejects the credentials, the error names the kind that was tried, for example `Phrase Platform OAuth returned HTTP 401 for the service account credentials`. To switch credential kinds, add the new secrets and delete the old ones in the same change.

Put the Phrase credentials in a protected Actions environment and pass it as the reusable-workflow `environment` input. An unmapped workflow-call secret name arrives empty, so every caller must map each name it uses in its `secrets:` block, even when the value lives in that environment. The called job's environment secret takes precedence over the mapped caller value. For example:

```yaml
secrets:
  PHRASE_PLATFORM_API_TOKEN: ${{ secrets.PHRASE_PLATFORM_API_TOKEN }}
```

Use repository or organization secrets only when mapped to the same workflow-call names; never use `secrets: inherit`. The CLI rejects credential-like keys (for example `apiToken`, `api_key`, `clientSecret`) anywhere in the config so tokens cannot enter batch-state files; the JSON schema does not enforce this.

The reusable workflows default to the calling repository and `GITHUB_TOKEN`. For App mode, add both `APP_CLIENT_ID` and `APP_PRIVATE_KEY` as secrets in the protected environment named by `environment`, alongside the Phrase credential, and map both names in the caller. GitHub secret names cannot start with `GITHUB_`. Leave both App secrets unset for `GITHUB_TOKEN` mode or set both for App mode; exactly one set fails the run. Consumer-owned callers use their own GitHub App; hub callers use the hub App installed on each target consumer. `GITHUB_TOKEN` mode can write only to the calling repository. In App mode, the token is scoped to the target repository and gets `contents: write` for submit, plus `pull-requests: write` for reconcile. The actual App credentials go only to `actions/create-github-app-token`; the target selector receives only booleans indicating whether they are set.

For another target repository, pass `repository: owner/name`. The `base-ref` input is used only when `repository` targets another repository. Same-repository runs check out the triggering commit. Cross-repository submit requires `base-ref` and uses the checked-out commit as `source-commit`; cross-repository reconcile checks out `base-ref` when supplied, otherwise the target repository's default branch. Both workflows print `GitHub auth: app <app-slug>[bot]` or `GitHub auth: GITHUB_TOKEN (github-actions[bot])` before the CLI runs, without logging credentials.

The target repository must support draft pull requests. A rejected draft creation reports an actionable error (check draft support and whether the locale branch has a diff); tooling does not silently fall back to a ready PR, because that would remove its merge safeguard.

In `GITHUB_TOKEN` mode, enable the repository setting **Allow GitHub Actions to create and approve pull requests**. Because this setting also lets workflows approve pull requests, require Code Owner review in branch protection. The GitHub PR and state operations need `contents: write` and, for reconciliation, `pull-requests: write`.

For consumer-owned callers, the consumer owns the triggers and pins the reusable workflows to a reviewed commit. Start from the [example callers](examples/phrase-consumer/.github/workflows/): submit runs when a merge changes the source input or the Phrase config, reconcile runs on a schedule, and both can be dispatched by hand.

For consumer-owned callers, put the selected Phrase credentials in the consumer's `phrase-pilot` Actions environment; the called job binds to that environment. The consumer's reconciliation caller should use the same `environment` and grant `contents: write` plus `pull-requests: write`; a schedule belongs in that consumer repository and runs from its default branch only.

Batch state is stored on the configured state branch under `.github/i18n-state/batches/` (the GitHub contents API lists at most 1,000 records per directory). A batch is keyed by repository, PR base, exact source bytes, and the Phrase-facing settings (project, region, filename, import settings, target languages). The source commit is not part of the key, so re-dispatching or pushing unrelated commits never creates a second Phrase job for unchanged source. Active batches adopt repository-side mapping changes (output paths, adapters, completion policy); completed batches return their stored configuration unchanged. After Phrase returns created job parts, submit saves every workflow level, the job UIDs, async request ID, and `importing` phase before pinned verification. If Phrase returns 404 for a new job, pin verification retries up to five times over about 60 seconds. If it is still missing, the batch stays `importing` and the run exits non-zero so the next submit or reconcile can continue it. A stored-job 404 is reported as `retrying` while the batch is younger than 15 minutes, whatever its phase; an older pinned 404 remains a pin mismatch. The workflow supersedes stale source batches and never auto-merges translation PRs. Reconciliation currently exports from one final job part per catalog and locale. `COMPLETED` on the final workflow step is the success signal; `DELIVERED` is not treated as completion.

If a `creating` or `unknown` batch has no saved jobs, submit searches its Phrase project, and reconcile searches only records whose stored project and source filename match the loaded config. Reconcile still processes other configs' batches as usual. Recovery lists every workflow level and groups candidates by creation time; each level's locale set must exactly match the pending locales before all parts in the group are bound. The next run then resumes import polling without the original async request ID. With zero unclaimed candidate jobs, a batch younger than 15 minutes is reported as `retrying`, since a job may still be appearing in Phrase. After 15 minutes with no candidate jobs, reconcile marks the batch failed and submit marks it failed before creating the next attempt automatically. It is voided only when Phrase has no candidate jobs, and this recovery does not need `--retry-failed`. If candidates exist but do not form exactly one complete match, the batch stays unchanged and the error lists every candidate's UID, locale, and creation time. Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.

Batch phases: `creating` → `importing` → `ready` → `completed`, or `failed`/`superseded`. `failed` and `superseded` batches are not reconciled again, except that a submit run may automatically move past an empty stuck batch after it has been voided. A batch stays `ready` while any locale PR is open; each reconcile checks its state and exports once from Phrase for every open locale PR. If the generated files match the branch, no commit is made. If they differ, one commit updates that same branch and the PR description's status line is refreshed. Changed findings also refresh the status line when catalog bytes are unchanged, and a changed report digest adds a new comment. Merged or closed PRs stop re-exporting, and the batch becomes `completed` after every locale is final and every PR is merged or closed. Closing without merging does not fail the locale. A closed PR is checked for reopening while its batch remains active; reopening resumes re-export only while the locale branch head remains tooling-owned. Once a reconcile observes every PR in the batch merged or closed, the batch completes, and reopening afterward does not resume automation. Each open locale PR costs one Phrase export per reconcile run. Reconciliation also resumes `importing` batches whose submit run timed out and repairs eligible empty `creating` or `unknown` batches. Each validation failure is reported once per export attempt; `tms reconcile` exits non-zero for locale failures or transient `retrying` errors, and an error in one batch never blocks the others. An `all-locales` target waits for all locales' final jobs to complete and remains pending while another locale has recorded validation errors, including errors on an existing draft PR. Per-locale targets can still deliver invalid drafts independently.

Closing a conflicted PR ends tooling delivery for that locale in the batch and leaves reviewer commits on the branch. Submitting unchanged source does not open a replacement PR. Reopening while the batch is active resumes re-export only if the branch head is tooling-owned; after the batch completes, reopening does not resume automation.

A `failed` batch blocks resubmission of the same source. After fixing a Phrase job/import failure, run `tms submit --retry-failed` (reusable-workflow input `retry-failed: true`) to create a new attempt. The exception is an empty stuck `creating` or `unknown` batch: after 15 minutes with no candidate jobs, submit voids it and starts the next attempt automatically. It is voided only when Phrase has no candidate jobs. This does not change `--retry-failed` behavior for other failures. For a `ready` or `completed` batch with failed locales, retry submission includes only those locales and carries successful locale PRs forward; a fully successful batch remains idempotent. Catalog-validation failures are normally retried in-place: after fixing the segment in the existing Phrase job, scheduled or manual reconciliation re-exports and validates it without creating a new job. A locale with an open draft PR is delivered for retry-submission purposes even when it has validation findings; fix that existing Phrase job rather than creating a replacement with `--retry-failed`. After reconciliation records that an invalid PR was closed without merging, `--retry-failed` can create a fresh job and PR for that locale while preserving the closed PR for audit. Merged PRs are never retried this way. Resubmitting source that was `superseded` and has become current again revives the existing batch instead of creating a new job. Superseded batches are never cancelled in Phrase automatically, since that would discard translator work; cancel stale jobs in Phrase if they should not continue.

The shared workflows serialize overlapping reconcile runs per target repository and config path, and overlapping submit runs per target repository, config path, and base ref; different configs can run in parallel. Submit and reconcile keep separate groups so a queued reconcile can never cancel a pending submission. A reconcile can supersede a batch while another reconcile is updating one of its locale PRs: the updating run re-checks eligibility immediately before moving the branch, so the remaining window is one request, and at worst a superseded batch's PR receives an export and validation findings checked against that batch's own source. Running `tms` commands for the same config outside these workflows concurrently is unsupported. Locale PRs are never merged automatically. Both jobs time out after 30 minutes; each Phrase request times out after 60 seconds and each GitHub request after 30 seconds.

**Recovery for an ambiguous submission:** Do not edit batch state. The next submit or reconcile checks recent candidates grouped by creation time and queries only the stored project and filename in the loaded config. A complete group whose locale set matches at every workflow level is bound with all its job parts and resumes import polling. With no unclaimed candidate jobs, the batch stays `retrying` for 15 minutes; after that reconcile marks it failed or submit starts the next attempt. Phrase jobs are voided only when there are no candidate jobs. If candidate groups are partial, include extra locales, disagree between workflow levels, or have more than one exact match, the batch stays unchanged and the error lists every candidate's UID, locale, and creation time. Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.

**GitHub Actions caveat:** PRs opened in `GITHUB_TOKEN` mode can trigger `pull_request` workflows for `opened`, `synchronize`, or `reopened`, but GitHub holds those runs for maintainer approval. Do not assume generated PRs will have automatically running/passing consumer checks; see [GitHub's token-trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). The workflows use no PAT and do not auto-merge PRs.

**Konflux caveat:** Konflux checks run through Pipelines-as-Code, which normally needs an `/ok-to-test` comment for a pull request whose author is not a collaborator or organization member. Locale branches live in the consumer repository rather than a fork, and Pipelines-as-Code authorizes such same-repository pull requests regardless of the author, so locale PRs from `github-actions[bot]` are expected to start Konflux checks on their own. Konflux on locale PRs remains untested and requires a separate acceptance check. If a locale PR shows no Konflux check, or one stays `Pending`, a repository collaborator or a user listed in the default branch's `OWNERS` file starts it by commenting `/ok-to-test`; see [Pipelines-as-Code ACL permissions](https://pipelinesascode.com/docs/guides/running-pipelines/).

The reusable workflows are generic; they do not add `rbac-ui` configuration or schedule wiring. Live Phrase job creation and secret setup remain explicit acceptance steps.

### Phrase TM/TB inventory (read-only)

To pick resources for a matching pilot, run from this repository's worktree with a Platform API token from a secret manager:

```sh
PHRASE_PLATFORM_API_TOKEN="$(op read 'op://<vault>/<item>/credential')" \
  node scripts/phrase-resource-inventory.mjs --region eu --output inventory/phrase-resources.csv
```

The ignored, private (`0600`) CSV lists token-visible translation memories and term bases, sorted by type and descending entry count. Columns include name, UID, TM source/target languages or TB languages, segment/term count, per-language counts, client, domain, subdomain, business unit, and creation date. The script pages through all visible resources, reads only listing/metadata GET endpoints at least 500 ms apart, retries throttled requests, and fails rather than writing an incomplete inventory. No TMX/TBX or segment/term text is exported. It does not list glossaries or establish rights to reuse a resource. Use a new output path for each run; existing files are not overwritten. `--region us` selects the US API hosts.

A service can validate its service-owned keyed ICU JSON catalog the same way:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      package-manager: npm
      validation-config: .github/i18n/catalog-validation.json
      catalog-adapter: icu-json
      catalog-path: i18n/en.json
      catalog-role: source
      catalog-locale: en
```

Run the CLI directly with explicit options or use workflow environment settings. `check` compares source and target message IDs and named ICU arguments, including arguments nested inside plural/select branches:

```bash
i18n-pipeline validate \
  --adapter icu-json \
  --catalog i18n/en.json \
  --role source \
  --locale en

i18n-pipeline check \
  --source locales/translation-template.json \
  --target locales/fr.json \
  --target-locale fr

i18n-pipeline convert \
  --source locales/translation-template.json \
  --source-adapter formatjs-json \
  --target-adapter icu-json \
  --output i18n/en.json \
  --locale en

# Run a multi-catalog plan with generated-file sync checks
i18n-pipeline validate-project --config .github/i18n/catalog-validation.json
```

`validate-project` accepts multiple source/target pairs, with an adapter and locale for every file; the formats may differ. `tmsConfig` derives the locale checks from the Phrase config, and delivered targets are checked while missing ones, and empty `{}` placeholders, count as pending. `generated` entries run a native generator into a temporary `{output}` file, without a shell, and fail when the checked-in file is stale. An entry without an adapter compares plain JSON, which covers runtime aggregates. `feo` entries compare the source catalog byte-for-byte with `feo extract` output and each delivered locale's inlined template with `feo inline` output. List every FEO target locale in `locales` up front. A listed locale with neither a file nor a `spec.locales` block in any Frontend object is reported as undelivered and skipped with a warning; once either exists, validation checks it, and a block without its file remains an error. Source drift reports the exact `i18n-pipeline feo extract --template <template> --output <source>` command; locale drift reports `i18n-pipeline feo inline --template <template> --source <source> --target <locale-file> --locale <tag>`. Invalid templates or JSON, stale English source, unknown keys, empty translations, and other read errors are reported as validation findings with the underlying error. When English changed in the template but the source catalog was not re-extracted, source drift is reported once and every locale file that still translates a changed key is reported with those keys; independent locale errors remain findings. A locale that has a `spec.locales` block in the template but is missing from the entry's `locales` is a finding too. `catalogDirectories` rejects catalog files that the plan does not declare; FEO source and locale files count as declared. These checks do not detect stale translations after English is re-extracted or hand edits against Phrase delivery state. The optional `sourceLint` section enables source checks in `i18n-pipeline validate-ci`; `validate-project` ignores it. `validate-ci` discovers the consumer config, applies its mode and deadline, and can write structured Tekton results. The validator never rewrites checked-in files. See the [package guide](packages/i18n-pipeline/README.md#generic-project-validation), the [CI validation command](packages/i18n-pipeline/README.md#ci-validation-command), the [schema](schemas/catalog-validation-config.schema.json), the [FEO consumer example](examples/feo-consumer/i18n/catalog-validation.json), and the [Phrase consumer example](examples/phrase-consumer/.github/i18n/catalog-validation.json).

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

The plugin implements `read(document, context) -> Catalog` and `write(catalog, context) -> document`. Optional `parseDocument(content, context) -> document` and `serializeDocument(document, context) -> string` methods own non-JSON file formats; when omitted, the CLI uses JSON parsing and formatted JSON output. `context` provides locale, source/target role, and options from the optional JSON `catalog-config` path. The configured ID must match the plugin's exported `id`. Custom modules are installed by the consumer; workflow inputs never select package names or shell code. The [package guide](packages/i18n-pipeline/README.md#custom-adapters) covers how bare package specifiers resolve and why the `tms` commands load only built-in adapters.

See [the architecture guide](docs/architecture.md) for the normalized model and the separation between framework, catalog-format, and TMS-provider integrations.

## npm release preparation

See [the release procedure](docs/releasing.md) for trusted publishing setup and maintainer steps. Package READMEs include npm consumer instructions for use after the first release.
