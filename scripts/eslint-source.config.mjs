import tseslint from "typescript-eslint";
import i18n from "../packages/eslint-plugin-i18n/dist/index.js";

const catalog = process.env.I18N_CATALOG_PATH ?? "locales/en.json";

export default [
  ...i18n.configs.source,
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
    rules: {
      "i18n/no-missing-default-catalog-entry": ["error", { catalog }],
    },
  },
];
