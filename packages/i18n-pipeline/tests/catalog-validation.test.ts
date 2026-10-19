import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCatalogValidationConfig } from "../src/index.js";
import { runCli } from "../src/cli.js";

let projectRoot: string | undefined;

const feoTemplate = `apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: validation-fixture
objects:
  - apiVersion: v1
    kind: Frontend
    metadata:
      name: sample-console
    spec:
      bundleSegments:
        - bundleId: access
          segmentId: administration
          navItems:
            - id: accounts
              title: Manage access
              permissions:
                - account:read
            - id: groups
              title: Manage access
              permissions:
                - group:read
      searchEntries:
        - id: people
          title: User management
          description: Manage people and their permissions
          alt_title: [People, Accounts]
      serviceTiles:
        - section: security
          group: access
          id: user-management
          title: User access
          description: Manage console access for your team
      module:
        defaultDocumentTitle: Access Management
`;

const feoZhTranslations = {
  "bundleSegments.access.administration.navItems.accounts.title": "SAMPLE ONLY — NOT REVIEWED 账户",
  "bundleSegments.access.administration.navItems.groups.title": "SAMPLE ONLY — NOT REVIEWED 群组",
  "searchEntries.people.title": "SAMPLE ONLY — NOT REVIEWED 用户管理",
  "searchEntries.people.description": "SAMPLE ONLY — NOT REVIEWED 管理人员及其权限",
  "searchEntries.people.alt_title.people": "SAMPLE ONLY — NOT REVIEWED 人员",
  "searchEntries.people.alt_title.accounts": "SAMPLE ONLY — NOT REVIEWED 账户",
  "serviceTiles.security.access.user-management.title": "SAMPLE ONLY — NOT REVIEWED 用户访问",
  "serviceTiles.security.access.user-management.description":
    "SAMPLE ONLY — NOT REVIEWED 管理团队的控制台访问权限",
  "module.defaultDocumentTitle": "SAMPLE ONLY — NOT REVIEWED 访问管理",
};

const feoFrTranslations = {
  "bundleSegments.access.administration.navItems.accounts.title": "EXAMPLE NOT REVIEWED Comptes",
  "bundleSegments.access.administration.navItems.groups.title": "EXAMPLE NOT REVIEWED Équipes",
  "searchEntries.people.title": "EXAMPLE NOT REVIEWED Gestion des utilisateurs",
  "searchEntries.people.description": "EXAMPLE NOT REVIEWED Gérer les personnes et leurs droits",
  "searchEntries.people.alt_title.people": "EXAMPLE NOT REVIEWED Personnes",
  "searchEntries.people.alt_title.accounts": "EXAMPLE NOT REVIEWED Comptes",
  "serviceTiles.security.access.user-management.title": "EXAMPLE NOT REVIEWED Accès utilisateur",
  "serviceTiles.security.access.user-management.description":
    "EXAMPLE NOT REVIEWED Gérer l'accès console de votre équipe",
  "module.defaultDocumentTitle": "EXAMPLE NOT REVIEWED Gestion des accès",
};

function feoValidationConfig(
  locales: Record<string, string> = {
    "zh-CN": "deploy/locales/zh-CN.json",
    fr: "deploy/locales/fr.json",
  },
): Record<string, unknown> {
  return {
    version: 1,
    checks: [],
    feo: [
      {
        template: "deploy/frontend.yaml",
        source: "deploy/locales/translation-template.json",
        locales,
      },
    ],
  };
}

async function runFeo(args: string[]): Promise<void> {
  const errors: string[] = [];
  const exitCode = await runCli(["feo", ...args], {
    cwd: projectRoot,
    env: {},
    stdout: () => undefined,
    stderr: (message) => errors.push(message),
  });
  if (exitCode !== 0) throw new Error(errors.join("\n"));
}

async function createFeoProject(): Promise<void> {
  await createProject();
  await mkdir(join(projectRoot!, "deploy/locales"), { recursive: true });
  await writeFile(join(projectRoot!, "deploy/frontend.yaml"), feoTemplate, "utf8");
  await writeFile(
    join(projectRoot!, "deploy/locales/zh-CN.json"),
    `${JSON.stringify(feoZhTranslations, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(projectRoot!, "deploy/locales/fr.json"),
    `${JSON.stringify(feoFrTranslations, null, 2)}\n`,
    "utf8",
  );
  await runFeo([
    "extract",
    "--template",
    "deploy/frontend.yaml",
    "--output",
    "deploy/locales/translation-template.json",
  ]);
  await runFeo([
    "inline",
    "--template",
    "deploy/frontend.yaml",
    "--source",
    "deploy/locales/translation-template.json",
    "--target",
    "deploy/locales/zh-CN.json",
    "--locale",
    "zh-CN",
  ]);
  await runFeo([
    "inline",
    "--template",
    "deploy/frontend.yaml",
    "--source",
    "deploy/locales/translation-template.json",
    "--target",
    "deploy/locales/fr.json",
    "--locale",
    "fr",
  ]);
}

async function createUndeliveredFeoProject(): Promise<void> {
  await createProject();
  await mkdir(join(projectRoot!, "deploy/locales"), { recursive: true });
  await writeFile(join(projectRoot!, "deploy/frontend.yaml"), feoTemplate, "utf8");
  await runFeo([
    "extract",
    "--template",
    "deploy/frontend.yaml",
    "--output",
    "deploy/locales/translation-template.json",
  ]);
}

async function createProject(): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), "i18n-validation-"));
  await mkdir(join(projectRoot, "locales"));
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({
      i18nTooling: { catalogAdapters: { "line-catalog": "./line-adapter.mjs" } },
    }),
  );
  await writeFile(
    join(projectRoot, "line-adapter.mjs"),
    `export default {
      id: "line-catalog",
      parseDocument(content) {
        const entries = Object.create(null);
        for (const line of content.trimEnd().split("\\n")) {
          if (!line) continue;
          const separator = line.indexOf(" = ");
          if (separator < 1) throw new Error("Expected id = message");
          entries[line.slice(0, separator)] = line.slice(separator + 3);
        }
        return entries;
      },
      serializeDocument(document) {
        return Object.entries(document).map(([id, message]) => id + " = " + message).join("\\n") + "\\n";
      },
      read(document, context) {
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          throw new Error("Expected a message map");
        }
        const messages = Object.fromEntries(Object.entries(document).map(([id, pattern]) => {
          if (typeof pattern !== "string") throw new Error("Expected string message");
          return [id, { pattern, metadata: {} }];
        }));
        return { locale: context.locale, messages };
      },
      write(catalog) {
        return Object.fromEntries(Object.entries(catalog.messages).map(([id, message]) => [id, message.pattern]));
      }
    };`,
  );
  await writeFile(
    join(projectRoot, "generate.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "greeting = Bonjour {name}\\n");\n`,
  );
  await writeFile(
    join(projectRoot, "locales/en.json"),
    JSON.stringify({ greeting: { defaultMessage: "Hello {name}" } }),
  );
  await writeFile(join(projectRoot, "locales/fr.messages"), "greeting = Bonjour {name}\n");
  await writeFile(
    join(projectRoot, "locales/fr-icu.json"),
    JSON.stringify({ greeting: "Bonjour {name}" }),
  );
  await writeFile(
    join(projectRoot, "validation.json"),
    JSON.stringify({
      version: 1,
      checks: [
        {
          source: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
          targets: [
            { path: "locales/fr.messages", adapter: "line-catalog", locale: "fr" },
            { path: "locales/fr-icu.json", adapter: "icu-json", locale: "fr" },
          ],
        },
      ],
      generated: [
        {
          path: "locales/fr.messages",
          adapter: "line-catalog",
          role: "target",
          locale: "fr",
          command: process.execPath,
          args: ["generate.mjs", "{output}"],
          updateCommand: "npm run translations:generate",
        },
      ],
      sourceLint: { files: ["src/**/*.tsx"], catalog: "locales/not-used.json" },
    }),
  );
}

async function runValidation(
  config: unknown,
): Promise<{ exitCode: number; output: string[]; errors: string[] }> {
  await writeFile(join(projectRoot!, "plan.json"), JSON.stringify(config));
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(["validate-project", "--config", "plan.json"], {
    cwd: projectRoot,
    env: {},
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  });
  return { exitCode, output, errors };
}

function validationWarnings(output: string[]): string[] {
  return output
    .flatMap((line) => line.split("\n"))
    .filter((line) => line.startsWith("- FEO locale "));
}

async function writeTmsConfig(): Promise<void> {
  await writeFile(
    join(projectRoot!, "phrase-tms.json"),
    JSON.stringify({
      provider: "phrase",
      project: { uid: "project-uid", region: "eu" },
      sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
      targetAdapter: "icu-json",
      targetLocales: [
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr-icu.json" },
        { phraseLocale: "zh_cn", repositoryLocale: "zh-CN", outputPath: "locales/zh-CN.json" },
      ],
    }),
  );
}

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("catalog project validation", () => {
  it("accepts and ignores sourceLint settings", async () => {
    await createProject();
    const parsed = parseCatalogValidationConfig(
      JSON.parse(await readFile(join(projectRoot!, "validation.json"), "utf8")),
    );

    expect(parsed.sourceLint).toEqual({
      files: ["src/**/*.tsx"],
      catalog: "locales/not-used.json",
    });
    const result = await runValidation(parsed);
    expect(result.exitCode).toBe(0);
  });

  it("rejects sourceLint paths outside the consumer root", () => {
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [],
        generated: [
          { path: "locales/en.json", command: "node", args: ["generate.mjs", "{output}"] },
        ],
        sourceLint: { catalog: "../outside.json" },
      }),
    ).toThrow("must be a repository-relative path without parent traversal");
  });

  it("checks different adapters and verifies generated text catalogs without a consumer validator", async () => {
    await createProject();
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["validate-project", "--config", "validation.json"], {
      cwd: projectRoot,
      env: {},
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "Catalog validation passed (1 source, 2 targets, 1 generated catalog).",
    ]);
    expect(errors).toEqual([]);
    expect(await readFile(join(projectRoot!, "locales/fr.messages"), "utf8")).toBe(
      "greeting = Bonjour {name}\n",
    );
  });

  it("reports an empty FEO section in the passing summary", async () => {
    await createProject();
    const config = JSON.parse(
      await readFile(join(projectRoot!, "validation.json"), "utf8"),
    ) as Record<string, unknown>;
    config.feo = [];

    const result = await runValidation(config);

    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual([
      "Catalog validation passed (1 source, 2 targets, 1 generated catalog, 0 FEO templates).",
    ]);
  });

  it("serializes converted catalogs with the output adapter's text format", async () => {
    await createProject();
    const errors: string[] = [];

    const exitCode = await runCli(
      [
        "convert",
        "--source",
        "locales/en.json",
        "--output",
        "generated/greeting.messages",
        "--source-adapter",
        "formatjs-json",
        "--target-adapter",
        "line-catalog",
      ],
      {
        cwd: projectRoot,
        env: {},
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(await readFile(join(projectRoot!, "generated/greeting.messages"), "utf8")).toBe(
      "greeting = Hello {name}\n",
    );
  });

  it("reports missing IDs, extra IDs, and ICU argument mismatches across adapters", async () => {
    await createProject();
    const configPath = join(projectRoot!, "validation.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      checks: Array<{ source: { path: string }; targets: unknown[] }>;
      generated: unknown[];
    };
    config.generated = [];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(projectRoot!, "locales/en.json"),
      JSON.stringify({
        greeting: { defaultMessage: "Hello {name}" },
        sourceOnly: { defaultMessage: "Source only" },
      }),
    );
    await writeFile(
      join(projectRoot!, "locales/fr.messages"),
      "greeting = Bonjour {user}\ntargetOnly = Target only\n",
    );
    const errors: string[] = [];

    const exitCode = await runCli(["validate-project", "--config", "validation.json"], {
      cwd: projectRoot,
      env: {},
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("missing from target: sourceOnly");
    expect(errors[0]).toContain("extra in target: targetOnly");
    expect(errors[0]).toContain('argument mismatch for "greeting": source [name], target [user]');
  });

  it("warns about plural semantics in the source without failing validation", async () => {
    await createProject();
    const configPath = join(projectRoot!, "validation.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      checks: Array<{ targets: unknown[] }>;
      generated: unknown[];
    };
    config.generated = [];
    config.checks[0]!.targets = [];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(projectRoot!, "locales/en.json"),
      JSON.stringify({
        remove: { defaultMessage: "{count, plural, one {{name}} other {# accounts}}" },
        items: { defaultMessage: "{count, plural, zero {None} other {# items}}" },
      }),
    );
    const run = async (env: NodeJS.ProcessEnv) => {
      const output: string[] = [];
      const exitCode = await runCli(["validate-project", "--config", "validation.json"], {
        cwd: projectRoot,
        env,
        stdout: (message) => output.push(message),
        stderr: () => undefined,
      });
      return { exitCode, output };
    };

    const local = await run({});
    expect(local.exitCode).toBe(0);
    expect(local.output[0]).toMatch(
      /^Catalog warnings:\n- Source catalog locales\/en.json: "items"/,
    );
    expect(local.output[0]).toContain('"remove": {name} appears only in the "one" branch');
    expect(local.output.at(-1)).toContain("Catalog validation passed");

    const actions = await run({ GITHUB_ACTIONS: "true" });
    expect(actions.exitCode).toBe(0);
    expect(
      actions.output.filter((line) => line.startsWith("::warning title=i18n-pipeline::")),
    ).toHaveLength(2);
  });

  it("explains argument mismatches caused by plural category branches in the source", async () => {
    await createProject();
    await writeTmsConfig();
    await writeFile(
      join(projectRoot!, "locales/en.json"),
      JSON.stringify({
        remove: { defaultMessage: "{count, plural, one {{name}} other {# accounts}}" },
      }),
    );
    await writeFile(
      join(projectRoot!, "locales/zh-CN.json"),
      JSON.stringify({ remove: "{count, plural, other {# 个帐户}}" }),
    );
    const result = await runValidation({ version: 1, tmsConfig: "phrase-tms.json", checks: [] });

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toContain(
      'argument mismatch for "remove": source [count, name], target [count] ' +
        '(source renders {name} only in the "one" branch of plural {count}',
    );
  });

  it("fails on lost exact plural branches and warns about target typography", async () => {
    await createProject();
    await writeTmsConfig();
    await writeFile(
      join(projectRoot!, "locales/en.json"),
      JSON.stringify({
        greeting: { defaultMessage: "Hello {name}" },
        remove: {
          defaultMessage: "{count, plural, =1 {Remove {name}?} other {Remove # accounts?}}",
        },
        items: { defaultMessage: "{total, plural, =1 {one item} other {# items}}" },
      }),
    );
    await writeFile(
      join(projectRoot!, "locales/fr-icu.json"),
      JSON.stringify({
        greeting: "Bonjour {name} !",
        remove: "{count, plural, =1 {Supprimer {name}\u00a0?} other {Supprimer # comptes\u00a0?}}",
        items: "{total, plural, =1 {un article} other {# articles}}",
      }),
    );
    await writeFile(
      join(projectRoot!, "locales/zh-CN.json"),
      JSON.stringify({
        greeting: "你好 {name}",
        remove: "{count, plural, other {删除 {name} # 个}}",
        items: "{total, number} 个",
      }),
    );

    const result = await runValidation({ version: 1, tmsConfig: "phrase-tms.json", checks: [] });

    expect(result.exitCode).toBe(1);
    expect(result.output[0]).toContain(
      'Target catalog locales/fr-icu.json: "greeting": a regular space precedes',
    );
    expect(result.errors[0]).toContain(
      'Target catalog locales/zh-CN.json: "remove": plural {count} lost exact branch =1',
    );
    expect(result.errors[0]).toContain(
      'Target catalog locales/zh-CN.json: "items": plural {total} lost exact branch =1',
    );
  });

  it("reports every invalid ICU message with a location and readable parser detail", async () => {
    await createProject();
    await writeFile(
      join(projectRoot!, "locales/en.json"),
      JSON.stringify({
        greeting: { defaultMessage: "Hello {name" },
        items: { defaultMessage: "{count, plural, one {# item}}" },
      }),
    );

    const result = await runValidation({
      version: 1,
      checks: [
        {
          source: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
          targets: [],
        },
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toContain(
      'Source catalog "locales/en.json" failed adapter validation',
    );
    expect(result.errors[0]).toContain(
      '  - formatjs-json message "greeting" has invalid ICU syntax at pattern line 1, column 7: ' +
        "Expected argument closing brace (EXPECT_ARGUMENT_CLOSING_BRACE)",
    );
    expect(result.errors[0]).toContain(
      '  - formatjs-json message "items" has invalid ICU syntax at pattern line 1, column 29: ' +
        "Missing other clause (MISSING_OTHER_CLAUSE)",
    );
  });

  it("reports generated catalogs that differ from the generator output", async () => {
    await createProject();
    await writeFile(join(projectRoot!, "locales/fr.messages"), "greeting = Salut {name}\n");
    const errors: string[] = [];

    const exitCode = await runCli(["validate-project", "--config", "validation.json"], {
      cwd: projectRoot,
      env: {},
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain('Generated catalog "locales/fr.messages" is out of date');
    expect(errors[0]).toContain("npm run translations:generate");
    expect(await readFile(join(projectRoot!, "locales/fr.messages"), "utf8")).toBe(
      "greeting = Salut {name}\n",
    );
  });

  it("rejects catalog paths outside the consumer repository", () => {
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [
          {
            source: { path: "../locales/en.json", adapter: "formatjs-json", locale: "en" },
            targets: [],
          },
        ],
      }),
    ).toThrowError("must be a repository-relative path without parent traversal");
  });

  it("requires generator arguments to contain the temporary output placeholder", () => {
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [],
        generated: [
          {
            path: "locales/en.json",
            adapter: "formatjs-json",
            role: "source",
            locale: "en",
            command: "npx",
            args: ["formatjs", "extract"],
          },
        ],
      }),
    ).toThrowError(
      'Catalog validation config "generated[0]".args must include the {output} placeholder',
    );
  });
  it("compares adapter-free generated files as plain JSON", async () => {
    await createProject();
    await writeFile(
      join(projectRoot!, "aggregate.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `const fr = JSON.parse(readFileSync("locales/fr-icu.json", "utf8"));\n` +
        `writeFileSync(process.argv[2], JSON.stringify({ fr }));\n`,
    );
    const generated = [
      { path: "locales/data.json", command: process.execPath, args: ["aggregate.mjs", "{output}"] },
    ];
    await writeFile(
      join(projectRoot!, "locales/data.json"),
      JSON.stringify({ fr: { greeting: "Bonjour {name}" } }, null, 2),
    );

    const current = await runValidation({ version: 1, checks: [], generated });
    expect(current.exitCode).toBe(0);
    expect(current.output).toEqual([
      "Catalog validation passed (0 sources, 0 targets, 1 generated catalog).",
    ]);

    await writeFile(join(projectRoot!, "locales/data.json"), JSON.stringify({ fr: {} }));
    const stale = await runValidation({ version: 1, checks: [], generated });
    expect(stale.exitCode).toBe(1);
    expect(stale.errors[0]).toContain('Generated catalog "locales/data.json" is out of date');
  });

  it("checks delivered TMS targets and counts undelivered ones as pending", async () => {
    await createProject();
    await writeTmsConfig();

    const passed = await runValidation({ version: 1, tmsConfig: "phrase-tms.json", checks: [] });
    expect(passed.exitCode).toBe(0);
    expect(passed.output).toEqual([
      "Catalog validation passed (1 source, 1 target, 0 generated catalogs, 1 pending TMS target).",
    ]);

    await writeFile(
      join(projectRoot!, "locales/zh-CN.json"),
      JSON.stringify({ greeting: "你好 {user}" }),
    );
    const failed = await runValidation({ version: 1, tmsConfig: "phrase-tms.json", checks: [] });
    expect(failed.exitCode).toBe(1);
    expect(failed.errors[0]).toContain(
      'Catalog check locales/en.json -> locales/zh-CN.json: argument mismatch for "greeting"',
    );
  });

  it("counts an empty placeholder TMS target as pending with a warning", async () => {
    await createProject();
    await writeTmsConfig();
    await writeFile(join(projectRoot!, "locales/zh-CN.json"), "{}\n");

    const result = await runValidation({ version: 1, tmsConfig: "phrase-tms.json", checks: [] });

    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain(
      'TMS target "locales/zh-CN.json" is an empty placeholder; counted as pending',
    );
    expect(result.output.at(-1)).toBe(
      "Catalog validation passed (1 source, 1 target, 0 generated catalogs, 1 pending TMS target).",
    );
  });

  it("still checks an empty placeholder named directly in checks", async () => {
    await createProject();
    await writeFile(join(projectRoot!, "locales/zh-CN.json"), "{}\n");

    const result = await runValidation({
      version: 1,
      checks: [
        {
          source: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
          targets: [{ path: "locales/zh-CN.json", adapter: "icu-json", locale: "zh-CN" }],
        },
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toContain("missing from target: greeting");
  });

  it("reports catalog files that the plan does not declare", async () => {
    await createProject();
    await writeTmsConfig();
    await writeFile(join(projectRoot!, "locales/de.json"), JSON.stringify({ greeting: "Hallo" }));

    const result = await runValidation({
      version: 1,
      tmsConfig: "phrase-tms.json",
      checks: [],
      catalogDirectories: [{ path: "locales" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toContain('Catalog "locales/de.json" is not declared');
    expect(result.errors[0]).not.toContain("locales/en.json");
    expect(result.errors[0]).not.toContain("locales/fr-icu.json");
    expect(result.errors[0]).not.toContain("fr.messages");
  });

  it("rejects catalog settings on adapter-free generated files", () => {
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [],
        generated: [
          { path: "locales/data.json", locale: "en", command: "node", args: ["x", "{output}"] },
        ],
      }),
    ).toThrowError('Catalog validation config "generated[0]".locale requires an adapter');
  });

  it("accepts a FEO-only validation plan with an empty locale map", () => {
    const config = parseCatalogValidationConfig({
      version: 1,
      checks: [],
      feo: [
        {
          template: "deploy/frontend.yaml",
          source: "deploy/locales/translation-template.json",
          locales: {},
        },
      ],
    });

    expect(config.feo).toEqual([
      {
        template: "deploy/frontend.yaml",
        source: "deploy/locales/translation-template.json",
        locales: {},
      },
    ]);
  });

  it("passes in-sync FEO files and declares them to catalogDirectories", async () => {
    await createFeoProject();
    const config = {
      ...feoValidationConfig(),
      catalogDirectories: [{ path: "deploy/locales" }],
    };

    const result = await runValidation(config);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([
      "Catalog validation passed (0 sources, 0 targets, 0 generated catalogs, 1 FEO template).",
    ]);
  });

  it("validates dotted FEO IDs and shared alias keys through the FEO adapter", async () => {
    await createProject();
    await mkdir(join(projectRoot!, "deploy/locales"), { recursive: true });
    const template = `kind: Template
objects:
  - kind: Frontend
    spec:
      searchEntries:
        - id: RHEL.ros
          title: RHEL ROS
          alt_title: [acs, ACS, operators]
      bundleSegments:
        - bundleId: hybrid-committed-spend
          segmentId: main
          navItems:
            - id: hybrid-committed-spend.nav
              routes:
                - id: hybrid-committed-spend.overview
                  title: Overview
`;
    await writeFile(join(projectRoot!, "deploy/frontend.yaml"), template, "utf8");
    const translations = {
      "searchEntries.RHEL.ros.title": "RHEL ROS FR",
      "searchEntries.RHEL.ros.alt_title.acs": "ACS FR",
      "bundleSegments.hybrid-committed-spend.main.navItems.hybrid-committed-spend.nav.routes.hybrid-committed-spend.overview.title":
        "Overview FR",
    };
    await writeFile(
      join(projectRoot!, "deploy/locales/fr.json"),
      `${JSON.stringify(translations, null, 2)}\n`,
      "utf8",
    );
    await runFeo([
      "extract",
      "--template",
      "deploy/frontend.yaml",
      "--output",
      "deploy/locales/translation-template.json",
    ]);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/fr.json",
      "--locale",
      "fr",
    ]);

    const result = await runValidation(feoValidationConfig({ fr: "deploy/locales/fr.json" }));

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([
      "Catalog validation passed (0 sources, 0 targets, 0 generated catalogs, 1 FEO template).",
    ]);
  });

  it("skips listed FEO locales that have not been delivered", async () => {
    await createUndeliveredFeoProject();
    const locales = {
      "zh-CN": "deploy/locales/zh-CN.json",
      fr: "deploy/locales/fr.json",
      ja: "deploy/locales/ja.json",
      de: "deploy/locales/de.json",
    };

    const result = await runValidation(feoValidationConfig(locales));

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    const notes = validationWarnings(result.output);
    expect(notes).toHaveLength(4);
    for (const locale of Object.keys(locales)) {
      expect(
        notes.some((note) => note.includes(`"${locale}"`) && note.includes("not delivered yet")),
      ).toBe(true);
    }
  });

  it("checks a delivered FEO locale while other configured locales remain undelivered", async () => {
    await createUndeliveredFeoProject();
    const locales = {
      "zh-CN": "deploy/locales/zh-CN.json",
      fr: "deploy/locales/fr.json",
      ja: "deploy/locales/ja.json",
      de: "deploy/locales/de.json",
    };
    const zhPath = join(projectRoot!, locales["zh-CN"]);
    await writeFile(zhPath, `${JSON.stringify(feoZhTranslations, null, 2)}\n`, "utf8");
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      locales["zh-CN"],
      "--locale",
      "zh-CN",
    ]);

    const valid = await runValidation(feoValidationConfig(locales));

    expect(valid.exitCode).toBe(0);
    expect(valid.errors).toEqual([]);
    expect(validationWarnings(valid.output)).toHaveLength(3);
    expect(validationWarnings(valid.output).join("\n")).not.toContain('"zh-CN"');

    await writeFile(
      zhPath,
      `${JSON.stringify({ ...feoZhTranslations, "searchEntries.people.missing": "未知" }, null, 2)}\n`,
      "utf8",
    );
    const invalid = await runValidation(feoValidationConfig(locales));

    expect(invalid.exitCode).toBe(1);
    expect(invalid.errors.join("\n")).toContain(
      "Unknown translation key: searchEntries.people.missing",
    );
    expect(validationWarnings(invalid.output)).toHaveLength(3);
  });

  it("reports a missing FEO locale file when the template already has its block", async () => {
    await createUndeliveredFeoProject();
    const localePath = "deploy/locales/zh-CN.json";
    const absoluteLocalePath = join(projectRoot!, localePath);
    await writeFile(absoluteLocalePath, `${JSON.stringify(feoZhTranslations, null, 2)}\n`, "utf8");
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      localePath,
      "--locale",
      "zh-CN",
    ]);
    await rm(absoluteLocalePath);

    const result = await runValidation(feoValidationConfig({ "zh-CN": localePath }));

    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain('FEO locale "zh-CN"');
    expect(result.errors.join("\n")).toContain("could not be read: ENOENT");
    expect(validationWarnings(result.output)).toEqual([]);
  });

  it("reports a FEO locale path that is a directory", async () => {
    await createUndeliveredFeoProject();
    const localePath = "deploy/locales/ja.json";
    await mkdir(join(projectRoot!, localePath));

    const result = await runValidation(feoValidationConfig({ ja: localePath }));

    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain('FEO locale "ja"');
    expect(result.errors.join("\n")).toContain(`"${localePath}" could not be read`);
    expect(validationWarnings(result.output)).toEqual([]);
  });

  it("validates per-alias FEO keys and allows an untranslated alias", async () => {
    await createFeoProject();
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    delete locale["searchEntries.people.alt_title.accounts"];
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/zh-CN.json",
      "--locale",
      "zh-CN",
    ]);

    const source = JSON.parse(
      await readFile(join(projectRoot!, "deploy/locales/translation-template.json"), "utf8"),
    ) as Record<string, unknown>;
    const template = await readFile(join(projectRoot!, "deploy/frontend.yaml"), "utf8");
    const zhLocale = template.split("        zh-CN:\n")[1]?.split("        fr:\n")[0] ?? "";
    const result = await runValidation(feoValidationConfig());

    expect(source).toHaveProperty("searchEntries.people.alt_title.people");
    expect(source).toHaveProperty("searchEntries.people.alt_title.accounts");
    expect(zhLocale).toContain("searchEntries.people.alt_title.people:");
    expect(zhLocale).not.toContain("searchEntries.people.alt_title.accounts:");
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("reports locale findings in the order configured", async () => {
    await createFeoProject();
    const zhPath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const zh = JSON.parse(await readFile(zhPath, "utf8")) as Record<string, string>;
    zh["searchEntries.people.missing"] = "未知";
    await writeFile(zhPath, `${JSON.stringify(zh, null, 2)}\n`);
    const frPath = join(projectRoot!, "deploy/locales/fr.json");
    const fr = JSON.parse(await readFile(frPath, "utf8")) as Record<string, string>;
    fr["searchEntries.people.missing"] = "Inconnue";
    await writeFile(frPath, `${JSON.stringify(fr, null, 2)}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]!;
    const zhFinding = message.indexOf('FEO locale "zh-CN"');
    const frFinding = message.indexOf('FEO locale "fr"');
    expect(zhFinding).toBeGreaterThanOrEqual(0);
    expect(frFinding).toBeGreaterThan(zhFinding);
  });

  it("reports translations left behind by an English-only edit", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    await writeFile(path, template.replace("title: User management", "title: People management"));

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      'FEO source catalog "deploy/locales/translation-template.json"',
    );
    expect(result.errors[0]).toContain('"deploy/frontend.yaml"');
    expect(result.errors[0]).toContain(
      "i18n-pipeline feo extract --template deploy/frontend.yaml --output deploy/locales/translation-template.json",
    );
    for (const [locale, file] of [
      ["zh-CN", "deploy/locales/zh-CN.json"],
      ["fr", "deploy/locales/fr.json"],
    ]) {
      expect(result.errors[0]).toContain(
        `FEO locale "${locale}" in "${file}" still has translations for English that changed ` +
          'in template "deploy/frontend.yaml": searchEntries.people.title.',
      );
    }
    expect(result.errors[0]).not.toContain("searchEntries.people.description");
    expect(result.errors[0]).not.toContain("English source changed for");
  });

  it("reports only English drift when the changed key has no translation", async () => {
    await createFeoProject();
    for (const [locale, translations] of [
      ["zh-CN", feoZhTranslations],
      ["fr", feoFrTranslations],
    ] as const) {
      const { "module.defaultDocumentTitle": _untranslated, ...rest } = translations;
      await writeFile(
        join(projectRoot!, `deploy/locales/${locale}.json`),
        `${JSON.stringify(rest, null, 2)}\n`,
      );
      await runFeo([
        "inline",
        "--template",
        "deploy/frontend.yaml",
        "--source",
        "deploy/locales/translation-template.json",
        "--target",
        `deploy/locales/${locale}.json`,
        "--locale",
        locale,
      ]);
    }
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    await writeFile(
      path,
      template.replace(
        "defaultDocumentTitle: Access Management",
        "defaultDocumentTitle: Access Administration",
      ),
    );

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not byte-identical to the extraction output");
    expect(result.errors[0]).not.toContain("FEO locale");
  });

  it("reports template locales that the FEO entry does not configure", async () => {
    await createFeoProject();
    const config = feoValidationConfig();
    const entries = config.feo as Array<{ locales: Record<string, string> }>;
    delete entries[0]!.locales.fr;

    const partial = await runValidation(config);

    expect(partial.exitCode).toBe(1);
    expect(partial.errors).toHaveLength(1);
    expect(partial.errors[0]).toContain(
      'FEO template "deploy/frontend.yaml" has spec.locales for "fr", but its "feo" entry does ' +
        "not list that locale",
    );
    expect(partial.errors[0]).not.toContain('spec.locales for "zh-CN"');

    entries[0]!.locales = {};
    const empty = await runValidation(config);

    expect(empty.exitCode).toBe(1);
    expect(empty.errors[0]).toContain('spec.locales for "fr"');
    expect(empty.errors[0]).toContain('spec.locales for "zh-CN"');
  });

  it("reports independent locale errors alongside English drift", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    await writeFile(path, template.replace("title: User management", "title: People management"));
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    locale["searchEntries.people.missing"] = "未知";
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not byte-identical to the extraction output");
    expect(result.errors[0]).toContain("Unknown translation key: searchEntries.people.missing");
    expect(result.errors[0]).toContain("i18n-pipeline feo extract");
    expect(result.errors[0]).toContain("i18n-pipeline feo inline");
  });

  it("reports locale JSON drift for only the changed locale", async () => {
    await createFeoProject();
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    locale["searchEntries.people.title"] = "改过的示例文字";
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);
    const before = await Promise.all(
      [
        "deploy/frontend.yaml",
        "deploy/locales/translation-template.json",
        "deploy/locales/zh-CN.json",
        "deploy/locales/fr.json",
      ].map((path) => readFile(join(projectRoot!, path))),
    );

    const result = await runValidation(feoValidationConfig());
    const after = await Promise.all(
      [
        "deploy/frontend.yaml",
        "deploy/locales/translation-template.json",
        "deploy/locales/zh-CN.json",
        "deploy/locales/fr.json",
      ].map((path) => readFile(join(projectRoot!, path))),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('FEO locale "zh-CN"');
    expect(result.errors[0]).toContain("deploy/locales/zh-CN.json");
    expect(result.errors[0]).toContain("i18n-pipeline feo inline");
    expect(result.errors[0]).not.toContain('FEO locale "fr"');
    expect(after).toEqual(before);
  });

  it("requires the source catalog to match extraction bytes exactly", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/locales/translation-template.json");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not byte-identical to the extraction output");
  });

  it("reports a hand-edited spec.locales value", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    await writeFile(path, template.replace("用户管理", "手工修改的文字"));

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('FEO locale "zh-CN"');
  });

  it("reports an unknown key in a locale file", async () => {
    await createFeoProject();
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    locale["searchEntries.people.missing"] = "未知";
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Unknown translation key: searchEntries.people.missing");
    expect(result.errors[0]).toContain("i18n-pipeline feo inline");
  });

  it("reports the old joined alt_title key as unknown in a locale file", async () => {
    await createFeoProject();
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    locale["searchEntries.people.alt_title"] = "SAMPLE ONLY — NOT REVIEWED 人员|账户";
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "Unknown translation key: searchEntries.people.alt_title; alt_title uses one message per slug",
    );
    expect(result.errors[0]).toContain("i18n-pipeline feo inline");
  });

  it("reports an empty translation with its key", async () => {
    await createFeoProject();
    const localePath = join(projectRoot!, "deploy/locales/zh-CN.json");
    const locale = JSON.parse(await readFile(localePath, "utf8")) as Record<string, string>;
    locale["searchEntries.people.title"] = "  ";
    await writeFile(localePath, `${JSON.stringify(locale, null, 2)}\n`);

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid translation: searchEntries.people.title");
  });

  it("reports invalid source catalog JSON with the extraction command", async () => {
    await createFeoProject();
    await writeFile(join(projectRoot!, "deploy/locales/translation-template.json"), "{ invalid");

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("FEO source catalog");
    expect(result.errors[0]).toContain("is not valid JSON");
    expect(result.errors[0]).toContain("i18n-pipeline feo extract");
  });

  it("quotes paths in repair commands when a configured path contains spaces", async () => {
    await createFeoProject();
    const config = feoValidationConfig();
    const entries = config.feo as Array<{ source: string }>;
    entries[0]!.source = "deploy/locales/missing source.json";

    const result = await runValidation(config);

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toContain("--output 'deploy/locales/missing source.json'");
  });

  it("reports invalid locale JSON with the inline command", async () => {
    await createFeoProject();
    await writeFile(join(projectRoot!, "deploy/locales/zh-CN.json"), "{ invalid");

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('FEO locale "zh-CN"');
    expect(result.errors[0]).toContain("is not valid JSON");
    expect(result.errors[0]).toContain("i18n-pipeline feo inline");
  });

  it("continues checking later FEO entries when one locale file is missing", async () => {
    await createFeoProject();
    const config = feoValidationConfig();
    const entries = config.feo as Array<{
      template: string;
      source: string;
      locales: Record<string, string>;
    }>;
    entries[0]!.locales["zh-CN"] = "deploy/locales/missing-zh-CN.json";
    entries.push({
      template: "deploy/frontend.yaml",
      source: "deploy/locales/translation-template.json",
      locales: { fr: "deploy/locales/missing-fr.json" },
    });

    const result = await runValidation(config);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('FEO locale "zh-CN"');
    expect(result.errors[0]).toContain("missing-zh-CN.json");
    expect(result.errors[0]).toContain('FEO locale "fr"');
    expect(result.errors[0]).toContain("missing-fr.json");
    expect(result.errors[0]).toContain("ENOENT");
  });

  it("continues checking later FEO entries when one source catalog is missing", async () => {
    await createFeoProject();
    const config = feoValidationConfig();
    const entries = config.feo as Array<{
      template: string;
      source: string;
      locales: Record<string, string>;
    }>;
    entries[0]!.source = "deploy/locales/missing-source.json";
    entries[0]!.locales = {};
    entries.push({
      template: "deploy/frontend.yaml",
      source: "deploy/locales/translation-template.json",
      locales: { fr: "deploy/locales/missing-fr.json" },
    });

    const result = await runValidation(config);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing-source.json");
    expect(result.errors[0]).toContain('FEO locale "fr"');
    expect(result.errors[0]).toContain("missing-fr.json");
    expect(result.errors[0]).toContain("ENOENT");
  });

  it("reports invalid FEO YAML as a project finding", async () => {
    await createFeoProject();
    await writeFile(join(projectRoot!, "deploy/frontend.yaml"), "kind: [\n");

    const result = await runValidation(feoValidationConfig());

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid Frontend template");
    expect(result.errors[0]).toContain("i18n-pipeline feo extract");
  });

  it("reports a missing FEO template as a project finding", async () => {
    await createFeoProject();
    const config = feoValidationConfig();
    const entries = config.feo as Array<{ template: string }>;
    entries[0]!.template = "deploy/missing-frontend.yaml";

    const result = await runValidation(config);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("deploy/missing-frontend.yaml");
    expect(result.errors[0]).toContain("ENOENT");
    expect(result.errors[0]).toContain("i18n-pipeline feo extract");
  });

  it("passes after changing unrelated fields and regenerating FEO files", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    await writeFile(
      path,
      template.replace("- account:read", "- account:write\n              route: /accounts"),
    );
    await runFeo([
      "extract",
      "--template",
      "deploy/frontend.yaml",
      "--output",
      "deploy/locales/translation-template.json",
    ]);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/zh-CN.json",
      "--locale",
      "zh-CN",
    ]);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/fr.json",
      "--locale",
      "fr",
    ]);

    const result = await runValidation({
      ...feoValidationConfig(),
      catalogDirectories: [{ path: "deploy/locales" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(await readFile(path, "utf8")).toContain("route: /accounts");
  });

  it("keeps FEO keys stable when entries are reordered and inserted", async () => {
    await createFeoProject();
    const path = join(projectRoot!, "deploy/frontend.yaml");
    const template = await readFile(path, "utf8");
    const originalItems = `            - id: accounts
              title: Manage access
              permissions:
                - account:read
            - id: groups
              title: Manage access
              permissions:
                - group:read`;
    const reorderedItems = `            - id: groups
              title: Manage access
              permissions:
                - group:read
            - id: reports
              title: Manage access
              permissions:
                - report:read
            - id: accounts
              title: Manage access
              permissions:
                - account:read`;
    expect(template).toContain(originalItems);
    await writeFile(path, template.replace(originalItems, reorderedItems));
    const zh = {
      ...feoZhTranslations,
      "bundleSegments.access.administration.navItems.reports.title":
        "SAMPLE ONLY — NOT REVIEWED 报告",
    };
    const fr = {
      ...feoFrTranslations,
      "bundleSegments.access.administration.navItems.reports.title":
        "EXAMPLE NOT REVIEWED Rapports",
    };
    await writeFile(
      join(projectRoot!, "deploy/locales/zh-CN.json"),
      `${JSON.stringify(zh, null, 2)}\n`,
    );
    await writeFile(
      join(projectRoot!, "deploy/locales/fr.json"),
      `${JSON.stringify(fr, null, 2)}\n`,
    );
    await runFeo([
      "extract",
      "--template",
      "deploy/frontend.yaml",
      "--output",
      "deploy/locales/translation-template.json",
    ]);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/zh-CN.json",
      "--locale",
      "zh-CN",
    ]);
    await runFeo([
      "inline",
      "--template",
      "deploy/frontend.yaml",
      "--source",
      "deploy/locales/translation-template.json",
      "--target",
      "deploy/locales/fr.json",
      "--locale",
      "fr",
    ]);

    const source = JSON.parse(
      await readFile(join(projectRoot!, "deploy/locales/translation-template.json"), "utf8"),
    ) as Record<string, unknown>;
    const result = await runValidation(feoValidationConfig());

    expect(Object.keys(source)).toEqual(
      expect.arrayContaining([
        "bundleSegments.access.administration.navItems.accounts.title",
        "bundleSegments.access.administration.navItems.groups.title",
        "bundleSegments.access.administration.navItems.reports.title",
      ]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("rejects invalid FEO locale tags and paths outside the consumer root", () => {
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [],
        feo: [
          {
            template: "deploy/frontend.yaml",
            source: "deploy/locales/translation-template.json",
            locales: { zh_CN: "deploy/locales/zh-CN.json" },
          },
        ],
      }),
    ).toThrow("must be a non-English FEO locale tag");
    expect(() =>
      parseCatalogValidationConfig({
        version: 1,
        checks: [],
        feo: [
          {
            template: "deploy/frontend.yaml",
            source: "deploy/locales/translation-template.json",
            locales: { "zh-CN": "../deploy/locales/zh-CN.json" },
          },
        ],
      }),
    ).toThrow("must be a repository-relative path without parent traversal");
  });
});
