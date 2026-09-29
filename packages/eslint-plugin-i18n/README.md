# `@redhat-cloud-services/eslint-plugin-i18n`

ESLint rules for product UI localization with ICU-compatible message catalogs. This workspace-only plugin is loaded from source by the repository's root ESLint config and is not published to npm.

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
