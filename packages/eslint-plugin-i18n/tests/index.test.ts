import packageMetadata from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("plugin metadata", () => {
  it("uses the package version", () => {
    expect(plugin.meta.version).toBe(packageMetadata.version);
  });
});

describe("source config", () => {
  it("supports a consumer catalog override and reports ICU errors and warnings", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        ...plugin.configs!.source,
        {
          rules: {
            "i18n/no-missing-default-catalog-entry": [
              "error",
              { catalog: "tests/fixtures/en.json" },
            ],
          },
        },
      ],
    });
    for (const [defaultMessage, ruleId, severity] of [
      ["Hello.", "i18n/no-missing-default-catalog-entry", 2],
      ["{count, plural, one {item}}", "formatjs/no-invalid-icu", 2],
      [
        "{count, plural, one {one item} other {{count} items}}",
        "formatjs/prefer-pound-in-plural",
        1,
      ],
    ] as const) {
      const [result] = await eslint.lintText(
        `formatMessage({ id: "missing", defaultMessage: ${JSON.stringify(defaultMessage)} });`,
        { filePath: "source.js" },
      );
      expect(result.messages).toContainEqual(expect.objectContaining({ ruleId, severity }));
    }
  });
});
