# Validation baseline

Use this reference when creating or updating the validation config. Create new configuration under `i18n/` (`i18n/catalog-validation.json`, and `i18n/phrase-tms.json` for the Phrase track). Keep `.github/i18n/` only when the repository already has its configuration there; never keep both locations.

## Choose checks for the catalog format

The config requires `version: 1` and a `checks` array. Each check has a `source` catalog and a `targets` array. Catalog entries use repository-relative `path`, `adapter`, and `locale`; adapter-specific `options` are optional.

- **FormatJS:** use `formatjs-json` for the descriptor source catalog and compiled flat message catalogs. Compare the source catalog to compiled English and any non-Phrase catalogs. If Phrase supplies targets, point `tmsConfig` at `phrase-tms.json`; do not duplicate its locale list.
- **Keyed ICU JSON:** use `icu-json` for both source and target flat `message-id: pattern` files. Do not configure JavaScript `sourceLint` for a repository with no JavaScript messages.
- **OpenAPI Problem Details:** use the source-only `openapi-problem-details` adapter on the OpenAPI 3 YAML or JSON file. It requires component schemas whose `code` has one string `const` or `enum` and an `x-i18n.message`; the schema must require a typed `params` object, and every ICU argument must be a required property of it. Local component `$ref` and `allOf` composition are supported. With no checked-in derived catalog, use `targets: []`. If a derived ICU catalog is committed, compare it as an `icu-json` target to check IDs and ICU arguments. To also require exact generated-output parity, add a `generated` entry that runs `convert`; use a repository-owned generator script if the selected CLI is available only through `I18N_PIPELINE_CLI`, so the config does not assume a global executable.

## Declare generators and directories

`generated` entries compare each checked-in file to output from a command and argument array. The command runs without a shell; include `{output}` in `args` so it writes to the validator's temporary path. With an `adapter`, also set `locale` and `role` (`source` or `target`). Without an adapter, the files are compared as plain JSON, which fits a locale-keyed runtime aggregate. `updateCommand` is only a failure hint.

Use the repository's own extract, compile, and aggregate scripts. Confirm that each honors the output argument without touching tracked files. FormatJS CLI options accept a second `--out-file`; use the package script with `-- --out-file {output}`. Do not copy generator arguments when the package script can be reused.

Add `catalogDirectories` for every directory holding catalogs. The default extension is `.json`. Every catalog file in those directories must be declared by `checks`, `tmsConfig`, `generated`, or FEO config. This catches undeclared locale files.

## Scope source lint

`sourceLint` is optional and is ignored by `validate-project`; `validate-ci` uses it to opt into source lint. `files` accepts repository-relative globs and defaults to `src/**/*.{js,jsx,ts,tsx}`. Scope it to files that declare messages if the default glob catches imports or unrelated inline messages. Set `catalog` only when a committed explicit-ID source catalog should be enforced. Omitting `catalog` keeps ICU and translatability checks while disabling the missing-ID rule.

Without a config, a declared `react-intl` or `@formatjs/*` dependency enables zero-config ICU lint over `src/**/*.{js,jsx,ts,tsx}`. It checks the four ICU error rules but does not enforce message IDs. With configured `sourceLint`, the same four ICU rules run at error severity and translatability rules run as warnings. A configured `sourceLint.catalog` also checks message IDs against that catalog.

## Run it on pull requests

The i18n-hub and standalone Phrase callers only submit and reconcile; neither checks pull requests. A repository sees validation errors on its PRs, including the locale PRs Phrase opens, only through its own caller. Add `.github/workflows/locale-validation.yml` from `assets/workflows/` next to this `references/` folder. It calls `RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml` on changes to the validation config, the source and locale catalogs, message source files, package scripts, and generators. Adapt its `validation-config` and catalog inputs to the repository, and make its `paths` cover every file the validation config reads: the config itself, each catalog and generated file, each `catalogDirectories` entry as `<dir>/**`, every `sourceLint` file, every `feo` template, and the scripts and lockfile behind each generator.

Every consumer caller uses top-level `permissions: {}` and grants each job only the permissions it needs. Pin the reusable workflow to a commit on i18n-tooling's `main`. If none can be resolved, keep the `<reviewed-commit-sha>` marker and list replacing it as a follow-up; a caller with the marker is not ready to run.

## Prove the plan and use the documented traps

Run `i18n-pipeline validate-ci --mode error` with the consumer root as the working root or with `--root <consumer-dir>`. Error mode exits 1 for error findings or tool errors and 0 for warning-only findings. `warn` mode exits 0 even when findings exist.

Temporarily introduce one failure for each configured catalog comparison, generated entry, FEO entry, and declared catalog directory. Also exercise `sourceLint` when it is configured. Examples from consumer onboarding are deleting a message from a target, changing a generated aggregate, and adding an undeclared `xx.json`. For FEO, make one English or locale value drift. For source lint, use a missing `other` plural branch. Save each original file's exact content and restore it immediately; do not leave test breaks in the working tree.

Check the consumer's normal build hooks and test imports as well as the CLI result. A prebuild that regenerates an aggregate can hide stale checked-in data, and tests may import that checked-in aggregate directly. A wildcard script runner such as `npm-run-all translations:*` picks up `translations:validate`; replace the wildcard with its current scripts as [SKILL.md](../SKILL.md#resolve-and-check-the-cli-first) describes, and do not rely on `prestart` to run before a differently named start script.
