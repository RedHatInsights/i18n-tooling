import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { isCliEntryPoint, runCli } from "../src/cli.js";

let projectRoot: string | undefined;
let outsideRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
  if (outsideRoot) {
    await rm(outsideRoot, { recursive: true, force: true });
    outsideRoot = undefined;
  }
});

function phraseTmsConfig(sourceCatalogPath = "locales/en.json"): string {
  return JSON.stringify({
    provider: "phrase",
    project: { uid: "project-uid", region: "us" },
    sourceCatalog: { path: sourceCatalogPath, adapter: "formatjs-json", locale: "en" },
    targetLocales: [{ phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" }],
  });
}

function generatedSourceTmsConfig(): string {
  return JSON.stringify({
    provider: "phrase",
    project: { uid: "project-uid", region: "eu" },
    sourceCatalog: {
      path: "deploy/locales/insights-rbac-ui-feo-frontend-en.json",
      adapter: "formatjs-json",
      locale: "en",
    },
    frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
    targetLocales: [
      {
        phraseLocale: "zh_cn",
        repositoryLocale: "zh-CN",
        outputPath: "deploy/locales/zh-CN.json",
      },
    ],
  });
}

function credentialTrackingEnv(reads: string[]): NodeJS.ProcessEnv {
  const credentials = new Set([
    "PHRASE_PLATFORM_API_TOKEN",
    "PHRASE_SERVICE_ACCOUNT_CLIENT_ID",
    "PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET",
    "GITHUB_TOKEN",
  ]);
  return new Proxy({} as NodeJS.ProcessEnv, {
    get: (_target, property) => {
      if (typeof property === "string" && credentials.has(property)) reads.push(property);
      return undefined;
    },
  });
}

describe("i18n-pipeline CLI", () => {
  it("recognizes itself as the entry point when started through a bin symlink", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-entry-"));
    const cliFile = join(projectRoot, "dist/cli.js");
    const binLink = join(projectRoot, "node_modules/.bin/i18n-pipeline");
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

  it("converts OpenAPI Problem Details schemas from YAML into an ICU source catalog", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-openapi-convert-"));
    await mkdir(join(projectRoot, "specs"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/openapi-i18n/problem-details.yaml",
    );
    await writeFile(join(projectRoot, "specs/openapi.yaml"), await readFile(fixturePath, "utf8"));
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "convert",
        "--source",
        "specs/openapi.yaml",
        "--source-adapter",
        "openapi-problem-details",
        "--target-adapter",
        "icu-json",
        "--output",
        "i18n/en.json",
        "--locale",
        "en",
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
    expect(await readFile(join(projectRoot, "i18n/en.json"), "utf8")).toBe(
      '{\n  "insights-rbac.role.not-found": "Role {roleName} was not found."\n}\n',
    );
    expect(output).toEqual([
      "Converted catalog from openapi-problem-details to icu-json (locale=en).",
    ]);
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

  it("round-trips dotted FEO IDs and shared aliases through check mode", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-feo-dotted-"));
    const templatePath = join(projectRoot, "frontend.yaml");
    const sourcePath = join(projectRoot, "locales/source.json");
    const targetPath = join(projectRoot, "locales/fr.json");
    const template = `kind: Template
objects:
  - kind: Frontend
    spec:
      searchEntries:
        - id: RHEL.ros
          title: RHEL ROS
          description: Manage ROS
          alt_title: [acs, ACS, operators]
        - id: hosts
          title: Hosts
          alt_title: [hosts, hosts]
      serviceTiles:
        - section: rhel
          group: security
          id: malware.signatures
          title: Malware signatures
      bundleSegments:
        - bundleId: hybrid-committed-spend
          segmentId: main
          navItems:
            - id: hybrid-committed-spend.nav
              title: Committed spend
              routes:
                - id: hybrid-committed-spend.overview
                  title: Overview
                - id: hybrid-committed-spend.details
                  title: Details
`;
    await writeFile(templatePath, template);
    const errors: string[] = [];
    const run = (args: string[]) =>
      runCli(["feo", ...args], {
        cwd: projectRoot,
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      });
    const extract = ["extract", "--template", "frontend.yaml", "--output", "locales/source.json"];
    const inline = [
      "inline",
      "--template",
      "frontend.yaml",
      "--source",
      "locales/source.json",
      "--target",
      "locales/fr.json",
      "--locale",
      "fr",
    ];

    expect(await run(extract)).toBe(0);
    expect(await run([...extract, "--check"])).toBe(0);
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    expect(source["searchEntries.RHEL.ros.alt_title.acs"].defaultMessage).toBe("acs");
    expect(source["searchEntries.RHEL.ros.alt_title.ACS"]).toBeUndefined();
    const translations = {
      "searchEntries.RHEL.ros.title": "RHEL ROS FR",
      "searchEntries.RHEL.ros.description": "Manage ROS FR",
      "searchEntries.RHEL.ros.alt_title.acs": "ACS FR",
      "searchEntries.RHEL.ros.alt_title.operators": "Operators FR",
      "searchEntries.hosts.alt_title.hosts": "Hosts FR",
      "serviceTiles.rhel.security.malware.signatures.title": "Signatures FR",
      "bundleSegments.hybrid-committed-spend.main.navItems.hybrid-committed-spend.nav.routes.hybrid-committed-spend.overview.title":
        "Overview FR",
      "bundleSegments.hybrid-committed-spend.main.navItems.hybrid-committed-spend.nav.routes.hybrid-committed-spend.details.title":
        "Details FR",
    };
    await writeFile(targetPath, JSON.stringify(translations));

    expect(await run([...inline, "--check"])).toBe(1);
    expect(await readFile(templatePath, "utf8")).toBe(template);
    expect(await run(inline)).toBe(0);
    const updated = await readFile(templatePath, "utf8");
    expect(parse(updated).objects[0].spec.locales.fr).toEqual(translations);
    expect(await run([...inline, "--check"])).toBe(0);
    expect(await readFile(templatePath, "utf8")).toBe(updated);
    expect(await run([...extract, "--check"])).toBe(0);
    expect(errors).toEqual([expect.stringContaining("out of sync with the FEO inline output")]);
  });

  it("extracts, inlines and checks a multi-Frontend template without writing in check mode", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-feo-"));
    const templatePath = join(projectRoot, "frontend.yaml");
    const sourcePath = join(projectRoot, "locales/source.json");
    const targetPath = join(projectRoot, "locales/fr.json");
    const template = `kind: Template
objects:
  - kind: Frontend
    metadata:
      name: first
    spec:
      module:
        defaultDocumentTitle: First
  - kind: Frontend
    metadata:
      name: second
    spec:
      module:
        defaultDocumentTitle: Second
`;
    await writeFile(templatePath, template);
    const errors: string[] = [];
    const run = (args: string[]) =>
      runCli(["feo", ...args], {
        cwd: projectRoot,
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      });
    const extract = ["extract", "--template", "frontend.yaml", "--output", "locales/source.json"];
    const inline = [
      "inline",
      "--template",
      "frontend.yaml",
      "--source",
      "locales/source.json",
      "--target",
      "locales/fr.json",
      "--locale",
      "fr",
    ];

    expect(await run([...extract, "--check"])).toBe(1);
    await expect(readFile(sourcePath, "utf8")).rejects.toThrow();
    expect(await run(extract)).toBe(0);
    expect(await run([...extract, "--check"])).toBe(0);
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    expect(Object.keys(source)).toEqual([
      "objects.first.spec.module.defaultDocumentTitle",
      "objects.second.spec.module.defaultDocumentTitle",
    ]);
    await writeFile(
      targetPath,
      JSON.stringify({
        "objects.first.spec.module.defaultDocumentTitle": "Premier",
        "objects.second.spec.module.defaultDocumentTitle": "Deuxième",
      }),
    );
    expect(await run([...inline, "--check"])).toBe(1);
    expect(await readFile(templatePath, "utf8")).toBe(template);
    expect(await run(inline)).toBe(0);
    const updated = await readFile(templatePath, "utf8");
    const objects = parse(updated).objects;
    expect(objects[0].spec.locales.fr).toEqual({ "module.defaultDocumentTitle": "Premier" });
    expect(objects[1].spec.locales.fr).toEqual({ "module.defaultDocumentTitle": "Deuxième" });
    expect(await run([...inline, "--check"])).toBe(0);
    expect(await readFile(templatePath, "utf8")).toBe(updated);
    expect(await run([...extract, "--check"])).toBe(0);

    await writeFile(targetPath, '{"__proto__":"unknown"}');
    expect(await run(inline)).toBe(1);
    expect(errors.at(-1)).toContain("Unknown translation key: __proto__");
    expect(await readFile(templatePath, "utf8")).toBe(updated);
    await writeFile(
      templatePath,
      updated.replace("defaultDocumentTitle: First", "defaultDocumentTitle: Changed"),
    );
    expect(await run([...extract, "--check"])).toBe(1);
    expect(await run([...inline, "--check"])).toBe(1);
    expect(errors.at(-1)).toContain("English source changed");
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
    expect(output[0]).toContain(
      "<check|validate|validate-project|validate-ci|convert|feo|tms|version|help>",
    );

    expect(
      await runCli(["check", "--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(output[1]).toContain("Usage: i18n-pipeline check --source <path> --target <path>");
    expect(errors).toEqual([]);

    expect(
      await runCli(["validate-ci", "--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(output[2]).toContain("Usage: i18n-pipeline validate-ci [options]");
    expect(output[2]).toContain("--results-dir <dir>");

    const unknownErrors: string[] = [];
    expect(
      await runCli(["unknown"], {
        stdout: () => undefined,
        stderr: (message) => unknownErrors.push(message),
      }),
    ).toBe(1);
    expect(unknownErrors[0]).toContain('Unknown command "unknown"');
    expect(unknownErrors[0]).toContain(
      "Usage: i18n-pipeline <check|validate|validate-project|validate-ci|convert|feo|tms|version|help>",
    );
  });

  it("shows TMS command help and marks the user token as required for submission", async () => {
    const help: string[] = [];
    expect(
      await runCli(["tms", "submit", "--help"], {
        stdout: (message) => help.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(help[0]).toContain("Usage: i18n-pipeline tms submit --config <path>");
    expect(help[0]).toContain("--expect-project <uid>");
    expect(help[0]).toContain("--expect-source-filename <name>");
    expect(
      await runCli(["tms", "reconcile", "--help"], {
        stdout: (message) => help.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(help[1]).toContain("--expect-project <uid>");
    expect(help[1]).toContain("--expect-source-filename <name>");
    expect(
      await runCli(["tms", "--help"], {
        stdout: (message) => help.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(help[2]).toContain("PHRASE_SERVICE_ACCOUNT_CLIENT_ID");
    expect(help[2]).toContain("PHRASE_PLATFORM_API_TOKEN");
    expect(help[2]).toContain("required for submit");
    expect(help[2]).toContain("reconciliation support remains unverified");

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
      "submit",
      "--expect-project",
      "other-project",
      'Phrase project UID mismatch: expected "other-project", actual "project-uid"',
    ],
    [
      "submit",
      "--expect-source-filename",
      "other.json",
      'Phrase source filename mismatch: expected "other.json", actual "en.json"',
    ],
    [
      "reconcile",
      "--expect-project",
      "other-project",
      'Phrase project UID mismatch: expected "other-project", actual "project-uid"',
    ],
    [
      "reconcile",
      "--expect-source-filename",
      "other.json",
      'Phrase source filename mismatch: expected "other.json", actual "en.json"',
    ],
  ] as const)(
    "checks %s %s against parsed config before reading credentials",
    async (command, option, value, message) => {
      projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-pins-"));
      await mkdir(join(projectRoot, "locales"));
      await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());
      await writeFile(join(projectRoot, "locales/en.json"), JSON.stringify({ greeting: "Hello" }));
      const credentialReads: string[] = [];
      const errors: string[] = [];

      const exitCode = await runCli(["tms", command, "--config", "phrase.json", option, value], {
        cwd: projectRoot,
        env: credentialTrackingEnv(credentialReads),
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      });

      expect(exitCode).toBe(1);
      expect(errors[0]).toContain(message);
      expect(credentialReads).toEqual([]);
    },
  );

  it.each(["submit", "reconcile"] as const)(
    "accepts matching Phrase pins for %s before credential checks",
    async (command) => {
      projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-pins-match-"));
      await mkdir(join(projectRoot, "locales"));
      await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());
      await writeFile(join(projectRoot, "locales/en.json"), JSON.stringify({ greeting: "Hello" }));
      const credentialReads: string[] = [];
      const errors: string[] = [];

      const exitCode = await runCli(
        [
          "tms",
          command,
          "--config",
          "phrase.json",
          "--expect-project",
          "project-uid",
          "--expect-source-filename",
          "en.json",
        ],
        {
          cwd: projectRoot,
          env: credentialTrackingEnv(credentialReads),
          stdout: () => undefined,
          stderr: (message) => errors.push(message),
        },
      );

      expect(exitCode).toBe(1);
      expect(errors[0]).toContain("Set PHRASE_SERVICE_ACCOUNT_CLIENT_ID");
      expect(credentialReads).toContain("PHRASE_PLATFORM_API_TOKEN");
    },
  );

  it.each(["submit", "reconcile"] as const)(
    "rejects a symbolic-link TMS config for %s before reading credentials",
    async (command) => {
      projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-config-link-"));
      outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-config-outside-"));
      const linkedConfig = join(projectRoot, "phrase-link.json");
      await writeFile(join(outsideRoot, "phrase.json"), "not valid JSON");
      await symlink(join(outsideRoot, "phrase.json"), linkedConfig);
      const credentialReads: string[] = [];
      const errors: string[] = [];

      const exitCode = await runCli(["tms", command, "--config", "phrase-link.json"], {
        cwd: projectRoot,
        env: credentialTrackingEnv(credentialReads),
        stdout: () => undefined,
        stderr: (message) => errors.push(message),
      });

      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('TMS config path "phrase-link.json" must not be a symbolic link');
      expect(credentialReads).toEqual([]);
    },
  );

  it("rejects a non-symlink TMS config outside the working directory before reading it", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-config-outside-root-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-config-outside-file-"));
    await writeFile(join(outsideRoot, "phrase.json"), "not valid JSON");
    const configPath = relative(projectRoot, join(outsideRoot, "phrase.json"));
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "reconcile", "--config", configPath], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      `TMS config path "${configPath}" resolves outside the working directory`,
    );
    expect(credentialReads).toEqual([]);
  });

  it("rejects a symbolic-link source catalog before reading the catalog or credentials", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-link-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-outside-"));
    await mkdir(join(projectRoot, "locales"));
    await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());
    await writeFile(join(outsideRoot, "en.json"), "not valid JSON");
    await symlink(join(outsideRoot, "en.json"), join(projectRoot, "locales/en.json"));
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      'Source catalog path "locales/en.json" must not be a symbolic link',
    );
    expect(credentialReads).toEqual([]);
  });

  it("rejects a source catalog reached through a directory symlink outside the working directory", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-dir-link-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-dir-outside-"));
    await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig("locales/en.json"));
    await writeFile(join(outsideRoot, "en.json"), "not valid JSON");
    await symlink(outsideRoot, join(projectRoot, "locales"), "dir");
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      'Source catalog path "locales/en.json" resolves outside the working directory',
    );
    expect(credentialReads).toEqual([]);
  });

  it("rejects a symbolic-link generated-source Frontend template before reading credentials", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-template-link-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-template-outside-"));
    await mkdir(join(projectRoot, "deploy"));
    await writeFile(join(projectRoot, "phrase.json"), generatedSourceTmsConfig());
    await writeFile(join(outsideRoot, "frontend.yaml"), "kind: Template\n");
    await symlink(join(outsideRoot, "frontend.yaml"), join(projectRoot, "deploy/frontend.yaml"));
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      'Frontend template path "deploy/frontend.yaml" must not be a symbolic link',
    );
    expect(credentialReads).toEqual([]);
  });

  it("rejects a generated-source Frontend template reached through a directory symlink outside the working directory", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-template-dir-link-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-template-dir-outside-"));
    await writeFile(join(projectRoot, "phrase.json"), generatedSourceTmsConfig());
    await writeFile(join(outsideRoot, "frontend.yaml"), "kind: Template\n");
    await symlink(outsideRoot, join(projectRoot, "deploy"), "dir");
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      'Frontend template path "deploy/frontend.yaml" resolves outside the working directory',
    );
    expect(credentialReads).toEqual([]);
  });

  it("rejects source catalog parent traversal before reading credentials", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-outside-root-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-catalog-outside-file-"));
    await writeFile(join(outsideRoot, "en.json"), "not valid JSON");
    const sourceCatalogPath = relative(projectRoot, join(outsideRoot, "en.json"));
    await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig(sourceCatalogPath));
    const credentialReads: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: credentialTrackingEnv(credentialReads),
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      "Source catalog path must be a repository-relative path without parent traversal",
    );
    expect(credentialReads).toEqual([]);
  });

  it("submits from regular config and catalog paths inside the working directory", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-regular-paths-"));
    await mkdir(join(projectRoot, "locales"));
    const sourceBytes = Buffer.from(JSON.stringify({ greeting: { defaultMessage: "Hello" } }));
    await writeFile(join(projectRoot, "locales/en.json"), sourceBytes);
    await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());
    let stateRevision: string | undefined;
    let stateWriteCount = 0;
    const output: string[] = [];
    const errors: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/contents/locales/en.json?ref=abc123")) {
        return new Response(
          JSON.stringify({
            type: "file",
            sha: "source-sha",
            encoding: "base64",
            content: sourceBytes.toString("base64"),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/contents/.github/i18n-state/batches/")) {
        if (method === "GET") {
          if (!stateRevision) return new Response("", { status: 404 });
          return new Response(
            JSON.stringify({
              type: "file",
              sha: stateRevision,
              encoding: "base64",
              content: Buffer.from("{}").toString("base64"),
            }),
            { status: 200 },
          );
        }
        stateRevision = `state-sha-${++stateWriteCount}`;
        return new Response(JSON.stringify({ content: { sha: stateRevision } }), { status: 200 });
      }
      if (url.endsWith("/git/ref/heads/i18n-tms-state")) return new Response("", { status: 404 });
      if (url.endsWith("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
      }
      if (url.endsWith("/git/refs") && method === "POST") {
        return new Response("{}", { status: 201 });
      }
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "phrase-access-token" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api2/v1/projects/project-uid/jobs") && method === "POST") {
        return new Response(
          JSON.stringify({
            asyncRequest: { id: "import-1" },
            jobs: [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1 }],
            unsupportedFiles: [],
            warnings: [],
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/api2/v1/async/import-1")) {
        return new Response(JSON.stringify({ id: "import-1", asyncResponse: {} }), {
          status: 200,
        });
      }
      if (url.endsWith("/api2/v1/projects/project-uid/jobs/job-fr")) {
        return new Response(
          JSON.stringify({
            uid: "job-fr",
            targetLang: "fr",
            workflowLevel: 1,
            filename: "en.json",
            importStatus: { status: "OK" },
          }),
          { status: 200 },
        );
      }
      return new Response(`Unexpected request: ${method} ${url}`, { status: 500 });
    };

    const exitCode = await runCli(
      [
        "tms",
        "submit",
        "--config",
        "phrase.json",
        "--expect-project",
        "project-uid",
        "--expect-source-filename",
        "en.json",
      ],
      {
        cwd: projectRoot,
        env: {
          PHRASE_PLATFORM_API_TOKEN: "platform-token",
          GITHUB_TOKEN: "run-token",
          GITHUB_REPOSITORY: "example/app",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: "abc123",
        },
        fetch,
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(output[0]).toBe("Phrase auth: user Platform API token (PHRASE_PLATFORM_API_TOKEN)");
    expect(output[1]).toMatch(/^Phrase batch [a-f0-9]{64} is ready \(1 job parts\)\.$/);
    expect(errors).toEqual([]);
  });

  it.each([
    ["pinned", true],
    ["unpinned", false],
  ] as const)(
    "exits 1 with a retryable visibility message for a %s submit whose job stays missing",
    async (_label, pinned) => {
      projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-job-404-"));
      await mkdir(join(projectRoot, "locales"));
      const sourceBytes = Buffer.from(JSON.stringify({ greeting: { defaultMessage: "Hello" } }));
      await writeFile(join(projectRoot, "locales/en.json"), sourceBytes);
      await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());

      let stateRevision: string | undefined;
      let stateWriteCount = 0;
      let stateRecord: Record<string, unknown> | undefined;
      let jobLookupCount = 0;
      let signalFirstJobLookup: () => void = () => undefined;
      const firstJobLookup = new Promise<void>((resolve) => {
        signalFirstJobLookup = resolve;
      });
      const output: string[] = [];
      const errors: string[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsed = new URL(url);
        const method = (init?.method ?? "GET").toUpperCase();

        if (parsed.pathname.endsWith("/contents/locales/en.json")) {
          return new Response(
            JSON.stringify({
              type: "file",
              sha: "source-sha",
              encoding: "base64",
              content: sourceBytes.toString("base64"),
            }),
          );
        }
        if (parsed.pathname.endsWith("/contents/.github/i18n-state/batches")) {
          return new Response("", { status: 404 });
        }
        const stateFile = parsed.pathname.match(
          /\/contents\/\.github\/i18n-state\/batches\/([a-f0-9]{64})\.json$/,
        );
        if (stateFile) {
          if (method === "GET") {
            if (!stateRecord || !stateRevision) return new Response("", { status: 404 });
            return new Response(
              JSON.stringify({
                type: "file",
                sha: stateRevision,
                encoding: "base64",
                content: Buffer.from(`${JSON.stringify(stateRecord, null, 2)}\n`).toString(
                  "base64",
                ),
              }),
            );
          }
          if (method === "PUT") {
            const body = JSON.parse(String(init?.body)) as { content: string };
            stateRecord = JSON.parse(
              Buffer.from(body.content, "base64").toString("utf8"),
            ) as Record<string, unknown>;
            stateRevision = `state-sha-${++stateWriteCount}`;
            return new Response(JSON.stringify({ content: { sha: stateRevision } }));
          }
        }
        if (parsed.pathname.endsWith("/git/ref/heads/i18n-tms-state")) {
          return new Response("", { status: 404 });
        }
        if (parsed.pathname.endsWith("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "base-sha" } }));
        }
        if (parsed.pathname.endsWith("/git/refs") && method === "POST") {
          return new Response("{}", { status: 201 });
        }
        if (url === "https://us.phrase.com/idm/oauth/token") {
          return new Response(JSON.stringify({ access_token: "phrase-access-token" }));
        }
        if (parsed.pathname.endsWith("/api2/v1/projects/project-uid/jobs") && method === "POST") {
          return new Response(
            JSON.stringify({
              asyncRequest: { id: "import-1" },
              jobs: [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1 }],
              unsupportedFiles: [],
              warnings: [],
            }),
            { status: 201 },
          );
        }
        if (parsed.pathname.endsWith("/api2/v1/async/import-1")) {
          return new Response(JSON.stringify({ id: "import-1", asyncResponse: {} }));
        }
        if (parsed.pathname.endsWith("/api2/v1/projects/project-uid/jobs/job-fr")) {
          jobLookupCount += 1;
          signalFirstJobLookup();
          return new Response("", { status: 404 });
        }
        return new Response(`Unexpected request: ${method} ${url}`, { status: 500 });
      };

      if (pinned) vi.useFakeTimers();
      try {
        const cliRun = runCli(
          [
            "tms",
            "submit",
            "--config",
            "phrase.json",
            ...(pinned
              ? ["--expect-project", "project-uid", "--expect-source-filename", "en.json"]
              : []),
          ],
          {
            cwd: projectRoot,
            env: {
              PHRASE_PLATFORM_API_TOKEN: "platform-token",
              GITHUB_TOKEN: "run-token",
              GITHUB_REPOSITORY: "example/app",
              GITHUB_REF: "refs/heads/main",
              GITHUB_SHA: "abc123",
            },
            fetch,
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
          },
        );
        const reachedJobLookup = await Promise.race([
          firstJobLookup.then(() => true),
          cliRun.then(() => false),
        ]);
        expect(reachedJobLookup).toBe(true);
        if (pinned) {
          for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
          await vi.runAllTimersAsync();
        }
        const exitCode = await cliRun;

        expect(exitCode).toBe(1);
        expect(errors[0]).toContain(
          "Phrase has not yet exposed the new jobs; the next run continues this batch",
        );
        expect(stateRecord).toMatchObject({ phase: "importing", jobs: [{ uid: "job-fr" }] });
        expect(jobLookupCount).toBe(pinned ? 5 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("generates the Phrase source from Frontend YAML without a checked-in catalog", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-feo-phrase-"));
    await mkdir(join(projectRoot, "deploy"));
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(
      join(projectRoot, "deploy/frontend.yaml"),
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n",
    );
    await writeFile(join(projectRoot, "phrase.json"), generatedSourceTmsConfig());
    const calls: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(["tms", "submit", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: {
        PHRASE_PLATFORM_API_TOKEN: "protected-phrase-token",
        GITHUB_TOKEN: "run-token",
        GITHUB_REPOSITORY: "example/app",
        GITHUB_REF: "refs/heads/phrase-pilot",
        GITHUB_SHA: "abc123",
      },
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.url : String(input));
        return new Response("{}", { status: 404 });
      },
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      "Source bytes do not match the source file at the requested commit",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/contents/deploy/frontend.yaml?ref=abc123");
    expect(calls[0]).not.toContain("insights-rbac-ui-feo-frontend-en.json");
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

  it("processes shared batches unpinned while repairing only the loaded config's stuck batch", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-repair-scope-"));
    await mkdir(join(projectRoot, "locales"));
    const sourceBytes = Buffer.from(JSON.stringify({ greeting: { defaultMessage: "Hello" } }));
    await writeFile(join(projectRoot, "locales/en.json"), sourceBytes);
    await writeFile(join(projectRoot, "phrase.json"), phraseTmsConfig());
    const now = new Date().toISOString();
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    const currentConfig = {
      projectUid: "project-uid",
      region: "us",
      sourceCatalog: {
        path: "locales/en.json",
        filename: "en.json",
        adapter: "formatjs-json",
        locale: "en",
      },
      targetAdapter: "formatjs-json",
      targetLocales: [
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
      ],
      completionPolicy: { default: "per-locale" },
    };
    const otherConfig = {
      projectUid: "other-project",
      region: "eu",
      sourceCatalog: {
        path: "locales/other-en.json",
        filename: "other-en.json",
        adapter: "formatjs-json",
        locale: "en",
      },
      targetAdapter: "formatjs-json",
      targetLocales: [
        { phraseLocale: "de", repositoryLocale: "de", outputPath: "locales/de.json" },
      ],
      completionPolicy: { default: "per-locale" },
    };
    const currentKey = "a".repeat(64);
    const otherReadyKey = "b".repeat(64);
    const otherStuckKey = "c".repeat(64);
    const batch = (
      key: string,
      phase: string,
      batchConfig: typeof currentConfig | typeof otherConfig,
      locales: Record<string, { phase: string; failureReason?: string }>,
      jobs: Array<{ uid: string; targetLang: string; workflowLevel: number }> = [],
    ) => ({
      schema: 1,
      key,
      phase,
      repository: "example/app",
      baseRef: "main",
      sourceCommit: "abc123",
      sourceDigest,
      config: batchConfig,
      createdAt: now,
      jobs,
      warningCount: 0,
      locales,
    });
    const stateRecords = new Map<string, Record<string, unknown>>([
      [currentKey, batch(currentKey, "unknown", currentConfig, { fr: { phase: "pending" } })],
      [
        otherReadyKey,
        batch(
          otherReadyKey,
          "ready",
          otherConfig,
          { de: { phase: "failed", failureReason: "previous Phrase failure" } },
          [{ uid: "other-job", targetLang: "de", workflowLevel: 1 }],
        ),
      ],
      [otherStuckKey, batch(otherStuckKey, "creating", otherConfig, { de: { phase: "pending" } })],
    ]);
    const otherStuckBefore = structuredClone(stateRecords.get(otherStuckKey));
    let revisionNumber = 0;
    const revisions = new Map(
      [...stateRecords.keys()].map((key) => [key, `sha-${++revisionNumber}`]),
    );
    const listProjectUids: string[] = [];
    const listWorkflowLevels: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const parsed = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();

      if (parsed.pathname.endsWith("/contents/.github/i18n-state/batches")) {
        return new Response(
          JSON.stringify(
            [...stateRecords.keys()].map((key) => ({ type: "file", name: `${key}.json` })),
          ),
        );
      }
      const stateFile = parsed.pathname.match(
        /\/contents\/\.github\/i18n-state\/batches\/([a-f0-9]{64})\.json$/,
      );
      if (stateFile) {
        const key = stateFile[1]!;
        if (method === "GET") {
          const record = stateRecords.get(key);
          if (!record) return new Response("", { status: 404 });
          return new Response(
            JSON.stringify({
              type: "file",
              sha: revisions.get(key),
              encoding: "base64",
              content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString("base64"),
            }),
          );
        }
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as { content: string };
          stateRecords.set(
            key,
            JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<
              string,
              unknown
            >,
          );
          revisions.set(key, `sha-${++revisionNumber}`);
          return new Response(JSON.stringify({ content: { sha: revisions.get(key) } }));
        }
      }
      if (parsed.pathname.endsWith("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha" } }));
      }
      if (parsed.pathname.endsWith("/contents/locales/en.json")) {
        return new Response(
          JSON.stringify({
            type: "file",
            sha: "source-sha",
            encoding: "base64",
            content: sourceBytes.toString("base64"),
          }),
        );
      }
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "phrase-access-token" }));
      }
      if (parsed.pathname.endsWith("/api2/v2/projects/project-uid/jobs")) {
        const workflowLevel = parsed.searchParams.get("workflowLevel") ?? "1";
        listProjectUids.push(parsed.pathname.split("/").at(-2)!);
        listWorkflowLevels.push(workflowLevel);
        const content =
          workflowLevel === "1"
            ? [
                {
                  uid: "recovered-job-fr",
                  targetLang: "fr",
                  filename: "en.json",
                  dateCreated: now,
                  imported: true,
                  workflowStep: { workflowLevel: 1 },
                },
              ]
            : [];
        return new Response(JSON.stringify({ content, totalPages: 1 }));
      }
      if (parsed.pathname.endsWith("/api2/v1/projects/project-uid/jobs/recovered-job-fr")) {
        return new Response(
          JSON.stringify({
            uid: "recovered-job-fr",
            targetLang: "fr",
            workflowLevel: 1,
            lastWorkflowLevel: 1,
            filename: "en.json",
            imported: true,
            status: "NEW",
            importStatus: { status: "OK" },
          }),
        );
      }
      return new Response(`Unexpected request: ${method} ${url}`, { status: 500 });
    };

    const exitCode = await runCli(["tms", "reconcile", "--config", "phrase.json"], {
      cwd: projectRoot,
      env: {
        PHRASE_PLATFORM_API_TOKEN: "platform-token",
        GITHUB_TOKEN: "run-token",
        GITHUB_REPOSITORY: "example/app",
      },
      fetch,
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output.some((line) => line.startsWith(`${currentKey.slice(0, 12)} fr: pending`))).toBe(
      true,
    );
    expect(output.some((line) => line.includes(otherStuckKey.slice(0, 12)))).toBe(false);
    expect(stateRecords.get(currentKey)).toMatchObject({
      phase: "ready",
      jobs: [{ uid: "recovered-job-fr" }],
    });
    expect(stateRecords.get(otherReadyKey)).toMatchObject({ phase: "completed" });
    expect(stateRecords.get(otherStuckKey)).toEqual(otherStuckBefore);
    expect(listProjectUids.every((projectUid) => projectUid === "project-uid")).toBe(true);
    expect(listWorkflowLevels).toEqual(["1", "1", "2", "2"]);
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

  it("never imports consumer adapter modules in TMS commands", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-cli-tms-adapters-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        i18nTooling: { catalogAdapters: { "wrapped-json": "./wrapped-adapter.mjs" } },
      }),
    );
    await writeFile(
      join(projectRoot, "wrapped-adapter.mjs"),
      `import { writeFileSync } from "node:fs";
      writeFileSync(new URL("./adapter-loaded.marker", import.meta.url), "loaded");
      export default { id: "wrapped-json", read() { return { locale: "en", messages: {} }; }, write() { return {}; } };`,
    );
    const config = (adapter: string) =>
      JSON.stringify({
        provider: "phrase",
        project: { uid: "project-uid", region: "us" },
        sourceCatalog: { path: "locales/en.json", adapter, locale: "en" },
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        ],
      });
    await writeFile(join(projectRoot, "built-in.json"), config("formatjs-json"));
    await writeFile(join(projectRoot, "custom.json"), config("wrapped-json"));
    const env = {
      PHRASE_PLATFORM_API_TOKEN: "protected-phrase-token",
      GITHUB_TOKEN: "run-token",
      GITHUB_REPOSITORY: "example/app",
    };
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("{}", { status: 404 });
    };

    // A declared adapter that the TMS config does not use must still not run.
    expect(
      await runCli(["tms", "reconcile", "--config", "built-in.json"], {
        cwd: projectRoot,
        env,
        fetch,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(0);

    calls.length = 0;
    const errors: string[] = [];
    const exitCode = await runCli(["tms", "reconcile", "--config", "custom.json"], {
      cwd: projectRoot,
      env,
      fetch,
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(
      'TMS commands load only built-in catalog adapters (formatjs-json, icu-json, openapi-problem-details); "wrapped-json" is a custom adapter',
    );
    expect(calls).toEqual([]);
    await expect(readFile(join(projectRoot, "adapter-loaded.marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
