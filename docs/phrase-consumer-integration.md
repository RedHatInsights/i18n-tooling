# Phrase consumer integration example

This example shows the consumer-owned boundary around the reusable Phrase workflows. It uses synthetic `fr` data and placeholders only; it does not call Phrase or GitHub. Replace the sample locale and paths to match each application.

## Catalog handoff

1. Keep the extracted FormatJS source committed at `locales/translation-template.json`. The submit workflow reads the catalog at the dispatched commit; it does not run framework extraction.
2. Configure Phrase's JSON settings to translate `defaultMessage`, retain `description` as context, and enable ICU parsing. The sample config selects project file-import settings; use that only after verifying the project settings.
3. Reconciliation writes one flat `id -> message string` file per repository locale, for example `src/locales/fr.json`. Do not point `outputPath` at an aggregate file such as `src/locales/data.json`.
4. Run the consumer's native compile/aggregation and build checks on the generated locale PR. The reusable Phrase workflow validates catalog IDs and ICU arguments, but does not run application-specific build steps.

The checked-in example files:

- [Phrase config](../examples/phrase-consumer/.github/i18n/phrase-tms.json)
- [Manual submit caller](../examples/phrase-consumer/.github/workflows/phrase-submit.yml)
- [Manual reconcile caller](../examples/phrase-consumer/.github/workflows/phrase-reconcile.yml)
- [Locale PR validation caller](../examples/phrase-consumer/.github/workflows/locale-validation.yml)
- [Locale aggregation script](../examples/phrase-consumer/scripts/assemble-locales.mjs)

## Consumer validation script

Ensure every application build regenerates the aggregate from the per-locale files. For a single `fr` target, add a build hook and validation script like:

```json
{
  "scripts": {
    "prebuild": "npm run translations:compile && npm run translations:datafile",
    "i18n:validate": "npm run translations:extract && git diff --exit-code -- locales/translation-template.json && frontend-i18n check --source locales/translation-template.json --target src/locales/fr.json --target-locale fr && npm run build"
  }
}
```

Without `prebuild` (or an equivalent consumer build step), the Phrase PR changes only `src/locales/fr.json`; tracked `data.json` stays stale and the application may still ship English-only data. `npm run build` invokes `prebuild`, which recompiles English and aggregates every locale. The sample `locale-validation.yml` calls the reusable validation workflow, which installs consumer dependencies and puts `frontend-i18n` on `PATH` before running `npm run i18n:validate`. For multiple locales, check each configured target rather than only `fr`. Keep the framework-specific extraction, compilation, aggregation, and build commands in the consumer repository.

The sample aggregation script models the important contract in rbac-ui's existing `translations:datafile` flow: compiled `translations.json` becomes `en`, per-locale files remain separate, and the generated `data.json` contains both without overwriting English. Keep an existing consumer aggregator instead of copying this script if it already provides the same behavior.

## GitHub setup

1. Copy the caller workflows and config into the consumer repository. Replace `<reviewed-commit-sha>` with the reviewed `i18n-tooling` commit SHA and update the Phrase UID, region, language mapping, and output path.
2. Land the manual `workflow_dispatch` caller files on the consumer's default branch before dispatching. Keep scheduling disabled during the pilot.
3. Add the Phrase credentials to the named protected environment: `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET` for a Service Account (preferred), or `PHRASE_PLATFORM_API_TOKEN` for a user's Platform token (fine for a pilot). Use one set, never both. Place them in the environment (sample: `phrase-pilot`) and restrict its allowed deployment refs. The workflows use `GITHUB_TOKEN`: submission needs `contents: write`; reconciliation also needs `pull-requests: write`. Do not add a PAT or put credentials in the config.
4. Confirm locale PR checks run. GitHub can hold checks started by `GITHUB_TOKEN` PRs for maintainer approval.

For rbac-ui, the existing source path and `translations:datafile` aggregation fit this shape. The repository currently has no target locale JSON files, `src/locales/data.json` contains only `en`, and `src/locales/locale.ts` is hard-coded to `en`. A Phrase PR can add a locale catalog and the aggregate can include it, but users will not see that locale until rbac-ui wires its runtime locale selection. Keep that runtime change separate if the first pilot only tests catalog delivery.

## Credential-free integration test

`packages/i18n-pipeline/tests/phrase-consumer-example.test.ts` exercises the contract without external services:

1. A fake Phrase export returns descriptor-shaped entries with string and object descriptions.
2. `PhraseWorkflow` validates the export and captures its flat locale PR file.
3. The example aggregation script combines that file with compiled English data.
4. Assertions prove English remains present, the translated locale is included, IDs match, and ICU arguments remain valid.

Run it with:

```bash
npm run test --workspace @redhat-cloud-services/i18n-pipeline -- tests/phrase-consumer-example.test.ts
```

This test checks the integration seam, not Phrase settings, GitHub Actions dispatch, or the consumer's runtime language switch. Those remain pilot acceptance steps.
