# FEO Frontend localization

`i18n-pipeline feo` turns the `Frontend` objects in an OpenShift Template into a FormatJS-style source catalog and writes translations back into `spec.locales`. These commands need no Phrase access, credentials or GitHub workflows. The Frontend CRD, operator, publisher and Chrome overlay are separate work. For `FrontendEnvironment` resources, see the [package guide](../packages/i18n-pipeline/README.md#feo-template-localization).

```bash
# English source catalog from the template
i18n-pipeline feo extract --template deploy/frontend.yaml \
  --output deploy/locales/translation-template.json

# Write one locale into objects[].spec.locales.zh-CN
i18n-pipeline feo inline --template deploy/frontend.yaml \
  --source deploy/locales/translation-template.json \
  --target deploy/locales/zh-CN.json --locale zh-CN
```

Add `--check` to either command to detect drift in CI without writing.

## Catalog keys

Keys mirror YAML fields and use item IDs, not array indexes:

| Area | Key |
| --- | --- |
| Search | `searchEntries.<id>.*` |
| Bundle navigation | `bundleSegments.<bundleId>.<segmentId>.navItems.<id>[.routes.<id>\|.navItems.<id>...].*` |
| Navigation segments | `navigationSegments.<segmentId>.navItems.<id>[.routes.<id>\|.navItems.<id>...].*` |
| Service tiles | `serviceTiles.<section>.<group>.<id>.*` |
| Widgets | `widgetRegistry.<scope>.<moduleSlug>.<importNameSlug>.title` and `.headerLink.title` |
| Base widget layouts | `baseWidgetLayouts.<name>.displayName` |
| Module | `module.defaultDocumentTitle` |

- **Widgets** have no ID, so their key slugs `module` and `importName` (default `default`) with the alias slug rule below; `./OpenShiftWidget` becomes `openshiftwidget`.
- **Navigation segments** are keyed by the Frontend that defines them, so one translation serves every `segmentRef` to the segment. Nav items or routes with `segmentRef` produce no keys.
- **Key components** (`id`, `section`, `group`, `bundleId`, `segmentId`, widget `scope`, layout `name`) may contain dot-separated segments. Each segment must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
- **Key length** in `spec.locales` is limited to 256 characters, excluding the multi-Frontend prefix.
- **Multiple Frontend objects** prefix catalog keys with `objects.<metadata.name>.spec.`; names must be present and unique. Single-Frontend keys stay unprefixed. Inlining strips the prefix, so each `spec.locales` keeps local keys. Adding a second Frontend therefore changes existing catalog IDs: re-extract and migrate translations to the new IDs.
- **Errors:** missing IDs fail extraction. Items with colliding catalog or runtime keys are rejected, even when the colliding fields are empty.
- Keys are written in code-unit order, so output does not depend on the machine's locale. English and non-text fields stay hand-edited. `packages/i18n-pipeline/tests/feo-schema-coverage.test.ts` classifies every string field of the FEC Frontend schema as translated or not translatable.

## Search aliases

Each search `alt_title` alias uses `searchEntries.<id>.alt_title.<slug>`. The slug lowercases the English alias, replaces each run of characters outside `[a-z0-9]` with `-`, and trims `-` from both ends; an empty slug fails extraction.

Aliases with the same slug share one key and translation. The first alias in document order supplies the default message, and the description lists the others. A pipe has no special meaning. Consumers rebuilding the alias list in English order use the shared translation for every alias with that slug; without a translation, each alias keeps its English text. No separator joins messages; any future translatable list should also use one message per item.

To migrate legacy aliases: re-extract the source, remove unsuffixed `alt_title` keys from locale files, translate each distinct alias-slug key, then re-inline each locale.

## Inlining rules

`feo inline` writes only `objects[].spec.locales.<locale>` and preserves other fields and comments. It rejects stale English source and unknown or empty translations. Missing translations are omitted, so the message falls back to English downstream.

- **Locale IDs** must be canonical BCP 47 limited to language, script and region (`fr`, `ja`, `zh-CN`, `zh-Hant-TW`, `es-419`), other than `en`, matching the Frontend operator. `zh-cn` is rejected with a `use "zh-CN"` hint, and deprecated aliases such as `iw` with `use "he"`. The operator accepts those aliases, but locale resolution never looks them up. Inlining under a canonical ID consolidates differently spelled blocks, such as `zh-cn`, into the canonical one.
- **Limits** (the operator's): at most 32 locales per Frontend (configs with more are rejected, and inlining refuses to add a 33rd block) and 2048 keys per locale. English source catalogs may hold more messages because translations can be partial.
- **Long translations:** a translation over 4096 Unicode code points is omitted like a missing one, so only that message falls back to English. `feo inline`, `validate-project` and Phrase locale PRs report it as a warning.

## Validation

A `feo` entry in the [validation config](validation.md#validation-config) checks that the committed source catalog matches `feo extract` byte for byte and that each delivered locale matches `feo inline`. List every target locale up front in `locales`. A listed locale is skipped with a warning until its file or a `spec.locales` block exists. A template block without its locale file is an error, as is a block for an unlisted locale. Drift findings print the exact `feo extract` or `feo inline` command to run. See the [`feo` config reference](../packages/i18n-pipeline/README.md#generic-project-validation).

## Phrase handoff

Phrase locale PRs can update the Frontend template too; the i18n-hub test-consumer pilot verified this on 2026-10-16. Enable it in the [Phrase config](phrase-tms.md#consumer-config):

```json
"frontendTemplate": { "path": "deploy/frontend.yaml", "generateSourceCatalog": true }
```

- Each `repositoryLocale` must be a canonical FEO locale ID such as `zh-CN`; `phraseLocale` keeps Phrase's code, such as `zh_cn`. A config written with `zh-cn` fails to load until renamed. Batches already in flight keep their branches and PRs, and their YAML is inlined under the canonical ID.
- Submit generates the source JSON from the pinned YAML. Reconcile generates it from the pinned YAML, and from the current YAML to choose the locale PR base: when current English differs, new locale branches start from the submitted commit. The source file need not be committed: `sourceCatalog.path` gives its logical location, and `sourceCatalog.filename` (for example `<repository-name>.feo.en.json`) names the Phrase upload.
- The pinned catalog digest must match at each step. A later change to English on the base branch does not discard completed translations; the next submit waits for the batch's final Phrase jobs, then submits the latest source.
- Reconcile opens one draft PR per locale with its JSON and validation findings. The `spec.locales.<repositoryLocale>` change is added only after the locale passes validation against the pinned source. Re-export starts from the YAML at the locale branch head, so unrelated branch changes stay intact, while stale-English checks use the locale PR base.
- This handoff sits on top of the Phrase-independent `feo` CLI; it adds no automatic Phrase submission.
