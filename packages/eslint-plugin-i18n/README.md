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

The first rule checks literal IDs used by supported FormatJS call forms against the committed English catalog. It deliberately does not make a generated temporary extraction file authoritative.
