import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseCatalogValidationConfig } from "../src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("repository i18n contracts", () => {
  it("uses the committed npm lockfile for repository and production installs", async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    expect(manifest.packageManager).toMatch(/^npm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/);
    for (const name of ["ci", "release", "phrase-submit", "phrase-reconcile"]) {
      const workflow = await readFile(
        join(repositoryRoot, `.github/workflows/${name}.yml`),
        "utf8",
      );
      expect(workflow).toContain("run: npm ci");
      expect(workflow).toContain(".github/actions/setup-environment");
      expect(workflow).not.toMatch(/npm install --global npm@/);
      expect(workflow).not.toContain("bun install");
    }
    const container = await readFile(join(repositoryRoot, "Containerfile"), "utf8");
    expect(container).toContain("sha256sum package-lock.json");
    expect(container).toContain("npm ci --omit=dev");
    expect(container).toContain("corepack enable npm");
    expect(container).toContain("require('./package.json').packageManager");
    expect(container).not.toContain("bun");
    const release = parse(
      await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
    );
    expect(
      release.jobs.preflight.steps.some((step: { uses?: string }) =>
        step.uses?.includes(".github/actions/setup-environment"),
      ),
    ).toBe(false);
    const setup = release.jobs.release.steps.find((step: { uses?: string }) =>
      step.uses?.endsWith(".github/actions/setup-environment"),
    );
    expect(setup.with.cache).toBe("false");
  });

  it("keeps all consumer installers separate from the npm tooling install", async () => {
    const source = await readFile(
      join(repositoryRoot, ".github/workflows/i18n-validate.yml"),
      "utf8",
    );
    const workflow = parse(source);
    expect(workflow.on.workflow_call.inputs["package-manager"].default).toBe("npm");
    const steps = workflow.jobs.validate.steps;
    expect(
      steps.some(
        (step: { run?: string; "working-directory"?: string }) =>
          step.run === "npm ci" && step["working-directory"] === "i18n-tooling-source",
      ),
    ).toBe(true);
    // Unlike npm/Bun, the pnpm reusable-workflow branch is not exercised by CI yet.
    const pnpm = steps.find((step: { run?: string }) => step.run?.includes("corepack prepare"));
    expect(pnpm.if).toBe("inputs.package-manager == 'pnpm' && inputs.catalog-only != true");
    expect(source).toContain("pnpm install --frozen-lockfile");
    const ci = parse(await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.jobs["pack-parity"].strategy.matrix.pm).toEqual(["npm", "bun", "pnpm"]);
    expect(ci.jobs["reusable-cli"].strategy.matrix.pm).toEqual(["npm", "bun"]);
    expect(ci.jobs["reusable-cli"].with["package-manager"]).toBe("${{ matrix.pm }}");
  });

  it("takes the development runtime from .nvmrc while retaining compatibility jobs", async () => {
    const version = (await readFile(join(repositoryRoot, ".nvmrc"), "utf8")).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const ci = parse(await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
    for (const name of ["lockfile", "lint-format", "schema-contracts", "markdown"]) {
      const setup = ci.jobs[name].steps.find((step: { uses?: string }) =>
        step.uses?.endsWith(".github/actions/setup-environment"),
      );
      expect(setup.with?.["node-version"]).toBeUndefined();
    }
    for (const name of ["typecheck", "test", "build", "cli-smoke"]) {
      const setup = ci.jobs[name].steps.find((step: { uses?: string }) =>
        step.uses?.endsWith(".github/actions/setup-environment"),
      );
      expect(setup.with["node-version-file"]).toBeUndefined();
      expect(setup.with["node-version"]).toContain("24");
    }
    for (const name of [
      "reusable-cli",
      "reusable-workflow-self-test",
      "catalog-only-workflow-self-test",
    ]) {
      expect(ci.jobs[name].with["node-version"]).toBeUndefined();
    }
    const parity = ci.jobs["pack-parity"];
    expect(parity.strategy.matrix["node-version"]).toEqual(["22.14.0", 24]);
    const setup = parity.steps.find((step: { uses?: string }) =>
      step.uses?.endsWith(".github/actions/setup-environment"),
    );
    expect(setup.with["node-version"]).toBeUndefined();
    const action = parse(
      await readFile(join(repositoryRoot, ".github/actions/setup-environment/action.yml"), "utf8"),
    );
    expect(action.inputs["node-version"].default).toBe("");
    const node = action.runs.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(node.with["node-version-file"]).toContain("/.nvmrc");
    expect(node.with.cache).toContain("inputs.cache");
    const npm = action.runs.steps.find((step: { run?: string }) =>
      step.run?.includes("corepack enable npm"),
    );
    expect(npm["working-directory"]).toContain("inputs.working-directory");
    expect(npm.run).toContain("require('./package.json').packageManager");
  });

  it("defaults reusable workflows to the tooling pin without removing consumer overrides", async () => {
    for (const name of ["i18n-validate", "phrase-submit", "phrase-reconcile"]) {
      const workflow = parse(
        await readFile(join(repositoryRoot, `.github/workflows/${name}.yml`), "utf8"),
      );
      expect(workflow.on.workflow_call.inputs["node-version"].default).toBe("");
      const job = Object.values(workflow.jobs)[0] as {
        steps: { uses?: string; with?: Record<string, string> }[];
      };
      const setup = job.steps.find((step) => step.uses === "$/.github/actions/setup-environment");
      expect(setup?.with?.["node-version"]).toContain("inputs.node-version");
      expect(setup?.with?.["working-directory"]).toBe("i18n-tooling-source");
      if (name.startsWith("phrase-")) expect(setup?.with?.cache).toBe("false");
    }
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
