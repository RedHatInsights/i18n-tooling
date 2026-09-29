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
