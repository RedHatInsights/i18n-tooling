import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parsePhraseTmsConfig,
  rejectCredentialFields,
  resolvePhraseTmsConfig,
} from "../src/phrase-config.js";
import { PHRASE_TMS_PRESETS } from "../src/phrase-presets.js";

async function readJsonFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

const minimalConfig = {
  provider: "phrase",
  project: { uid: "project-uid", region: "eu" },
  sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
  targetLocales: [{ phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" }],
};

const minimalPresetConfig = {
  preset: "hcc-ui",
  sourceCatalog: {
    path: "locales/translation-template.json",
    filename: "i18n-frontend-environment.frontend-environment.en.json",
  },
  targetOutputPath: "locales/{locale}.json",
};

const fullHccConfig = {
  provider: "phrase",
  project: { uid: "LFsYhKphLpXQ0WWa47VZ19", region: "eu" },
  sourceCatalog: {
    path: "locales/translation-template.json",
    filename: "i18n-frontend-environment.frontend-environment.en.json",
    adapter: "formatjs-json",
    locale: "en",
    useProjectFileImportSettings: true,
  },
  targetAdapter: "formatjs-json",
  targetLocales: [
    { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
    { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
    { phraseLocale: "ko", repositoryLocale: "ko", outputPath: "locales/ko.json" },
    { phraseLocale: "zh_cn", repositoryLocale: "zh-CN", outputPath: "locales/zh-CN.json" },
  ],
};

describe("Phrase TMS config parser", () => {
  it("pins the hcc-ui preset because changing it resubmits every consumer's source", () => {
    expect(PHRASE_TMS_PRESETS["hcc-ui"]).toEqual({
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
    });
  });

  it("resolves the minimal hcc-ui config to the equivalent full config", () => {
    expect(resolvePhraseTmsConfig(minimalPresetConfig)).toEqual(fullHccConfig);
    expect(parsePhraseTmsConfig(minimalPresetConfig)).toEqual(parsePhraseTmsConfig(fullHccConfig));
    expect(parsePhraseTmsConfig({ ...minimalPresetConfig, provider: "phrase" })).toEqual(
      parsePhraseTmsConfig(fullHccConfig),
    );
    // Existing consumer configs also spell out the state and completion-policy defaults.
    expect(parsePhraseTmsConfig(minimalPresetConfig)).toEqual(
      parsePhraseTmsConfig({
        ...fullHccConfig,
        state: { branch: "i18n-tms-state", directory: ".github/i18n-state/batches" },
        completionPolicy: { default: "per-locale" },
      }),
    );
  });

  it("requires only sourceCatalog.path for a preset and supports output templates without a preset", () => {
    expect(
      parsePhraseTmsConfig({
        preset: "hcc-ui",
        sourceCatalog: { path: "locales/translation-template.json" },
        targetOutputPath: "locales/{locale}.json",
      }).workflow.sourceCatalog,
    ).toMatchObject({
      filename: "translation-template.json",
      adapter: "formatjs-json",
    });

    const parsed = parsePhraseTmsConfig({
      provider: "phrase",
      project: { uid: "project-uid", region: "eu" },
      sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
      targetLocales: [{ phraseLocale: "zh_cn", repositoryLocale: "zh-CN" }],
      targetOutputPath: "locales/{locale}.json",
    });
    expect(parsed.workflow.targetLocales[0].outputPath).toBe("locales/zh-CN.json");
  });

  it("merges a partial project override and keeps the preset region", () => {
    const sandboxConfig = {
      ...fullHccConfig,
      project: { uid: "yWWEIEQgpNVK650YBQhGx6", region: "eu" },
    };
    expect(
      parsePhraseTmsConfig({ ...minimalPresetConfig, project: { uid: "yWWEIEQgpNVK650YBQhGx6" } }),
    ).toEqual(parsePhraseTmsConfig(sandboxConfig));
    expect(
      parsePhraseTmsConfig({ ...minimalPresetConfig, project: { uid: "yWWEIEQgpNVK650YBQhGx6" } })
        .workflow.region,
    ).toBe("eu");
  });

  it("keeps the full non-preset config behavior and defaults", () => {
    expect(parsePhraseTmsConfig(minimalConfig)).toEqual({
      workflow: {
        projectUid: "project-uid",
        region: "eu",
        sourceCatalog: {
          path: "locales/en.json",
          filename: "en.json",
          adapter: "formatjs-json",
          locale: "en",
        },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        ],
        completionPolicy: { default: "per-locale" },
      },
      stateBranch: "i18n-tms-state",
      stateDirectory: ".github/i18n-state/batches",
    });
  });

  it("selects preset locales in requested order and fills locale output paths", () => {
    const parsed = parsePhraseTmsConfig({
      ...minimalPresetConfig,
      locales: ["zh-CN", "fr"],
      targetOutputPath: "deploy/locales/{locale}.json",
    });
    expect(parsed.workflow.targetLocales).toEqual([
      { phraseLocale: "zh_cn", repositoryLocale: "zh-CN", outputPath: "deploy/locales/zh-CN.json" },
      { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "deploy/locales/fr.json" },
    ]);
  });

  it("lets a repository target mapping replace the preset and explicit paths win", () => {
    const parsed = parsePhraseTmsConfig({
      ...minimalPresetConfig,
      targetOutputPath: "ignored/{locale}.json",
      targetLocales: [
        { phraseLocale: "fr_fr", repositoryLocale: "fr-FR", outputPath: "custom/fr.json" },
      ],
    });
    expect(parsed.workflow.targetLocales).toEqual([
      { phraseLocale: "fr_fr", repositoryLocale: "fr-FR", outputPath: "custom/fr.json" },
    ]);
  });

  it("uses the hcc-ui preset with Frontend template configs", () => {
    const parsed = parsePhraseTmsConfig({
      preset: "hcc-ui",
      locales: ["zh-CN", "fr"],
      sourceCatalog: {
        path: "deploy/locales/translation-template.json",
        filename: "sample.feo.en.json",
      },
      targetOutputPath: "deploy/locales/{locale}.json",
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
    });
    expect(parsed.workflow).toMatchObject({
      sourceCatalog: { adapter: "formatjs-json", locale: "en" },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
      targetLocales: [
        { repositoryLocale: "zh-CN", outputPath: "deploy/locales/zh-CN.json" },
        { repositoryLocale: "fr", outputPath: "deploy/locales/fr.json" },
      ],
    });
  });

  it("rejects invalid preset names, provider overrides, locale filters, and output templates", () => {
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, preset: "other" })).toThrow(
      /Unknown TMS config preset "other"\. Available presets: hcc-ui/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, provider: "other" })).toThrow(
      /provider.*phrase/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, preset: 1 })).toThrow(
      /preset.*string/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalConfig, locales: ["fr"] })).toThrow(
      /only valid with a preset/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, locales: [] })).toThrow(
      /non-empty array/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, locales: "fr" })).toThrow(
      /non-empty array/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, locales: [1] })).toThrow(
      /non-empty string/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, locales: ["fr", "fr"] })).toThrow(
      /Duplicate repository locale.*fr/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, locales: ["es"] })).toThrow(
      /Unknown repository locale "es".*fr, ja, ko, zh-CN/,
    );
    expect(() =>
      parsePhraseTmsConfig({
        ...minimalPresetConfig,
        locales: ["fr"],
        targetLocales: [{ phraseLocale: "fr", repositoryLocale: "fr", outputPath: "fr.json" }],
      }),
    ).toThrow(/cannot be combined with "targetLocales"/);
    expect(() =>
      parsePhraseTmsConfig({ ...minimalPresetConfig, targetOutputPath: "locales/all.json" }),
    ).toThrow(/must contain "\{locale\}"/);
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, targetOutputPath: 1 })).toThrow(
      /targetOutputPath.*non-empty string/,
    );
    expect(() =>
      parsePhraseTmsConfig({
        preset: "hcc-ui",
        sourceCatalog: { path: "locales/translation-template.json" },
      }),
    ).toThrow(/outputPath.*required/);
    expect(() =>
      parsePhraseTmsConfig({
        ...minimalPresetConfig,
        targetOutputPath: "../{locale}.json",
      }),
    ).toThrow(/repository-relative path/);
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, apiToken: "secret" })).toThrow(
      /must not contain credentials/,
    );
    expect(() => parsePhraseTmsConfig({ ...minimalPresetConfig, unexpected: true })).toThrow(
      /unknown property "unexpected"/,
    );
  });

  it.each([
    "../../../schemas/fixtures/phrase-tms-config.valid.json",
    "../../../schemas/fixtures/phrase-tms-config.preset.valid.json",
    "../../../schemas/fixtures/phrase-tms-config.preset-locales.valid.json",
    "../../../examples/phrase-consumer/.github/i18n/phrase-tms.json",
  ])("accepts the schema-valid config %s", async (fixture) => {
    await expect(readJsonFixture(fixture).then(parsePhraseTmsConfig)).resolves.toMatchObject({
      workflow: { sourceCatalog: { adapter: "formatjs-json" } },
    });
  });

  it("rejects the schema-invalid fixture", async () => {
    const invalid = await readJsonFixture(
      "../../../schemas/fixtures/phrase-tms-config.invalid.json",
    );
    expect(() => parsePhraseTmsConfig(invalid)).toThrow();
  });

  it("applies defaults for filename, completion policy, and state location", () => {
    expect(parsePhraseTmsConfig(minimalConfig)).toMatchObject({
      workflow: {
        sourceCatalog: { filename: "en.json" },
        completionPolicy: { default: "per-locale" },
      },
      stateBranch: "i18n-tms-state",
      stateDirectory: ".github/i18n-state/batches",
    });
  });

  it("accepts a separate Frontend template path for the locale PR", () => {
    expect(
      parsePhraseTmsConfig({ ...minimalConfig, frontendTemplate: { path: "deploy/frontend.yaml" } })
        .workflow.frontendTemplate,
    ).toEqual({ path: "deploy/frontend.yaml" });
    for (const path of ["../frontend.yaml", "locales/en.json", "locales/fr.json"]) {
      expect(() =>
        parsePhraseTmsConfig({ ...minimalConfig, frontendTemplate: { path } }),
      ).toThrow();
    }
  });

  it("requires a FormatJS English source catalog for every Frontend template", () => {
    const frontendConfig = {
      ...minimalConfig,
      frontendTemplate: { path: "deploy/frontend.yaml" },
    };
    expect(() =>
      parsePhraseTmsConfig({
        ...frontendConfig,
        sourceCatalog: { ...minimalConfig.sourceCatalog, adapter: "icu-json" },
      }),
    ).toThrow(/formatjs-json and en/);
    expect(() =>
      parsePhraseTmsConfig({
        ...frontendConfig,
        sourceCatalog: { ...minimalConfig.sourceCatalog, locale: "fr" },
      }),
    ).toThrow(/formatjs-json and en/);
  });

  it.each([
    ["en", "canonical BCP 47"],
    ["EN", "canonical BCP 47"],
    ["zh_cn", "canonical BCP 47"],
    ["fr_FR", "canonical BCP 47"],
    ["zh-cn", 'use "zh-CN"'],
    ["fr-fr", 'use "fr-FR"'],
    ["zh-hant-tw", 'use "zh-Hant-TW"'],
    ["fr-FR-u-nu-latn", "canonical BCP 47"],
  ])("rejects unsupported FEO repository locale %s during parsing", (locale, hint) => {
    expect(() =>
      parsePhraseTmsConfig({
        ...minimalConfig,
        frontendTemplate: { path: "deploy/frontend.yaml" },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: locale, outputPath: "locales/fr.json" },
        ],
      }),
    ).toThrow(
      new RegExp(
        `Target repository locale "${locale}" is not a canonical FEO locale id.*${hint.replace(/[()]/g, "\\$&")}`,
      ),
    );
  });

  it.each(["fr", "ko", "ja", "zh-CN", "zh-Hant-TW", "es-419", "fil", "sr-Latn"])(
    "accepts canonical FEO repository locale %s and keeps Phrase codes as phraseLocale",
    (locale) => {
      const parsed = parsePhraseTmsConfig({
        ...minimalConfig,
        frontendTemplate: { path: "deploy/frontend.yaml" },
        targetLocales: [
          { phraseLocale: "zh_cn", repositoryLocale: locale, outputPath: "locales/x.json" },
        ],
      });
      expect(parsed.workflow.targetLocales[0]).toMatchObject({
        phraseLocale: "zh_cn",
        repositoryLocale: locale,
      });
    },
  );

  it("limits a FEO config to the operator's 32 locales per Frontend", () => {
    const locales =
      "ar bg cs da de el es et fi fr ga hr hu id it ja ko lt lv mt nl pl pt ro sk sl sv th tr uk vi zh hi".split(
        " ",
      );
    const parse = (count: number) =>
      parsePhraseTmsConfig({
        ...minimalConfig,
        frontendTemplate: { path: "deploy/frontend.yaml" },
        targetLocales: locales.slice(0, count).map((locale) => ({
          phraseLocale: locale,
          repositoryLocale: locale,
          outputPath: `locales/${locale}.json`,
        })),
      });
    expect(() => parse(32)).not.toThrow();
    expect(() => parse(33)).toThrow("at most 32 target locales, got 33");
  });

  it("leaves repository locales of non-FEO configs unrestricted", () => {
    expect(() =>
      parsePhraseTmsConfig({
        ...minimalConfig,
        targetLocales: [
          { phraseLocale: "fr_fr", repositoryLocale: "fr_FR", outputPath: "locales/fr.json" },
        ],
      }),
    ).not.toThrow();
  });

  it("opts into generating a FormatJS source catalog from Frontend YAML", () => {
    const config = {
      ...minimalConfig,
      sourceCatalog: {
        path: "deploy/locales/insights-rbac-ui-feo-frontend-en.json",
        adapter: "formatjs-json",
        locale: "en",
      },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
    };
    expect(parsePhraseTmsConfig(config).workflow.frontendTemplate).toEqual(config.frontendTemplate);
    expect(() =>
      parsePhraseTmsConfig({
        ...config,
        frontendTemplate: { ...config.frontendTemplate, generateSourceCatalog: "yes" },
      }),
    ).toThrow(/must be a boolean/);
    expect(() =>
      parsePhraseTmsConfig({
        ...config,
        sourceCatalog: { ...config.sourceCatalog, adapter: "icu-json" },
      }),
    ).toThrow(/formatjs-json/);
  });

  it.each(["./locales/en.json", "locales//en.json", "locales/en.json/", "locales/../en.json"])(
    "rejects the non-canonical source path %s",
    (path) => {
      expect(() =>
        parsePhraseTmsConfig({
          ...minimalConfig,
          sourceCatalog: { ...minimalConfig.sourceCatalog, path },
        }),
      ).toThrow(/repository-relative path/);
    },
  );

  it.each([
    "apiToken",
    "api_key",
    "API-KEY",
    "privateKey",
    "clientSecret",
    "password",
    "credentials",
  ])("rejects credential-like key %s", (key) => {
    expect(() => rejectCredentialFields({ targetOptions: { [key]: "x" } })).toThrow(
      /must not contain credentials/,
    );
  });

  it.each(["tokenize", "keyPrefix", "secretary", "authorName"])(
    "allows ordinary adapter option %s",
    (key) => {
      expect(() => rejectCredentialFields({ targetOptions: { [key]: "x" } })).not.toThrow();
    },
  );
});
