import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseCatalogValidationConfig } from "../src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("repository i18n contracts", () => {
  // Invariants on paths CI does not execute: the pnpm consumer branch and release permissions.
  it("keeps installer and release-permission invariants that CI does not exercise", async () => {
    const read = (path: string) => readFile(join(repositoryRoot, path), "utf8");
    const manifest = JSON.parse(await read("package.json"));
    expect(manifest.packageManager).toMatch(/^npm@\d+\.\d+\.\d+/);

    const validate = await read(".github/workflows/i18n-validate.yml");
    expect(validate).toContain("pnpm) pnpm install --frozen-lockfile ;;");
    const steps = parse(validate).jobs.validate.steps;
    expect(steps).toContainEqual(
      expect.objectContaining({ run: "npm ci", "working-directory": "i18n-tooling-source" }),
    );

    const release = parse(await read(".github/workflows/release.yml")).jobs;
    expect(release.check.permissions["id-token"]).toBeUndefined();
    expect(release.check.environment).toBeUndefined();
    expect(release.release.needs).toBe("check");
    expect(release.release.environment).toBe("npm-release");

    // Tag runs would race the release eligibility check.
    const ci = parse(await read(".github/workflows/ci.yml"));
    expect(ci.on.push).toEqual({ branches: ["**"] });
  });

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

    expect(workflow).toContain("$/.github/actions/setup-environment");
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow).toContain("      validation-config:");
    expect(workflow).toContain("      catalog-only:");
    expect(workflow).toContain("catalog-only mode requires validation-config");
    expect(workflow).toContain("if: inputs.catalog-only != true");
    expect(workflow).toContain('i18n-pipeline validate-project --config "$VALIDATION_CONFIG"');
    expect(workflow).toContain('"$PACKAGE_MANAGER" run "$VALIDATION_COMMAND"');
    expect(workflow).toContain("PACKAGE_MANAGER: ${{ inputs.package-manager }}");
    expect(workflow).toContain("VALIDATION_CONFIG: ${{ inputs.validation-config }}");
    expect(workflow).toContain("Build source-catalog ESLint plugin");
    expect(workflow).toContain("Lint consumer source message IDs");
    expect(workflow).toContain('--config "$TOOLING_ROOT/scripts/eslint-source.config.mjs"');
    expect(workflow).toContain('"$I18N_SOURCE_GLOB"');
    expect(workflow).toContain("Cache Bun dependencies");
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

  it("grants read access to the reusable locale-validation caller", async () => {
    const workflow = await readFile(
      join(repositoryRoot, "examples/phrase-consumer/.github/workflows/locale-validation.yml"),
      "utf8",
    );

    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow.split("    permissions:\n      contents: read")).toHaveLength(2);
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

  it("keeps the FEO consumer example within the catalog validation contract", async () => {
    const example = JSON.parse(
      await readFile(
        join(repositoryRoot, "examples/feo-consumer/i18n/catalog-validation.json"),
        "utf8",
      ),
    ) as unknown;
    const config = parseCatalogValidationConfig(example);

    expect(config.checks).toEqual([]);
    expect(config.feo).toEqual([
      {
        template: "deploy/frontend.yaml",
        source: "deploy/locales/translation-template.json",
        locales: { "zh-CN": "deploy/locales/zh-CN.json" },
      },
    ]);
  });
});
