# Architecture

## Repository seams

Consumer repositories learn a small interface:

1. Run the reusable validation workflow.
2. Select a catalog-format adapter and provide catalog configuration.
3. Optionally use the Phrase TMS CLI/workflows for source handoff and target reconciliation.

Framework integration, catalog serialization, and TMS-provider behavior are separate concerns. Framework-owned extraction/compilation commands remain in the consumer repository; catalog adapters normalize repository artifacts; TMS-provider adapters own provider-specific APIs and job behavior.

## Catalog adapters

`@redhat-cloud-services/i18n-pipeline` exposes a `CatalogAdapter` interface over a small normalized model:

```ts
interface CatalogAdapter {
  readonly id: string;
  parseDocument?(content: string, context: AdapterContext): unknown;
  serializeDocument?(document: unknown, context: AdapterContext): string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}

interface AdapterContext {
  locale: string;
  role: "source" | "target";
  options: Readonly<Record<string, unknown>>;
}
```

The normalized `Catalog` keeps message IDs, ICU patterns, descriptions, and format-specific metadata. Adapters own repository serialization. Optional `parseDocument`/`serializeDocument` codecs handle non-JSON text files; adapters without codecs use JSON defaults. Adapters do not own framework extraction or TMS credentials.

Built-in adapter IDs:

- **`formatjs-json`** reads FormatJS extracted source descriptors (`id -> {defaultMessage, description}`) and flat compiled target messages (`id -> string`). Phrase target exports may also use descriptor objects; the target reader extracts only `defaultMessage` and the writer emits flat `id -> string` output. This matches `rbac-ui`'s `translation-template.json` and `translations.json` artifacts.
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

The package is loaded at runtime by the Node CLI. Its exported `id` must match the configured ID. Adapter-specific options come from an optional JSON config file and are passed as `context.options`. Optional `parseDocument(content, context)` and `serializeDocument(document, context)` methods let adapters read and write formats such as YAML or PO; without them, the CLI uses JSON. The reusable workflow selects only an adapter ID and config path; it does not dynamically choose GitHub `uses` references or package names.

Django gettext is enabled in `insights-rbac`, but there are no current PO catalogs or catalog workflow. The POC therefore introduces keyed ICU JSON instead of adding a PO conversion path. i18next, Lingui, and PO adapters remain future plugins.

## Runtime and framework tooling

The shared adapter package is compiled TypeScript targeting Node.js 22+. Node is the runtime; Bun can be used as an optional local tool or dependency installer. The package uses Node's ESM module loading for installed adapter packages. Framework extraction and compilation remain native to each consumer—for example, FormatJS CLI in a React app.

## TMS workflow

The initial round trip uses direct Phrase TMS API calls; consumer repositories invoke a provider-discriminated `frontend-i18n tms` command and do not implement Phrase request logic:

```text
consumer framework/extractor
        │
        ▼
PhraseClient
  ├── Platform auth (service-account client credentials or API-token exchange)
  ├── source-job upload + async import tracking
  ├── final-step status reads
  └── target export + download
        │
        ▼
PhraseWorkflow
  ├── exact source digest + durable batch state
  ├── duplicate/ambiguous submission protection
  ├── stale-source detection
  ├── normalized catalog validation
  └── locale-specific PR handoff
        │
        ▼
GitHubPhraseRepository
  ├── CAS-updated records on a dedicated state branch
  └── deterministic translation branches + ordinary PRs
```

`PhraseWorkflow` is the initial provider implementation, not a claim that Phrase APIs are provider-neutral. Future TMS providers can implement the same orchestration boundary without changing catalog adapters or consumer workflow inputs. Phrase Connectors/APC and webhooks remain deferred. A webhook is only a wake-up signal; reconciliation re-queries Phrase and treats `COMPLETED` on the final workflow level as success.

The state record is keyed by repository, base ref, exact source bytes, and the Phrase-facing settings; the source commit is recorded but not keyed, so unchanged source is never submitted twice. Terminal batches (`completed`, `failed`, `superseded`) leave reconciliation, and each batch is reconciled in isolation. The exact job-create request is never replayed after an ambiguous outcome. Reconciliation verifies the source at its pinned commit and current PR base, validates every downloaded target against the pinned source, and opens one PR per locale. Reconciliation downloads afresh after an interrupted export rather than reusing a possibly consumed one-time request ID.

The reusable submit and reconcile workflows use protected environment secrets for Phrase credentials (a Service Account or a user's Platform API token) and the run-scoped `GITHUB_TOKEN` for state and PR operations. They do not auto-merge or add consumer-specific schedules/configuration. GitHub may hold `pull_request` checks from a `GITHUB_TOKEN`-created PR for maintainer approval; generated PRs must not be assumed to have immediately running checks.

## Reusable workflow

The GitHub workflow sets up Node.js 22+ and supports Bun or npm for dependency installation. With `validation-config`, it invokes `frontend-i18n validate-project` directly; a JSON plan declares catalog paths, adapters, locale contexts, and generated-file sync commands. Each generator runs with an argument array (no shell) and writes to a temporary output path for comparison. Otherwise, the workflow retains `validation-command` through `npm run`. Simple commands can continue using adapter ID, path, role, locale, and optional JSON config through `I18N_CATALOG_*` environment variables.

Workflow inputs are not interpolated into shell code, and a format adapter ID never selects a dynamic GitHub `uses` reference. Custom adapter packages must be installed and pinned by the consumer environment.

## Deliberate non-goals

- No runtime TMS lookup.
- No translation service in the browser.
- No mandatory shared message catalog for ordinary application UI.
- No PO/POT format as the canonical repository artifact.
- No direct coupling between frontend applications and Phrase API details.
