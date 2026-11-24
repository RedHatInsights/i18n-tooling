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

## Render-site fragment composition

`no-fragment-composition` reports compositions at error severity in `configs.source`.
It checks `formatMessage` calls and `<FormattedMessage>` uses in JSX, string addition,
and template literals. Descriptors may be inline, local `const` values, or relative
source imports (default and named exports, including `defineMessage(s)`). It reuses
the configured parser and never executes imported modules.

For example, this prevents translators from moving the link:

```jsx
<p>{intl.formatMessage({ defaultMessage: 'Try again. Contact' })} <a>support</a>.</p>
```

Use a complete message such as `Try again. Contact <SupportLink>support</SupportLink>.`,
with a `SupportLink` renderer in the React Intl values instead.

The boundary contract is deliberately conservative, not a grammatical-completeness
check. A finding needs sentence punctuation (`.`, `!`, `?`, `…`, or CJK equivalents);
Western punctuation must follow a word at a token boundary (or be a standalone mark),
so decimal versions and dotted abbreviations such as `2.0` and `e.g.` are not evidence.
It also needs an open-ended message outside a link (or one starting with continuation punctuation),
and either an inline link, two explicitly concatenated/interpolated messages, or
multiple JSX messages with a leading continuation mark such as a comma. Plain JSX
adjacency alone is not a finding.
It catches Chrome's feedback, research, tag-help, and error compositions even when
fragments have no boundary whitespace. It does not flag bare adjacent labels,
colon-delimited labels, complete independent sentences, or separate block content.

Unknown/dynamic expressions and block elements break the inspected sequence. Mutable
bindings, statically visible object writes, spreads, computed descriptor properties,
package imports, re-exports, and path aliases are not resolved. Custom JSX components
are boundaries, except explicit PatternFly `Content component="a"`/inline elements.
Compositions with no sentence punctuation and plain JSX siblings without a leading
continuation mark can be missed, even when a sibling ends in a full stop. These limits
avoid treating all adjacent messages as broken; absence of findings is not proof of translatability.

Include **render sites** in your source globs: linting only a descriptor file such as
`src/locales/Messages.ts` cannot detect composition in components. In configured
`validate-ci`, source lint remains opt-in through `sourceLint`; zero-config FormatJS
validation enables this rule alongside its ICU syntax checks. `--mode error` fails
on findings; `--mode warn` reports them without failing. Clean up existing violations
before enabling blocking validation in a consumer. **Compatibility change:** zero-config
FormatJS consumers previously ran only ICU checks; without adding any config, they
can now fail `--mode error` on detected fragment composition.

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

`configs.source` adds the catalog and fragment-composition rules plus the nine FormatJS rules and severities that configured `validate-ci` uses; parsing is left to you (`typescript-eslint` above). `configs.recommended` adds only the catalog rule. For CI validation, see the [CLI instructions](../i18n-pipeline/README.md#npm-consumers-after-the-first-release).
