# `@redhat-cloud-services/eslint-plugin-i18n`

ESLint rules for product UI localization with ICU-compatible message catalogs. This workspace-only plugin is loaded from source by the repository's root ESLint config and is not published to npm.

## Flat config

```js
import i18n from "./packages/eslint-plugin-i18n/dist/index.js";

export default [
  {
    plugins: {
      i18n,
    },
    rules: {
      "i18n/no-missing-default-catalog-entry": ["error", { catalog: "./locales/en.json" }],
      "i18n/extractable-message-descriptor": "error",
    },
  },
];
```

`no-missing-default-catalog-entry` checks IDs in FormatJS `formatMessage`, `defineMessage(s)`, and `<FormattedMessage>` forms against the configured catalog. Missing entries fail lint. Missing or dynamic inline IDs, spread/computed descriptors, and unresolved descriptor expressions also fail. Static reusable descriptors are checked at their definitions; configure the source glob to include those files.

`extractable-message-descriptor` rejects message objects with a static `id` and a `defaultMessage` unless they appear directly as the first argument to `formatMessage`/`defineMessage` or as a direct value in `defineMessages`. This catches descriptors that may render through `defaultMessage` but disappear from FormatJS extraction. The reusable workflow runs both rules against consumer sources before validation; consumers do not need to install the workspace-only plugin.
