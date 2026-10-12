import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { executeValidateCi } from "../src/validate-ci.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultNames = [
  "I18N_STATUS",
  "I18N_ERRORS",
  "I18N_WARNINGS",
  "I18N_MODE",
  "I18N_CONFIG",
  "I18N_TOOL_VERSION",
];
const icuRules = new Set([
  "formatjs/no-invalid-icu",
  "formatjs/enforce-plural-rules",
  "formatjs/no-missing-icu-plural-one-placeholders",
  "formatjs/no-offset",
]);

let temporaryDirectories: string[] = [];
let generatorPids: number[] = [];

interface RunResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  resultsDir: string;
  root: string;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "i18n-validate-ci-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeProjectFile(root: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function writeConfig(
  root: string,
  config: Record<string, unknown>,
  path = ".github/i18n/catalog-validation.json",
): Promise<void> {
  await writeProjectFile(root, path, `${JSON.stringify(config, null, 2)}\n`);
}

function baseConfig(sourceLint?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    checks: [
      {
        source: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
        targets: [{ path: "locales/fr.json", adapter: "icu-json", locale: "fr" }],
      },
    ],
    generated: [],
    ...(sourceLint === undefined ? {} : { sourceLint }),
  };
}

async function createPassProject(
  root: string,
  sourceLint?: Record<string, unknown>,
): Promise<void> {
  await writeProjectFile(
    root,
    "package.json",
    JSON.stringify({ name: "consumer", version: "1.0.0" }),
  );
  await writeProjectFile(
    root,
    "locales/en.json",
    JSON.stringify({ greeting: { defaultMessage: "Hello {name}." } }),
  );
  await writeProjectFile(root, "locales/fr.json", JSON.stringify({ greeting: "Bonjour {name}." }));
  await writeConfig(root, baseConfig(sourceLint));
}

async function runValidateCi(
  root: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const resultsDir = join(root, `results-${temporaryDirectories.length}-${Math.random()}`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["validate-ci", "--root", root, "--results-dir", resultsDir, ...args],
    {
      cwd: packageRoot,
      env,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  );
  return { exitCode, stdout, stderr, resultsDir, root };
}

async function readResults(directory: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    resultNames.map(async (name) => [name, await readFile(join(directory, name), "utf8")] as const),
  );
  return Object.fromEntries(entries);
}

async function expectResults(
  result: RunResult,
  expected: {
    status: string;
    errors: number;
    warnings: number;
    mode?: string;
    config: string;
  },
): Promise<void> {
  expect(await readResults(result.resultsDir)).toEqual({
    I18N_STATUS: expected.status,
    I18N_ERRORS: String(expected.errors),
    I18N_WARNINGS: String(expected.warnings),
    I18N_MODE: expected.mode ?? "warn",
    I18N_CONFIG: expected.config,
    I18N_TOOL_VERSION: "0.1.0",
  });
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessesToExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const remaining = await Promise.all(pids.map(processIsRunning));
    if (remaining.every((running) => !running)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const remaining = await Promise.all(pids.map(processIsRunning));
  expect(remaining).toEqual(pids.map(() => false));
}

afterEach(async () => {
  for (const pid of generatorPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The command under test already cleaned up this process.
    }
  }
  for (const directory of temporaryDirectories) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
  generatorPids = [];
});

describe("frontend-i18n validate-ci", () => {
  it("passes a configured consumer and prefers i18n/ over the GitHub config path", async () => {
    const root = await createRoot();
    await createPassProject(root);
    await writeProjectFile(root, ".github/i18n/catalog-validation.json", "not json");
    await writeConfig(
      root,
      baseConfig({ files: ["client/**/*.js"] }),
      "i18n/catalog-validation.json",
    );

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      "validate-ci mode=warn status=pass errors=0 warnings=0 config=config",
    ]);
    await expectResults(result, { status: "pass", errors: 0, warnings: 0, config: "config" });
  });

  it("checks source message IDs against sourceLint.catalog", async () => {
    const root = await createRoot();
    await createPassProject(root, {
      files: ["src/**/*.{js,jsx,ts,tsx}"],
      catalog: "locales/en.json",
    });
    await writeProjectFile(
      root,
      "src/App.tsx",
      'formatMessage({ id: "missing", defaultMessage: "A readable sentence." });\n',
    );

    const result = await runValidateCi(root, ["--mode", "error"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toMatch(
      /^src\/App\.tsx:1:\d+ error i18n\/no-missing-default-catalog-entry Message ID "missing" is missing from the default catalog\./,
    );
    await expectResults(result, {
      status: "findings",
      errors: 1,
      warnings: 0,
      mode: "error",
      config: "config",
    });
  });

  it("reports invalid ICU source as an error finding", async () => {
    const root = await createRoot();
    await createPassProject(root, { files: ["src/**/*.js"] });
    await writeProjectFile(
      root,
      "src/messages.js",
      'formatMessage({ id: "bad", defaultMessage: "Hello {name" });\n',
    );

    const result = await runValidateCi(root, ["--mode", "error"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.some((line) => line.includes("formatjs/no-invalid-icu"))).toBe(true);
    const actual = await readResults(result.resultsDir);
    expect(actual.I18N_STATUS).toBe("findings");
    expect(Number(actual.I18N_ERRORS)).toBeGreaterThan(0);
    expect(actual.I18N_WARNINGS).toBe(
      String(result.stdout.filter((line) => line.includes(" warning ")).length),
    );
    expect(actual.I18N_MODE).toBe("error");
    expect(actual.I18N_CONFIG).toBe("config");
    expect(actual.I18N_TOOL_VERSION).toBe("0.1.0");
  });

  it.each(["warn", "error"] as const)(
    "keeps warning-only source findings non-failing in %s mode",
    async (mode) => {
      const root = await createRoot();
      await createPassProject(root, { files: ["src/**/*.js"] });
      await writeProjectFile(
        root,
        "src/messages.js",
        'formatMessage({ id: "items", defaultMessage: "{count, plural, one {one item} other {{count} items}}" });\n',
      );

      const result = await runValidateCi(root, ["--mode", mode]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.some((line) => line.includes("formatjs/prefer-pound-in-plural"))).toBe(
        true,
      );
      expect(result.stderr).toEqual([]);
      const actual = await readResults(result.resultsDir);
      expect(actual.I18N_STATUS).toBe("findings");
      expect(actual.I18N_ERRORS).toBe("0");
      expect(Number(actual.I18N_WARNINGS)).toBeGreaterThan(0);
      expect(actual.I18N_MODE).toBe(mode);
      expect(actual.I18N_CONFIG).toBe("config");
      expect(actual.I18N_TOOL_VERSION).toBe("0.1.0");
    },
  );

  it("combines catalog mismatch and generated catalog drift as project errors", async () => {
    const root = await createRoot();
    await createPassProject(root);
    await writeProjectFile(root, "locales/fr.json", JSON.stringify({ other: "Other" }));
    await writeProjectFile(
      root,
      "generate.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify({ value: "fresh" }));\n',
    );
    await writeProjectFile(root, "locales/generated.json", JSON.stringify({ value: "checked-in" }));
    await writeConfig(root, {
      ...baseConfig(),
      generated: [
        {
          path: "locales/generated.json",
          command: process.execPath,
          args: ["generate.mjs", "{output}"],
          updateCommand: "npm run catalogs:generate",
        },
      ],
    });

    const result = await runValidateCi(root, ["--mode", "error"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("missing from target: greeting");
    expect(result.stderr.join("\n")).toContain(
      'Generated catalog "locales/generated.json" is out of date',
    );
    await expectResults(result, {
      status: "findings",
      errors: 3,
      warnings: 0,
      mode: "error",
      config: "config",
    });
  });

  it("uses only the four ICU rules for a FormatJS consumer without config", async () => {
    const root = await createRoot();
    await writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ devDependencies: { "@formatjs/cli": "^6.0.0" } }),
    );
    await writeProjectFile(
      root,
      "eslint.config.js",
      'export default [{ rules: { "formatjs/no-invalid-icu": "off" } }];\n',
    );
    await writeProjectFile(
      root,
      "src/messages.ts",
      [
        "// eslint-disable-next-line formatjs/no-invalid-icu",
        'formatMessage({ id: "invalid", defaultMessage: "Hello {name" });',
        'formatMessage({ id: "missing-other", defaultMessage: "{count, plural, one {one item}}" });',
        'formatMessage({ id: "one-number", defaultMessage: "{count, plural, one {1 item} other {# items}}" });',
        'formatMessage({ id: "offset", defaultMessage: "{count, plural, offset:1 one {one} other {# items}}" });',
        'formatMessage({ id: "translatability-only", defaultMessage: "Click <b>here</b>." });',
        "",
      ].join("\n"),
    );

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    const ruleIds = new Set(
      result.stderr.map((line) => line.match(/ error (\S+) /)?.[1]).filter(Boolean),
    );
    expect(ruleIds).toEqual(icuRules);
    expect(
      result.stderr.some(
        (line) => line.startsWith("src/messages.ts:2:") && line.includes("formatjs/no-invalid-icu"),
      ),
    ).toBe(true);
    expect(result.stdout.at(-1)).toContain("status=findings");
    expect(await stat(join(root, "node_modules")).catch(() => undefined)).toBeUndefined();
    await expectResults(result, {
      status: "findings",
      errors: result.stderr.length,
      warnings: 0,
      config: "zero-config",
    });
  });

  it("reports a consumer without config or FormatJS dependencies as not configured", async () => {
    const root = await createRoot();
    await writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "^19" } }),
    );
    await writeProjectFile(
      root,
      "src/messages.js",
      'formatMessage({ defaultMessage: "Hello {name" });\n',
    );

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([
      "No i18n validation configured. validate-ci mode=warn status=not-configured errors=0 warnings=0 config=none",
    ]);
    expect(result.stderr).toEqual([]);
    await expectResults(result, {
      status: "not-configured",
      errors: 0,
      warnings: 0,
      config: "none",
    });
  });

  it("defaults the consumer root to the current directory", async () => {
    const root = await createRoot();
    await writeProjectFile(root, "package.json", JSON.stringify({ name: "consumer" }));
    const resultsDir = join(root, "relative-results");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["validate-ci", "--results-dir", "relative-results"], {
      cwd: root,
      env: {},
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("status=not-configured");
    expect(stderr).toEqual([]);
    expect(await readResults(resultsDir)).toEqual({
      I18N_STATUS: "not-configured",
      I18N_ERRORS: "0",
      I18N_WARNINGS: "0",
      I18N_MODE: "warn",
      I18N_CONFIG: "none",
      I18N_TOOL_VERSION: "0.1.0",
    });
  });

  it("runs project validation only when configured without sourceLint", async () => {
    const root = await createRoot();
    await createPassProject(root);
    await writeProjectFile(
      root,
      "src/messages.js",
      'formatMessage({ defaultMessage: "Hello {name" });\n',
    );

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    await expectResults(result, { status: "pass", errors: 0, warnings: 0, config: "config" });
  });

  it("loads a custom catalog adapter declared by the consumer", async () => {
    const root = await createRoot();
    await writeProjectFile(
      root,
      "package.json",
      JSON.stringify({
        i18nTooling: { catalogAdapters: { "consumer-json": "./adapter.mjs" } },
      }),
    );
    await writeProjectFile(
      root,
      "adapter.mjs",
      `export default {
        id: "consumer-json",
        read(document, context) {
          const messages = Object.fromEntries(Object.entries(document).map(([id, pattern]) => [
            id,
            { pattern, metadata: {} }
          ]));
          return { locale: context.locale, messages };
        },
        write(catalog) {
          return Object.fromEntries(Object.entries(catalog.messages).map(([id, message]) => [
            id,
            message.pattern
          ]));
        }
      };`,
    );
    await writeProjectFile(root, "locales/en.json", JSON.stringify({ greeting: "Hello {name}" }));
    await writeProjectFile(root, "locales/fr.json", JSON.stringify({ greeting: "Hello {name}" }));
    await writeConfig(root, {
      version: 1,
      checks: [
        {
          source: { path: "locales/en.json", adapter: "consumer-json", locale: "en" },
          targets: [{ path: "locales/fr.json", adapter: "consumer-json", locale: "fr" }],
        },
      ],
      generated: [],
    });

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    await expectResults(result, { status: "pass", errors: 0, warnings: 0, config: "config" });
  });

  it("reports an unparseable source file as one warning", async () => {
    const root = await createRoot();
    await createPassProject(root, { files: ["src/**/*.ts"] });
    await writeProjectFile(root, "src/broken.ts", "const message: = ;\n");

    const result = await runValidateCi(root, ["--mode", "error"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.filter((line) => line.includes("warning parse-error"))).toHaveLength(1);
    await expectResults(result, {
      status: "findings",
      errors: 0,
      warnings: 1,
      mode: "error",
      config: "config",
    });
  });

  it.each(["warn", "error"] as const)(
    "terminates a hanging generator and its child process at the deadline in %s mode",
    async (mode) => {
      const root = await createRoot();
      const resultsDir = join(root, "results-deadline");
      const pidsPath = join(root, "generator-pids.json");
      const fallbackPath = join(root, "fallback-status.txt");
      const generator = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "fs.writeFileSync(process.env.PIDS_PATH, JSON.stringify([process.pid, child.pid]));",
        'fs.writeFileSync(process.env.FALLBACK_PATH, fs.readFileSync(process.env.RESULTS_DIR + "/I18N_STATUS", "utf8"));',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      await writeProjectFile(root, "package.json", JSON.stringify({ name: "generator-consumer" }));
      await writeProjectFile(
        root,
        "locales/en.json",
        JSON.stringify({ greeting: { defaultMessage: "Hello" } }),
      );
      await writeProjectFile(root, "locales/fr.json", JSON.stringify({ greeting: "Hello" }));
      await writeConfig(root, {
        version: 1,
        checks: [],
        generated: [
          {
            path: "locales/generated.json",
            command: process.execPath,
            args: ["-e", generator, "{output}"],
          },
        ],
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(
        [
          "validate-ci",
          "--root",
          root,
          "--results-dir",
          resultsDir,
          "--mode",
          mode,
          "--timeout-seconds",
          "2",
        ],
        {
          cwd: packageRoot,
          env: {
            PIDS_PATH: pidsPath,
            FALLBACK_PATH: fallbackPath,
            RESULTS_DIR: resultsDir,
          },
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      );

      const [generatorPid, childPid] = JSON.parse(await readFile(pidsPath, "utf8")) as number[];
      generatorPids.push(generatorPid!, childPid!);
      await waitForProcessesToExit([generatorPid!, childPid!]);
      expect(await readFile(fallbackPath, "utf8")).toBe("tool-error");
      expect(exitCode).toBe(mode === "warn" ? 0 : 1);
      expect(stderr.some((line) => line.includes("deadline exceeded after 2 seconds"))).toBe(true);
      expect(stdout.at(-1)).toContain("status=tool-error errors=0 warnings=0 config=config");
      const entries = await readResults(resultsDir);
      expect(entries).toEqual({
        I18N_STATUS: "tool-error",
        I18N_ERRORS: "0",
        I18N_WARNINGS: "0",
        I18N_MODE: mode,
        I18N_CONFIG: "config",
        I18N_TOOL_VERSION: "0.1.0",
      });
    },
  );

  it("turns a crashed validation worker into a tool error and cleans up its process group", async () => {
    const root = await createRoot();
    const pidsPath = join(root, "crash-pids.json");
    const generator = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "fs.writeFileSync(process.env.PIDS_PATH, JSON.stringify([process.pid, child.pid]));",
      'process.kill(process.ppid, "SIGKILL");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeProjectFile(root, "package.json", JSON.stringify({ name: "crash-consumer" }));
    await writeConfig(root, {
      version: 1,
      checks: [],
      generated: [
        {
          path: "locales/generated.json",
          command: process.execPath,
          args: ["-e", generator, "{output}"],
        },
      ],
    });

    const result = await runValidateCi(root, ["--mode", "warn"], { PIDS_PATH: pidsPath });

    const [generatorPid, childPid] = JSON.parse(await readFile(pidsPath, "utf8")) as number[];
    generatorPids.push(generatorPid!, childPid!);
    await waitForProcessesToExit([generatorPid!, childPid!]);
    expect(result.exitCode).toBe(0);
    expect(
      result.stderr.some((line) => line.includes("Validation work exited with signal SIGKILL")),
    ).toBe(true);
    expect(result.stdout.at(-1)).toContain("status=tool-error errors=0 warnings=0 config=config");
    await expectResults(result, {
      status: "tool-error",
      errors: 0,
      warnings: 0,
      config: "config",
    });
  });

  it("returns usage status 2 for a missing or invalid mode", async () => {
    const root = await createRoot();
    const invalid = await runValidateCi(root, ["--mode", "skip"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr[0]).toContain('--mode must be "warn" or "error"');
    expect(await stat(invalid.resultsDir).catch(() => undefined)).toBeUndefined();

    const missing = await runValidateCi(root, ["--mode"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr[0]).toContain('Option "--mode" requires a value');
    expect(await stat(missing.resultsDir).catch(() => undefined)).toBeUndefined();
  });

  it("works with HOME unset, nonexistent, or read-only", async () => {
    const root = await createRoot();
    await createPassProject(root);
    const readOnlyHome = join(root, "read-only-home");
    await mkdir(readOnlyHome);
    await chmod(readOnlyHome, 0o500);

    for (const env of [{}, { HOME: join(root, "missing-home") }, { HOME: readOnlyHome }]) {
      const result = await runValidateCi(root, [], env);
      expect(result.exitCode).toBe(0);
      await expectResults(result, { status: "pass", errors: 0, warnings: 0, config: "config" });
    }
  });

  it("reports invalid consumer package metadata and bad non-mode arguments as tool errors", async () => {
    const invalidPackage = await createRoot();
    await writeProjectFile(invalidPackage, "package.json", "[]\n");
    const invalid = await runValidateCi(invalidPackage, ["--mode", "error"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr[0]).toContain("Consumer package.json must contain a JSON object");
    await expectResults(invalid, {
      status: "tool-error",
      errors: 0,
      warnings: 0,
      mode: "error",
      config: "none",
    });

    const badArgument = await runValidateCi(await createRoot(), ["--mode", "warn", "--unknown"]);
    expect(badArgument.exitCode).toBe(0);
    expect(badArgument.stderr[0]).toContain("Unknown option '--unknown'");
    await expectResults(badArgument, {
      status: "tool-error",
      errors: 0,
      warnings: 0,
      config: "none",
    });

    const badTimeout = await runValidateCi(await createRoot(), [
      "--mode",
      "warn",
      "--timeout-seconds",
      "0",
    ]);
    expect(badTimeout.exitCode).toBe(0);
    expect(badTimeout.stderr[0]).toContain("--timeout-seconds must be a positive integer");
    await expectResults(badTimeout, {
      status: "tool-error",
      errors: 0,
      warnings: 0,
      config: "none",
    });
  });

  it("reports an unwritable results directory as a tool error", async () => {
    const root = await createRoot();
    await createPassProject(root);
    const resultsFile = join(root, "results-file");
    await writeFile(resultsFile, "not a directory");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ["validate-ci", "--root", root, "--mode", "error", "--results-dir", resultsFile],
      {
        cwd: packageRoot,
        env: {},
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr[0]).toContain("EEXIST");
    expect(stdout[0]).toContain("status=tool-error errors=0 warnings=0 config=none");
  });

  it("loads the CLI-owned lint stack for a consumer in another tree without node_modules", async () => {
    const root = await createRoot();
    await writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ peerDependencies: { "react-intl": "^6.0.0" } }),
    );
    await writeProjectFile(
      root,
      "src/valid.ts",
      'formatMessage({ id: "ok", defaultMessage: "Ready." });\n',
    );

    const result = await runValidateCi(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    await expectResults(result, { status: "pass", errors: 0, warnings: 0, config: "zero-config" });
    await expect(stat(join(root, "node_modules"))).rejects.toThrow();
  });

  it("returns the discovery result directly for configured, zero-config, and empty globs", async () => {
    const configuredRoot = await createRoot();
    await createPassProject(configuredRoot, { files: [] });
    expect(await executeValidateCi(configuredRoot)).toEqual({
      status: "pass",
      config: "config",
      errors: [],
      warnings: [],
    });

    const formatJsRoot = await createRoot();
    await writeProjectFile(
      formatJsRoot,
      "package.json",
      JSON.stringify({ dependencies: { "@formatjs/icu-messageformat-parser": "3.5.20" } }),
    );
    expect(await executeValidateCi(formatJsRoot)).toEqual({
      status: "pass",
      config: "zero-config",
      errors: [],
      warnings: [],
    });

    const invalidRoot = await createRoot();
    await writeProjectFile(invalidRoot, ".github/i18n/catalog-validation.json", "invalid");
    expect(await executeValidateCi(invalidRoot)).toMatchObject({
      status: "tool-error",
      config: "config",
      errors: [],
      warnings: [],
    });
  });
});
