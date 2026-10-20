#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_CATALOG_ADAPTER_IDS,
  CatalogAdapterRegistry,
  CatalogFormatError,
  checkCatalogs as compareCatalogs,
  convertCatalog as convertCatalogDocument,
  createCatalogAdapterRegistry,
  describeArgumentMismatch,
  lintSourceCatalog,
  lintTargetCatalog,
  parseCatalogDocument,
  parseCatalogValidationConfig,
  serializeCatalogDocument,
  validateCatalogProject,
  type AdapterContext,
  type Catalog,
  type CatalogAdapter,
  type CatalogRole,
} from "./index.js";
import { GitHubPhraseRepository } from "./github-phrase-repository.js";
import { PhraseClient, type PhraseClientOptions } from "./phrase-client.js";
import { overlongFeoTranslationsWarning } from "./feo-locale.js";
import { parsePhraseTmsConfig, targetAdapterId } from "./phrase-config.js";
import { PhraseWorkflow, type PhraseReconcileResult } from "./phrase-workflow.js";
import {
  extractFeoCatalog,
  formatFeoCatalog,
  inlineFeoLocale,
  serializeFeoCatalog,
  type FeoCatalog,
} from "./feo-template.js";
import { extractFeoEnvironmentCatalogs, inlineFeoEnvironmentLocale } from "./feo-environment.js";
import { runValidateCiCommand, VALIDATE_CI_HELP } from "./validate-ci.js";

export interface CliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

const ROOT_HELP = `Usage: i18n-pipeline <check|validate|validate-project|validate-ci|convert|feo|tms|version|help> [options]

Commands:
  check             Compare source and target catalogs
  validate          Validate one catalog's format and ICU syntax
  validate-project  Check configured catalogs and generated-catalog sync
  validate-ci       Discover and validate a consumer repository for CI
  convert           Convert a catalog between adapters
  tms               Submit and reconcile translation batches
  feo               Extract and inline Frontend and FrontendEnvironment translations
  version           Print the package version
  help              Show help, optionally for one command

Use i18n-pipeline <command> --help for command options.`;

const COMMAND_HELP: Record<string, string> = {
  feo: `Usage: i18n-pipeline feo <extract|inline> [options]

  extract --template <yaml> [--template <yaml> ...] --output <json> [--kind <kind>] [--check]
  inline --template <yaml> --source <json> --target <json> --locale <tag> [--kind <kind>] [--check]

  --kind <kind> is Frontend (default) or FrontendEnvironment.
  FrontendEnvironment extract accepts multiple --template files and combines them into one catalog.
  --check verifies checked-in output without writing. Inline updates only spec.locales.<locale>.`,
  check: `Usage: i18n-pipeline check --source <path> --target <path> [options]

Options:
  --source-adapter <id>  Source adapter (default: formatjs-json)
  --target-adapter <id>  Target adapter (default: source adapter)
  --source-locale <tag>  Source locale (default: en)
  --target-locale <tag>  Target locale (default: und)
  --source-config <path> Source adapter JSON config
  --target-config <path> Target adapter JSON config
  -h, --help             Show this help`,
  validate: `Usage: i18n-pipeline validate --catalog <path> [options]

Options:
  --adapter <id>  Catalog adapter (default: formatjs-json)
  --locale <tag>  Catalog locale (default: en)
  --role <role>   Catalog role: source or target (default: source)
  --config <path> Adapter JSON config
  -h, --help      Show this help`,
  "validate-project": `Usage: i18n-pipeline validate-project --config <path>

Run configured source/target catalog checks and verify generated catalogs are current.
The config may declare multiple adapters, native generator commands, a Phrase TMS config
whose target locales are checked once delivered, and directories that must hold only
declared catalogs.

Options:
  --config <path>  Catalog validation JSON config
  -h, --help       Show this help`,
  "validate-ci": VALIDATE_CI_HELP,
  convert: `Usage: i18n-pipeline convert --source <path> --output <path> --source-adapter <id> --target-adapter <id> [options]

Options:
  --locale <tag>         Catalog locale (default: en)
  --source-role <role>   Source role: source or target (default: source)
  --target-role <role>   Target role: source or target (default: target)
  --source-config <path> Source adapter JSON config
  --target-config <path> Target adapter JSON config
  -h, --help             Show this help`,
  tms: `Usage: i18n-pipeline tms <submit|reconcile> [options]

Use i18n-pipeline tms <command> --help for command options.

Environment:
  PHRASE_PLATFORM_API_TOKEN   a user's Platform API token (required for submit)
  PHRASE_SERVICE_ACCOUNT_CLIENT_ID and
  PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET
                              Service Account; reconciliation support remains unverified
  GITHUB_TOKEN                State-branch and pull-request access`,
  "tms submit": `Usage: i18n-pipeline tms submit --config <path> [options]

Options:
  --repository <owner/name>        GitHub repository (default: GITHUB_REPOSITORY)
  --base-ref <branch>              PR base branch (default: branch from GITHUB_REF)
  --source-commit <sha>            Source revision (default: GITHUB_SHA)
  --config <path>                  TMS JSON config path
  --retry-failed                   Retry failed locales or a failed batch for this source
  --expect-project <uid>           Require this Phrase project UID
  --expect-source-filename <name>  Require this Phrase source filename
  -h, --help                       Show this help

The base branch defaults to the pushed or dispatched branch (GITHUB_REF=refs/heads/*).
Pull-request and tag refs require an explicit --base-ref.`,
  "tms reconcile": `Usage: i18n-pipeline tms reconcile --config <path> [options]

Options:
  --repository <owner/name>        GitHub repository (default: GITHUB_REPOSITORY)
  --config <path>                  TMS JSON config path
  --expect-project <uid>           Require this Phrase project UID
  --expect-source-filename <name>  Require this Phrase source filename
  --fallback-assignee <login>      Fallback GitHub assignee; may be repeated
  -h, --help                       Show this help`,
  version: `Usage: i18n-pipeline version

Prints the i18n-pipeline package version.`,
};

function helpText(command?: string): string {
  return command ? (COMMAND_HELP[command] ?? ROOT_HELP) : ROOT_HELP;
}

type ParsedOptionValue<Option> = Option extends { multiple: true }
  ? Option extends { type: "boolean" }
    ? boolean[]
    : string[]
  : Option extends { type: "boolean" }
    ? boolean
    : string;

function parseOptions<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(
  args: string[],
  options: T,
): { [K in keyof T]: ParsedOptionValue<T[K]> | undefined } {
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  return values as unknown as { [K in keyof T]: ParsedOptionValue<T[K]> | undefined };
}

function requireRole(value: string): CatalogRole {
  if (value === "source" || value === "target") return value;
  throw new Error('Catalog role must be "source" or "target"');
}

async function readJson(path: string, label: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`, { cause: error });
  }
}

async function resolveTmsInputPath(cwd: string, inputPath: string, label: string): Promise<string> {
  const absolutePath = resolve(cwd, inputPath);
  let workingDirectory: string;
  try {
    workingDirectory = await realpath(cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} path "${inputPath}" cannot resolve the working directory: ${detail}`,
      {
        cause: error,
      },
    );
  }
  let fileInfo;
  try {
    fileInfo = await lstat(absolutePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${inputPath}" cannot be inspected: ${detail}`, {
      cause: error,
    });
  }
  if (fileInfo.isSymbolicLink()) {
    throw new Error(`${label} path "${inputPath}" must not be a symbolic link`);
  }

  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${inputPath}" cannot be resolved: ${detail}`, {
      cause: error,
    });
  }
  const pathFromWorkingDirectory = relative(workingDirectory, realPath);
  if (
    pathFromWorkingDirectory === ".." ||
    pathFromWorkingDirectory.startsWith(`..${sep}`) ||
    isAbsolute(pathFromWorkingDirectory)
  ) {
    throw new Error(`${label} path "${inputPath}" resolves outside the working directory`);
  }
  return realPath;
}

function parseCatalogFile(
  content: string,
  label: string,
  adapter: CatalogAdapter,
  context: AdapterContext,
): unknown {
  try {
    return parseCatalogDocument(content, adapter, context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const format = adapter.parseDocument ? `adapter "${adapter.id}" input` : "JSON";
    throw new Error(`${label} is not valid ${format}: ${detail}`, { cause: error });
  }
}

async function readAdapterOptions(
  cwd: string,
  configPath: string | undefined,
): Promise<Record<string, unknown>> {
  if (!configPath) return {};
  const options = await readJson(resolve(cwd, configPath), "Adapter config");
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("Adapter config must be a JSON object");
  }
  return options as Record<string, unknown>;
}

function createContext(
  locale: string,
  role: CatalogRole,
  options: Record<string, unknown>,
): AdapterContext {
  return { locale, role, options };
}

function messageCount(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}

function escapeAnnotation(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Prints non-failing findings; GitHub Actions renders them as warning annotations. */
function reportWarnings(
  warnings: string[],
  { env, stdout }: Required<Pick<CliOptions, "env" | "stdout">>,
): void {
  if (!warnings.length) return;
  if (env.GITHUB_ACTIONS === "true") {
    for (const warning of warnings) {
      stdout(`::warning title=i18n-pipeline::${escapeAnnotation(warning)}`);
    }
    return;
  }
  stdout(`Catalog warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
}

async function validateCatalog(
  args: string[],
  { cwd, env, stdout, stderr }: Required<Pick<CliOptions, "cwd" | "env" | "stdout" | "stderr">>,
): Promise<boolean> {
  const values = parseOptions(args, {
    adapter: { type: "string" },
    catalog: { type: "string" },
    locale: { type: "string" },
    role: { type: "string" },
    config: { type: "string" },
  });
  const adapterId = values.adapter ?? env.I18N_CATALOG_ADAPTER ?? "formatjs-json";
  const catalogPath = values.catalog ?? env.I18N_CATALOG_PATH;
  if (!catalogPath) throw new Error("Pass --catalog or set I18N_CATALOG_PATH");
  const locale = values.locale ?? env.I18N_CATALOG_LOCALE ?? "en";
  const role = requireRole(values.role ?? env.I18N_CATALOG_ROLE ?? "source");
  const configPath = values.config ?? env.I18N_CATALOG_CONFIG;
  const [content, options] = await Promise.all([
    readFile(resolve(cwd, catalogPath), "utf8"),
    readAdapterOptions(cwd, configPath),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const adapter = registry.get(adapterId);
  const context = createContext(locale, role, options);
  const document = parseCatalogFile(content, "Catalog", adapter, context);
  let catalog: Catalog;
  try {
    catalog = adapter.read(document, context);
  } catch (error) {
    if (!(error instanceof CatalogFormatError)) throw error;
    stderr(`Catalog validation failed for "${catalogPath}":\n${error.message}`);
    return false;
  }
  if (role === "source") {
    reportWarnings(
      lintSourceCatalog(catalog).map((warning) => warning.message),
      { env, stdout },
    );
  }
  stdout(
    `Validated ${messageCount(Object.keys(catalog.messages).length)} ` +
      `(adapter=${adapterId}, locale=${locale}, role=${role}).`,
  );
  return true;
}

async function checkCatalog(
  args: string[],
  { cwd, env, stdout, stderr }: Required<Pick<CliOptions, "cwd" | "env" | "stdout" | "stderr">>,
): Promise<boolean> {
  const values = parseOptions(args, {
    source: { type: "string" },
    target: { type: "string" },
    "source-adapter": { type: "string" },
    "target-adapter": { type: "string" },
    "source-locale": { type: "string" },
    "target-locale": { type: "string" },
    "source-config": { type: "string" },
    "target-config": { type: "string" },
  });
  const sourcePath = values.source;
  const targetPath = values.target;
  if (!sourcePath || !targetPath) {
    throw new Error("check requires --source and --target");
  }

  const sourceAdapterId =
    values["source-adapter"] ??
    env.I18N_SOURCE_CATALOG_ADAPTER ??
    env.I18N_CATALOG_ADAPTER ??
    "formatjs-json";
  const targetAdapterId =
    values["target-adapter"] ??
    env.I18N_TARGET_CATALOG_ADAPTER ??
    env.I18N_CATALOG_ADAPTER ??
    sourceAdapterId;
  const sourceLocale = values["source-locale"] ?? env.I18N_SOURCE_CATALOG_LOCALE ?? "en";
  const targetLocale = values["target-locale"] ?? env.I18N_TARGET_CATALOG_LOCALE ?? "und";
  const [sourceContent, targetContent, sourceOptions, targetOptions] = await Promise.all([
    readFile(resolve(cwd, sourcePath), "utf8"),
    readFile(resolve(cwd, targetPath), "utf8"),
    readAdapterOptions(cwd, values["source-config"] ?? env.I18N_SOURCE_CATALOG_CONFIG),
    readAdapterOptions(cwd, values["target-config"] ?? env.I18N_TARGET_CATALOG_CONFIG),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const sourceAdapter = registry.get(sourceAdapterId);
  const targetAdapter = registry.get(targetAdapterId);
  const sourceContext = createContext(sourceLocale, "source", sourceOptions);
  const targetContext = createContext(targetLocale, "target", targetOptions);
  const sourceDocument = parseCatalogFile(
    sourceContent,
    "Source catalog",
    sourceAdapter,
    sourceContext,
  );
  const targetDocument = parseCatalogFile(
    targetContent,
    "Target catalog",
    targetAdapter,
    targetContext,
  );
  const source = sourceAdapter.read(sourceDocument, sourceContext);
  const target = targetAdapter.read(targetDocument, targetContext);
  const result = compareCatalogs(source, target);

  const problems: string[] = [];
  if (result.missingIds.length) {
    problems.push(`Missing from target: ${result.missingIds.join(", ")}`);
  }
  if (result.extraIds.length) {
    problems.push(`Extra in target: ${result.extraIds.join(", ")}`);
  }
  for (const mismatch of result.argumentMismatches) {
    problems.push(
      `Argument mismatch for ${describeArgumentMismatch(source.messages[mismatch.id]!.pattern, mismatch)}`,
    );
  }
  const warnings: string[] = [];
  for (const finding of lintTargetCatalog(source, target)) {
    (finding.severity === "error" ? problems : warnings).push(finding.message);
  }
  reportWarnings(warnings, { env, stdout });

  if (problems.length) {
    stderr(`Catalog check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return false;
  }

  stdout(
    `Catalog check passed (${messageCount(Object.keys(source.messages).length)} source, ` +
      `${messageCount(Object.keys(target.messages).length)} target).`,
  );
  return true;
}

/**
 * Chooses Phrase credentials from protected workflow secrets. Empty values come from unset
 * reusable-workflow secrets and count as absent.
 */
function phraseCredentials(
  env: NodeJS.ProcessEnv,
): Pick<PhraseClientOptions, "platformApiToken" | "serviceAccount"> {
  // Selection is by secret name only; credential values are never inspected to guess a kind.
  const platformApiToken = env.PHRASE_PLATFORM_API_TOKEN || undefined;
  const clientId = env.PHRASE_SERVICE_ACCOUNT_CLIENT_ID || undefined;
  const clientSecret = env.PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET || undefined;
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error(
        "Set both PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET",
      );
    }
    if (platformApiToken) {
      throw new Error(
        "Both PHRASE_PLATFORM_API_TOKEN and the Phrase service account secrets are set. " +
          "Remove PHRASE_PLATFORM_API_TOKEN to use the service account, or remove " +
          "PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET to use the token",
      );
    }
    return { serviceAccount: { clientId, clientSecret } };
  }
  if (!platformApiToken) {
    throw new Error(
      "Set PHRASE_SERVICE_ACCOUNT_CLIENT_ID and PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET, or PHRASE_PLATFORM_API_TOKEN, as protected workflow secrets",
    );
  }
  return { platformApiToken };
}

// TMS commands run with Phrase and GitHub write credentials, so they never import() the adapter
// modules a consumer declares in package.json.
function builtInCatalogAdapters(adapterIds: string[]): CatalogAdapterRegistry {
  for (const adapterId of adapterIds) {
    if (!BUILT_IN_CATALOG_ADAPTER_IDS.includes(adapterId)) {
      throw new Error(
        `TMS commands load only built-in catalog adapters (${BUILT_IN_CATALOG_ADAPTER_IDS.join(", ")}); "${adapterId}" is a custom adapter and cannot run with Phrase and GitHub credentials`,
      );
    }
  }
  return new CatalogAdapterRegistry();
}

async function runTmsCommand(
  command: "submit" | "reconcile",
  args: string[],
  options: Required<Pick<CliOptions, "cwd" | "env" | "stdout">> & Pick<CliOptions, "fetch">,
): Promise<number> {
  const values = parseOptions(args, {
    config: { type: "string" },
    repository: { type: "string" },
    "base-ref": { type: "string" },
    "source-commit": { type: "string" },
    "retry-failed": { type: "boolean" },
    "expect-project": { type: "string" },
    "expect-source-filename": { type: "string" },
    "fallback-assignee": { type: "string", multiple: true },
  });
  const fallbackAssignees = values["fallback-assignee"] ?? [];
  if (command === "submit" && fallbackAssignees.length) {
    throw new Error("--fallback-assignee is only valid with tms reconcile");
  }
  const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  for (const login of fallbackAssignees) {
    if (!githubLogin.test(login)) {
      throw new Error(`Invalid GitHub login for --fallback-assignee: ${JSON.stringify(login)}`);
    }
  }
  const configPath = values.config;
  if (!configPath) throw new Error("TMS command requires --config");
  const safeConfigPath = await resolveTmsInputPath(options.cwd, configPath, "TMS config");
  const config = await readJson(safeConfigPath, "TMS config");
  const parsed = parsePhraseTmsConfig(config);
  if (
    values["expect-project"] !== undefined &&
    parsed.workflow.projectUid !== values["expect-project"]
  ) {
    throw new Error(
      `Phrase project UID mismatch: expected ${JSON.stringify(values["expect-project"])}, actual ${JSON.stringify(parsed.workflow.projectUid)}`,
    );
  }
  if (
    values["expect-source-filename"] !== undefined &&
    parsed.workflow.sourceCatalog.filename !== values["expect-source-filename"]
  ) {
    throw new Error(
      `Phrase source filename mismatch: expected ${JSON.stringify(values["expect-source-filename"])}, actual ${JSON.stringify(parsed.workflow.sourceCatalog.filename)}`,
    );
  }
  const hasPhrasePins =
    values["expect-project"] !== undefined || values["expect-source-filename"] !== undefined;
  const phrasePins = hasPhrasePins
    ? {
        expectedProjectUid: values["expect-project"] ?? parsed.workflow.projectUid,
        expectedSourceFilename:
          values["expect-source-filename"] ?? parsed.workflow.sourceCatalog.filename,
      }
    : {};
  // A generated-source FEO config reads the Frontend template instead of a checked-in catalog.
  const generatedFrom = parsed.workflow.frontendTemplate?.generateSourceCatalog
    ? parsed.workflow.frontendTemplate
    : undefined;
  const submitInputPath =
    command !== "submit"
      ? undefined
      : generatedFrom
        ? await resolveTmsInputPath(options.cwd, generatedFrom.path, "Frontend template")
        : await resolveTmsInputPath(
            options.cwd,
            parsed.workflow.sourceCatalog.path,
            "Source catalog",
          );
  const catalogAdapters = builtInCatalogAdapters([
    parsed.workflow.sourceCatalog.adapter,
    targetAdapterId(parsed.workflow),
  ]);
  const credentials = phraseCredentials(options.env);
  const githubToken = options.env.GITHUB_TOKEN;
  if (!githubToken)
    throw new Error("GITHUB_TOKEN is required for state and pull-request operations");
  // Empty strings arrive from unset reusable-workflow inputs, so fall through with `||`.
  const repositoryName = values.repository || options.env.GITHUB_REPOSITORY;
  if (!repositoryName) throw new Error("Pass --repository or set GITHUB_REPOSITORY");

  const phrase = new PhraseClient({
    ...credentials,
    region: parsed.workflow.region,
    fetch: options.fetch,
  });
  options.stdout(
    phrase.authMethod === "service-account"
      ? "Phrase auth: service account (PHRASE_SERVICE_ACCOUNT_CLIENT_ID/_SECRET)"
      : "Phrase auth: user Platform API token (PHRASE_PLATFORM_API_TOKEN)",
  );
  const github = new GitHubPhraseRepository({
    repository: repositoryName,
    token: githubToken,
    stateBranch: parsed.stateBranch,
    stateDirectory: parsed.stateDirectory,
    ...(options.env.GITHUB_API_URL ? { apiUrl: options.env.GITHUB_API_URL } : {}),
    fetch: options.fetch,
  });
  const workflow = new PhraseWorkflow({
    phrase,
    state: github,
    repository: github,
    catalogAdapters,
  });

  if (command === "submit") {
    const branchRef = options.env.GITHUB_REF?.startsWith("refs/heads/")
      ? options.env.GITHUB_REF.slice("refs/heads/".length)
      : undefined;
    const baseRef = values["base-ref"] || options.env.I18N_BASE_REF || branchRef;
    const sourceCommit =
      values["source-commit"] || options.env.I18N_SOURCE_COMMIT || options.env.GITHUB_SHA;
    if (!baseRef) {
      throw new Error(
        "Pass --base-ref: GITHUB_REF is not a branch (pull-request and tag runs need an explicit PR base)",
      );
    }
    if (!sourceCommit) throw new Error("Pass --source-commit or set GITHUB_SHA");
    const sourceBytes = generatedFrom
      ? new TextEncoder().encode(formatFeoCatalog(await readFile(submitInputPath!, "utf8")))
      : await readFile(submitInputPath!);
    const batch = await workflow.submit({
      repository: repositoryName,
      baseRef,
      sourceCommit,
      sourceBytes,
      config: parsed.workflow,
      retryFailed: values["retry-failed"] === true,
      ...phrasePins,
    });
    const warningSummary = batch.warningCount ? `, ${batch.warningCount} import warning(s)` : "";
    options.stdout(
      `Phrase batch ${batch.key} is ${batch.phase} (${batch.jobs.length} job parts${warningSummary}).`,
    );
    const failedLocales = Object.entries(batch.locales).filter(
      ([, locale]) => locale.phase === "failed",
    );
    for (const [phraseLocale, locale] of failedLocales) {
      options.stdout(
        `${batch.key.slice(0, 12)} ${phraseLocale}: failed` +
          (locale.failureReason ? ` — ${locale.failureReason}` : ""),
      );
    }
    return failedLocales.length ? 1 : 0;
  }

  const results = await workflow.reconcile({
    ...phrasePins,
    fallbackAssignees,
    repairScope: {
      projectUid: parsed.workflow.projectUid,
      sourceFilename: parsed.workflow.sourceCatalog.filename,
    },
  });
  if (!results.length) {
    options.stdout("No ready Phrase batches found.");
    return 0;
  }
  for (const result of results) options.stdout(formatReconcileResult(result));
  return results.some((result) => result.phase === "failed" || result.phase === "retrying") ? 1 : 0;
}

function formatReconcileResult(result: PhraseReconcileResult): string {
  return (
    `${result.batchKey.slice(0, 12)} ${result.phraseLocale ?? "(batch)"}: ${result.phase}` +
    (result.pullRequestUrl ? ` — ${result.pullRequestUrl}` : "") +
    (result.reason ? ` — ${result.reason}` : "")
  );
}

async function convertCatalog(
  args: string[],
  { cwd, stdout }: Required<Pick<CliOptions, "cwd" | "stdout">>,
): Promise<void> {
  const values = parseOptions(args, {
    source: { type: "string" },
    output: { type: "string" },
    "source-adapter": { type: "string" },
    "target-adapter": { type: "string" },
    locale: { type: "string" },
    "source-role": { type: "string" },
    "target-role": { type: "string" },
    "source-config": { type: "string" },
    "target-config": { type: "string" },
  });
  const sourcePath = values.source;
  const outputPath = values.output;
  const sourceAdapterId = values["source-adapter"];
  const targetAdapterId = values["target-adapter"];
  if (!sourcePath || !outputPath || !sourceAdapterId || !targetAdapterId) {
    throw new Error("convert requires --source, --output, --source-adapter, and --target-adapter");
  }

  const locale = values.locale ?? "en";
  const sourceRole = requireRole(values["source-role"] ?? "source");
  const targetRole = requireRole(values["target-role"] ?? "target");
  const [content, sourceOptions, targetOptions] = await Promise.all([
    readFile(resolve(cwd, sourcePath), "utf8"),
    readAdapterOptions(cwd, values["source-config"]),
    readAdapterOptions(cwd, values["target-config"]),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const sourceAdapter = registry.get(sourceAdapterId);
  const targetAdapter = registry.get(targetAdapterId);
  const sourceContext = createContext(locale, sourceRole, sourceOptions);
  const targetContext = createContext(locale, targetRole, targetOptions);
  const document = parseCatalogFile(content, "Source catalog", sourceAdapter, sourceContext);
  const converted = convertCatalogDocument(
    document,
    sourceAdapter,
    targetAdapter,
    sourceContext,
    targetContext,
  );
  const serialized = serializeCatalogDocument(converted, targetAdapter, targetContext);
  const absoluteOutputPath = resolve(cwd, outputPath);
  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, serialized, "utf8");
  stdout(`Converted catalog from ${sourceAdapterId} to ${targetAdapterId} (locale=${locale}).`);
}

async function validateProject(
  args: string[],
  { cwd, env, stdout, stderr }: Required<Pick<CliOptions, "cwd" | "env" | "stdout" | "stderr">>,
): Promise<boolean> {
  const values = parseOptions(args, { config: { type: "string" } });
  if (!values.config) throw new Error("validate-project requires --config");
  const config = parseCatalogValidationConfig(
    await readJson(resolve(cwd, values.config), "Catalog validation config"),
  );
  const registry = await createCatalogAdapterRegistry(cwd);
  const result = await validateCatalogProject(cwd, config, registry);
  reportWarnings(result.warnings, { env, stdout });
  if (result.problems.length) {
    stderr(
      `Catalog validation failed:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    return false;
  }

  const count = (value: number, label: string) => `${value} ${label}${value === 1 ? "" : "s"}`;
  const pending = result.pendingTargetCount
    ? `, ${count(result.pendingTargetCount, "pending TMS target")}`
    : "";
  const feo = config.feo === undefined ? "" : `, ${count(config.feo.length, "FEO template")}`;
  stdout(
    `Catalog validation passed (${count(result.sourceCount, "source")}, ` +
      `${count(result.targetCount, "target")}, ${count(result.generatedCount, "generated catalog")}` +
      `${pending}${feo}).`,
  );
  return true;
}

async function runFeoCommand(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "extract" && subcommand !== "inline")
    throw new Error("feo requires extract or inline");
  const { values } = parseArgs({
    args: rest,
    options: {
      template: { type: "string", multiple: true },
      output: { type: "string" },
      source: { type: "string" },
      target: { type: "string" },
      locale: { type: "string" },
      kind: { type: "string" },
      check: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const kind = values.kind ?? "Frontend";
  if (kind !== "Frontend" && kind !== "FrontendEnvironment") {
    throw new Error('--kind must be "Frontend" or "FrontendEnvironment"');
  }
  const templatePaths = values.template ?? [];
  if (!templatePaths.length) throw new Error("feo requires --template");
  if (kind === "Frontend" && templatePaths.length > 1) {
    throw new Error("feo --kind Frontend accepts only one --template");
  }
  if (subcommand === "inline" && templatePaths.length > 1) {
    throw new Error(`feo inline --kind ${kind} accepts only one --template`);
  }
  let path: string;
  let generated: string;
  if (subcommand === "extract") {
    if (!values.output) throw new Error("feo extract requires --output");
    path = resolve(cwd, values.output);
    if (kind === "Frontend") {
      const template = await readFile(resolve(cwd, templatePaths[0]!), "utf8");
      generated = serializeFeoCatalog(extractFeoCatalog(template));
    } else {
      const templates = await Promise.all(
        templatePaths.map(async (templatePath) => ({
          path: templatePath,
          template: await readFile(resolve(cwd, templatePath), "utf8"),
        })),
      );
      generated = serializeFeoCatalog(extractFeoEnvironmentCatalogs(templates));
    }
  } else {
    if (!values.source || !values.target || !values.locale)
      throw new Error("feo inline requires --source, --target and --locale");
    const templatePath = resolve(cwd, templatePaths[0]!);
    const template = await readFile(templatePath, "utf8");
    path = templatePath;
    const source = (await readJson(
      resolve(cwd, values.source),
      "FEO source catalog",
    )) as FeoCatalog;
    const target = (await readJson(resolve(cwd, values.target), "FEO target catalog")) as Record<
      string,
      string
    >;
    generated =
      kind === "Frontend"
        ? inlineFeoLocale(template, source, target, values.locale)
        : inlineFeoEnvironmentLocale(template, source, target, values.locale);
    const overlong = overlongFeoTranslationsWarning(values.locale, target);
    if (overlong) stdout(`Warning: ${overlong}.`);
  }
  if (values.check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== generated)
      throw new Error(`${path} is out of sync with the FEO ${subcommand} output`);
    stdout(`FEO ${subcommand} output is in sync.`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, generated, "utf8");
    stdout(`Updated ${path}.`);
  }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    const requestedHelp = command === "help" ? args.slice(0, 2).join(" ") : undefined;
    stdout(helpText(requestedHelp));
    return 0;
  }
  if (command === "tms") {
    const [subcommand, ...subargs] = args;
    const helpCommand =
      subcommand === "submit" || subcommand === "reconcile" ? `tms ${subcommand}` : "tms";
    if (
      !subcommand ||
      subcommand === "help" ||
      subcommand === "--help" ||
      subcommand === "-h" ||
      subargs.includes("--help") ||
      subargs.includes("-h")
    ) {
      stdout(helpText(helpCommand));
      return 0;
    }
  } else if (args.includes("--help") || args.includes("-h")) {
    stdout(helpText(command));
    return 0;
  }

  try {
    if (command === "tms") {
      const [subcommand, ...subargs] = args;
      if (subcommand !== "submit" && subcommand !== "reconcile") {
        throw new Error(`Unknown TMS command "${subcommand ?? ""}"`);
      }
      return await runTmsCommand(subcommand, subargs, {
        cwd,
        env,
        stdout,
        fetch: options.fetch,
      });
    }
    if (command === "feo") {
      await runFeoCommand(args, cwd, stdout);
      return 0;
    }
    if (command === "version") {
      const manifest = await readJson(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "Package metadata",
      );
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        throw new Error("Package metadata must be a JSON object");
      }
      const version = (manifest as Record<string, unknown>).version;
      if (typeof version !== "string") throw new Error("Package version is missing");
      stdout(version);
      return 0;
    }
    if (command === "check") {
      return (await checkCatalog(args, { cwd, env, stdout, stderr })) ? 0 : 1;
    }
    if (command === "validate") {
      return (await validateCatalog(args, { cwd, env, stdout, stderr })) ? 0 : 1;
    }
    if (command === "validate-project") {
      return (await validateProject(args, { cwd, env, stdout, stderr })) ? 0 : 1;
    }
    if (command === "validate-ci") {
      return await runValidateCiCommand(args, { cwd, env, stdout, stderr });
    }
    if (command === "convert") {
      await convertCatalog(args, { cwd, stdout });
      return 0;
    }
    throw new Error(`Unknown command "${command}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`i18n-pipeline: ${message}\n${COMMAND_HELP[command] ?? ROOT_HELP}`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when the script Node was asked to run is this module. Symlinks are resolved on both
 * sides: npm-style `.bin/i18n-pipeline` links point here, and without resolving them the CLI
 * would exit 0 without doing anything.
 */
export function isCliEntryPoint(argvPath: string | undefined, moduleUrl: string): boolean {
  return argvPath !== undefined && realPath(argvPath) === realPath(fileURLToPath(moduleUrl));
}

if (isCliEntryPoint(process.argv[1], import.meta.url)) {
  void main();
}
