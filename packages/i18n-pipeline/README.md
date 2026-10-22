# `@redhat-cloud-services/i18n-pipeline`

Node.js 22.14+ workspace package for repository-owned locale catalogs. It provides a normalized `Catalog` model, built-in FormatJS, keyed ICU JSON, and OpenAPI Problem Details adapters, adapter-owned text codecs, ICU pattern validation, generated-catalog sync, and the `i18n-pipeline` CLI.

The reusable workflow builds the CLI from this source; consumers do not need an npm dependency on this repository. npm consumer usage below applies after the first release. Framework extraction and compilation stay with each consumer's native tooling. Catalog-format adapters normalize repository artifacts; TMS-provider adapters are a separate future seam.

## Built-in adapters

| ID                        | Source catalog                                                                      | Target catalog                            |
| ------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `formatjs-json`           | FormatJS descriptors: `{ "id": { "defaultMessage": "...", "description": "..." } }` | Flat compiled messages: `{ "id": "..." }` |
| `icu-json`                | Flat message-code-to-ICU-pattern JSON                                               | Flat message-code-to-ICU-pattern JSON     |
| `openapi-problem-details` | OpenAPI 3 Problem Details schemas annotated with `x-i18n.message`                   | Source-only; convert to `icu-json`        |

The FormatJS adapter retains string/object descriptions and other descriptor metadata. The JSON adapters validate ICU syntax with FormatJS's `@formatjs/icu-messageformat-parser`; the OpenAPI adapter also parses ICU arguments and checks them against the schema. Consumers should run native framework compilation and validation where applicable. ICU failure reports list each malformed message ID, its line and column within the pattern, and a readable parser diagnostic.

## CLI

`check` compares source and target message IDs and named ICU arguments, including arguments nested in plural/select branches. Use `--source-adapter` and `--target-adapter` when the catalogs use different formats.

`i18n-pipeline tms reconcile --config <path>` reconciles completed Phrase jobs into draft locale PRs. It accepts `--expect-project <uid>` and `--expect-source-filename <name>` pins, plus repeatable `--fallback-assignee <login>` values. When a run first creates a locale PR, it assigns GitHub users linked to commits that changed the batch's source input since the previous batch for the same repository, base ref, Phrase project, and upload filename. If GitHub assigns none of those users, it tries the fallback list. Existing PRs are not assigned retroactively; transient assignment errors are retried from batch state, while final errors do not change the locale result. When a newer source batch opens a locale PR, reconciliation closes matching locale PRs from earlier superseded batches unless their heads contain reviewer commits, or the replacement lacks one of their translations; those PRs stay open with a notice. A translation counts as lacking when its English is unchanged between the two batches, it differs from the English, it has no validation error, and the replacement's catalog has a different value. Such a PR is checked again on every reconcile and closes, with a second notice, once the replacement carries the same translations. Hub callers pass fallback logins through the reusable workflow's `fallback-assignees` input; the list does not belong in `phrase-tms.json`.

`i18n-pipeline tms config --config <path>` validates and prints the resolved config as two-space-indented JSON without credentials or network calls. The built-in `hcc-ui` preset supplies the shared HCC UI project, FormatJS source settings, and `fr`, `ja`, `ko`, and `zh_cn` locale mapping. Repository objects merge recursively; repository arrays and scalar values replace preset values. Use `locales` to select a subset in the requested order, or write `targetLocales` for a different mapping. `targetOutputPath` fills missing target paths by replacing `{locale}` with the repository locale; explicit target paths win. Changing a preset changes each consumer's batch identity, so its next run resubmits the source to Phrase.

In GitHub Actions, `tms submit` and `tms reconcile` append a run summary with Phrase links. Reconcile rows show locale PRs, recorded assignees, and validation finding counts; detailed findings remain in the PR's 🌐 Translation check comment.

`validate --role source` and `validate-project` also warn about source plural semantics that per-locale ICU validation cannot see. Warnings do not fail validation; under GitHub Actions they become annotations.

- **`plural-category-only-arguments`** — an argument appears only under a CLDR category (`zero`, `one`, `two`, `few`, `many`) and never under `other`. Categories are locale grammar, not numbers: zh selects only `other`, so translation tools drop the `one` branch and its argument, and ru `one` also matches 21. Use an exact `=1` branch for content that depends on the count: `{count, plural, =1 {{name} will be removed.} other {# accounts will be removed.}}`.
- **`unused-plural-category`** — a branch uses a category the source locale never selects, such as `zero` in English. Use `=0`.
- **`unformatted-count-argument`** — a plural selector or count-like argument (`count`, `total`, `*Count`, …) is printed as `{count}`, which renders raw digits. Use `{count, number}` or `#` so fr renders `1 234 567`.

`check`, `validate-project`, and Phrase reconciliation also check each translation against its source and target locale. Errors fail validation; Phrase reconciliation opens a draft locale PR and puts a concise findings status line in its description. A 🌐 Translation check comment contains the structured error and warning tables; the first export posts a report, and later exports add one when findings, the batch, or the final job change. Jobs stay `COMPLETED`. Invalid exports do not update generated Frontend YAML; the PR description and report warn when retained YAML may reflect an earlier valid export. Failed downloads, comment delivery, and other API errors remain retryable without fabricating catalog content.

In `tms reconcile`, translation-validation findings do not fail the command: GitHub Actions emits warning annotations alongside the PR's 🌐 Translation check comment, and only pipeline failures exit 1.

| Rule                             | Severity                                    | Locales        | Finding                                                                                                     |
| -------------------------------- | ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `missing-exact-plural-selector`  | error                                       | all            | The translation dropped a source `=N` branch.                                                               |
| `plural-count-dropped`           | error in `other`; warning in other branches | all            | A structurally paired `other` branch drops a count shown by the source; use `#` where the number belongs.   |
| `ambiguous-plural-occurrence`    | warning                                     | all            | Repeated plurals at the same structural path cannot be paired safely, so count-drop checks are skipped.     |
| `unused-plural-category`         | warning                                     | all            | The translation has a category its locale never selects, such as `one` in zh, ja, or ko.                    |
| `korean-particle-after-argument` | warning                                     | ko             | A bare 이/가, 은/는, 을/를, 과/와, or (으)로 follows a runtime value. Use `을(를)`-style forms or rephrase. |
| `french-punctuation-space`       | warning                                     | fr (not fr-CA) | A regular space precedes `: ; ! ? »` or follows `«`. Use U+00A0 or U+202F.                                  |

When a target loses an argument because the source used a category branch, the mismatch error names the source branch to fix.

```bash
i18n-pipeline validate \
  --adapter formatjs-json \
  --catalog locales/translation-template.json \
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

i18n-pipeline convert \
  --source docs/source/specs/v2/openapi.yaml \
  --source-adapter openapi-problem-details \
  --target-adapter icu-json \
  --output i18n/en.json \
  --locale en \
  --target-role source
```

The OpenAPI adapter reads OpenAPI 3 JSON or YAML. It extracts component schemas whose required `code` property has a single string `const`/`enum` and an `x-i18n: { message: "..." }` extension. The schema must also require a typed object `params`; every ICU argument must name a required property in that object. Local component `$ref`s and `allOf` composition are supported. The adapter is source-only and intended for contracts generated from a higher-level source such as TypeSpec.

`validate` also reads `I18N_CATALOG_ADAPTER`, `I18N_CATALOG_PATH`, `I18N_CATALOG_ROLE`, `I18N_CATALOG_LOCALE`, and `I18N_CATALOG_CONFIG`, which lets the reusable workflow pass settings without building shell commands from inputs.

## FEO template localization

`i18n-pipeline feo extract --template deploy/frontend.yaml --output deploy/locales/translation-template.json` extracts the Frontend objects in an OpenShift Template. `feo inline` writes only `spec.locales.<locale>` and preserves the rest of the YAML. The default `--kind` is `Frontend`; pass `--kind FrontendEnvironment` for a single FrontendEnvironment custom resource.

FrontendEnvironment extraction combines multiple custom resources into one English catalog. Shared keys with the same English text are included once; conflicting English text reports both file paths. The keys are `bundles.<id>.title`, `bundles.<id>.description`, `serviceCategories.<id>.title`, and `serviceCategories.<id>.groups.<group-id>.title`. Jinja `{{ ... }}` placeholders are preserved. Jinja statements/comments and placeholders inside translatable fields or `spec.locales` are rejected. Inlining validates the whole `spec.locales` block and any existing `spec.enabledLocales` against the operator CRD.

```bash
i18n-pipeline feo extract --kind FrontendEnvironment \
  --template deploy/frontend-environment.yaml \
  --template deploy/frontend-environment-stage-multicluster.yaml \
  --template deploy/frontend-environment-prod-multicluster.yaml \
  --output deploy/locales/frontend-environment-translation-template.json

i18n-pipeline feo inline --kind FrontendEnvironment \
  --template deploy/frontend-environment.yaml \
  --source deploy/locales/frontend-environment-translation-template.json \
  --target deploy/locales/fr.json --locale fr
i18n-pipeline feo inline --kind FrontendEnvironment \
  --template deploy/frontend-environment-stage-multicluster.yaml \
  --source deploy/locales/frontend-environment-translation-template.json \
  --target deploy/locales/fr.json --locale fr
i18n-pipeline feo inline --kind FrontendEnvironment \
  --template deploy/frontend-environment-prod-multicluster.yaml \
  --source deploy/locales/frontend-environment-translation-template.json \
  --target deploy/locales/fr.json --locale fr
```

Add `--check` to extraction or inlining for CI drift detection without writing files. Frontend retains its single-template behavior; only FrontendEnvironment extraction accepts repeated `--template` options.

## Generic project validation

Use `i18n-pipeline validate-project --config <path>` for a repository-wide validation plan. A plan can compare several catalogs, use different adapters for each input/output, derive locale checks from the Phrase TMS config, check generated files against fresh outputs, and reject catalog files nobody declared:

```json
{
  "version": 1,
  "tmsConfig": ".github/i18n/phrase-tms.json",
  "checks": [
    {
      "source": {
        "path": "locales/translation-template.json",
        "adapter": "formatjs-json",
        "locale": "en"
      },
      "targets": [
        { "path": "src/locales/translations.json", "adapter": "formatjs-json", "locale": "en" },
        { "path": "backend/i18n/fr.json", "adapter": "icu-json", "locale": "fr" }
      ]
    }
  ],
  "generated": [
    {
      "path": "locales/translation-template.json",
      "adapter": "formatjs-json",
      "role": "source",
      "locale": "en",
      "command": "npm",
      "args": ["run", "--silent", "translations:extract", "--", "--out-file", "{output}"],
      "updateCommand": "npm run translations:extract"
    },
    {
      "path": "src/locales/data.json",
      "command": "node",
      "args": ["scripts/createDataJson.js", "--output", "{output}"],
      "updateCommand": "npm run translations:datafile"
    }
  ],
  "catalogDirectories": [{ "path": "src/locales" }],
  "feo": [
    {
      "template": "deploy/frontend.yaml",
      "source": "deploy/locales/translation-template.json",
      "locales": { "zh-CN": "deploy/locales/zh-CN.json" }
    }
  ]
}
```

- **`tmsConfig`** adds one check from the Phrase config: its `sourceCatalog` against every `targetLocales[].outputPath`, read with `targetAdapter` (default: the source adapter) and the `repositoryLocale`. The locale mapping has one source of truth. A target whose file does not exist yet, or that holds no messages (such as a `{}` placeholder an app imports before delivery), is reported as pending, not failed, so the plan works before the first translation PR lands. An empty placeholder also prints a warning. Targets listed directly in `checks` are always compared.
- **`generated`** runs its configured executable with an argument array (no shell), substituting `{output}` with a temporary file path, and compares the result with the checked-in file. With an `adapter` (plus `role` and `locale`), both documents are parsed as catalogs. Without one, both are compared as plain JSON, which suits runtime aggregates such as a locale-keyed `data.json`. Prefer calling the consumer's own package script with an output override (FormatJS CLI options take the last value, so `-- --out-file {output}` redirects `translations:extract`) over copying its arguments; copied arguments drift from the script developers actually run. Generators must honor `{output}` without other side effects. The validator never rewrites checked-in files; `updateCommand` is only a failure hint. A stale file is an error unless the entry sets `"severity": "warning"`. Use that for a committed runtime aggregate built from Phrase target files: Phrase locale PRs change its inputs but cannot regenerate it, so a strict check would fail every locale PR. Committed aggregates are not supported beyond this warning; load the locale files directly or build the aggregate outside the catalog directories instead.
- **`feo`** is an array of `{ "template", "source", "locales" }` entries. List every target locale up front in `locales`, mapped from a non-English locale id to its repository-relative locale file. Locale ids are canonical BCP 47 limited to language, script and region (`fr`, `zh-CN`, `zh-Hant-TW`, `es-419`), matching the Frontend operator's CRD rule; `zh-cn`, `fr_FR`, `en` and deprecated aliases such as `iw` are rejected, with the canonical spelling suggested where there is one. `locales` holds at most 32 entries and inlining allows at most 2048 translated keys per locale and Frontend, the operator's limits; English extraction is not capped because translations can be partial. A translation over 4096 characters is omitted from `spec.locales`, so that message falls back to English, and is reported as a warning. A listed locale is checked when its file or a `spec.locales` block in any Frontend object exists; if neither exists yet, the missing file is skipped with a warning. A template block without its locale file remains an error, as does a template locale block that is not listed. The committed source file must be byte-identical to `feo extract` output. A source drift finding names both files and gives the command `i18n-pipeline feo extract --template <template> --output <source>`. Each delivered locale file is checked by running `feo inline` in memory; a template drift finding names the template, source, and locale file and gives the matching `i18n-pipeline feo inline --template <template> --source <source> --target <locale-file> --locale <tag>` command. Template and JSON parse failures, other read errors, stale English, unknown keys, and empty translations are validation findings that include the underlying error and the relevant fix command. These checks are read-only. English FEO text containing `{…}` gets a warning: FEO strings are rendered literally, so the braces reach users as typed, while translators see a locked ICU placeholder. Each entry also reads the Frontend CRD schema from the consumer's installed `@redhat-cloud-services/frontend-components-config-utilities` (as JSON; no consumer code runs) and checks that it accepts `spec.locales`. When the template is localized (it has `spec.locales`, a locale file exists, or a `phrase-tms*.json` next to `tmsConfig`, or in `i18n/` or `.github/i18n/` when there is no `tmsConfig`, names it as `frontendTemplate`), a schema without `spec.locales` is an error naming the installed version; before that it is a warning. If the package is not installed, a localized template gets a warning that the check was skipped, so run validation after installing dependencies from the lockfile.
- **`catalogDirectories`** lists directories whose files (default extension `.json`) must all be declared by a check, a TMS target, a generated entry, or a `feo` source or locale path. It catches a locale file added without a TMS mapping, or a stale file left after a locale was removed.
- **`sourceLint`** opts `validate-ci` into source-code lint. It has optional repository-relative `files` globs (default: `src/**/*.{js,jsx,ts,tsx}`) and an optional repository-relative `catalog` path. `validate-project` accepts this section and ignores it.

The reusable workflow accepts this file through `validation-config`, so consumers do not need a validation script. Non-JavaScript repositories can set `catalog-only: true`; this skips consumer dependency installation and FormatJS source lint, requires `validation-config`, and runs the shared catalog validator only. See the [schema](../../schemas/catalog-validation-config.schema.json), the [FEO consumer example](../../examples/feo-consumer/i18n/catalog-validation.json), the [Phrase consumer example](../../examples/phrase-consumer/.github/i18n/catalog-validation.json), and the [consumer onboarding checklist](../../docs/consumer-onboarding.md).

When English changed in the template but the source catalog was not re-extracted, FEO validation reports the source drift once and, for each locale file, the keys that still carry a translation of the old English; remove those keys so they are translated again. Independent locale failures remain findings. It does not detect stale translations after English is re-extracted or hand edits against Phrase delivery state.

## CI validation command

`i18n-pipeline validate-ci` discovers a consumer's configuration and combines optional source lint with the same catalog checks as `validate-project`:

```bash
i18n-pipeline validate-ci \
  --root /workspace/consumer \
  --mode error \
  --results-dir /tekton/results/i18n \
  --timeout-seconds 600
```

`--root` defaults to the current directory. Relative `--root` paths are resolved from the current directory. Relative `--results-dir` paths are also resolved from the current directory; the directory is created when missing.

Discovery checks `<root>/i18n/catalog-validation.json`, then `<root>/.github/i18n/catalog-validation.json`. The first file found selects configured validation: `sourceLint`, when present, runs before the configured catalog checks. A missing config enables zero-config ICU lint when `react-intl` or an `@formatjs/*` dependency is declared in `package.json`. That mode checks `src/**/*.{js,jsx,ts,tsx}` with only the four ICU error rules. Consumers with neither a config nor a FormatJS dependency are reported as not configured.

Configured `sourceLint` runs those same four ICU rules at error severity, followed by the translatability rules from `scripts/eslint-source.config.mjs` at warning severity: the five FormatJS sentence and selector rules, FormatJS `enforce-description` for a descriptor without a literal `description`, and `i18n/no-duplicate-message-id` for one `id` declared twice in a file with different text or context. If `sourceLint.catalog` is set, `i18n/no-missing-default-catalog-entry` also runs at error severity against that source catalog. The ESLint version, parser, and plugins come from this CLI package; consumer ESLint configuration and inline disable comments do not affect the result. A source glob with no matches is allowed.

When `--results-dir` is set, the command writes `I18N_STATUS`, `I18N_ERRORS`, `I18N_WARNINGS`, `I18N_MODE`, `I18N_CONFIG`, and `I18N_TOOL_VERSION` files without trailing newlines. It writes fallback tool-error values before discovery and replaces them with the completed result. Status is `pass`, `findings`, `not-configured`, or `tool-error`; config is `config`, `zero-config`, or `none`.

The default mode is `warn`, which exits 0 for findings and runtime tool errors. `--mode error` exits 1 for error findings or runtime tool errors, and exits 0 for warning-only findings. Argument parsing failures, an empty `--results-dir`, an invalid `--timeout-seconds`, and missing or invalid `--mode` values are usage errors and exit 2 regardless of mode. `--timeout-seconds` is a positive integer and defaults to 600; the deadline covers the validation worker and terminates its process group, including configured generators and their ordinary child processes. Cleanup terminates the validation process group; a consumer command that deliberately detaches into its own session or process group is not terminated.

## Custom adapters

Install a Node package that default-exports an adapter object, then register its stable ID in the consumer's `package.json`:

```json
{
  "i18nTooling": {
    "catalogAdapters": {
      "my-format": "@acme/i18n-adapter-my-format"
    }
  }
}
```

The adapter implements the structural TypeScript contract declared in `src/index.ts`:

```ts
interface CatalogAdapter {
  readonly id: string;
  parseDocument?(content: string, context: AdapterContext): unknown;
  serializeDocument?(document: unknown, context: AdapterContext): string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}
```

The configured ID must match `adapter.id`. The optional JSON config file supplies adapter-specific `context.options`. Without document codecs, the CLI defaults to JSON; implement `parseDocument` and `serializeDocument` to handle text formats such as YAML or PO.

Bare package specifiers resolve from the consumer root under ESM import conditions. Provide a package `main` field or an `exports` entry with an `import` or `default` condition. Dual-export packages use their ESM entry, not their CommonJS `require` entry.

`tms submit` and `tms reconcile` run with Phrase and GitHub write credentials, so they load only the [built-in adapters](#built-in-adapters) and never import adapter modules declared in `package.json`. A TMS config that names a custom adapter fails before any credential is used.

## npm consumers (after the first release)

Install the CLI as a development dependency (Node.js 22.14+):

```bash
npm install --save-dev @redhat-cloud-services/i18n-pipeline
```

Add a package script, configure `i18n/catalog-validation.json` as described above, and run `npm run translations:validate`:

```json
{
  "scripts": {
    "translations:validate": "i18n-pipeline validate-ci --mode error"
  }
}
```

For editor feedback, see the [ESLint plugin setup](../eslint-plugin-i18n/README.md#npm-consumers-after-the-first-release).
