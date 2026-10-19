# Expected onboarding

## Tracks and findings

- Run the validation baseline for a non-JavaScript backend.
- Validate the two plain key-to-ICU-message JSON catalogs with the `icu-json` adapter.
- Do not configure FormatJS source lint; this fixture has no JavaScript source.

## Required files and config

- `i18n/catalog-validation.json` with `checks` and `catalogDirectories`.
- `checks[0].source` points to `locales/en.json` with `adapter: icu-json` and `locale: en`; its target is `locales/fr.json` with `locale: fr`.
- `Makefile` has an `i18n-validate` target running `i18n-pipeline validate-ci --mode error`.
- `validate-ci --mode error` passes.

## Must not change

- Keep both locale catalogs byte-for-byte unchanged.
- Do not add JavaScript source, FormatJS dependencies, or a Phrase config unless Phrase was selected.
