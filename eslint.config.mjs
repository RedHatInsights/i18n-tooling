import js from "@eslint/js";
import tseslint from "typescript-eslint";
import i18n from "./packages/eslint-plugin-i18n/dist/index.js";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["packages/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    plugins: { i18n },
    rules: {
      "i18n/no-missing-default-catalog-entry": [
        "error",
        { catalog: "packages/eslint-plugin-i18n/tests/fixtures/en.json" },
      ],
    },
  },
];
