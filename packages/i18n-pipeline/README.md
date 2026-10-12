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

`validate --role source` and `validate-project` also warn about source plural semantics that per-locale ICU validation cannot see. Warnings do not fail validation; under GitHub Actions they become annotations.

- **`plural-category-only-arguments`** — an argument appears only under a CLDR category (`zero`, `one`, `two`, `few`, `many`) and never under `other`. Categories are locale grammar, not numbers: zh selects only `other`, so translation tools drop the `one` branch and its argument, and ru `one` also matches 21. Use an exact `=1` branch for content that depends on the count: `{count, plural, =1 {{name} will be removed.} other {# accounts will be removed.}}`.
- **`unused-plural-category`** — a branch uses a category the source locale never selects, such as `zero` in English. Use `=0`.
- **`unformatted-count-argument`** — a plural selector or count-like argument (`count`, `total`, `*Count`, …) is printed as `{count}`, which renders raw digits. Use `{count, number}` or `#` so fr renders `1 234 567`.

`check`, `validate-project`, and Phrase reconciliation also check each translation against its source and target locale. Errors fail the locale; Phrase reconciliation lists warnings in the locale PR description.

| Rule                             | Severity | Locales        | Finding                                                                                                                              |
| -------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `missing-exact-plural-selector`  | error    | all            | The translation dropped a source `=N` branch.                                                                                        |
| `plural-count-dropped`           | warning  | all            | The source `other` branch shows the count; the translation's does not. FormatJS treats `#` inside a nested `select` as literal text. |
| `unused-plural-category`         | warning  | all            | The translation has a category its locale never selects, such as `one` in zh, ja, or ko.                                             |
| `korean-particle-after-argument` | warning  | ko             | A bare 이/가, 은/는, 을/를, 과/와, or (으)로 follows a runtime value. Use `을(를)`-style forms or rephrase.                          |
| `french-punctuation-space`       | warning  | fr (not fr-CA) | A regular space precedes `: ; ! ? »` or follows `«`. Use U+00A0 or U+202F.                                                           |

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

- **`tmsConfig`** adds one check from the Phrase config: its `sourceCatalog` against every `targetLocales[].outputPath`, read with `targetAdapter` (default: the source adapter) and the `repositoryLocale`. The locale mapping has one source of truth. A target whose file does not exist yet is reported as pending, not failed, so the plan works before the first translation PR lands.
- **`generated`** runs its configured executable with an argument array (no shell), substituting `{output}` with a temporary file path, and compares the result with the checked-in file. With an `adapter` (plus `role` and `locale`), both documents are parsed as catalogs. Without one, both are compared as plain JSON, which suits runtime aggregates such as a locale-keyed `data.json`. Prefer calling the consumer's own package script with an output override (FormatJS CLI options take the last value, so `-- --out-file {output}` redirects `translations:extract`) over copying its arguments; copied arguments drift from the script developers actually run. Generators must honor `{output}` without other side effects. The validator never rewrites checked-in files; `updateCommand` is only a failure hint.
- **`feo`** is an array of `{ "template", "source", "locales" }` entries. Each `locales` object maps a non-English locale tag to its repository-relative locale file and may be empty; a locale with a `spec.locales` block in the template that is not listed is a finding. The committed source file must be byte-identical to `feo extract` output. A source drift finding names both files and gives the command `i18n-pipeline feo extract --template <template> --output <source>`. Each locale file is checked by running `feo inline` in memory; a template drift finding names the template, source, and locale file and gives the matching `i18n-pipeline feo inline --template <template> --source <source> --target <locale-file> --locale <tag>` command. Template and JSON parse failures, missing files, stale English, unknown keys, and empty translations are validation findings that include the underlying error and the relevant fix command. These checks are read-only.
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

Configured `sourceLint` runs those same four ICU rules at error severity, followed by the five translatability rules from `scripts/eslint-source.config.mjs` at warning severity. If `sourceLint.catalog` is set, `i18n/no-missing-default-catalog-entry` also runs at error severity against that source catalog. The ESLint version, parser, and plugins come from this CLI package; consumer ESLint configuration and inline disable comments do not affect the result. A source glob with no matches is allowed.

When `--results-dir` is set, the command writes `I18N_STATUS`, `I18N_ERRORS`, `I18N_WARNINGS`, `I18N_MODE`, `I18N_CONFIG`, and `I18N_TOOL_VERSION` files without trailing newlines. It writes fallback tool-error values before discovery and replaces them with the completed result. Status is `pass`, `findings`, `not-configured`, or `tool-error`; config is `config`, `zero-config`, or `none`.

The default mode is `warn`, which exits 0 for findings and tool errors. `--mode error` exits 1 for error findings or tool errors, and exits 0 for warning-only findings. Missing or invalid `--mode` values are usage errors and exit 2. `--timeout-seconds` is a positive integer and defaults to 600; the deadline covers the validation worker and terminates its process group, including configured generators and their ordinary child processes. Cleanup terminates the validation process group; a consumer command that deliberately detaches into its own session or process group is not terminated.

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

For editor feedback, install `@redhat-cloud-services/eslint-plugin-i18n` and its required `eslint-plugin-formatjs@8.1.0` peer as development dependencies, and spread `i18n.configs.source` into your ESLint flat config. Set the catalog rule's `catalog` option to your source catalog and supply your own TypeScript/JSX parser. See the [complete editor config](../eslint-plugin-i18n/README.md#npm-consumers-after-the-first-release). Editor lint uses consumer configuration; `validate-ci` keeps its own pinned lint runtime.
