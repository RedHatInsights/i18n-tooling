import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCatalogValidationConfig } from "../src/index.js";
import { runCli } from "../src/cli.js";

let projectRoot: string | undefined;

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
});
