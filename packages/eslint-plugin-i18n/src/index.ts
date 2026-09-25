import noMissingDefaultCatalogEntry from './rules/no-missing-default-catalog-entry.js';

type Plugin = {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    'no-missing-default-catalog-entry': typeof noMissingDefaultCatalogEntry;
  };
  configs?: {
    recommended: {
      plugins: { i18n: Plugin };
      rules: { 'i18n/no-missing-default-catalog-entry': 'error' };
    };
  };
};

const plugin: Plugin = {
  meta: {
    name: '@redhat-cloud-services/eslint-plugin-i18n',
    version: '0.1.0',
  },
  rules: {
    'no-missing-default-catalog-entry': noMissingDefaultCatalogEntry,
  },
};

plugin.configs = {
  recommended: {
    plugins: {
      i18n: plugin,
    },
    rules: {
      'i18n/no-missing-default-catalog-entry': 'error',
    },
  },
};

export { noMissingDefaultCatalogEntry };
export default plugin;
