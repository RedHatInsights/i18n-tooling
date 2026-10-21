# FEO localization

Use this reference when `deploy/frontend.yaml` contains localizable Frontend fields or the developer selects FEO localization.

## Check FEC schema support

Inspect the installed `@redhat-cloud-services/frontend-components-config-utilities` package and follow its validator or package entry point to the installed Frontend CRD JSON Schema. Check for `spec.properties.locales`. Do not compare version numbers as the support test. Record the schema path and whether the property exists.

If `locales` is absent, generated translations will be rejected by that schema. Include upgrading this dependency and removing any local validator patch for it (including a `patches/` entry or `patch-package` step) as a separate dependency unit. Inspect the package manager and lockfile; use the repository's normal upgrade workflow, and verify the installed schema again after the upgrade. The plan lists this upgrade as its own track, included by default. When the approved plan keeps it, perform the upgrade as its own unit (its own commit when commits were chosen). When the developer drops it, or the package registry cannot be reached, leave the dependency and lockfile unchanged and report the upgrade as a required follow-up for FEO localization. Do not patch the installed schema or hide its validation failure.

**Release note:** `frontend-components-config-utilities` `4.14.0` (2026-10-15) is the first release whose schema accepts `spec.locales`. It usually arrives through `@redhat-cloud-services/frontend-components-config`, whose `^4.12.5` range already allows it, so updating only the utilities package in the lockfile is enough. Schema inspection, not this note, determines support.

## Stable keys and source catalog

Give each translated FEO item a stable ID before extracting. IDs for navigation items and nested routes, bundle IDs, segment IDs, search-entry IDs, service-tile section/group/IDs, and Frontend metadata names must be unique and stable; the CLI rejects missing or duplicate IDs. Never use array indexes. An ID may contain dots: each dot-separated segment must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, so empty segments and a leading `_` or `-` are rejected. Every key written to `spec.locales` is limited to 256 characters. Items whose keys would collide, even through fields that are empty, are rejected with both items named.

Run `i18n-pipeline feo extract --template deploy/frontend.yaml --output deploy/locales/translation-template.json` and review the extracted English and generated FormatJS descriptor `description` context. Include the source catalog in the repository change; stage or commit it only if the selected autonomy allows that. The extractor makes context from the field name and stable item key. It includes:

- `bundleSegments.<bundleId>.<segmentId>.navItems.<id>[.routes.<id>...].title` and `.product`;
- `searchEntries.<id>.title`, `.description`, and `.alt_title.<slug>`;
- `serviceTiles.<section>.<group>.<id>.title` and `.description`;
- `module.defaultDocumentTitle`.

Each search `alt_title` alias is its own message. Its slug is the English alias lowercased, with each run of characters outside `[a-z0-9]` replaced by `-` and the ends trimmed; an empty slug fails extraction. Aliases with the same slug, such as `acs` and `ACS`, share one key and one translation; the first alias in document order is the English default. The app rebuilds the alias list in English order, using the translation of each alias's slug when present. With multiple Frontend objects, keys gain `objects.<metadata.name>.spec.` and the names must be unique. Adding a second Frontend changes catalog IDs, so migrate translations when that happens.

Add a `feo` entry such as:

```json
{
  "feo": [
    {
      "template": "deploy/frontend.yaml",
      "source": "deploy/locales/translation-template.json",
      "locales": {
        "fr": "deploy/locales/fr.json",
        "ja": "deploy/locales/ja.json",
        "ko": "deploy/locales/ko.json",
        "zh-CN": "deploy/locales/zh-CN.json"
      }
    }
  ],
  "catalogDirectories": [{ "path": "deploy/locales" }]
}
```

Locale ids are canonical BCP 47 with only language, script and region, other than `en`: `fr`, `zh-CN`, `zh-Hant-TW`, `es-419`. Never `zh-cn`, `zh_CN`, `pt_BR` or a deprecated alias such as `iw`; normalize a developer-supplied tag to its canonical form (`zh-CN`, `pt-BR`, `he`) before writing it, and keep Phrase's own code (`zh_cn`) only in `phraseLocale`. The Frontend operator allows at most 32 locales per Frontend and 2048 translated keys per locale. English source catalogs may contain more messages; inlining checks the per-locale limit after selecting that Frontend's translations. Translations over 4096 characters are dropped to English with a warning.

`locales` lists every target locale from the approved plan up front, each mapped to its repository-relative flat JSON file. Until a locale's file or a `spec.locales` block for it exists, validation skips it with a warning, so the config is complete on first write. Leave the locale files to Phrase; never create them by hand. Phrase reconciliation is authoritative for these locale files and overwrites manual edits on the next reconcile.

## Translation ownership and inlining

English in `deploy/frontend.yaml` is the source of truth; `translation-template.json` is generated from it and is never edited by hand. Phrase is authoritative for translations and overwrites hand edits to `deploy/locales/<locale>.json` on the next reconcile. `i18n-pipeline feo inline --template deploy/frontend.yaml --source deploy/locales/translation-template.json --target deploy/locales/<locale>.json --locale <locale>` generates only `spec.locales.<locale>` from that file. `feo inline --check` verifies output without writing. The `feo` config flags hand-edited or stale embedded output; it never rewrites the template. Re-running inlining from the Phrase locale file replaces manual edits to that locale's `spec.locales` values. With the Phrase track, reconciliation writes both the locale file and `spec.locales.<locale>` in one locale PR (see below). Without it, run `feo inline` after each delivery.

If English changes, re-run `feo extract`, resubmit the source through the normal Phrase process, then inline the delivered locale files. Never hand-edit a generated locale JSON file or a `spec.locales` translation.

## Phrase for FEO

When the Phrase track is also selected, the FEO catalog gets its own Phrase config, `i18n/phrase-tms-feo.json`, next to the app's. It follows [phrase.md](phrase.md#config-both-modes), with these differences:

- `state.branch` is `i18n-tms-state-feo`. Every config in a repository needs its own state branch.
- `sourceCatalog.path` is `deploy/locales/translation-template.json`, and `sourceCatalog.filename` is `<repository-name>.feo.en.json`.
- `"frontendTemplate": { "path": "deploy/frontend.yaml", "generateSourceCatalog": true }` makes submission extract the source from the YAML and makes reconciliation add `spec.locales.<locale>` to the same PR as the locale file.
- Use `locales` for a subset of the preset's repository locales and set `targetOutputPath` to `deploy/locales/{locale}.json`. Write a full `targetLocales` array only when FEO needs a different Phrase-to-repository mapping.

Validation keeps `tmsConfig` on the app's config; the `feo` entry already checks the FEO locales. In hub mode, register this config as its own `consumers.json` entry (see [phrase-hub.md](phrase-hub.md#registry-entry)). In standalone mode, add a second pair of callers with this config path. Until the installed FEC schema accepts `spec.locales`, keep this config out of the change and list it as blocked by the FEC upgrade, because its locale PRs would fail that schema.
