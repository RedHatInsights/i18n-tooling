import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("repository i18n contracts", () => {
  it("forwards catalog settings through the reusable Node workflow", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github/workflows/i18n-validate.yml"),
      "utf8",
    );

    for (const input of [
      "catalog-adapter",
      "catalog-path",
      "catalog-role",
      "catalog-locale",
      "catalog-config",
      "source-glob",
    ]) {
      const environmentName = `I18N_${input.toUpperCase().replaceAll("-", "_")}`;
      expect(workflow).toContain(`      ${input}:`);
      expect(workflow).toContain(`          ${environmentName}: \${{ inputs.${input} }}`);
    }

    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow).toContain('npm run "$VALIDATION_COMMAND"');
    expect(workflow).toContain("Build source-catalog ESLint plugin");
    expect(workflow).toContain("Lint consumer source message IDs");
    expect(workflow).toContain('--config "$TOOLING_ROOT/scripts/eslint-source.config.mjs"');
    expect(workflow).toContain('"$I18N_SOURCE_GLOB"');
    expect(workflow).toContain("Cache Bun dependencies");
    expect(workflow).toContain("Cache npm dependencies");
  });

  it("splits typecheck, tests, and builds across Node 22 and 24", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("  push:");
    expect(workflow).toContain("  pull_request:");
    expect(workflow).toContain("node-version: [22, 24]");
    expect(workflow).toContain("run: npm run typecheck");
    expect(workflow).toContain("run: npm run test:coverage");
    expect(workflow).toContain("run: npm run build");
  });

  it("calls the reusable workflow with a real repository fixture", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("uses: $/.github/workflows/i18n-validate.yml");
    expect(workflow).toContain("validation-command: i18n:validate");
    expect(workflow).toContain(
      "catalog-path: packages/i18n-pipeline/tests/fixtures/rbac-ui/translation-template.json",
    );
    expect(workflow).toContain('source-glob: "packages/*/src/**/*.ts"');
    expect(workflow).toContain("validation-command: smoke:reusable-cli");
    expect(workflow).toContain("catalog-adapter: icu-json");
    expect(workflow).toContain(
      "catalog-path: packages/i18n-pipeline/tests/fixtures/insights-rbac/i18n-en.json",
    );
  });

  it("keeps backend problem details keyed by code, raw params, and English detail", async () => {
    const schema = JSON.parse(
      await readFile(join(repositoryRoot, "schemas/problem-details-i18n.schema.json"), "utf8"),
    ) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties).toHaveProperty("code");
    expect(schema.properties).toHaveProperty("params");
    expect(schema.properties).toHaveProperty("detail");
    expect(schema.required).toEqual(expect.arrayContaining(["code", "params", "detail"]));
    expect(schema.properties).not.toHaveProperty("key");
  });
});
