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

## npm consumers (after the first release)

Install as development dependencies:

```bash
npm install --save-dev @redhat-cloud-services/eslint-plugin-i18n eslint-plugin-formatjs@8.1.0 eslint@9 @redhat-cloud-services/i18n-pipeline
```

The FormatJS peer is required. The plugin adds no runtime dependency; the peer must be resolvable even when using `configs.recommended`. Node.js 22.14+ is the supported runtime, including the CommonJS entry point, which loads the ESM FormatJS peer through Node's require(ESM) support. ESLint 9 or 10 is required by that peer. Add a package script:

```json
{
  "scripts": {
    "translations:validate": "i18n-pipeline validate-ci --mode error"
  }
}
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

Install `typescript-eslint` as a development dependency when using that parser. The preset includes the catalog rule and the same nine FormatJS rules and severities as the repository source config: four ICU correctness errors and five translatability warnings. It supplies plugins and rules, leaving parsing to the consumer. `configs.recommended` still supplies only the catalog rule. Configure the CLI using the [pipeline validation instructions](../i18n-pipeline/README.md#ci-validation-command); editor configuration does not change CLI validation.
