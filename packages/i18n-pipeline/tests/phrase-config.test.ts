import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parsePhraseTmsConfig, rejectCredentialFields } from "../src/phrase-config.js";

async function readJsonFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

const minimalConfig = {
  provider: "phrase",
  project: { uid: "project-uid", region: "eu" },
  sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
  targetLocales: [{ phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" }],
};

describe("Phrase TMS config parser", () => {
  it.each([
    "../../../schemas/fixtures/phrase-tms-config.valid.json",
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
