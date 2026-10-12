# FEO localization

Use this reference when `deploy/frontend.yaml` contains localizable Frontend fields or the developer selects FEO localization.

## Check FEC schema support

Inspect the installed `@redhat-cloud-services/frontend-components-config-utilities` package and follow its validator or package entry point to the installed Frontend CRD JSON Schema. Check for `spec.properties.locales`. Do not compare version numbers as the support test. Record the schema path and whether the property exists.

If `locales` is absent, generated translations will be rejected by that schema. Include upgrading this dependency and removing any local validator patch for it (including a `patches/` entry or `patch-package` step) as a separate dependency unit. Inspect the package manager and lockfile; use the repository's normal upgrade workflow, and verify the installed schema again after the upgrade. The wizard lists this upgrade as its own preselected item. When the developer keeps it selected, perform the upgrade as its own unit (its own commit when commits were chosen). When they deselect it, or the package registry cannot be reached, leave the dependency and lockfile unchanged and report the upgrade as a required follow-up for FEO localization. Do not patch the installed schema or hide its validation failure.

**Release note, verify before relying on it:** the first release expected to contain this schema change is `4.14.0`; the release is not confirmed. Schema inspection, not this expectation, determines support.

## Stable keys and source catalog

Give each translated FEO item a stable ID before extracting. IDs for navigation items and nested routes, bundle IDs, segment IDs, search-entry IDs, service-tile section/group/IDs, and Frontend metadata names must be unique and stable; the CLI rejects missing or duplicate IDs. Never use array indexes.

Run `i18n-pipeline feo extract --template deploy/frontend.yaml --output deploy/locales/translation-template.json` and review the extracted English and generated FormatJS descriptor `description` context. Include the source catalog in the repository change; stage or commit it only if the selected autonomy allows that. The extractor makes context from the field name and stable item key. It includes:

- `bundleSegments.<bundleId>.<segmentId>.navItems.<id>[.routes.<id>...].title` and `.product`;
- `searchEntries.<id>.title`, `.description`, and `.alt_title`;
- `serviceTiles.<section>.<group>.<id>.title` and `.description`;
- `module.defaultDocumentTitle`.

Search `alt_title` values are joined with `|`; no individual English alias may contain `|`. With multiple Frontend objects, keys gain `objects.<metadata.name>.spec.` and the names must be unique. Adding a second Frontend changes catalog IDs, so migrate translations when that happens.

Add a `feo` entry such as:

```json
{
  "feo": [
    {
      "template": "deploy/frontend.yaml",
      "source": "deploy/locales/translation-template.json",
      "locales": {}
    }
  ],
  "catalogDirectories": [{ "path": "deploy/locales" }]
}
```

`locales` maps each delivered non-English locale tag to its repository-relative flat JSON file. Start with an empty map when Phrase translations have not arrived; never create locale files by hand. Phrase reconciliation is authoritative for these locale files and overwrites manual edits on the next reconcile.

## Translation ownership and inlining

English in `deploy/frontend.yaml` is the source of truth; `translation-template.json` is generated from it and is never edited by hand. Phrase is authoritative for translations and overwrites hand edits to `deploy/locales/<locale>.json` on the next reconcile. `i18n-pipeline feo inline --template deploy/frontend.yaml --source deploy/locales/translation-template.json --target deploy/locales/<locale>.json --locale <locale>` generates only `spec.locales.<locale>` from that file. `feo inline --check` verifies output without writing. The `feo` config flags hand-edited or stale embedded output; it never rewrites the template. Re-running inlining from the Phrase locale file replaces manual edits to that locale's `spec.locales` values. The current reusable Phrase workflow does not run FEO inlining, so document and run `feo inline` after each reconciliation; do not expect Phrase reconciliation to update `spec.locales` itself.

If English changes, re-run `feo extract`, resubmit the source through the normal Phrase process, then inline the delivered locale files. Never hand-edit a generated locale JSON file or a `spec.locales` translation.
