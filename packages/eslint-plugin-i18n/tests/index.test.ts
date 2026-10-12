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
    const [missing] = await eslint.lintText(
      'formatMessage({ id: "missing", defaultMessage: "Hello." });',
      { filePath: "source.js" },
    );
    expect(
      missing.messages.some(
        (message) => message.ruleId === "i18n/no-missing-default-catalog-entry",
      ),
    ).toBe(true);
    const [invalid] = await eslint.lintText(
      'formatMessage({ id: "missing", defaultMessage: "{count, plural, one {item}}" });',
      { filePath: "source.js" },
    );
    expect(
      invalid.messages.some(
        (message) => message.ruleId === "formatjs/no-invalid-icu" && message.severity === 2,
      ),
    ).toBe(true);
    const [warning] = await eslint.lintText(
      'formatMessage({ id: "missing", defaultMessage: "{count, plural, one {one item} other {{count} items}}" });',
      { filePath: "source.js" },
    );
    expect(
      warning.messages.some(
        (message) => message.ruleId === "formatjs/prefer-pound-in-plural" && message.severity === 1,
      ),
    ).toBe(true);
  });
});
