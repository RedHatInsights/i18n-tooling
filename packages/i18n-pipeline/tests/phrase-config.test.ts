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
