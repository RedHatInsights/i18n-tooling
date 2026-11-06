# Phrase TMS setup

The reusable Phrase workflows submit one validated source catalog to Phrase and reconcile completed target jobs into draft pull requests, one per locale. This guide covers configuration, credentials and GitHub access. For day-to-day operation and troubleshooting, see [Phrase operations](phrase-operations.md). For copyable files, see the [Phrase consumer integration example](phrase-consumer-integration.md).

Most HCC repositories should register in the central i18n hub (`RedHatInsights/i18n-hub`, not public), which owns the Phrase credential, the GitHub App and the schedule; see [hub-owned Phrase automation](consumer-onboarding.md#hub-owned-phrase-automation). The rest of this guide applies to both modes, and the [credentials](#phrase-credentials) and [GitHub authentication](#github-authentication) sections matter mainly to consumer-owned (standalone) callers.

## Workflows and commands

| Piece | Purpose |
| --- | --- |
| `.github/workflows/phrase-submit.yml` | `workflow_call` for source submission, on merge or by hand |
| `.github/workflows/phrase-reconcile.yml` | `workflow_call` for scheduled or manual reconciliation |
| `i18n-pipeline tms submit --config <path>` | Validates and submits the pinned source revision. The PR base defaults to the pushed or dispatched branch; direct CLI runs for pull-request and tag events must pass `--base-ref`. |
| `i18n-pipeline tms reconcile --config <path>` | Waits for each locale's final Phrase workflow step to reach `COMPLETED`, downloads and validates the target, and opens or updates one draft PR per locale |
| `i18n-pipeline tms config --config <path>` | Prints the expanded config as JSON, without credentials or network access |

The workflows are generic: they add no consumer configuration or schedules, use no PAT, and never merge PRs. The consumer, or the hub, owns the triggers and pins the reusable workflows to a reviewed commit. Start from the [example callers](../examples/phrase-consumer/.github/workflows/): submit runs when a merge changes the source input or the Phrase config, reconcile runs on a schedule, and both can be dispatched by hand. A schedule runs from the default branch only.

## Consumer config

The config follows the [Phrase TMS config schema](../schemas/phrase-tms-config.schema.json):

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
    { "phraseLocale": "fr", "repositoryLocale": "fr", "outputPath": "locales/fr.json" }
  ],
  "completionPolicy": { "default": "per-locale" }
}
```

- `project.region` (`eu` or `us`) selects the Platform OAuth and TMS API hosts.
- Set `sourceCatalog.importSettingsUid` or `useProjectFileImportSettings` when the Phrase project requires a particular import format.
- `sourceCatalog.filename` (the name uploaded to Phrase) defaults to the source path's basename.
- The CLI rejects credential-like keys such as `apiToken`, `api_key` or `clientSecret` anywhere in the config, so tokens cannot reach batch-state files. The JSON schema does not enforce this.
- For Frontend templates, add `frontendTemplate`; see [FEO Phrase handoff](feo-localization.md#phrase-handoff).

### `hcc-ui` preset

Consumers of the shared HCC UI Phrase project can use the preset instead of repeating its project, FormatJS, import-settings and locale-mapping values:

```json
{
  "preset": "hcc-ui",
  "sourceCatalog": {
    "path": "locales/translation-template.json",
    "filename": "<repository-name>.ui.en.json"
  },
  "targetOutputPath": "locales/{locale}.json"
}
```

- The preset maps Phrase `fr`, `ja`, `ko` and `zh_cn` to repository `fr`, `ja`, `ko` and `zh-CN`.
- `locales` selects a non-empty subset by repository locale, in the listed order. Use a full `targetLocales` array only for a different mapping.
- Objects merge recursively with the repository config; arrays and scalar values replace preset values.
- `targetOutputPath` fills missing `outputPath` values, replacing `{locale}` with the repository locale. An explicit `outputPath` wins.
- Changing the preset changes the batch identity of every consumer that uses it, so each consumer's next run resubmits its source.

### Shared Phrase projects

Hubs that use one Phrase credential across several consumers can set the `expected-phrase-project` and `expected-source-filename` workflow inputs. These pin each config to its reviewed project UID and source filename. Reconciliation also rejects mismatched batch records and Phrase job filenames before downloading translations or creating PRs.

The filename pin separates consumers only if every pinned filename is unique within the Phrase project and never reused by any job, including jobs created outside the hub. Use repository-qualified names such as `<repository-name>.ui.en.json` and `<repository-name>.feo.en.json`. The hub's consumer list rejects duplicate filenames between hub consumers, but cannot detect reuse by outside jobs.

## Phrase credentials

The CLI chooses credentials by **which secret names are set**. It never inspects a value, so a value stored under the wrong name is sent with the wrong login flow and Phrase rejects it.

- **User token (required for submit):** `PHRASE_PLATFORM_API_TOKEN`, a Platform API token from Settings → Profile → Access tokens, exchanged for a short-lived access token. It carries the user's full permissions, expires after two years, and stops working if the user is deactivated. A person's token may serve until a dedicated technical user exists. Then replace it with a technical-user token scoped to the business unit that owns the Phrase project (projects, templates, translation memories and term bases), with the Project Manager role and no user-management or global-settings rights.
- **Service account:** `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`, used with the OAuth client-credentials grant. A Phrase organization admin creates it under Organization Settings → Service Accounts; the secret is shown once. Its bot user [cannot create jobs or projects](https://support.phrase.com/hc/en-us/articles/29488404284316-Service-Accounts), so `tms submit` cannot use it. Whether it can run `tms reconcile`, which only reads jobs and downloads targets, is not verified.

| Secrets set (unset workflow secrets arrive empty) | Result |
| --- | --- |
| Both service-account secrets, no user token | Service account |
| User token only | User token |
| Both kinds | Fails before any request; the error says which secrets to remove |
| Only one service-account secret | Fails before any request |
| None | Fails before any request |

Each run logs the chosen kind, never the value, for example `Phrase auth: service account (PHRASE_SERVICE_ACCOUNT_CLIENT_ID/_SECRET)`. A rejection names the kind tried, for example `Phrase Platform OAuth returned HTTP 401 for the service account credentials`. To switch kinds, add the new secrets and delete the old ones in the same change.

Do-not-translate terms are planned for Phrase term bases; see [RHCLOUD-51839](https://issues.redhat.com/browse/RHCLOUD-51839).

### Secrets and environments

Put the Phrase credentials in a protected Actions environment (the examples use `phrase-pilot`) and pass its name as the `environment` input. Restrict its deployment refs to the default branch and add no required reviewers, or scheduled runs wait for approval. An unmapped workflow-call secret arrives empty, so every caller must map each name it uses, even when the value lives in that environment; the environment's secret takes precedence over the mapped caller value:

```yaml
secrets:
  PHRASE_PLATFORM_API_TOKEN: ${{ secrets.PHRASE_PLATFORM_API_TOKEN }}
```

Map service-account and `APP_*` names the same way. Repository or organization secrets work only when mapped to the same names. Never use `secrets: inherit`.

## GitHub authentication

| Mode | Secrets | Writes to |
| --- | --- | --- |
| `GITHUB_TOKEN` (default) | Neither `APP_*` secret | The calling repository only |
| GitHub App | Both `APP_CLIENT_ID` and `APP_PRIVATE_KEY`, in the same protected environment, both mapped | The target repository, with `contents: write` for submit and `pull-requests: write` for reconcile |

Setting exactly one `APP_*` secret fails the run. GitHub secret names cannot start with `GITHUB_`. Consumer-owned callers use their own App; hub callers use the hub App, [`hcc-i18n-tms-sync`](https://github.com/apps/hcc-i18n-tms-sync), installed on each target consumer. App credentials go only to `actions/create-github-app-token`; the target selector sees only whether they are set. Both workflows log `GitHub auth: app <app-slug>[bot]` or `GitHub auth: GITHUB_TOKEN (github-actions[bot])` before the CLI runs.

In both modes, grant the caller jobs `contents: write`, plus `pull-requests: write` for reconcile. In `GITHUB_TOKEN` mode, also enable **Allow GitHub Actions to create and approve pull requests**. Because that setting also lets workflows approve PRs, require Code Owner review in branch protection.

### Repository requirements

- **Draft pull requests** must be supported. A rejected draft creation reports an actionable error (check draft support and whether the locale branch has a diff). Tooling never falls back to a ready PR, since that would remove its merge safeguard.
- **State branch:** automation must be able to create the configured `state.branch` and write batch records to it directly. Do not relax protection on the PR base branch. See [Check Phrase branch permissions](consumer-onboarding.md#check-phrase-branch-permissions-both-modes).
- **Required checks:** require consumer validation in branch protection. A draft PR is a review signal, not a substitute for required checks.

### Target repository

Pass `repository: owner/name` to target another repository, as the hub does. Same-repository runs check out the triggering commit, and `base-ref` is used only for cross-repository runs. Cross-repository submit requires `base-ref` and uses the checked-out commit as `source-commit`. Cross-repository reconcile checks out `base-ref` when supplied, otherwise the target's default branch.

## Locale PR checks

- **GitHub Actions:** PRs opened in `GITHUB_TOKEN` mode trigger `pull_request` workflows for `opened`, `synchronize` and `reopened`, but GitHub holds those runs for maintainer approval. Do not assume generated PRs have running or passing checks; see [GitHub's token-trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
- **Konflux:** Pipelines-as-Code normally needs `/ok-to-test` for PRs from non-collaborators, but authorizes same-repository PRs regardless of author, so locale PRs from `github-actions[bot]` should start Konflux checks on their own. This is untested and needs a separate acceptance check. If a locale PR shows no Konflux check, or one stays `Pending`, a collaborator or a user in the default branch's `OWNERS` file comments `/ok-to-test`; see [Pipelines-as-Code ACL permissions](https://pipelinesascode.com/docs/guides/running-pipelines/).

Live Phrase job creation and secret setup remain explicit acceptance steps for each consumer.

## Phrase TM/TB inventory

To choose translation memories and term bases for a pilot, run this read-only script from a checkout of this repository with a Platform API token from a secret manager:

```sh
PHRASE_PLATFORM_API_TOKEN="$(op read 'op://<vault>/<item>/credential')" \
  node scripts/phrase-resource-inventory.mjs --region eu --output inventory/phrase-resources.csv
```

- Writes an ignored, private (`0600`) CSV of token-visible TMs and TBs, sorted by type and descending entry count. Columns include name, UID, languages, segment/term counts (total and per language), client, domain, subdomain, business unit and creation date.
- Pages through every visible resource using only listing/metadata `GET` endpoints, at least 500 ms apart, retries throttled requests, and fails rather than write an incomplete file.
- Exports no TMX/TBX or segment/term text, does not list glossaries, and does not establish rights to reuse a resource.
- Never overwrites an existing file; use a new `--output` path each run. `--region us` selects the US hosts.
