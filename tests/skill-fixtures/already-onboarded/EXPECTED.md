# Expected onboarding

## Tracks and findings

- Detect the existing validation baseline and report its status.
- Offer only missing tracks and actual upgrades. Do not rewrite the existing validation config or add a duplicate validation script.

## Required files and config

- The checked-in `i18n/catalog-validation.json` remains valid and has `checks`, `catalogDirectories`, and `sourceLint`.
- `node scripts/check-skill-fixture.mjs already-onboarded tests/skill-fixtures/already-onboarded` passes.
- `validate-ci --mode error` passes.

## Must not change

- Keep `i18n/catalog-validation.json`, `package.json`, both catalogs, and `src/messages.js` byte-for-byte unchanged when no additional track is selected.
- Do not add a Phrase locale, secrets, or a new workflow.
