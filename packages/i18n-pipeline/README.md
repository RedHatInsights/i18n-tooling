# `@redhat-cloud-services/i18n-pipeline`

Node.js 22+ workspace package for repository-owned locale catalogs. It provides a normalized `Catalog` model, built-in FormatJS and keyed ICU JSON adapters, adapter-owned text codecs, ICU pattern validation, generated-catalog sync, and the `frontend-i18n` CLI.

The reusable workflow builds the CLI from this source; consumers do not need an npm dependency on this repository. This repository does not publish workspace packages to npm. Framework extraction and compilation stay with each consumer's native tooling. Catalog-format adapters normalize repository artifacts; TMS-provider adapters are a separate future seam.

## Built-in adapters

| ID              | Source catalog                                                                      | Target catalog                            |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `formatjs-json` | FormatJS descriptors: `{ "id": { "defaultMessage": "...", "description": "..." } }` | Flat compiled messages: `{ "id": "..." }` |
| `icu-json`      | Flat message-code-to-ICU-pattern JSON                                               | Flat message-code-to-ICU-pattern JSON     |

The FormatJS adapter retains string/object descriptions and other descriptor metadata. Both built-ins validate ICU syntax with FormatJS's `@formatjs/icu-messageformat-parser`; consumers should also run native framework compilation and validation. ICU failure reports list each malformed message ID, its line and column within the pattern, and a readable parser diagnostic.

## CLI

`check` compares source and target message IDs and named ICU arguments, including arguments nested in plural/select branches. Use `--source-adapter` and `--target-adapter` when the catalogs use different formats.

```bash
frontend-i18n validate \
  --adapter formatjs-json \
  --catalog locales/translation-template.json \
  --role source \
  --locale en

frontend-i18n check \
  --source locales/translation-template.json \
  --target locales/fr.json \
  --target-locale fr

frontend-i18n convert \
  --source locales/translation-template.json \
  --source-adapter formatjs-json \
  --target-adapter icu-json \
  --output i18n/en.json \
  --locale en
```

`validate` also reads `I18N_CATALOG_ADAPTER`, `I18N_CATALOG_PATH`, `I18N_CATALOG_ROLE`, `I18N_CATALOG_LOCALE`, and `I18N_CATALOG_CONFIG`, which lets the reusable workflow pass settings without building shell commands from inputs.

## Generic project validation

Use `frontend-i18n validate-project --config <path>` for a repository-wide validation plan. A plan can compare several catalogs, use different adapters for each input/output, derive locale checks from the Phrase TMS config, check generated files against fresh outputs, and reject catalog files nobody declared:

```json
{
  "version": 1,
  "tmsConfig": ".github/i18n/phrase-tms.json",
  "checks": [
    {
      "source": {
        "path": "locales/translation-template.json",
        "adapter": "formatjs-json",
        "locale": "en"
      },
      "targets": [
        { "path": "src/locales/translations.json", "adapter": "formatjs-json", "locale": "en" },
        { "path": "backend/i18n/fr.json", "adapter": "icu-json", "locale": "fr" }
      ]
    }
  ],
  "generated": [
    {
      "path": "locales/translation-template.json",
      "adapter": "formatjs-json",
      "role": "source",
      "locale": "en",
      "command": "npm",
      "args": ["run", "--silent", "translations:extract", "--", "--out-file", "{output}"],
      "updateCommand": "npm run translations:extract"
    },
    {
      "path": "src/locales/data.json",
      "command": "node",
      "args": ["scripts/createDataJson.js", "--output", "{output}"],
      "updateCommand": "npm run translations:datafile"
    }
  ],
  "catalogDirectories": [{ "path": "src/locales" }]
}
```

- **`tmsConfig`** adds one check from the Phrase config: its `sourceCatalog` against every `targetLocales[].outputPath`, read with `targetAdapter` (default: the source adapter) and the `repositoryLocale`. The locale mapping has one source of truth. A target whose file does not exist yet is reported as pending, not failed, so the plan works before the first translation PR lands.
- **`generated`** runs its configured executable with an argument array (no shell), substituting `{output}` with a temporary file path, and compares the result with the checked-in file. With an `adapter` (plus `role` and `locale`), both documents are parsed as catalogs. Without one, both are compared as plain JSON, which suits runtime aggregates such as a locale-keyed `data.json`. Prefer calling the consumer's own package script with an output override (FormatJS CLI options take the last value, so `-- --out-file {output}` redirects `translations:extract`) over copying its arguments; copied arguments drift from the script developers actually run. Generators must honor `{output}` without other side effects. The validator never rewrites checked-in files; `updateCommand` is only a failure hint.
- **`catalogDirectories`** lists directories whose files (default extension `.json`) must all be declared by a check, a TMS target, or a generated entry. It catches a locale file added without a TMS mapping, or a stale file left after a locale was removed.

The reusable workflow accepts this file through `validation-config`, so consumers do not need a validation script. See the [schema](../../schemas/catalog-validation-config.schema.json), the [consumer example](../../examples/phrase-consumer/.github/i18n/catalog-validation.json), and the [consumer onboarding checklist](../../docs/consumer-onboarding.md).

## Custom adapters

Install a Node package that default-exports an adapter object, then register its stable ID in the consumer's `package.json`:

```json
{
  "i18nTooling": {
    "catalogAdapters": {
      "my-format": "@acme/i18n-adapter-my-format"
    }
  }
}
```

The adapter implements the structural TypeScript contract declared in `src/index.ts`:

```ts
interface CatalogAdapter {
  readonly id: string;
  parseDocument?(content: string, context: AdapterContext): unknown;
  serializeDocument?(document: unknown, context: AdapterContext): string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}
```

The configured ID must match `adapter.id`. The optional JSON config file supplies adapter-specific `context.options`. Without document codecs, the CLI defaults to JSON; implement `parseDocument` and `serializeDocument` to handle text formats such as YAML or PO.
