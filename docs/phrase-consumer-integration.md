# Phrase consumer integration example

This example shows the consumer-owned boundary around the reusable Phrase workflows. It uses synthetic `fr` data and placeholders only; it does not call Phrase or GitHub. Replace the sample locale and paths to match each application.

## Catalog handoff

1. Keep the extracted FormatJS source committed at `locales/translation-template.json`. The submit workflow reads the catalog at the dispatched commit; it does not run framework extraction.
2. Set `sourceCatalog.ensureJsonIcuImportSettings.name` to let submit copy the project's file-import defaults into a reusable job record, select `fileFormat: "json"`, and enable **Parse ICU messages** (`json.icuSubFilter: true`). Submit reuses an identical reusable record or creates it if missing, then sends its UID as `importSettings: { uid }`. For a separately provisioned record, set `sourceCatalog.importSettingsUid` instead. `useProjectFileImportSettings: true` selects project defaults directly; it is a different, mutually exclusive option. See Phrase's [List Import Settings](https://developers.phrase.com/en/api/tms/latest/import-settings/list-import-settings), [Get Import Settings](https://developers.phrase.com/en/api/tms/latest/import-settings/get-import-settings), [Create Import Settings](https://developers.phrase.com/en/api/tms/latest/import-settings/create-import-settings), and [Create Job](https://developers.phrase.com/en/api/tms/latest/job/create-job) APIs. [Phrase TMS JSON](https://support.phrase.com/hc/en-us/articles/5709604147100--JSON-JavaScript-Object-Notation-TMS) skips ICU parsing for segments containing inline elements, so test messages combining ICU with FormatJS tags such as `<b>...</b>`; tag protection does not guarantee ICU parsing for the same segment.
3. Reconciliation writes one flat `id -> message string` file per repository locale, for example `src/locales/fr.json`. Do not point `outputPath` at an aggregate file such as `src/locales/data.json`.
4. Run the consumer's native compile/aggregation and build checks on the generated locale PR. The reusable Phrase workflow validates catalog IDs and ICU arguments, but does not run application-specific build steps.

The checked-in example files:

- [Phrase config](../examples/phrase-consumer/.github/i18n/phrase-tms.json)
- [Catalog validation config](../examples/phrase-consumer/.github/i18n/catalog-validation.json)
- [Manual submit caller](../examples/phrase-consumer/.github/workflows/phrase-submit.yml)
- [Manual reconcile caller](../examples/phrase-consumer/.github/workflows/phrase-reconcile.yml)
- [Locale PR validation caller](../examples/phrase-consumer/.github/workflows/locale-validation.yml)
- [Locale aggregation script](../examples/phrase-consumer/scripts/assemble-locales.mjs)

For a step-by-step adoption guide, including the traps found while piloting rbac-ui, see [consumer onboarding](consumer-onboarding.md).

## Consumer catalog validation

A consumer-specific `validate-i18n.mjs` is not a general solution: this example's source glob, FormatJS commands, catalog paths, and JSON layouts are repository choices. The shared `validate-project` command moves those choices into [`catalog-validation.json`](../examples/phrase-consumer/.github/i18n/catalog-validation.json): each source and target declares its own adapter and locale, and each generated artifact declares its native generator command. The example re-runs the consumer's own `translations:*` scripts into temporary files, so it checks that extraction, English compilation, and the `data.json` aggregate are all current. It then checks compiled English against the source, and `tmsConfig` adds every Phrase target locale once its file exists. `catalogDirectories` fails on any file in `src/locales/` that the plan does not declare.

Use the reusable workflow's `validation-config` input to run this plan instead of maintaining a custom validation script. Generator arguments are passed without a shell; `{output}` points to a temporary file. The CLI parses generated and checked-in documents with their adapter and fails on drift. Configure generators to write only to `{output}`; the validator itself never rewrites tracked catalogs. `updateCommand` only tells maintainers how to refresh a stale file.

Without `prebuild` (or an equivalent consumer build step), the Phrase PR changes only `src/locales/fr.json`; tracked `data.json` stays stale and the application may still ship English-only data. `npm run build` invokes `prebuild`, which recompiles English and aggregates every locale. Extraction, compilation, and aggregate sync are checked by `validation-config`. The application build steps remain the consumer's responsibility. The example's `locale-validation.yml` calls the reusable workflow, which installs consumer dependencies and puts `frontend-i18n` on `PATH` before running `validate-project`. Target locales come from `phrase-tms.json` through `tmsConfig`; do not list them a second time. Keep framework-specific extraction, compilation, aggregation, and build commands in the consumer repository.

The sample aggregation script models the important contract in rbac-ui's existing `translations:datafile` flow: compiled `translations.json` becomes `en`, per-locale files remain separate, and the generated `data.json` contains both without overwriting English. Keep an existing consumer aggregator instead of copying this script if it already provides the same behavior.

## GitHub setup

1. Copy the caller workflows and config into the consumer repository. Replace `<reviewed-commit-sha>` with the reviewed `i18n-tooling` commit SHA and update the Phrase UID, region, language mapping, and output path.
2. Land the manual `workflow_dispatch` caller files on the consumer's default branch before dispatching. Keep scheduling disabled during the pilot.
3. Add the Phrase credentials to the named protected environment: `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET` for a Service Account (preferred), or `PHRASE_PLATFORM_API_TOKEN` for a user's Platform token (fine for a pilot). The CLI chooses by which secret names are set, not by inspecting values; setting both kinds fails the run before any request. Check the `Phrase auth:` line in the job log to confirm which kind was used. Place them in the environment (sample: `phrase-pilot`) and restrict its allowed deployment refs. The workflows use `GITHUB_TOKEN`: submission needs `contents: write`; reconciliation also needs `pull-requests: write`. Do not add a PAT or put credentials in the config.
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
