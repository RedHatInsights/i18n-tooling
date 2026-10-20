import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  FEO_LOCALE_PATTERN_SOURCE,
  assertFeoLocaleId,
  exceedsFeoMessageLength,
  isFeoLocaleId,
  overlongFeoTranslationsWarning,
  suggestFeoLocale,
} from "../src/feo-locale.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Ids that the Frontend operator CRD accepts, and ids it rejects, with the expected suggestion. */
const ACCEPTED_FEO_LOCALES = ["fr", "ko", "ja", "zh-CN", "zh-Hant-TW", "es-419", "fil", "sr-Latn"];
const REJECTED_FEO_LOCALES: [locale: string, suggestion: string | undefined][] = [
  ["zh-cn", "zh-CN"],
  ["fr-fr", "fr-FR"],
  ["zh-hant-tw", "zh-Hant-TW"],
  ["fr-FR-u-nu-latn", undefined],
  ["fr_FR", undefined],
  ["EN", undefined],
  ["en", undefined],
];

describe("FEO locale ids", () => {
  it.each(ACCEPTED_FEO_LOCALES)("accepts %s", (locale) => {
    expect(isFeoLocaleId(locale)).toBe(true);
  });

  it.each(REJECTED_FEO_LOCALES)("rejects %s and suggests %s", (locale, suggestion) => {
    expect(isFeoLocaleId(locale)).toBe(false);
    expect(suggestFeoLocale(locale)).toBe(suggestion);
    expect(() => assertFeoLocaleId(locale, "Locale")).toThrow(
      `Locale ${JSON.stringify(locale)} is not a canonical FEO locale id; ` +
        (suggestion === undefined ? "use canonical BCP 47" : `use "${suggestion}"`),
    );
  });

  // The CRD pattern accepts these, but locale resolution would only ever look for the replacement.
  it.each([
    ["iw", "he"],
    ["in", "id"],
    ["ji", "yi"],
    ["mo", "ro"],
    ["sh", "sr-Latn"],
  ])("rejects deprecated alias %s and suggests %s", (locale, suggestion) => {
    expect(isFeoLocaleId(locale)).toBe(false);
    expect(suggestFeoLocale(locale)).toBe(suggestion);
  });

  it("rejects trailing newlines and other shapes outside language, script and region", () => {
    for (const locale of [
      "fr\n",
      "f",
      "fran",
      "fr-",
      "fr-FR-x",
      "fr-Latn-Latn",
      "zh-Hant-TW-1",
      "",
    ]) {
      expect(isFeoLocaleId(locale)).toBe(false);
    }
  });

  it("counts message length in code points, as the CRD does", () => {
    expect(exceedsFeoMessageLength("a".repeat(4096))).toBe(false);
    expect(exceedsFeoMessageLength("a".repeat(4097))).toBe(true);
    // 4096 code points are 8192 UTF-16 units.
    expect(exceedsFeoMessageLength("\u{1F600}".repeat(4096))).toBe(false);
    expect(exceedsFeoMessageLength("\u{1F600}".repeat(4097))).toBe(true);
  });

  it("warns about overlong translations by key, and only about those", () => {
    expect(overlongFeoTranslationsWarning("fr", { a: "x", b: "y".repeat(4096) })).toBeUndefined();
    const warning = overlongFeoTranslationsWarning("fr", {
      b: "y".repeat(4097),
      a: "x".repeat(4097),
      c: "ok",
    });
    expect(warning).toContain('FEO locale "fr"');
    expect(warning).toContain("4096-character limit");
    expect(warning).toMatch(/fall back to English: a, b$/);
  });

  it.each(["catalog-validation-config", "phrase-tms-config"])(
    "keeps the %s schema pattern in sync with the source constant",
    async (name) => {
      const text = await readFile(join(repositoryRoot, "schemas", `${name}.schema.json`), "utf8");
      expect(text).toContain(JSON.stringify(FEO_LOCALE_PATTERN_SOURCE).slice(1, -1));
    },
  );

  describe("schemas", () => {
    async function compile(name: string) {
      const schema = JSON.parse(
        await readFile(join(repositoryRoot, "schemas", `${name}.schema.json`), "utf8"),
      );
      return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    }
    const accepted = ACCEPTED_FEO_LOCALES;
    const rejected = REJECTED_FEO_LOCALES.map(([locale]) => locale);

    it("validates feo.locales keys in the catalog validation config schema", async () => {
      const validate = await compile("catalog-validation-config");
      const config = (locale: string) => ({
        version: 1,
        checks: [],
        feo: [
          {
            template: "deploy/frontend.yaml",
            source: "deploy/locales/translation-template.json",
            locales: { [locale]: "deploy/locales/x.json" },
          },
        ],
      });
      for (const locale of accepted) expect(validate(config(locale)), locale).toBe(true);
      for (const locale of rejected) expect(validate(config(locale)), locale).toBe(false);
    });

    it("validates repositoryLocale of a FEO Phrase config but leaves phraseLocale alone", async () => {
      const validate = await compile("phrase-tms-config");
      const config = (repositoryLocale: string, phraseLocale = "zh_cn", feo = true) => ({
        provider: "phrase",
        project: { uid: "project-uid", region: "eu" },
        sourceCatalog: { path: "deploy/locales/en.json", adapter: "formatjs-json", locale: "en" },
        ...(feo ? { frontendTemplate: { path: "deploy/frontend.yaml" } } : {}),
        targetLocales: [{ phraseLocale, repositoryLocale, outputPath: "deploy/locales/x.json" }],
      });
      for (const locale of accepted) expect(validate(config(locale)), locale).toBe(true);
      for (const locale of rejected) expect(validate(config(locale)), locale).toBe(false);
      expect(validate(config("zh-CN", "zh_cn"))).toBe(true);
      // Non-FEO Phrase configs keep their free-form repository locales.
      expect(validate(config("fr_FR", "fr_fr", false))).toBe(true);
    });
  });
});
