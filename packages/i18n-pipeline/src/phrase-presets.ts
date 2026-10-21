// Changing a preset value changes the batch identity of every consumer that uses it.
// Their next run then resubmits their sources to Phrase.
export const PHRASE_TMS_PRESETS = {
  "hcc-ui": {
    provider: "phrase",
    project: { uid: "LFsYhKphLpXQ0WWa47VZ19", region: "eu" },
    sourceCatalog: {
      adapter: "formatjs-json",
      locale: "en",
      useProjectFileImportSettings: true,
    },
    targetAdapter: "formatjs-json",
    targetLocales: [
      { phraseLocale: "fr", repositoryLocale: "fr" },
      { phraseLocale: "ja", repositoryLocale: "ja" },
      { phraseLocale: "ko", repositoryLocale: "ko" },
      { phraseLocale: "zh_cn", repositoryLocale: "zh-CN" },
    ],
  },
} as const;

export type PhraseTmsPresetName = keyof typeof PHRASE_TMS_PRESETS;
