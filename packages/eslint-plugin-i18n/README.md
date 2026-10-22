# `@redhat-cloud-services/eslint-plugin-i18n`

ESLint rules for product UI localization with ICU-compatible message catalogs. The repository builds this plugin from source; npm consumer usage below applies after the first release.

## Flat config

```js
import i18n from './packages/eslint-plugin-i18n/dist/index.js';

export default [
  {
    plugins: {
      i18n,
    },
    rules: {
      'i18n/no-missing-default-catalog-entry': [
        'error',
        { catalog: './locales/en.json' },
      ],
    },
  },
];
```

`no-missing-default-catalog-entry` checks IDs in FormatJS `formatMessage`, `defineMessage(s)`, and `<FormattedMessage>` forms against the configured catalog. Missing entries fail lint. Missing or dynamic inline IDs, spread/computed descriptors, and unresolved descriptor expressions also fail. Static reusable descriptors are checked at their definitions; configure the source glob to include those files. The reusable workflow builds this plugin and runs the rule against consumer sources before consumer validation; it does not require consumers to install the workspace-only package.

`no-duplicate-message-id` reports a descriptor whose `id` is already declared in the same file with a different `defaultMessage` or `description`. Extraction keeps only one of them, so the other text or translator context never reaches the source catalog. Reusing an identical descriptor is allowed. The rule compares descriptors within one file; `configs.source` runs it as a warning, together with FormatJS `enforce-description`.

## npm consumers (after the first release)

Install with its FormatJS peer, which is required even for `configs.recommended` (Node.js 22.14+, ESLint 9 or 10):

```bash
npm install --save-dev @redhat-cloud-services/eslint-plugin-i18n eslint-plugin-formatjs@8.1.0 eslint@9
```

For editor feedback, spread `configs.source` into `eslint.config.mjs`, then set your catalog path. Supply your own parser for TypeScript and JSX:

```js
import i18n from '@redhat-cloud-services/eslint-plugin-i18n';
import tseslint from 'typescript-eslint';

export default [
  ...i18n.configs.source,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'i18n/no-missing-default-catalog-entry': [
        'error',
        { catalog: './locales/en.json' },
      ],
    },
  },
];
```

`configs.source` adds the catalog rule plus the nine FormatJS rules and severities that `validate-ci` uses; parsing is left to you (`typescript-eslint` above). `configs.recommended` adds only the catalog rule. For CI validation, see the [CLI instructions](../i18n-pipeline/README.md#npm-consumers-after-the-first-release).
