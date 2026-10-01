# Consumer onboarding

This checklist onboards a frontend repository to shared catalog validation and the Phrase TMS round trip. It is written so a person or a coding agent can follow it in order; each step names a check that proves it is done. The [Phrase consumer integration example](phrase-consumer-integration.md) has copyable files, and the [package guide](../packages/i18n-pipeline/README.md#generic-project-validation) documents the validation config.

The traps listed under each step were found while piloting `insights-rbac-ui`. Expect the same ones in other FormatJS consumers.

## 1. Measure existing drift first

Run the consumer's own extraction, compilation, and aggregation scripts on a clean checkout of the default branch, then run `git status`.

- **Trap: the default branch is already stale.** In rbac-ui, an earlier feature PR changed `src/Messages.js` without regenerating the catalogs, so about 40 English strings were missing from every checked-in catalog. Land that catch-up as its own commit or PR, before any tooling change. Mixed into the onboarding, it hides which catalog changes the tooling caused, and reverting the onboarding would also drop real strings.
- **Trap: duplicate message IDs.** FormatJS extraction only warns when two descriptors share an ID with different text or descriptions (rbac-ui: `recommendedContentTitle`). The catalog keeps one of them, and translators see only that one. Resolve every duplicate warning before the first Phrase submission.

**Done when:** regeneration on the default branch leaves no diff, and extraction prints no duplicate-ID warnings.

## 2. Make every generator honor an output path

`validate-project` re-runs each generator into a temporary `{output}` file and compares the result with the checked-in file. Each script must therefore write where it is told, and nowhere else.

- FormatJS `extract` and `compile` accept a second `--out-file`; the last value wins. Reuse the package script (`npm run --silent translations:extract -- --out-file {output}`) instead of copying its arguments into the config, so the check runs exactly what developers run.
- Custom aggregation scripts (such as a `createDataJson.js` that writes `src/locales/data.json`) usually hard-code their output. Add an output option that defaults to the current path.
- **Trap: silently ignored CLI flags.** rbac-ui's aggregation script read options as `program.langDir`, which Commander 7 and later no longer populate, so its `-l`/`-I` flags did nothing. Use `program.opts()` and test that the new output flag is actually respected.

**Done when:** each generator, pointed at a temporary path, leaves `git status` clean.

## 3. Write the validation plan

Create `.github/i18n/catalog-validation.json`:

- `checks`: the source catalog against compiled English (and any catalog outside Phrase).
- `tmsConfig`: the path to `phrase-tms.json`. Target locales come from there; do not list them again. Phrase locale codes and repository codes differ (`zh_cn` against `zh-CN`), so keep that mapping in one file.
- `generated`: extraction, compilation, and every runtime aggregate. A locale-keyed aggregate is not a catalog, so omit `adapter` for it to get a plain JSON comparison.
- `catalogDirectories`: every directory that holds locale files, so an undeclared or leftover file fails.

**Trap: build hooks hide stale aggregates.** A `prebuild` hook that regenerates `data.json` makes builds correct but leaves the checked-in file stale, and unit tests often import the checked-in file directly. Validate the aggregate as a `generated` entry even when the build regenerates it.

**Done when:** `frontend-i18n validate-project --config .github/i18n/catalog-validation.json` passes locally. Then deliberately break each piece (delete a message, edit the aggregate, add a stray `xx.json`) and confirm each break fails.

## 4. Wire the package scripts

- Add `translations:validate` that runs `frontend-i18n validate-project --config .github/i18n/catalog-validation.json`.
- **Trap: wildcard script runners.** `npm-run-all translations:*` also picks up new `translations:validate` or `translations:prepare` scripts. List the steps explicitly.
- **Trap: pre-hooks match exact names.** `prestart` does not run before `start:no-proxy`. Add a hook for every entry point that serves the app, or none.
- The CLI is not published to npm. To run it locally, build `packages/i18n-pipeline` in an `i18n-tooling` checkout and put a `frontend-i18n` wrapper for `dist/cli.js` on `PATH`. CI builds it from the pinned workflow source.

**Done when:** `npm run translations` regenerates everything and `npm run translations:validate` passes.

## 5. Add the CI callers

Copy the callers from [`examples/phrase-consumer`](../examples/phrase-consumer/.github/workflows/).

- Pin every `uses:` to a reviewed `i18n-tooling` commit SHA. `validation-config` needs a tooling commit that contains `validate-project`; bump the SHA whenever the plan uses a newer feature.
- Set top-level `permissions: {}` and grant permissions per job.
- **Trap: source lint scope.** The default `source-glob` scans all sources. Existing code with imported, dynamic, or inline descriptors fails immediately. Scope `source-glob` to the files that declare messages (rbac-ui: `src/Messages.js`), and track migrating the rest as separate work.

**Done when:** the validation job passes on a PR, and fails on a PR that edits `Messages.js` without regenerating the catalogs.

## 6. Pilot Phrase from a feature branch

- Pilot runs usually happen on a feature branch before the callers land on the default branch. Temporarily point each caller's branch guard (`if: github.ref == …`) and the submit `base-ref` at the pilot branch, and allow that branch in the `phrase-pilot` environment's deployment refs. Mark each change with `FIXME` and restore the default branch before merge.
- Store credentials only in the protected environment. Check the `Phrase auth:` line in the job log.
- Create or select a reusable Phrase import-settings record for the job. Configure its JSON settings to translate `defaultMessage`, keep `description` as context, and enable **Parse ICU messages** (`fileImportSettings.json.icuSubFilter: true`). Set its UID in `sourceCatalog.importSettingsUid`; Create Job sends this as `importSettings: { uid }`. `useProjectFileImportSettings: true` selects project defaults instead and is not a substitute for the job-specific record. Use Phrase's [List](https://developers.phrase.com/en/api/tms/latest/import-settings/list-import-settings), [Get](https://developers.phrase.com/en/api/tms/latest/import-settings/get-import-settings), and [Create Import Settings APIs](https://developers.phrase.com/en/api/tms/latest/import-settings/create-import-settings) to find or configure the record, then verify it before submitting.
- **Inline-tag caveat:** [Phrase TMS JSON](https://support.phrase.com/hc/en-us/articles/5709604147100--JSON-JavaScript-Object-Notation-TMS) skips ICU parsing for segments containing inline elements. Test any message that combines ICU with FormatJS rich-text tags (such as `<b>...</b>`); HTML subfilter or regex-to-tag conversion may protect the tags but does not guarantee ICU parsing for that same segment. The [Strings Connector CDATA option](https://support.phrase.com/hc/en-us/articles/5709647502620-Phrase-Strings-Connector-Job-Sync) is not part of direct JSON job upload.

**Done when:** submit creates jobs with the intended Phrase import settings, reconcile opens a per-locale PR, and that PR's validation job passes.

## 7. Confirm what users actually see

A delivered catalog is not a live locale. rbac-ui's `src/locales/locale.ts` always returns `en`, so translated catalogs ship but never display. Treat runtime locale selection as its own product change, with its own tests.

## Agent prompt

Paste this into a coding agent session in the consumer repository:

```text
Onboard this repository to RedHatInsights/i18n-tooling catalog validation and the Phrase TMS
round trip. Follow docs/consumer-onboarding.md from i18n-tooling step by step. For every step,
run its "Done when" check and report the result before moving on. Keep catalog catch-up,
tooling onboarding, and runtime locale selection in separate commits. Never put Phrase
credentials in files. Pin reusable workflows to a reviewed commit SHA. Mark any temporary
pilot-branch settings with FIXME and list them in your final summary.
```
