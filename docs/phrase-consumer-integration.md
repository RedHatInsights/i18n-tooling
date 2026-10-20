# Phrase consumer integration example

This example shows the consumer-owned boundary around the reusable Phrase workflows. It uses synthetic `fr` data and placeholders only; it does not call Phrase or GitHub. Replace the sample locale and paths to match each application. For hub-owned automation, follow the [hub route in consumer onboarding](consumer-onboarding.md#hub-owned-phrase-automation).

For maintainer guidance on run schedules, Phrase job links, locale PRs, and outcomes, see [Where is my translation?](../README.md#where-is-my-translation).

## Catalog handoff

1. Keep the extracted FormatJS source committed at `locales/translation-template.json`. The submit workflow reads the catalog at the dispatched commit; it does not run framework extraction.
2. Configure Phrase's JSON settings to translate `defaultMessage`, retain `description` as context, and enable ICU parsing. The sample config selects project file-import settings; use that only after verifying the project settings.
3. Reconciliation writes one flat `id -> message string` file per repository locale, for example `src/locales/fr.json`. Do not point `outputPath` at an aggregate file such as `src/locales/data.json`.
4. Run the consumer's native compile/aggregation and build checks on the generated locale PR. The reusable Phrase workflow validates catalog IDs and ICU arguments, but does not run application-specific build steps.

The checked-in example files:

- [Phrase config](../examples/phrase-consumer/.github/i18n/phrase-tms.json)
- [Catalog validation config](../examples/phrase-consumer/.github/i18n/catalog-validation.json)
- [Submit caller: on merge, or by hand](../examples/phrase-consumer/.github/workflows/phrase-submit.yml)
- [Reconcile caller: scheduled, or by hand](../examples/phrase-consumer/.github/workflows/phrase-reconcile.yml)
- [Locale PR validation caller](../examples/phrase-consumer/.github/workflows/locale-validation.yml)
- [Locale aggregation script](../examples/phrase-consumer/scripts/assemble-locales.mjs)

For a step-by-step adoption guide, including the traps found while piloting rbac-ui, see [consumer onboarding](consumer-onboarding.md).

## Consumer catalog validation

A consumer-specific `validate-i18n.mjs` is not a general solution: this example's source glob, FormatJS commands, catalog paths, and JSON layouts are repository choices. The shared `validate-project` command moves those choices into [`catalog-validation.json`](../examples/phrase-consumer/.github/i18n/catalog-validation.json): each source and target declares its own adapter and locale, and each generated artifact declares its native generator command. The example re-runs the consumer's own `translations:*` scripts into temporary files, so it checks that extraction, English compilation, and the `data.json` aggregate are all current. It then checks compiled English against the source, and `tmsConfig` adds every Phrase target locale once its file exists. `catalogDirectories` fails on any file in `src/locales/` that the plan does not declare.

Use the reusable workflow's `validation-config` input to run this plan instead of maintaining a custom validation script. Generator arguments are passed without a shell; `{output}` points to a temporary file. The CLI parses generated and checked-in documents with their adapter and fails on drift. Configure generators to write only to `{output}`; the validator itself never rewrites tracked catalogs. `updateCommand` only tells maintainers how to refresh a stale file.

Without `prebuild` (or an equivalent consumer build step), the Phrase PR changes only `src/locales/fr.json`; tracked `data.json` stays stale and the application may still ship English-only data. `npm run build` invokes `prebuild`, which recompiles English and aggregates every locale. Extraction, compilation, and aggregate sync are checked by `validation-config`. The application build steps remain the consumer's responsibility. The example's `locale-validation.yml` calls the reusable workflow, which installs consumer dependencies and puts `i18n-pipeline` on `PATH` before running `validate-project`. Target locales come from `phrase-tms.json` through `tmsConfig`; do not list them a second time. Keep framework-specific extraction, compilation, aggregation, and build commands in the consumer repository.

The sample aggregation script models the important contract in rbac-ui's existing `translations:datafile` flow: compiled `translations.json` becomes `en`, per-locale files remain separate, and the generated `data.json` contains both without overwriting English. Keep an existing consumer aggregator instead of copying this script if it already provides the same behavior.

## Tracked aggregates

The shared Phrase workflow does not run consumer aggregation scripts. Keep the aggregate current by running the consumer's generator. If the aggregate must be committed on a locale PR, commit it only when accepting that locale as final: a reviewer commit makes the branch ineligible for Phrase re-export, so later corrections are refused and the commit is preserved. Keep aggregate generation in the consumer build while the PR needs re-export.

## GitHub setup

1. Copy the caller workflows and config into the consumer repository. Replace `<reviewed-commit-sha>` with the reviewed `i18n-tooling` commit SHA and update the Phrase UID, region, language mapping, and output path.
2. Run the first pilot round trip from a branch as in [consumer onboarding step 6](consumer-onboarding.md#6-pilot-phrase-from-a-feature-branch), then land the caller files on the consumer's default branch with the merge and schedule triggers as in [step 8](consumer-onboarding.md#8-turn-on-the-merge-and-schedule-triggers).
3. Add the Phrase credential to the named protected environment: `PHRASE_PLATFORM_API_TOKEN`, a user's Platform API token. A person's token may serve until a dedicated technical user exists; then replace it with the scoped technical-user token. Phrase Service Accounts (`PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`) [cannot create jobs](https://support.phrase.com/hc/en-us/articles/29488404284316-Service-Accounts), so submit cannot use them. The CLI chooses by which secret names are set, not by inspecting values; setting both kinds fails the run before any request. Check the `Phrase auth:` line in the job log to confirm which kind was used. Place it in the environment (sample: `phrase-pilot`) and restrict its allowed deployment refs to the default branch. Do not put Phrase credentials in the config.
   Unmapped workflow-call secret names arrive empty, so every caller must map each name it uses in `secrets:`, even when its value is in the protected environment passed as `environment`. The called job's environment secret takes precedence over the mapped caller value. For example:

   ```yaml
   secrets:
     PHRASE_PLATFORM_API_TOKEN: ${{ secrets.PHRASE_PLATFORM_API_TOKEN }}
   ```

   Map any App secret names the same way. Service Account reconciliation support remains unverified; never use those secrets for submit. Never use `secrets: inherit`.

4. For App mode, add `APP_CLIENT_ID` and `APP_PRIVATE_KEY` as secrets in the same protected environment and map both names in the caller; GitHub secret names cannot start with `GITHUB_`. Consumer-owned callers use a consumer-owned App; hub callers use the hub App installed on each target consumer. See the [README's full guidance on authentication modes and permissions](../README.md#phrase-tms-round-trip).
5. For central-hub repository targeting, pass `repository: owner/name`. The `base-ref` input is used only when `repository` targets another repository; same-repository runs check out the triggering commit. Cross-repository submit requires `base-ref`, while reconcile uses it when supplied and otherwise checks out the target repository's default branch. See the [Phrase workflow guidance](../README.md#phrase-tms-round-trip).

Hub reconcile callers may pass `fallback-assignees` as a space- or comma-separated list of GitHub logins. New locale PRs first try users linked to commits that changed the batch source input since the previous matching batch; this hub-owned fallback list is used only when GitHub assigns none of those authors. Keep the list in the workflow call input rather than `phrase-tms.json`.

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
