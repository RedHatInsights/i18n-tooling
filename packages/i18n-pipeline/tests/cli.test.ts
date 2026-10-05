import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isCliEntryPoint, runCli } from "../src/cli.js";

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("frontend-i18n CLI", () => {
  it("recognizes itself as the entry point when started through a bin symlink", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-entry-"));
    const cliFile = join(projectRoot, "dist/cli.js");
    const binLink = join(projectRoot, "node_modules/.bin/frontend-i18n");
    await mkdir(join(projectRoot, "dist"));
    await mkdir(join(projectRoot, "node_modules/.bin"), { recursive: true });
    await writeFile(cliFile, "");
    await symlink(cliFile, binLink);
    const moduleUrl = pathToFileURL(cliFile).href;

    expect(isCliEntryPoint(cliFile, moduleUrl)).toBe(true);
    expect(isCliEntryPoint(binLink, moduleUrl)).toBe(true);
    expect(isCliEntryPoint(join(projectRoot, "other.js"), moduleUrl)).toBe(false);
    expect(isCliEntryPoint(undefined, moduleUrl)).toBe(false);
  });

  it("validates catalogs using workflow environment settings", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ greeting: "Hello {name}" }),
    );
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["validate"], {
      cwd: projectRoot,
      env: {
        I18N_CATALOG_ADAPTER: "icu-json",
        I18N_CATALOG_PATH: "locales/en.json",
        I18N_CATALOG_ROLE: "source",
        I18N_CATALOG_LOCALE: "en",
      },
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(["Validated 1 message (adapter=icu-json, locale=en, role=source)."]);
    expect(errors).toEqual([]);
  });

  it("reports all ICU syntax errors with message IDs, locations, and readable details", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-icu-errors-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/fr.json"),
      JSON.stringify({
        greeting: "Hello {name",
        items: "{count, plural, one {# item}}",
      }),
    );
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["validate", "--catalog", "locales/fr.json", "--adapter", "icu-json", "--locale", "fr"],
      {
        cwd: projectRoot,
        env: {},
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      'Catalog validation failed for "locales/fr.json":\n' +
        "ICU validation failed:\n" +
        '  - icu-json message "greeting" has invalid ICU syntax at pattern line 1, column 7: ' +
        "Expected argument closing brace (EXPECT_ARGUMENT_CLOSING_BRACE)\n" +
        '  - icu-json message "items" has invalid ICU syntax at pattern line 1, column 29: ' +
        "Missing other clause (MISSING_OTHER_CLAUSE)",
    ]);
  });

  it("converts a FormatJS source catalog through the shared adapter model", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-convert-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/source.json"),
      JSON.stringify({
        greeting: {
          defaultMessage: "Hello {name}",
          description: "Welcome message",
        },
      }),
    );
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "convert",
        "--source",
        "locales/source.json",
        "--output",
        "generated/catalogs/icu.json",
        "--source-adapter",
        "formatjs-json",
        "--target-adapter",
        "icu-json",
        "--locale",
        "en",
        "--source-role",
        "source",
        "--target-role",
        "source",
      ],
      {
        cwd: projectRoot,
        env: {},
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(projectRoot, "generated/catalogs/icu.json"), "utf8")).toBe(
      '{\n  "greeting": "Hello {name}"\n}\n',
    );
    expect(output).toEqual(["Converted catalog from formatjs-json to icu-json (locale=en)."]);
  });

  it("passes when source and target IDs and ICU arguments match", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-check-passes-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ greeting: { defaultMessage: "Hello {name}" } }),
    );
    await writeFile(
      join(projectRoot, "locales/fr.json"),
      JSON.stringify({ greeting: "Bonjour {name}" }),
    );
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["check", "--source", "locales/en.json", "--target", "locales/fr.json"],
      {
        cwd: projectRoot,
        env: {},
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(output).toEqual(["Catalog check passed (1 message source, 1 message target)."]);
    expect(errors).toEqual([]);
  });

  it("checks source and target IDs and ICU argument parity", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-check-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({
        greeting: { defaultMessage: "Hello {name} and {count}" },
        sourceOnly: { defaultMessage: "Source only" },
      }),
    );
    await writeFile(
      join(projectRoot, "locales/fr.json"),
      JSON.stringify({
        greeting: "Bonjour {name}",
        targetOnly: "Target only",
      }),
    );
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["check", "--source", "locales/en.json", "--target", "locales/fr.json"],
      {
        cwd: projectRoot,
        env: {},
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "Catalog check failed:\n" +
        "- Missing from target: sourceOnly\n" +
        "- Extra in target: targetOnly\n" +
        '- Argument mismatch for "greeting": source [count, name], target [name]',
    ]);
  });

  it("fails check when a target replaces a source exact plural with a number", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-exact-plural-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({
        items: { defaultMessage: "{count, plural, =1 {one item} other {# items}}" },
      }),
    );
    await writeFile(
      join(projectRoot, "locales/fr.json"),
      JSON.stringify({ items: "{count, number} items" }),
    );
    const errors: string[] = [];

    const exitCode = await runCli(
      [
        "check",
        "--source",
        "locales/en.json",
        "--target",
        "locales/fr.json",
        "--target-locale",
        "fr",
      ],
      {
        cwd: projectRoot,
        env: {},
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain('"items": plural {count} lost exact branch =1');
  });

  it("warns about source plural semantics and explains the target mismatch they cause", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-plural-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ remove: "{count, plural, one {{name}} other {# accounts}}" }),
    );
    await writeFile(
      join(projectRoot, "locales/zh-CN.json"),
      JSON.stringify({ remove: "{count, plural, other {# 个帐户}}" }),
    );
    const output: string[] = [];
    const errors: string[] = [];
    const options = {
      cwd: projectRoot,
      env: { I18N_CATALOG_ADAPTER: "icu-json" },
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => errors.push(message),
    };

    expect(await runCli(["validate", "--catalog", "locales/en.json"], options)).toBe(0);
    expect(output[0]).toContain(
      'Catalog warnings:\n- "remove": {name} appears only in the "one" branch',
    );
    expect(
      await runCli(
        ["validate", "--catalog", "locales/zh-CN.json", "--role", "target", "--locale", "zh-CN"],
        options,
      ),
    ).toBe(0);
    expect(output.filter((line) => line.startsWith("Catalog warnings"))).toHaveLength(1);

    expect(
      await runCli(
        ["check", "--source", "locales/en.json", "--target", "locales/zh-CN.json"],
        options,
      ),
    ).toBe(1);
    expect(errors.at(-1)).toContain(
      '- Argument mismatch for "remove": source [count, name], target [count] ' +
        '(source renders {name} only in the "one" branch of plural {count}',
    );
  });

  it("shows general and per-command help", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    expect(
      await runCli(["--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(output[0]).toContain("<check|validate|validate-project|convert|tms|version|help>");

    expect(
      await runCli(["check", "--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(output[1]).toContain("Usage: frontend-i18n check --source <path> --target <path>");
    expect(errors).toEqual([]);

    const unknownErrors: string[] = [];
    expect(
      await runCli(["unknown"], {
        stdout: () => undefined,
        stderr: (message) => unknownErrors.push(message),
      }),
    ).toBe(1);
    expect(unknownErrors[0]).toContain('Unknown command "unknown"');
    expect(unknownErrors[0]).toContain(
      "Usage: frontend-i18n <check|validate|validate-project|convert|tms|version|help>",
    );
  });

  it("shows TMS command help and requires the protected Phrase secret for submission", async () => {
    const help: string[] = [];
    expect(
      await runCli(["tms", "submit", "--help"], {
        stdout: (message) => help.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(help[0]).toContain("Usage: frontend-i18n tms submit --config <path>");
    expect(
      await runCli(["tms", "--help"], {
        stdout: (message) => help.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(help[1]).toContain("PHRASE_SERVICE_ACCOUNT_CLIENT_ID");

    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ greeting: { defaultMessage: "Hello" } }),
    );
    await writeFile(
      join(projectRoot, "phrase.json"),
      JSON.stringify({
        provider: "phrase",
        project: { uid: "project-uid", region: "us" },
        sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        ],
      }),
    );
    const errors: string[] = [];
    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: {
        GITHUB_TOKEN: "run-token",
        GITHUB_REPOSITORY: "example/app",
        GITHUB_REF_NAME: "phrase-pilot",
        GITHUB_SHA: "abc123",
      },
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      "Set PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET, or PHRASE_PLATFORM_API_TOKEN, as protected workflow secrets",
    );
  });

  it.each([
    [
      "a partial service account",
      { PHRASE_SERVICE_ACCOUNT_CLIENT_ID: "client-id" },
      "Set both PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET",
    ],
    [
      "both credential kinds",
      {
        PHRASE_PLATFORM_API_TOKEN: "user-token",
        PHRASE_SERVICE_ACCOUNT_CLIENT_ID: "client-id",
        PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET: "client-secret",
      },
      "Remove PHRASE_PLATFORM_API_TOKEN to use the service account, or remove PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET to use the token",
    ],
  ] as Array<[string, Record<string, string>, string]>)(
    "rejects %s before calling external services",
    async (_label, secrets, message) => {
      projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-credentials-"));
      await writeFile(join(projectRoot, "package.json"), "{}\n");
      await writeFile(
        join(projectRoot, "phrase.json"),
        JSON.stringify({
          provider: "phrase",
          project: { uid: "project-uid", region: "eu" },
          sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
          targetLocales: [
            { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
          ],
        }),
      );
      const calls: string[] = [];
      const errors: string[] = [];

      const exitCode = await runCli(["tms", "reconcile", "--config", "phrase.json"], {
        cwd: projectRoot,
        env: {
          // Unset reusable-workflow secrets arrive as empty strings.
          PHRASE_PLATFORM_API_TOKEN: "",
          ...secrets,
          GITHUB_TOKEN: "run-token",
          GITHUB_REPOSITORY: "example/app",
        },
        fetch: async (input) => {
          calls.push(input instanceof Request ? input.url : String(input));
          return new Response("{}", { status: 500 });
        },
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      });

      expect(exitCode).toBe(1);
      expect(errors[0]).toContain(message);
      expect(calls).toEqual([]);
    },
  );

  it("reconciles an empty state branch without calling external services", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-empty-"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "phrase.json"),
      JSON.stringify({
        provider: "phrase",
        project: { uid: "project-uid", region: "us" },
        sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        ],
      }),
    );
    const calls: string[] = [];
    const output: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return new Response("{}", { status: 404 });
    };

    const exitCode = await runCli(["tms", "reconcile", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: {
        PHRASE_PLATFORM_API_TOKEN: "protected-phrase-token",
        GITHUB_TOKEN: "run-token",
        GITHUB_REPOSITORY: "example/app",
      },
      fetch,
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "Phrase auth: user Platform API token (PHRASE_PLATFORM_API_TOKEN)",
      "No ready Phrase batches found.",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/contents/.github/i18n-state/batches?ref=i18n-tms-state");

    output.length = 0;
    expect(
      await runCli(["tms", "reconcile", "--config", "phrase.json"], {
        cwd: projectRoot,
        env: {
          PHRASE_PLATFORM_API_TOKEN: "",
          PHRASE_SERVICE_ACCOUNT_CLIENT_ID: "client-id",
          PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET: "client-secret",
          GITHUB_TOKEN: "run-token",
          GITHUB_REPOSITORY: "example/app",
        },
        fetch,
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(output[0]).toBe(
      "Phrase auth: service account (PHRASE_SERVICE_ACCOUNT_CLIENT_ID/_SECRET)",
    );
    expect(output.join("\n")).not.toContain("client-secret");
  });

  it("requires an explicit base ref for pull-request runs and ignores empty workflow inputs", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-base-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ greeting: { defaultMessage: "Hello" } }),
    );
    await writeFile(
      join(projectRoot, "phrase.json"),
      JSON.stringify({
        provider: "phrase",
        project: { uid: "project-uid", region: "us" },
        sourceCatalog: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        ],
      }),
    );
    const calls: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: {
        PHRASE_PLATFORM_API_TOKEN: "protected-phrase-token",
        GITHUB_TOKEN: "run-token",
        GITHUB_REPOSITORY: "example/app",
        GITHUB_REF: "refs/pull/12/merge",
        GITHUB_REF_NAME: "12/merge",
        GITHUB_SHA: "abc123",
        I18N_BASE_REF: "",
      },
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.url : String(input));
        return new Response("{}", { status: 500 });
      },
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Pass --base-ref: GITHUB_REF is not a branch");
    expect(calls).toEqual([]);
  });

  it("passes JSON adapter config to a dynamically loaded plugin", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-plugin-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        i18nTooling: {
          catalogAdapters: { "wrapped-json": "./wrapped-adapter.mjs" },
        },
      }),
    );
    await writeFile(
      join(projectRoot, "wrapped-adapter.mjs"),
      `export default {
        id: "wrapped-json",
        read(document, context) {
          const entries = document[context.options.container];
          const messages = Object.fromEntries(Object.entries(entries).map(([id, pattern]) => [
            id,
            { pattern, metadata: {} }
          ]));
          return { locale: context.locale, messages };
        },
        write(catalog) { return catalog.messages; }
      };`,
    );
    await writeFile(
      join(projectRoot, "locales/en.json"),
      JSON.stringify({ messages: { welcome: "Welcome {name}" } }),
    );
    await writeFile(join(projectRoot, "adapter.json"), JSON.stringify({ container: "messages" }));
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["validate"], {
      cwd: projectRoot,
      env: {
        I18N_CATALOG_ADAPTER: "wrapped-json",
        I18N_CATALOG_PATH: "locales/en.json",
        I18N_CATALOG_CONFIG: "adapter.json",
      },
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Validated 1 message (adapter=wrapped-json, locale=en, role=source).");
    expect(errors).toEqual([]);
  });
});
