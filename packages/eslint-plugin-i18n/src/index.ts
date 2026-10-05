import packageMetadata from "../package.json" with { type: "json" };
import noMissingDefaultCatalogEntry from "./rules/no-missing-default-catalog-entry.js";
import extractableMessageDescriptor from "./rules/extractable-message-descriptor.js";

type Plugin = {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    "no-missing-default-catalog-entry": typeof noMissingDefaultCatalogEntry;
    "extractable-message-descriptor": typeof extractableMessageDescriptor;
  };
  configs?: {
    recommended: {
      plugins: { i18n: Plugin };
      rules: {
        "i18n/no-missing-default-catalog-entry": "error";
        "i18n/extractable-message-descriptor": "error";
      };
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
    "extractable-message-descriptor": extractableMessageDescriptor,
  },
};

plugin.configs = {
  recommended: {
    plugins: {
      i18n: plugin,
    },
    rules: {
      "i18n/no-missing-default-catalog-entry": "error",
      "i18n/extractable-message-descriptor": "error",
    },
  },
};

export { noMissingDefaultCatalogEntry, extractableMessageDescriptor };
export default plugin;
