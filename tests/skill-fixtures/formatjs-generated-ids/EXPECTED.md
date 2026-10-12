# Expected onboarding

## Tracks and findings

- Run the validation baseline.
- Ask the generated-ID special question. The selected fixture path is to keep generated IDs and validate without the missing-ID rule.
- Generate a source catalog with the existing extraction script and include it as a tracked deliverable, then generate compiled English. The IDs must remain generated from each `defaultMessage`.
- Draft translator descriptions from the surrounding component and add them without adding explicit `id` attributes.

## Required files and config

- `locales/translation-template.json` and `src/locales/en.json` generated from the existing scripts.
- `i18n/catalog-validation.json` with `checks`, `generated`, `catalogDirectories`, and `sourceLint`.
- `sourceLint.files` includes `src/App.jsx`; `sourceLint.catalog` is absent so no missing-ID rule is enabled.
- `package.json` has `translations:validate` running `i18n-pipeline validate-ci --mode error`.
- `validate-ci --mode error` passes.

## Must not change

- Keep the two English `defaultMessage` values in `src/App.jsx` unchanged.
- Do not add explicit message IDs when the developer chose to keep generated IDs.
- Do not create a target locale JSON file or Phrase config unless Phrase was selected.
