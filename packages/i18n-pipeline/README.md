# `@redhat-cloud-services/i18n-pipeline`

Node.js 22+ package for repository-owned locale catalogs. It provides a normalized `Catalog` model, built-in FormatJS and keyed ICU JSON adapters, ICU pattern validation, and the `frontend-i18n` CLI.

Framework extraction and compilation stay with each consumer's native tooling. Catalog-format adapters normalize repository artifacts; TMS-provider adapters are a separate future seam.

## Built-in adapters

| ID | Source catalog | Target catalog |
|---|---|---|
| `formatjs-json` | FormatJS descriptors: `{ "id": { "defaultMessage": "...", "description": "..." } }` | Flat compiled messages: `{ "id": "..." }` |
| `icu-json` | Flat message-code-to-ICU-pattern JSON | Flat message-code-to-ICU-pattern JSON |

The FormatJS adapter retains string/object descriptions and other descriptor metadata. Both built-ins validate ICU syntax with FormatJS's `@formatjs/icu-messageformat-parser`; consumers should also run native framework compilation and validation.

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

The adapter package depends on `@redhat-cloud-services/i18n-pipeline` for TypeScript types and implements:

```ts
interface CatalogAdapter {
  readonly id: string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}
```

The configured ID must match `adapter.id`. The optional JSON config file supplies adapter-specific `context.options`.
