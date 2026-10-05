import formatjs from "eslint-plugin-formatjs";
import tseslint from "typescript-eslint";
import i18n from "../packages/eslint-plugin-i18n/dist/index.js";

const catalog = process.env.I18N_CATALOG_PATH ?? "locales/en.json";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { formatjs, i18n },
    rules: {
      "i18n/no-missing-default-catalog-entry": ["error", { catalog }],
      "i18n/extractable-message-descriptor": "error",

      // ICU correctness: these break or mistranslate messages in some locales.
      "formatjs/no-invalid-icu": "error",
      "formatjs/enforce-plural-rules": ["error", { other: true }],
      "formatjs/no-missing-icu-plural-one-placeholders": "error",
      "formatjs/no-offset": "error",

      // Translatability: report without failing consumer validation.
      "formatjs/blocklist-elements": ["warn", ["tag"]],
      "formatjs/prefer-full-sentence": "warn",
      "formatjs/prefer-pound-in-plural": "warn",
      "formatjs/no-complex-selectors": ["warn", { limit: 20 }],
      "formatjs/no-multiple-plurals": "warn",
    },
  },
];
