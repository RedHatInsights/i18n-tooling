# Expected onboarding

## Tracks and findings

- Run the validation baseline for an API contract repository.
- Validate the checked-in ICU JSON catalog against fresh `openapi-problem-details` conversion output.
- Use a small repository-owned generator script to pass `I18N_PIPELINE_CLI` through when the CLI is available only as a built `cli.js` during phase 1.
- Do not configure FormatJS source lint; this fixture has no JavaScript source.

## Required files and config

- `i18n/catalog-validation.json` with `checks`, `generated`, and `catalogDirectories`.
- `checks[0].source` points to `locales/i18n-en.json` with `adapter: icu-json` and `locale: en`.
- A generated entry refreshes `locales/i18n-en.json` from `api/problem-details.yaml` with `openapi-problem-details` and `icu-json` adapters.
- `scripts/convert-openapi-catalog.mjs` forwards to the configured local CLI path or the `i18n-pipeline` executable on `PATH`.
- `Makefile` has an `i18n-validate` target running `i18n-pipeline validate-ci --mode error`.
- `validate-ci --mode error` passes.

## Must not change

- Keep `api/problem-details.yaml` and `locales/i18n-en.json` byte-for-byte unchanged.
- Do not add JavaScript source or change the message meaning.
