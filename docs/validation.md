# Catalog validation

The reusable `.github/workflows/i18n-validate.yml` workflow validates a consumer's catalogs and source in CI. Consumers need no npm dependency on this repository; npm installation will be available after the first release.

## Callers

Pin the workflow to a reviewed commit SHA. The workflow checks out the consumer and `i18n-tooling` at the called workflow's exact commit (`job.workflow_sha`), so pinning it also pins the CLI and ESLint rule source.

JavaScript consumer with a validation config (for example `rbac-ui`):

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      package-manager: npm
      validation-config: .github/i18n/catalog-validation.json
```

Non-JavaScript service, such as a Python service validating catalogs generated from its OpenAPI contract:

```yaml
jobs:
  i18n-catalog:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      catalog-only: true
      validation-config: .github/i18n/catalog-validation.json
```

Its config should generate the English ICU catalog from the checked-in contract, then validate it and any delivered target locales.

Single catalog without a config, for example a service-owned keyed ICU JSON catalog:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@<reviewed-commit-sha>
    with:
      validation-command: i18n:validate
      catalog-adapter: icu-json
      catalog-path: i18n/en.json
      catalog-role: source
      catalog-locale: en
```

## What the workflow runs

The workflow installs consumer dependencies with `package-manager` (npm by default; Bun and pnpm are supported) and the tooling workspace with npm, then builds the CLI and ESLint plugin. Node.js comes from the tooling `.nvmrc` unless `node-version` overrides it.

- **With `validation-config`:** it runs `i18n-pipeline validate-ci --mode error --config <path>`. That covers the config's catalog checks, generated-file sync and FEO checks, plus `sourceLint` when the config has one. Findings appear as pull request annotations. The `catalog-*`, `source-glob` and `validation-command` inputs are not used.
- **Without `validation-config`:** it checks consumer source message IDs against `catalog-path`, then runs the `validation-command` package script (default `i18n:validate`) through the consumer package manager's `run`. `source-glob` defaults to `src/**/*.{js,jsx,ts,tsx}`; include files that declare reusable messages. A simple `validation-command` can call `i18n-pipeline validate` or `check`, which read `I18N_CATALOG_ADAPTER`, `I18N_CATALOG_PATH`, `I18N_CATALOG_ROLE`, `I18N_CATALOG_LOCALE` and `I18N_CATALOG_CONFIG`.
- **`catalog-only: true`:** skips consumer dependency installation. It requires `validation-config`, whose catalog checks, generated-file sync and `sourceLint` still apply.

## Source lint

The source-lint rule recognizes FormatJS `formatMessage`, `defineMessage(s)` and `<FormattedMessage>`.

- **Errors:** a message ID missing from the catalog (`sourceLint.catalog`, or `catalog-path` without a config), a missing or dynamic inline ID, an opaque descriptor expression, invalid ICU, a plural without `other`, a hard-coded `1` in a `one` branch, and plural offsets.
- **Warnings:** inline tags, sentence fragments, `{count}` instead of `#`, multiple plurals, and selectors with more than 20 combinations.

Declare reusable descriptors with `defineMessages` so their IDs are checked where they are defined.

## Validation config

The config names source and target files with their adapters. It can derive locale checks from the Phrase config, run native generators into temporary files to prove that checked-in catalogs are current, check FEO templates, and reject undeclared catalog files. The validator never rewrites checked-in files.

- [Config reference](../packages/i18n-pipeline/README.md#generic-project-validation) (`tmsConfig`, `generated`, `feo`, `catalogDirectories`, `sourceLint`)
- [`validate-ci` discovery, modes and Tekton results](../packages/i18n-pipeline/README.md#ci-validation-command)
- [Config schema](../schemas/catalog-validation-config.schema.json)
- Examples: [FEO consumer](../examples/feo-consumer/i18n/catalog-validation.json), [Phrase consumer](../examples/phrase-consumer/.github/i18n/catalog-validation.json)

## CLI

`check` compares source and target message IDs and named ICU arguments, including arguments nested in plural and select branches. See the [CLI reference](../packages/i18n-pipeline/README.md#cli) for all commands.

```bash
i18n-pipeline validate --adapter icu-json --catalog i18n/en.json --role source --locale en

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

# Multi-catalog plan with generated-file sync checks
i18n-pipeline validate-project --config .github/i18n/catalog-validation.json
```

## Custom catalog adapters

Install a package that default-exports a `CatalogAdapter`, then map its stable ID under `i18nTooling.catalogAdapters` in the consumer's `package.json`. Workflow inputs select only the ID, never a package name or shell code. The `tms` commands load only built-in adapters. See [custom adapters](../packages/i18n-pipeline/README.md#custom-adapters) and the [adapter model](architecture.md#catalog-adapters).
