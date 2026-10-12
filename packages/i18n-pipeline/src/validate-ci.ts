import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCatalogAdapterRegistry,
  parseCatalogValidationConfig,
  validateCatalogProject,
} from "./index.js";
import type { ESLint as ESLintApi, Linter } from "eslint";

export const VALIDATE_CI_HELP = `Usage: frontend-i18n validate-ci [options]

Options:
  --root <dir>             Consumer repository root (default: current directory)
  --mode <warn|error>      Whether errors affect the exit code (default: warn)
  --results-dir <dir>      Write Tekton result files into this directory
  --timeout-seconds <n>    Deadline for the complete run (positive integer, default: 600)
  -h, --help               Show this help

Discovery checks i18n/catalog-validation.json, then .github/i18n/catalog-validation.json.
Without a config, FormatJS dependencies enable zero-config ICU lint; other consumers are
reported as not configured. Configured source lint is opt-in through sourceLint in the config.

warn exits 0 for findings and tool errors. error exits 1 for errors and tool errors, and 0
for warnings only. Invalid or missing --mode values exit 2.`;

const DEFAULT_SOURCE_FILES = ["src/**/*.{js,jsx,ts,tsx}"];
const ICU_RULES: Linter.RulesRecord = {
  "formatjs/no-invalid-icu": "error",
  "formatjs/enforce-plural-rules": ["error", { other: true }],
  "formatjs/no-missing-icu-plural-one-placeholders": "error",
  "formatjs/no-offset": "error",
};
const TRANSLATABILITY_RULES: Linter.RulesRecord = {
  "formatjs/blocklist-elements": ["warn", ["tag"]],
  "formatjs/prefer-full-sentence": "warn",
  "formatjs/prefer-pound-in-plural": "warn",
  "formatjs/no-complex-selectors": ["warn", { limit: 20 }],
  "formatjs/no-multiple-plurals": "warn",
};

export type ValidateCiMode = "warn" | "error";
export type ValidateCiConfigKind = "config" | "zero-config" | "none";
export type ValidateCiStatus = "pass" | "findings" | "not-configured" | "tool-error";

export interface ValidateCiReport {
  status: ValidateCiStatus;
  config: ValidateCiConfigKind;
  errors: string[];
  warnings: string[];
  toolError?: string;
}

interface ValidateCiArguments {
  root?: string;
  mode: ValidateCiMode;
  resultsDir?: string;
  timeoutSeconds?: string;
}

interface WorkerMessage {
  type: "config" | "result";
  config?: ValidateCiConfigKind;
  report?: ValidateCiReport;
}

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ValidateCiCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modeFromArgs(args: string[]): { mode?: ValidateCiMode; usageError?: string } {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--mode") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { usageError: 'Option "--mode" requires a value of "warn" or "error"' };
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      values.push(argument.slice("--mode=".length));
    }
  }

  const invalidValue = values.find((value) => value !== "warn" && value !== "error");
  if (invalidValue !== undefined) {
    return { usageError: `--mode must be "warn" or "error" (received "${invalidValue}")` };
  }
  return { mode: (values.at(-1) as ValidateCiMode | undefined) ?? "warn" };
}

function resultsDirectoryFromArgs(args: string[]): { present: boolean; value?: string } {
  let present = false;
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--results-dir") {
      present = true;
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    } else if (argument.startsWith("--results-dir=")) {
      present = true;
      value = argument.slice("--results-dir=".length);
    }
  }
  return { present, ...(value === undefined ? {} : { value }) };
}

function parseValidateCiArguments(args: string[], mode: ValidateCiMode): ValidateCiArguments {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      mode: { type: "string" },
      "results-dir": { type: "string" },
      "timeout-seconds": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    ...(values.root === undefined ? {} : { root: values.root }),
    mode,
    ...(values["results-dir"] === undefined ? {} : { resultsDir: values["results-dir"] }),
    ...(values["timeout-seconds"] === undefined
      ? {}
      : { timeoutSeconds: values["timeout-seconds"] }),
  };
}

function parseTimeoutSeconds(value: string | undefined): bigint {
  const text = value ?? "600";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new TypeError("--timeout-seconds must be a positive integer");
  }
  return BigInt(text);
}

async function readToolVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest.version !== "string") {
    throw new Error("Package version is missing");
  }
  return manifest.version;
}

type ResultValues = {
  status: ValidateCiStatus;
  errors: number;
  warnings: number;
  mode: ValidateCiMode;
  config: ValidateCiConfigKind;
  version: string;
};

const RESULT_KEYS: Array<[string, keyof ResultValues]> = [
  ["I18N_STATUS", "status"],
  ["I18N_ERRORS", "errors"],
  ["I18N_WARNINGS", "warnings"],
  ["I18N_MODE", "mode"],
  ["I18N_CONFIG", "config"],
  ["I18N_TOOL_VERSION", "version"],
];

async function writeResults(directory: string | undefined, values: ResultValues): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await Promise.all(
    RESULT_KEYS.map(([file, key]) =>
      writeFile(resolve(directory, file), String(values[key]), "utf8"),
    ),
  );
}

function reportForToolError(
  message: string,
  config: ValidateCiConfigKind = "none",
): ValidateCiReport {
  return { status: "tool-error", config, errors: [], warnings: [], toolError: message };
}

function statusForFindings(errors: string[], warnings: string[]): ValidateCiStatus {
  return errors.length + warnings.length ? "findings" : "pass";
}

function reportForFindings(
  config: ValidateCiConfigKind,
  errors: string[],
  warnings: string[],
): ValidateCiReport {
  return { status: statusForFindings(errors, warnings), config, errors, warnings };
}

function summaryLine(mode: ValidateCiMode, report: ValidateCiReport): string {
  return (
    `validate-ci mode=${mode} status=${report.status} errors=${report.errors.length} ` +
    `warnings=${report.warnings.length} config=${report.config}`
  );
}

function exitCodeFor(mode: ValidateCiMode, report: ValidateCiReport): number {
  if (mode === "warn") return 0;
  return report.status === "tool-error" || report.errors.length > 0 ? 1 : 0;
}

function reportToResults(
  mode: ValidateCiMode,
  version: string,
  report: ValidateCiReport,
): ResultValues {
  return {
    status: report.status,
    errors: report.errors.length,
    warnings: report.warnings.length,
    mode,
    config: report.config,
    version,
  };
}

function toolErrorText(error: unknown): string {
  return `frontend-i18n validate-ci: ${errorMessage(error)}`;
}

function emitReport(
  mode: ValidateCiMode,
  report: ValidateCiReport,
  { stdout, stderr }: Pick<ValidateCiCommandOptions, "stdout" | "stderr">,
): void {
  if (report.toolError) stderr(toolErrorText(report.toolError));
  for (const error of report.errors) stderr(error);
  for (const warning of report.warnings) stdout(warning);
  const summary = summaryLine(mode, report);
  stdout(
    report.status === "not-configured" ? `No i18n validation configured. ${summary}` : summary,
  );
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

async function readOptionalFile(path: string, label: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error(`${label} "${path}" could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function readConsumerPackage(root: string): Promise<Record<string, unknown> | undefined> {
  const path = resolve(root, "package.json");
  const text = await readOptionalFile(path, "Consumer package.json");
  if (text === undefined) return undefined;
  const manifest = parseJson(text, "Consumer package.json");
  if (!isRecord(manifest)) throw new TypeError("Consumer package.json must contain a JSON object");

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      throw new TypeError(`Consumer package.json "${field}" must be an object`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string") {
        throw new TypeError(`Consumer package.json "${field}.${name}" must be a string`);
      }
    }
  }
  return manifest;
}

function hasFormatJsDependency(manifest: Record<string, unknown> | undefined): boolean {
  if (!manifest) return false;
  return ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const dependencies = manifest[field];
    return (
      isRecord(dependencies) &&
      Object.keys(dependencies).some(
        (name) => name === "react-intl" || name.startsWith("@formatjs/"),
      )
    );
  });
}

interface LintFindings {
  errors: string[];
  warnings: string[];
}

function formatLintFinding(
  root: string,
  filePath: string,
  line: number | undefined,
  column: number | undefined,
  severity: "error" | "warning",
  rule: string,
  message: string,
): string {
  const file = relative(root, filePath).split(sep).join("/") || filePath;
  return `${file}:${line ?? 1}:${column ?? 1} ${severity} ${rule} ${message}`;
}

async function lintSource(
  root: string,
  files: string[],
  configured: boolean,
  catalog: string | undefined,
): Promise<LintFindings> {
  if (!files.length) return { errors: [], warnings: [] };

  const [{ ESLint }, typescriptEslint, formatjs] = await Promise.all([
    import("eslint"),
    import("typescript-eslint"),
    import("eslint-plugin-formatjs"),
  ]);
  const plugins: NonNullable<Linter.Config["plugins"]> = {
    formatjs: formatjs.default as ESLintApi.Plugin,
  };
  const rules: Linter.RulesRecord = {
    ...ICU_RULES,
    ...(configured ? TRANSLATABILITY_RULES : {}),
  };
  if (catalog) {
    const require = createRequire(import.meta.url);
    const pluginModule = require("@redhat-cloud-services/eslint-plugin-i18n") as {
      default?: unknown;
    };
    plugins.i18n = (pluginModule.default ?? pluginModule) as ESLintApi.Plugin;
    rules["i18n/no-missing-default-catalog-entry"] = ["error", { catalog }];
  }

  const config: Linter.Config = {
    files,
    languageOptions: {
      parser: typescriptEslint.default.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: { noInlineConfig: true },
    plugins,
    rules,
  };
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [config],
    errorOnUnmatchedPattern: false,
    cache: false,
  });
  const results = await eslint.lintFiles(files);
  const findings: LintFindings = { errors: [], warnings: [] };

  for (const result of results) {
    let parseFailureReported = false;
    for (const message of result.messages) {
      if (message.fatal) {
        if (!parseFailureReported) {
          findings.warnings.push(
            formatLintFinding(
              root,
              result.filePath,
              message.line,
              message.column,
              "warning",
              "parse-error",
              `Unable to parse source file: ${message.message}`,
            ),
          );
          parseFailureReported = true;
        }
        continue;
      }
      if (!message.ruleId) continue;
      const severity = message.severity === 2 ? "error" : "warning";
      const finding = formatLintFinding(
        root,
        result.filePath,
        message.line,
        message.column,
        severity,
        message.ruleId,
        message.message,
      );
      findings[severity === "error" ? "errors" : "warnings"].push(finding);
    }
  }
  return findings;
}

export async function executeValidateCi(
  root: string,
  onConfig?: (config: ValidateCiConfigKind) => void,
): Promise<ValidateCiReport> {
  let configKind: ValidateCiConfigKind = "none";
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new TypeError(`Consumer root "${root}" is not a directory`);
    }
    const configPaths = [
      resolve(root, "i18n/catalog-validation.json"),
      resolve(root, ".github/i18n/catalog-validation.json"),
    ];
    let configText: string | undefined;
    for (const path of configPaths) {
      configText = await readOptionalFile(path, "Catalog validation config");
      if (configText !== undefined) {
        configKind = "config";
        onConfig?.(configKind);
        break;
      }
    }

    if (configText !== undefined) {
      const config = parseCatalogValidationConfig(
        parseJson(configText, "Catalog validation config"),
      );
      await readConsumerPackage(root);
      const errors: string[] = [];
      const warnings: string[] = [];
      if (config.sourceLint) {
        const lint = await lintSource(
          root,
          config.sourceLint.files ?? DEFAULT_SOURCE_FILES,
          true,
          config.sourceLint.catalog ? resolve(root, config.sourceLint.catalog) : undefined,
        );
        errors.push(...lint.errors);
        warnings.push(...lint.warnings);
      }
      const registry = await createCatalogAdapterRegistry(root);
      const result = await validateCatalogProject(root, config, registry);
      errors.push(...result.problems);
      warnings.push(...result.warnings);
      return reportForFindings(configKind, errors, warnings);
    }

    const manifest = await readConsumerPackage(root);
    if (!hasFormatJsDependency(manifest)) {
      return { status: "not-configured", config: "none", errors: [], warnings: [] };
    }

    configKind = "zero-config";
    onConfig?.(configKind);
    const lint = await lintSource(root, DEFAULT_SOURCE_FILES, false, undefined);
    return reportForFindings(configKind, lint.errors, lint.warnings);
  } catch (error) {
    return reportForToolError(errorMessage(error), configKind);
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

async function waitForGroupToExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !groupExists(pid);
}

async function terminateProcessGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  if (await waitForGroupToExit(pid, 250)) return;
  signalGroup(pid, "SIGKILL");
  await waitForGroupToExit(pid, 500);
}

function deadlinePromise(deadline: bigint): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  let resolveDeadline!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolveDeadline = resolvePromise;
  });
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadline - BigInt(Date.now());
    if (remaining <= 0n) {
      resolveDeadline();
      return;
    }
    const maximumDelay = 2_147_000_000n;
    timer = setTimeout(schedule, Number(remaining > maximumDelay ? maximumDelay : remaining));
  };
  schedule();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function waitForChildClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    return;
  }
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500)),
  ]);
}

function forwardLines(buffer: string, chunk: string, output: (message: string) => void): string {
  const lines = `${buffer}${chunk}`.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) output(line);
  return remainder;
}

async function runWorker(
  root: string,
  env: NodeJS.ProcessEnv,
  deadline: bigint,
  onConfig: (config: ValidateCiConfigKind) => void,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<{ report: ValidateCiReport; deadlineExceeded: boolean }> {
  const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/validate-ci.js");
  const moduleUrl = pathToFileURL(modulePath).href;
  const workerSource = `
import { executeValidateCi } from ${JSON.stringify(moduleUrl)};
process.once("disconnect", () => {
  try { process.kill(-process.pid, "SIGKILL"); } catch {}
});
process.once("message", async ({ root }) => {
  let report;
  try {
    report = await executeValidateCi(root, (config) => {
      if (process.send) process.send({ type: "config", config });
    });
  } catch (error) {
    report = { status: "tool-error", config: "none", errors: [], warnings: [], toolError: String(error) };
  }
  if (process.send) process.send({ type: "result", report });
});
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let workerReport: ValidateCiReport | undefined;
  let workerExit: WorkerExit | undefined;
  const resultPromise = new Promise<ValidateCiReport>((resolvePromise) => {
    child.on("message", (value: unknown) => {
      if (!isRecord(value)) return;
      const message = value as unknown as WorkerMessage;
      if (message.type === "config" && message.config) onConfig(message.config);
      if (message.type === "result" && message.report) {
        workerReport = message.report;
        resolvePromise(message.report);
      }
    });
  });
  const exitPromise = new Promise<WorkerExit>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      workerExit = { code, signal };
      resolvePromise(workerExit);
    });
  });
  child.once("error", (error) => {
    stderrBuffer = forwardLines(stderrBuffer, `${errorMessage(error)}\n`, stderr);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer = forwardLines(stdoutBuffer, chunk, stdout);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer = forwardLines(stderrBuffer, chunk, stderr);
  });

  const remainingMilliseconds = deadline - BigInt(Date.now());
  if (remainingMilliseconds <= 0n) {
    if (child.pid) await terminateProcessGroup(child.pid);
    return {
      report: reportForToolError("deadline exceeded"),
      deadlineExceeded: true,
    };
  }
  const timeout = deadlinePromise(deadline);
  const sendTask = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("spawn", () => {
      child.send({ root }, (error) => (error ? rejectPromise(error) : resolvePromise()));
    });
    child.once("error", rejectPromise);
  });

  let deadlineExceeded = false;
  let outcome: "result" | "exit" | "deadline" = "result";
  try {
    await sendTask;
    const winner = await Promise.race([
      resultPromise.then(() => "result" as const),
      exitPromise.then(() => "exit" as const),
      timeout.promise.then(() => "deadline" as const),
    ]);
    outcome = winner;
    deadlineExceeded = winner === "deadline";
  } catch (error) {
    stderrBuffer = forwardLines(stderrBuffer, `${errorMessage(error)}\n`, stderr);
    outcome = "exit";
  } finally {
    timeout.cancel();
  }

  if (child.pid) {
    if (child.connected) child.disconnect();
    await terminateProcessGroup(child.pid);
    await waitForChildClose(child);
  }
  if (stdoutBuffer) stdout(stdoutBuffer);
  if (stderrBuffer) stderr(stderrBuffer);

  if (deadlineExceeded) {
    return { report: reportForToolError("deadline exceeded"), deadlineExceeded: true };
  }
  if (outcome === "result" && workerReport) {
    return { report: workerReport, deadlineExceeded: false };
  }
  const status = workerExit?.signal
    ? `signal ${workerExit.signal}`
    : `exit code ${workerExit?.code ?? "unknown"}`;
  return {
    report: reportForToolError(`Validation work exited with ${status}`),
    deadlineExceeded: false,
  };
}

export async function runValidateCiCommand(
  args: string[],
  options: ValidateCiCommandOptions,
): Promise<number> {
  const modeResult = modeFromArgs(args);
  if (modeResult.usageError) {
    options.stderr(`frontend-i18n validate-ci: ${modeResult.usageError}\n${VALIDATE_CI_HELP}`);
    return 2;
  }
  const mode = modeResult.mode ?? "warn";
  const startedAt = BigInt(Date.now());
  const resultsOption = resultsDirectoryFromArgs(args);
  let version: string;
  try {
    version = await readToolVersion();
  } catch (error) {
    const report = reportForToolError(errorMessage(error));
    emitReport(mode, report, options);
    return exitCodeFor(mode, report);
  }

  const resultsDirectory =
    resultsOption.present && resultsOption.value !== undefined && resultsOption.value.length > 0
      ? resolve(options.cwd, resultsOption.value)
      : undefined;
  let fallbackWritten = false;
  try {
    if (resultsOption.present && resultsDirectory) {
      await writeResults(resultsDirectory, {
        status: "tool-error",
        errors: 0,
        warnings: 0,
        mode,
        config: "none",
        version,
      });
      fallbackWritten = true;
    }
  } catch (error) {
    const report = reportForToolError(errorMessage(error));
    emitReport(mode, report, options);
    return exitCodeFor(mode, report);
  }

  let parsed: ValidateCiArguments;
  try {
    parsed = parseValidateCiArguments(args, mode);
  } catch (error) {
    const report = reportForToolError(errorMessage(error));
    try {
      if (fallbackWritten && resultsDirectory) {
        await writeResults(resultsDirectory, reportToResults(mode, version, report));
      }
    } catch (writeError) {
      report.toolError = `${report.toolError}; could not write results: ${errorMessage(writeError)}`;
    }
    emitReport(mode, report, options);
    return exitCodeFor(mode, report);
  }

  if (parsed.resultsDir !== undefined && !parsed.resultsDir.trim()) {
    const report = reportForToolError("--results-dir must not be empty");
    emitReport(mode, report, options);
    return exitCodeFor(mode, report);
  }

  let timeoutSeconds: bigint;
  try {
    timeoutSeconds = parseTimeoutSeconds(parsed.timeoutSeconds);
  } catch (error) {
    const report = reportForToolError(errorMessage(error));
    try {
      if (fallbackWritten && resultsDirectory) {
        await writeResults(resultsDirectory, reportToResults(mode, version, report));
      }
    } catch (writeError) {
      report.toolError = `${report.toolError}; could not write results: ${errorMessage(writeError)}`;
    }
    emitReport(mode, report, options);
    return exitCodeFor(mode, report);
  }

  const root = resolve(options.cwd, parsed.root ?? ".");
  const deadline = startedAt + timeoutSeconds * 1000n;
  let discoveredConfig: ValidateCiConfigKind = "none";
  let report: ValidateCiReport;
  try {
    const outcome = await runWorker(
      root,
      options.env,
      deadline,
      (config) => {
        discoveredConfig = config;
      },
      options.stdout,
      options.stderr,
    );
    report = outcome.deadlineExceeded
      ? reportForToolError(
          `deadline exceeded after ${parsed.timeoutSeconds ?? "600"} seconds`,
          discoveredConfig,
        )
      : outcome.report.config === "none" && discoveredConfig !== "none"
        ? { ...outcome.report, config: discoveredConfig }
        : outcome.report;
  } catch (error) {
    report = reportForToolError(errorMessage(error), discoveredConfig);
  }

  try {
    if (fallbackWritten && resultsDirectory) {
      await writeResults(resultsDirectory, reportToResults(mode, version, report));
    }
  } catch (error) {
    report = reportForToolError(`Could not write results: ${errorMessage(error)}`, report.config);
  }
  emitReport(mode, report, options);
  return exitCodeFor(mode, report);
}
