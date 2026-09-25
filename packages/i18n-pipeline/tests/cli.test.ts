import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("frontend-i18n CLI", () => {
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

  it("shows general and per-command help", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    expect(
      await runCli(["--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(output[0]).toContain("<check|validate|convert|version|help>");

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
      "Usage: frontend-i18n <check|validate|convert|version|help>",
    );
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
