# Architecture

## Repository seams

Consumer repositories learn a small interface:

1. Run the reusable validation workflow.
2. Select a catalog-format adapter and provide catalog configuration.
3. Invoke the provider-neutral pipeline for future translation handoff/reconciliation work.

Framework integration, catalog serialization, and TMS-provider behavior are separate concerns. Framework-owned extraction/compilation commands remain in the consumer repository; catalog adapters normalize repository artifacts; TMS-provider adapters own provider-specific APIs and job behavior.

## Catalog adapters

`@redhat-cloud-services/i18n-pipeline` exposes a `CatalogAdapter` interface over a small normalized model:

```ts
interface CatalogAdapter {
  readonly id: string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}

interface AdapterContext {
  locale: string;
  role: "source" | "target";
  options: Readonly<Record<string, unknown>>;
}
```

The normalized `Catalog` keeps message IDs, ICU patterns, descriptions, and format-specific metadata. Adapters own repository serialization; they do not own framework extraction or TMS credentials.

Built-in adapter IDs:

- **`formatjs-json`** reads FormatJS extracted source descriptors (`id -> {defaultMessage, description}`) and flat compiled target messages (`id -> string`). This matches `rbac-ui`'s `translation-template.json` and `translations.json` artifacts.
- **`icu-json`** reads/writes flat `message code -> ICU pattern` JSON for service-owned errors. Problem Details carry the same `code`, raw typed `params`, and English `detail` fallback.

Both built-ins validate ICU syntax using FormatJS's official `@formatjs/icu-messageformat-parser`. Consumers still run their native compiler/extractor: syntax validation does not replace framework compilation or source-catalog checks.

### Extending catalog formats

Install a Node package that default-exports a `CatalogAdapter`, then map the stable adapter ID in the consumer's `package.json`:

```json
{
  "dependencies": {
    "@acme/i18n-adapter-yaml": "^1.0.0"
  },
  "i18nTooling": {
    "catalogAdapters": {
      "acme-yaml": "@acme/i18n-adapter-yaml"
    }
  }
}
```

The package is loaded at runtime by the Node CLI. Its exported `id` must match the configured ID. Adapter-specific options come from an optional JSON config file and are passed as `context.options`. The reusable workflow selects only an ID and config path; it does not dynamically choose GitHub `uses` references, package names, or shell code.

Django gettext is enabled in `insights-rbac`, but there are no current PO catalogs or catalog workflow. The POC therefore introduces keyed ICU JSON instead of adding a PO conversion path. i18next, Lingui, and PO adapters remain future plugins.

## Runtime and framework tooling

The shared adapter package is compiled TypeScript targeting Node.js 22+. Node is the runtime; Bun can be used as an optional local tool or dependency installer. The package uses Node's ESM module loading for installed adapter packages. Framework extraction and compilation remain native to each consumer—for example, FormatJS CLI in a React app.

## TMS providers

The current package implements catalog adapters and the validation/conversion CLI. Provider-neutral TMS orchestration is planned but is not implemented yet. The intended boundary is:

```text
consumer framework/extractor
        │
        ▼
catalog-format adapter
  ├── read/write repository catalog
  └── normalized Catalog model
        │
        ▼
provider-neutral TMS pipeline (future)
  ├── provider adapter
  ├── durable job mapping
  ├── status reconciliation
  ├── target download
  ├── catalog validation
  └── pull-request handoff
```

Phrase GitHub Connector/APC, `JOB_STATUS_CHANGED`, scheduled GitHub Actions, and future providers belong behind that seam. A webhook is a wake-up signal, not proof that a batch is ready. Reconciliation should re-query every expected locale, require final workflow state, validate target catalogs, and then create an idempotent PR.

## Reusable workflow

The GitHub workflow sets up Node.js 22+ and supports Bun or npm for dependency installation. It invokes the consumer's named validation script through `npm run`; the compiled package CLI starts on Node through its `node` shebang, while consumer-native commands retain their own toolchain. The script receives adapter ID, path, role, locale, and optional JSON config through `I18N_CATALOG_*` environment variables.

Workflow inputs are not interpolated into shell code, and a format adapter ID never selects a dynamic GitHub `uses` reference. Custom adapter packages must be installed and pinned by the consumer environment.

## Deliberate non-goals

- No runtime TMS lookup.
- No translation service in the browser.
- No mandatory shared message catalog for ordinary application UI.
- No PO/POT format as the canonical repository artifact.
- No direct coupling between frontend applications and Phrase API details.
