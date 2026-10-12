# Phrase submit and reconcile

Use this reference when the developer selects Phrase or existing Phrase callers need an update.

## Config and callers

Write `i18n/phrase-tms.json` (or keep the repository's existing location). Keep the extracted FormatJS source catalog in the repository change, normally at `locales/translation-template.json`. Phrase submission reads that file from the dispatched commit; it does not extract messages. Set `sourceCatalog.adapter` to `formatjs-json`, keep `description` as translator context, and confirm the Phrase project parses ICU. A minimal `phrase-tms.json` has this shape:

```json
{
  "provider": "phrase",
  "project": { "uid": "<phrase-project-uid>", "region": "us" },
  "state": { "branch": "i18n-tms-state" },
  "sourceCatalog": {
    "path": "locales/translation-template.json",
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

Use either `sourceCatalog.importSettingsUid` or `useProjectFileImportSettings`; use the latter only when it matches the Phrase project. Map each Phrase locale to the repository locale once in `targetLocales`. `catalog-validation.json` can use `tmsConfig` to derive those target checks; do not list them again. Add `tmsConfig` only once the Phrase config is complete: `project.region` must be `us` or `eu` and `project.uid` must be the real project. While either is unknown, keep the Phrase config as a draft with marked placeholders and leave `tmsConfig` out, so validation of the rest of the repository keeps passing. A target file that has not arrived yet is pending, not a validation error.

Add only missing consumer callers. Copy the templates shipped with this skill from `assets/workflows/` (next to this `references/` folder) into the consumer's `.github/workflows/` and adapt triggers, paths and the config location to the repository:

- `.github/workflows/phrase-submit.yml` calls `RedHatInsights/i18n-tooling/.github/workflows/phrase-submit.yml@<reviewed-commit-sha>` and grants `contents: write`.
- `.github/workflows/phrase-reconcile.yml` calls `RedHatInsights/i18n-tooling/.github/workflows/phrase-reconcile.yml@<reviewed-commit-sha>` and grants `contents: write` and `pull-requests: write`.
- `.github/workflows/locale-validation.yml` calls `RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>` on translation config, source catalogs, locale catalogs, package scripts, and relevant generators.

Use top-level `permissions: {}` and grant each job only its needed permissions. Pin each reusable workflow to a reviewed tooling commit SHA; leave no example placeholder in a runnable caller. Consumer-owned callers choose triggers. Keep submit/reconcile manual during a pilot, and do not dispatch them from this onboarding skill.

If no reviewed SHA is available, do not invent one. Keep the example marker in the manual-only caller draft and list replacement with a reviewed SHA as an adoption follow-up. A caller with the marker is not ready to run.

## Read-only GitHub checks

Choose the environment used in the caller, then use `gh api` with GET requests only to list repository environments and secret names. The endpoints are `repos/{owner}/{repo}/environments`, `repos/{owner}/{repo}/environments/{environment_name}/secrets`, and `repos/{owner}/{repo}/actions/secrets`. `gh api` defaults to GET when no request fields are supplied. Do not request, print, or copy secret values. If the repository owner/name cannot be resolved, or `gh` is absent, unauthenticated, or lacks permission, report the check as unverified and put it in the admin checklist.

The accepted secret names are `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`, or `PHRASE_PLATFORM_API_TOKEN`. Secret names may be checked; values are never visible through these list endpoints. Do not create or update secrets.

## PR and admin follow-up

Put a manual follow-up checklist in the PR description, not only in the final report. Include any unresolved items that apply:

- Replace the Phrase project UID and verify the project region and import settings.
- Confirm the Phrase locale to repository locale map and output paths.
- Create and protect the chosen GitHub environment, add one accepted secret set, and restrict its deployment refs.
- Confirm repository owners and the Phrase project settings for `defaultMessage`, `description`, and ICU parsing.
- Replace workflow SHA placeholders with reviewed immutable commits.
- Record missing permissions, unverified environment or secret names, runtime locale work, or other choices the agent could not make safely.

The reusable reconciliation workflow writes one flat locale JSON file per target locale and opens or updates a locale PR. It does not run the consumer's build or aggregation scripts. Never use an aggregate file as a target `outputPath`. Keep a missing CLI npm devDependency marked pending until the first npm release.
