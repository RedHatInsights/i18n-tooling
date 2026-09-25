# i18n Tooling

Shared product-UI internationalization tooling for HCC and other Red Hat frontend applications.

## Why this repository

`hcc-i18n` is the architecture and workflow initiative. This repository is the reusable implementation layer, named simply `i18n-tooling` because it may serve more than one frontend product:

- ESLint rules for ICU MessageFormat source and locale-catalog invariants.
- A Node.js/TypeScript catalog-adapter package and CLI.
- Reusable GitHub Actions workflows.
- Shared schemas and test fixtures for locale catalogs and backend-error contracts.

HCC is the first consumer; tooling should not make every future consumer pretend to be HCC.

## Initial packages

| Package                                     | Role                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redhat-cloud-services/eslint-plugin-i18n` | ESLint rules for message IDs, source catalogs, and ICU-oriented source checks.                                                                                       |
| `@redhat-cloud-services/i18n-pipeline`      | Node.js package with the normalized catalog model, FormatJS and keyed ICU JSON adapters, adapter plugin loading, ICU syntax validation, and the `frontend-i18n` CLI. |
| `.github/workflows/`                        | Repository CI, reusable consumer validation, and Changesets release automation.                                                                                      |

The TypeScript packages target Node.js 22+. Bun 1.3.14 manages workspace dependencies, while package code and the CLI run under Node.js. Framework extraction and compilation remain in each consumer's native tooling.

## Design rules

- ICU MessageFormat remains normative for every catalog adapter. Built-in adapters parse patterns with FormatJS's official `@formatjs/icu-messageformat-parser`.
- Initial built-ins target FormatJS descriptor/compiled JSON and keyed ICU JSON for service errors.
- Catalog-format adapters stay separate from TMS-provider adapters.
- Teams extend formats through installed Node packages, stable adapter IDs, and adapter-specific JSON options. GitHub `uses` references are not dynamic.
- Canonical locale catalogs remain repository-owned; TMS is a translation workspace, never a runtime dependency.
- Provider-specific Phrase/APC/webhook behavior belongs behind a future TMS-provider interface.
- English `detail` is fallback for backend errors; the English source catalog is fallback for UI messages.
- i18next, Lingui, and Django PO conversion are future adapters, not part of this POC slice.

## Terminology

- **Message ID** — Stable identifier used by application code to refer to the same translatable message across locales.
- **Locale catalog** — Repository-owned set of messages for one locale, keyed by message ID. Here, catalogs are JSON files, not ICU resource bundles.
- **Source catalog** — Canonical catalog for English source messages; also the fallback for missing or unavailable translations.
- **Target catalog** — Locale catalog containing translations of the source messages.
- **ICU MessageFormat pattern** — Syntax for message arguments, number/date formatting, and plural/select logic. It describes how messages are formatted, not how locale data is stored.
- **ICU resource bundle** — ICU's native locale-aware data container and lookup/fallback model. It is distinct from this repository's JSON locale catalogs.
- **ICU message catalog** — ICU's separate POSIX-style `ucat` API. Avoid this label for our JSON catalogs.
- **TMS (translation management system)** — Workspace for translation work; it is not a runtime dependency or source of truth.

## Repository layout

```text
.github/workflows/       Reusable consumer workflows
packages/
  eslint-plugin-i18n/    Published ESLint plugin
  i18n-pipeline/         Published Node.js/TypeScript package and CLI
schemas/                 Shared machine-readable contracts
docs/                    Architecture and consumer guidance
```

## Local development

Use Node.js 22 or newer and Bun 1.3.14. Bun is the canonical dependency installer; this repo has no npm lockfile, so do not run `npm install` or `npm ci`. Use npm only to run scripts under Node:

```bash
bun install --frozen-lockfile
npm run check
```

The package CLI is compiled to Node-compatible ESM:

```bash
npm run build --workspace @redhat-cloud-services/i18n-pipeline
node packages/i18n-pipeline/dist/cli.js version
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and release contributions.

## Package releases

Both workspace packages publish to npm as public `@redhat-cloud-services` packages. Add a Changesets entry for each user-facing package change. On pushes to `main`, the release workflow opens or updates a version PR; merging that PR publishes the packages. Configure the repository's `NPM_TOKEN` secret with publish access for the scope before enabling releases.

## Consumer examples

`rbac-ui` keeps its native FormatJS extraction/compile script and selects the matching catalog adapter:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@main
    with:
      package-manager: bun
      validation-command: i18n:validate # consumer script runs FormatJS extraction/compilation and frontend-i18n validate
      catalog-adapter: formatjs-json
      catalog-path: locales/translation-template.json
      catalog-role: source
      catalog-locale: en
```

The reusable workflow uses the selected package manager to install dependencies, then invokes the consumer script with `npm run` under Node.js. The script can call `frontend-i18n validate`; the catalog settings arrive through `I18N_CATALOG_*` environment variables.

A service can validate its service-owned keyed ICU JSON catalog the same way:

```yaml
jobs:
  i18n:
    uses: RedHatInsights/i18n-tooling/.github/workflows/i18n-validate.yml@main
    with:
      package-manager: npm
      validation-command: i18n:validate
      catalog-adapter: icu-json
      catalog-path: i18n/en.json
      catalog-role: source
      catalog-locale: en
```

Run the CLI directly with explicit options or use workflow environment settings. `check` compares source and target message IDs and named ICU arguments, including arguments nested inside plural/select branches:

```bash
frontend-i18n validate \
  --adapter icu-json \
  --catalog i18n/en.json \
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

### Add a custom catalog adapter

Install a package that default-exports an object implementing `CatalogAdapter`, then map its stable ID in the consumer's `package.json`:

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

The plugin implements `read(document, context) -> Catalog` and `write(catalog, context) -> JSON-compatible document`. `context` provides locale, source/target role, and options from the optional JSON `catalog-config` path. The configured ID must match the plugin's exported `id`. Custom modules are installed by the consumer; workflow inputs never select package names or shell code.

See [the architecture guide](docs/architecture.md) for the normalized model and the separation between framework, catalog-format, and TMS-provider integrations.
