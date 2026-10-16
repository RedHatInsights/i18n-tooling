# Phrase submit and reconcile

Use this reference when the developer selects Phrase, or when the repository already has Phrase callers or an i18n-hub registration.

## Choose the mode

Each repository is synced in exactly one mode:

- **Hub (default).** The central [RedHatInsights/i18n-hub](https://github.com/RedHatInsights/i18n-hub) runs submit and reconcile on a schedule, using its own Phrase credential and the shared i18n GitHub App. The consumer holds no Phrase or GitHub App secrets and no submit or reconcile callers. Offer it for repositories under `RedHatInsights`, because the hub registry accepts only `RedHatInsights/<name>`. Read [phrase-hub.md](phrase-hub.md).
- **Standalone.** The consumer runs its own submit and reconcile callers from its own protected environment. For GitHub writes, it uses the repository's own GitHub App, or `GITHUB_TOKEN` as the fallback. Offer it for repositories outside `RedHatInsights` or when the developer chooses it. Read [phrase-standalone.md](phrase-standalone.md).

Detect the current mode during inspection:

- **Standalone callers** are consumer workflows whose `uses:` names `RedHatInsights/i18n-tooling/.github/workflows/phrase-submit.yml` or `phrase-reconcile.yml`.
- **Hub registration** is an entry in i18n-hub's `consumers.json` whose `repository` equals this repository. The hub is private, so read it with `gh api repos/RedHatInsights/i18n-hub/contents/consumers.json -H "Accept: application/vnd.github.raw+json"`. If that request fails, report the registration as unverified.

When a repository has both, report it as a conflict for the developer to resolve. Otherwise, show the detected mode as done. For a standalone repository under `RedHatInsights`, offer **Migrate to i18n-hub** as an upgrade (see [phrase-hub.md](phrase-hub.md#migrate-from-standalone)).

## Shared project

Both modes use the shared HCC Phrase project, `yWWEIEQgpNVK650YBQhGx6` in region `eu`, created from the `[HCC UI]` template with shared translation memories and term bases. Developers do not know these details, so write them into the config directly. Its file import settings fit FormatJS JSON, so set `useProjectFileImportSettings: true`. Its Phrase locale for `zh-CN` is `zh_cn`; `fr`, `ja`, and `ko` match the repository codes. Use another project only when the developer names its UID and region. The i18n-hub's `docs/operations.md` records the shared project; when it is readable and disagrees, follow it and report the difference.

## Config (both modes)

Write `i18n/phrase-tms.json` (or keep the repository's existing location). Keep the extracted FormatJS source catalog in the repository change, normally at `locales/translation-template.json`. Phrase submission reads that file from the commit it syncs; it does not extract messages. Set `sourceCatalog.adapter` to `formatjs-json`, keep `description` as translator context, and confirm the Phrase project parses ICU. A minimal `phrase-tms.json` has this shape:

```json
{
  "provider": "phrase",
  "project": { "uid": "yWWEIEQgpNVK650YBQhGx6", "region": "eu" },
  "state": { "branch": "i18n-tms-state" },
  "sourceCatalog": {
    "path": "locales/translation-template.json",
    "filename": "<repository-name>.ui.en.json",
    "adapter": "formatjs-json",
    "locale": "en",
    "useProjectFileImportSettings": true
  },
  "targetAdapter": "formatjs-json",
  "targetLocales": [
    {
      "phraseLocale": "fr",
      "repositoryLocale": "fr-CA",
      "outputPath": "src/locales/fr-CA.json"
    }
  ],
  "completionPolicy": { "default": "per-locale" }
}
```

Set `sourceCatalog.filename` to `<repository-name>.<catalog>.en.json`, where `<catalog>` is `ui` for application messages and `feo` for FEO's catalog (for example `insights-rbac-ui.ui.en.json`). This is the shared HCC Phrase project's convention: the name the file gets in Phrase shows which app and catalog it belongs to. Without it, the pipeline uploads the source path's basename, which for most apps is the generic `translation-template.json`. The repository file keeps its path.

Use either `sourceCatalog.importSettingsUid` or `useProjectFileImportSettings`, not both. Map each Phrase locale to its repository locale once, in `targetLocales`. `catalog-validation.json` can use `tmsConfig` to derive those target checks; do not list them again.

Point the validation config's `tmsConfig` at `phrase-tms.json` in the same change. A target file that has not arrived yet is pending, not a validation error.

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
