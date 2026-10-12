# Expected onboarding

## Tracks and findings

- Run the validation baseline and Phrase submit/reconcile tracks.
- Mechanically add the missing `other` branch to `results.count` in `src/messages.js` as its own unit.
- Leave `service.pause.billing` wording unchanged. Report the wording question with its source line; the comment in `src/Services.jsx` says billing policy varies by service.
- Draft `description` fields for the four descriptors that lack them. Keep those drafts in a separate unit and mark them for human review before Phrase.
- Use explicit IDs and the committed source catalog. Phrase target locales and project details come from the wizard answers; the fixture does not contain them. With the answer "`fr` only, project unknown", map Phrase `fr` to repository `fr` and leave marked placeholders for the project UID and region.

## Required files and config

- `i18n/catalog-validation.json` with `checks`, `generated`, `catalogDirectories`, and `sourceLint` (`tmsConfig` is added once the Phrase project details are known).
- `i18n/phrase-tms.json` with the target locales from the wizard (for `fr`: output `src/locales/fr.json`). While the Phrase project is unknown it is a draft and the validation config does not reference it through `tmsConfig`; the checker only requires that the file exists.
- `.github/workflows/phrase-submit.yml`, `.github/workflows/phrase-reconcile.yml`, and `.github/workflows/locale-validation.yml`.
- `package.json` with `translations:validate` running `i18n-pipeline validate-ci --mode error`.
- The generated source catalog and compiled English catalog stay current with the extract and compile scripts.
- `validate-ci --mode error` passes. The Phrase locale file does not exist until Phrase delivers it.

## Must not change

- Keep `src/Services.jsx` byte-for-byte unchanged and do not change the `service.pause.billing` wording in `src/messages.js`.
- Do not create `src/locales/fr.json`, add Phrase secrets, or run Phrase workflows.
- Do not replace the workflow SHA placeholder with an unreviewed commit. List the reviewed SHA as a PR follow-up until it is available.
