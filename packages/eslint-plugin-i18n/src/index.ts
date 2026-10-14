import type { Linter } from "eslint";
import formatjs from "eslint-plugin-formatjs";
import packageMetadata from "../package.json" with { type: "json" };
import noMissingDefaultCatalogEntry from "./rules/no-missing-default-catalog-entry.js";

type Plugin = {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    "no-missing-default-catalog-entry": typeof noMissingDefaultCatalogEntry;
  };
  configs?: {
    source: Linter.Config[];
    recommended: {
      plugins: { i18n: Plugin };
      rules: { "i18n/no-missing-default-catalog-entry": "error" };
    };
  };
};

const plugin: Plugin = {
  meta: {
    name: "@redhat-cloud-services/eslint-plugin-i18n",
    version: packageMetadata.version,
  },
  rules: {
    "no-missing-default-catalog-entry": noMissingDefaultCatalogEntry,
  },
};

plugin.configs = {
  source: [
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      plugins: { i18n: plugin, formatjs },
      rules: {
        "i18n/no-missing-default-catalog-entry": "error",
        "formatjs/no-invalid-icu": "error",
        "formatjs/enforce-plural-rules": ["error", { other: true }],
        "formatjs/no-missing-icu-plural-one-placeholders": "error",
        "formatjs/no-offset": "error",
        "formatjs/blocklist-elements": ["warn", ["tag"]],
        "formatjs/prefer-full-sentence": "warn",
        "formatjs/prefer-pound-in-plural": "warn",
        "formatjs/no-complex-selectors": ["warn", { limit: 20 }],
        "formatjs/no-multiple-plurals": "warn",
      },
    },
  ],
  recommended: {
    plugins: {
      i18n: plugin,
    },
    rules: {
      "i18n/no-missing-default-catalog-entry": "error",
    },
  },
};

export { noMissingDefaultCatalogEntry };
export default plugin;
