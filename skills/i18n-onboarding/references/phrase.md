# Phrase submit and reconcile

Use this reference when the developer selects Phrase, or when the repository already has Phrase callers or an i18n-hub registration.

## Choose the mode

Each repository is synced in exactly one mode:

- **Hub (default).** The central i18n hub (the `RedHatInsights/i18n-hub` repository, not public) runs submit and reconcile on a schedule, using its own Phrase credential and the shared i18n GitHub App. The consumer holds no Phrase or GitHub App secrets and no submit or reconcile callers. Offer it for repositories under `RedHatInsights`, because the hub registry accepts only `RedHatInsights/<name>`. Read [phrase-hub.md](phrase-hub.md).
- **Standalone.** The consumer runs its own submit and reconcile callers from its own protected environment. For GitHub writes, it uses the repository's own GitHub App, or `GITHUB_TOKEN` as the fallback. Offer it for repositories outside `RedHatInsights` or when the developer chooses it. Read [phrase-standalone.md](phrase-standalone.md).

Detect the current mode during inspection:

- **Standalone callers** are consumer workflows whose `uses:` names `RedHatInsights/i18n-tooling/.github/workflows/phrase-submit.yml` or `phrase-reconcile.yml`.
- **Hub registration** is an entry in i18n-hub's `consumers.json` whose `repository` equals this repository. The hub is not public; organization members read it with `gh api repos/RedHatInsights/i18n-hub/contents/consumers.json -H "Accept: application/vnd.github.raw+json"`. If that request fails, report the registration as unverified.

When a repository has both, report it as a conflict for the developer to resolve. Otherwise, show the detected mode as done. For a standalone repository under `RedHatInsights`, offer **Migrate to i18n-hub** as an upgrade (see [phrase-hub.md](phrase-hub.md#migrate-from-standalone)).

## Shared project

Both modes use the shared Phrase project named `hcc-ui`, UID `LFsYhKphLpXQ0WWa47VZ19`, in region `eu`. It is created from the `[HCC UI]` project template; the template is not itself a project. The `hcc-ui` preset supplies its FormatJS settings, project file-import settings, and locale mapping: Phrase `fr`, `ja`, `ko`, and `zh_cn` map to repository `fr`, `ja`, `ko`, and `zh-CN`.

## Config (both modes)

Write `i18n/phrase-tms.json` (or keep the repository's existing location). Keep the extracted FormatJS source catalog in the repository change, normally at `locales/translation-template.json`. Phrase submission reads that file from the commit it syncs; it does not extract messages. Keep `description` as translator context and confirm the Phrase project parses ICU. A minimal shared-project config has this shape:

```json
{
  "preset": "hcc-ui",
  "sourceCatalog": {
    "path": "locales/translation-template.json",
    "filename": "<repository-name>.ui.en.json"
  },
  "targetOutputPath": "src/locales/{locale}.json"
}
```

Set `sourceCatalog.filename` to `<repository-name>.<catalog>.en.json`, where `<catalog>` is `ui` for application messages and `feo` for FEO's catalog (for example `insights-rbac-ui.ui.en.json`). This is the shared HCC Phrase project's convention: the name the file gets in Phrase shows which app and catalog it belongs to. Without it, the pipeline uploads the source path's basename, which for most apps is the generic `translation-template.json`. The repository file keeps its path.

For an FEO config, use `deploy/locales/translation-template.json` and `<repository-name>.feo.en.json`, set `targetOutputPath` to `deploy/locales/{locale}.json`, and add `"frontendTemplate": { "path": "deploy/frontend.yaml", "generateSourceCatalog": true }`.

After the preset and required source catalog path and filename, add only fields that override the preset: use `locales` for a subset of its repository locales, set `project` only when the developer names another Phrase project, and write a full `targetLocales` array only when the locale mapping differs. Repository objects merge recursively; arrays and scalar values replace the preset values. A changed preset changes the batch identity for every consumer that uses it, so its next run resubmits the source to Phrase. `i18n-pipeline tms config --config <path>` prints the expanded config. The preset turns on `useProjectFileImportSettings`, so a config that sets `sourceCatalog.importSettingsUid` must also set `useProjectFileImportSettings: false`.

A preset config needs an `i18n-pipeline` build and a pinned validation workflow that know presets. If `i18n-pipeline tms config --help` fails, rebuild the CLI from current `i18n-tooling` main, and pin the locale validation caller to an `i18n-tooling` commit that has `tms config`. `catalog-validation.json` can use `tmsConfig` to derive target checks; do not list them again.

Point the validation config's `tmsConfig` at `phrase-tms.json` in the same change. A target file that has not arrived yet, or that is an empty `{}` placeholder the app imports before delivery, is pending, not a validation error. Keep such placeholders.

The reusable reconciliation workflow writes one flat locale JSON file per target locale and opens or updates one PR per locale. It does not run the consumer's build or aggregation scripts. Never use an aggregate file as a target `outputPath`.

## Pull-request validation (both modes)

Neither mode checks pull requests. The validation baseline's locale validation caller does that, including on the locale PRs Phrase opens. Make sure the repository has it; see [validation-baseline.md](validation-baseline.md#run-it-on-pull-requests), which also sets the pinning rule for the Phrase callers.

## PR and admin follow-up (both modes)

Put a manual follow-up checklist in the consumer PR description and the final report; never in a repository file. Include every item that applies, plus the mode-specific items from the mode reference:

- Confirm the map from Phrase locale to repository locale, and the output paths.
- Confirm repository owners, and the Phrase project settings for `defaultMessage`, `description`, and ICU parsing.
- Replace workflow SHA placeholders with reviewed immutable commits.
- Record missing permissions, unverified environments or secret names, runtime locale work, and any other choice the agent could not make safely.

Keep a missing CLI npm devDependency marked pending until the first npm release.
