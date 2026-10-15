import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILT_IN_CATALOG_ADAPTER_IDS, parseCatalogValidationConfig } from "../src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

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

  it("keeps optional, least-privilege GitHub App auth in the shared Phrase workflows", async () => {
    const tokenAction = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
    const tokenReference = "${{ steps.create-app-token.outputs.token || github.token }}";
    const targetRepository = "${{ steps.github-auth.outputs.target-repository }}";
    const selectorActionRaw = await readFile(
      join(repositoryRoot, ".github/actions/select-github-target/action.yml"),
      "utf8",
    );
    const selectorAction = parse(selectorActionRaw) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { value: string }>;
      runs: { using: string; steps: WorkflowStep[] };
    };
    const selectorStep = selectorAction.runs.steps.find((step) => step.id === "select")!;

    expect(selectorAction.runs.using).toBe("composite");
    expect(Object.keys(selectorAction.inputs)).toEqual([
      "app-client-id-set",
      "app-private-key-set",
      "repository",
      "base-ref",
      "require-base-ref",
    ]);
    expect(Object.keys(selectorAction.outputs)).toEqual([
      "mode",
      "target-repository",
      "target-owner",
      "target-name",
      "cross-repository",
      "checkout-ref",
    ]);
    for (const output of Object.keys(selectorAction.outputs)) {
      expect(selectorAction.outputs[output].value).toBe(
        "${{ steps.select.outputs." + output + " }}",
      );
    }
    expect(selectorStep.shell).toBe("bash");
    expect(selectorStep.env).toEqual({
      APP_CLIENT_ID_SET: "${{ inputs.app-client-id-set }}",
      APP_PRIVATE_KEY_SET: "${{ inputs.app-private-key-set }}",
      TARGET_REPOSITORY_INPUT: "${{ inputs.repository }}",
      CALLING_REPOSITORY: "${{ github.repository }}",
      CALLING_SHA: "${{ github.sha }}",
      BASE_REF: "${{ inputs.base-ref }}",
      REQUIRE_BASE_REF: "${{ inputs.require-base-ref }}",
    });
    expect(selectorStep.run).not.toContain("${{");
    expect(selectorStep.run).toContain(
      '[ "$APP_CLIENT_ID_SET" = "true" ] && [ "$APP_PRIVATE_KEY_SET" = "true" ]',
    );
    expect(selectorStep.run).toContain(
      '[ "$APP_CLIENT_ID_SET" = "false" ] && [ "$APP_PRIVATE_KEY_SET" = "false" ]',
    );
    expect(selectorStep.run).toContain("APP_CLIENT_ID and APP_PRIVATE_KEY");
    expect(selectorStep.run).toContain(
      '[[ "$target_repository" != */* || "$target_repository" == */*/* ]]',
    );
    expect(selectorStep.run).toContain('[[ ! "$target_owner" =~ ^[A-Za-z0-9-]+$ ]]');
    expect(selectorStep.run).toContain('[[ ! "$target_name" =~ ^[A-Za-z0-9._-]+$ ]]');
    expect(selectorStep.run).toContain('[ "$target_name" = "." ]');
    expect(selectorStep.run).toContain('[ "$target_name" = ".." ]');
    expect(selectorStep.run).toContain('checkout_ref="$CALLING_SHA"');
    expect(selectorStep.run).toContain('checkout_ref="$BASE_REF"');
    expect(selectorStep.run).toContain('echo "checkout-ref=$checkout_ref"');

    const workflows = [
      {
        path: ".github/workflows/phrase-submit.yml",
        jobName: "submit",
        permissions: { "permission-contents": "write" },
        requireBaseRef: "true",
        workflowInputs: [
          "config-path",
          "environment",
          "node-version",
          "base-ref",
          "repository",
          "retry-failed",
        ],
      },
      {
        path: ".github/workflows/phrase-reconcile.yml",
        jobName: "reconcile",
        permissions: {
          "permission-contents": "write",
          "permission-pull-requests": "write",
        },
        requireBaseRef: "false",
        workflowInputs: ["config-path", "environment", "node-version", "base-ref", "repository"],
      },
    ];

    for (const { path, jobName, permissions, requireBaseRef, workflowInputs } of workflows) {
      const raw = await readFile(join(repositoryRoot, path), "utf8");
      const workflow = parse(raw) as {
        on: {
          workflow_call: {
            inputs: Record<
              string,
              { default?: string; description?: string; required?: boolean; type?: string }
            >;
            secrets: Record<string, { description: string; required: boolean }>;
          };
        };
        jobs: Record<string, { concurrency: { group: string }; steps: WorkflowStep[] }>;
      };
      const job = workflow.jobs[jobName];
      const steps = job.steps;
      const authStep = steps.find((step) => step.id === "github-auth")!;
      const tokenStep = steps.find((step) => step.id === "create-app-token")!;
      const installStep = steps.find((step) => step.name === "Install i18n tooling dependencies")!;
      const cliStep = steps.find((step) => step.env?.GITHUB_AUTH_MODE)!;
      const consumerCheckouts = steps.filter(
        (step) =>
          step.uses === "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683" &&
          step.with?.repository === targetRepository,
      );
      const consumerCheckout = consumerCheckouts[0];

      expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(workflowInputs);
      if (jobName === "reconcile") {
        expect(workflow.on.workflow_call.inputs["base-ref"].description).toBe(
          "Optional target branch used only when repository targets another repository; same-repository runs check out the triggering commit",
        );
      }
      expect(workflow.on.workflow_call.inputs.repository).toMatchObject({
        type: "string",
        required: false,
        default: "",
      });
      expect(workflow.on.workflow_call.secrets.APP_CLIENT_ID).toMatchObject({ required: false });
      expect(workflow.on.workflow_call.secrets.APP_PRIVATE_KEY).toMatchObject({ required: false });
      const clientIdDescription = workflow.on.workflow_call.secrets.APP_CLIENT_ID.description;
      const privateKeyDescription = workflow.on.workflow_call.secrets.APP_PRIVATE_KEY.description;
      expect(clientIdDescription).toContain("APP_PRIVATE_KEY");
      expect(privateKeyDescription).toContain("APP_CLIENT_ID");
      for (const description of [clientIdDescription, privateKeyDescription]) {
        expect(description).toContain("bound environment");
        expect(description).toContain("App mode");
        expect(description).toContain("GITHUB_TOKEN mode");
        expect(description).toContain("leave both unset");
      }
      expect(job.concurrency.group).toContain("${{ inputs.repository || github.repository }}");
      expect(authStep.uses).toBe("$/.github/actions/select-github-target");
      expect(authStep.with).toEqual({
        "app-client-id-set": "${{ secrets.APP_CLIENT_ID != '' }}",
        "app-private-key-set": "${{ secrets.APP_PRIVATE_KEY != '' }}",
        repository: "${{ inputs.repository }}",
        "base-ref": "${{ inputs.base-ref }}",
        "require-base-ref": requireBaseRef,
      });
      expect(tokenStep.if).toBe("steps.github-auth.outputs.mode == 'app'");
      expect(tokenStep.uses).toBe(tokenAction);
      expect(raw).toContain(`${tokenAction} # v3.2.0`);
      expect(tokenStep.with).toMatchObject({
        "client-id": "${{ secrets.APP_CLIENT_ID }}",
        "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
        owner: "${{ steps.github-auth.outputs.target-owner }}",
        repositories: "${{ steps.github-auth.outputs.target-name }}",
      });
      expect(
        Object.fromEntries(
          Object.entries(tokenStep.with ?? {}).filter(([name]) => name.startsWith("permission-")),
        ),
      ).toEqual(permissions);
      expect(installStep.run).toBe("npm ci --ignore-scripts");
      expect(consumerCheckouts).toHaveLength(1);
      expect(consumerCheckout?.if).toBeUndefined();
      expect(consumerCheckout?.with).toMatchObject({
        repository: targetRepository,
        ref: "${{ steps.github-auth.outputs.checkout-ref }}",
        token: tokenReference,
        "persist-credentials": false,
      });
      expect(cliStep.env?.GITHUB_TOKEN).toBe(tokenReference);
      expect(cliStep.env?.TARGET_REPOSITORY).toBe(targetRepository);
      expect(cliStep.run).toContain("GitHub auth: app %s[bot]");
      expect(cliStep.run).toContain("GitHub auth: GITHUB_TOKEN (github-actions[bot])");
      expect(cliStep.run).toContain('--repository "$TARGET_REPOSITORY"');
      expect(cliStep.run!.indexOf("GitHub auth:")).toBeLessThan(cliStep.run!.indexOf("node "));
      expect(steps.every((step) => !step.run?.includes("${{"))).toBe(true);

      const appSecretReferences = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.includes("secrets.APP_CLIENT_ID") || line.includes("secrets.APP_PRIVATE_KEY"),
        );
      expect(appSecretReferences).toEqual([
        "app-client-id-set: ${{ secrets.APP_CLIENT_ID != '' }}",
        "app-private-key-set: ${{ secrets.APP_PRIVATE_KEY != '' }}",
        "client-id: ${{ secrets.APP_CLIENT_ID }}",
        "private-key: ${{ secrets.APP_PRIVATE_KEY }}",
      ]);

      if (jobName === "submit") {
        expect(cliStep.run).toContain('--base-ref "$I18N_BASE_REF"');
        expect(cliStep.run).toContain('--source-commit "$(git rev-parse HEAD)"');
      }
    }
  });

  it("executes GitHub target selection and validation", async () => {
    const actionRaw = await readFile(
      join(repositoryRoot, ".github/actions/select-github-target/action.yml"),
      "utf8",
    );
    const action = parse(actionRaw) as { runs: { steps: WorkflowStep[] } };
    const selectorScript = action.runs.steps.find((step) => step.id === "select")?.run;
    if (selectorScript === undefined) {
      throw new Error("select-github-target action is missing the select run script");
    }

    type SelectorEnvironment = {
      APP_CLIENT_ID_SET: "true" | "false";
      APP_PRIVATE_KEY_SET: "true" | "false";
      TARGET_REPOSITORY_INPUT: string;
      CALLING_REPOSITORY: string;
      CALLING_SHA: string;
      BASE_REF: string;
      REQUIRE_BASE_REF: "true" | "false";
    };
    const defaults: SelectorEnvironment = {
      APP_CLIENT_ID_SET: "false",
      APP_PRIVATE_KEY_SET: "false",
      TARGET_REPOSITORY_INPUT: "",
      CALLING_REPOSITORY: "owner/current",
      CALLING_SHA: "triggering-sha",
      BASE_REF: "",
      REQUIRE_BASE_REF: "false",
    };
    const runSelector = async (overrides: Partial<SelectorEnvironment> = {}) => {
      const directory = await mkdtemp(join(tmpdir(), "select-github-target-"));
      const outputPath = join(directory, "github-output");
      await writeFile(outputPath, "", "utf8");

      try {
        const result = spawnSync("bash", ["-c", selectorScript], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            ...defaults,
            ...overrides,
            GITHUB_OUTPUT: outputPath,
          },
        });
        return { result, output: await readFile(outputPath, "utf8") };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
    const outputValue = (output: string, name: string) =>
      output
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1);

    const appMode = await runSelector({ APP_CLIENT_ID_SET: "true", APP_PRIVATE_KEY_SET: "true" });
    expect(appMode.result.status).toBe(0);
    expect(outputValue(appMode.output, "mode")).toBe("app");

    const sameRepository = await runSelector();
    expect(sameRepository.result.status).toBe(0);
    expect(outputValue(sameRepository.output, "mode")).toBe("github-token");
    expect(outputValue(sameRepository.output, "checkout-ref")).toBe("triggering-sha");

    for (const mixedAppFlags of [
      { APP_CLIENT_ID_SET: "true" as const },
      { APP_PRIVATE_KEY_SET: "true" as const },
    ]) {
      const mixed = await runSelector(mixedAppFlags);
      expect(mixed.result.status).toBe(1);
      expect(mixed.result.stdout).toContain("APP_CLIENT_ID");
      expect(mixed.result.stdout).toContain("APP_PRIVATE_KEY");
    }

    const crossRepositoryWithGitHubToken = await runSelector({
      TARGET_REPOSITORY_INPUT: "owner/other",
    });
    expect(crossRepositoryWithGitHubToken.result.status).toBe(1);
    expect(crossRepositoryWithGitHubToken.result.stdout).toContain(
      "GITHUB_TOKEN cannot write to another repository",
    );

    const crossRepositorySubmitWithoutBaseRef = await runSelector({
      APP_CLIENT_ID_SET: "true",
      APP_PRIVATE_KEY_SET: "true",
      TARGET_REPOSITORY_INPUT: "owner/other",
      REQUIRE_BASE_REF: "true",
    });
    expect(crossRepositorySubmitWithoutBaseRef.result.status).toBe(1);
    expect(crossRepositorySubmitWithoutBaseRef.result.stdout).toContain("base-ref is required");

    for (const repository of ["a/b/c", "a", "owner/..", "own er/x"]) {
      const invalidRepository = await runSelector({ TARGET_REPOSITORY_INPUT: repository });
      expect(invalidRepository.result.status).toBe(1);
      expect(invalidRepository.result.stdout).toContain("repository must use owner/name form");
    }

    for (const baseRef of ["main\nbranch", "main\rbranch"]) {
      const invalidBaseRef = await runSelector({ BASE_REF: baseRef });
      expect(invalidBaseRef.result.status).toBe(1);
      expect(invalidBaseRef.result.stdout).toContain("base-ref must be a single-line ref");
      expect(invalidBaseRef.output).toBe("");
    }

    const crossRepositoryWithBaseRef = await runSelector({
      APP_CLIENT_ID_SET: "true",
      APP_PRIVATE_KEY_SET: "true",
      TARGET_REPOSITORY_INPUT: "owner/other",
      BASE_REF: "release/2026",
    });
    expect(crossRepositoryWithBaseRef.result.status).toBe(0);
    expect(outputValue(crossRepositoryWithBaseRef.output, "checkout-ref")).toBe("release/2026");

    const crossRepositoryReconcileWithoutBaseRef = await runSelector({
      APP_CLIENT_ID_SET: "true",
      APP_PRIVATE_KEY_SET: "true",
      TARGET_REPOSITORY_INPUT: "owner/other",
    });
    expect(crossRepositoryReconcileWithoutBaseRef.result.status).toBe(0);
    expect(crossRepositoryReconcileWithoutBaseRef.output.split("\n")).toContain("checkout-ref=");
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

  it("triggers the example Phrase callers on merge and on a schedule, with manual fallbacks", async () => {
    const consumer = join(repositoryRoot, "examples/phrase-consumer");
    const read = (path: string) => readFile(join(consumer, path), "utf8");
    const submit = parse(await read(".github/workflows/phrase-submit.yml"));
    const reconcile = parse(await read(".github/workflows/phrase-reconcile.yml"));
    const configPath = submit.jobs.submit.with["config-path"];
    const config = JSON.parse(await read(configPath));

    expect(reconcile.jobs.reconcile.with["config-path"]).toBe(configPath);
    expect(submit.on.push.branches).toEqual(["main"]);
    expect(submit.on.push.paths).toEqual([config.sourceCatalog.path, configPath]);
    expect(submit.on.workflow_dispatch.inputs["retry-failed"]).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(submit.jobs.submit.with["retry-failed"]).toBe("${{ inputs.retry-failed == true }}");

    expect(reconcile.on.schedule).toHaveLength(1);
    expect(reconcile.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    expect(reconcile.on).toHaveProperty("workflow_dispatch");
  });

  it("limits the TMS config schema to the built-in adapters", async () => {
    const schema = JSON.parse(
      await readFile(join(repositoryRoot, "schemas/phrase-tms-config.schema.json"), "utf8"),
    );

    expect(schema.$defs.builtInAdapter.enum).toEqual(BUILT_IN_CATALOG_ADAPTER_IDS);
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
