import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { checkCatalogs } from "./catalog-check.js";
import { parseCatalogDocument } from "./catalog-document.js";
import { parsePhraseTmsConfig } from "./phrase-config.js";
import type {
  AdapterContext,
  Catalog,
  CatalogAdapter,
  CatalogAdapterRegistry,
  CatalogRole,
} from "./index.js";

const OUTPUT_PLACEHOLDER = "{output}";
const DEFAULT_CATALOG_EXTENSION = ".json";

export interface CatalogFileReference {
  path: string;
  adapter: string;
  locale: string;
  options?: Record<string, unknown>;
}

export interface CatalogValidationCheck {
  source: CatalogFileReference;
  targets: CatalogFileReference[];
}

/**
 * A checked-in file that must match fresh generator output. With an adapter, both files are
 * parsed as catalogs; without one, both are compared as plain JSON (for runtime aggregates).
 */
export interface GeneratedCatalogCheck {
  path: string;
  adapter?: string;
  locale?: string;
  role?: CatalogRole;
  options?: Record<string, unknown>;
  command: string;
  args: string[];
  updateCommand?: string;
}

/** A directory whose catalog files must all be declared by the validation plan. */
export interface CatalogDirectory {
  path: string;
  extension: string;
}

export interface CatalogValidationConfig {
  version: 1;
  /** Repository-relative Phrase TMS config whose source and target locales become a check. */
  tmsConfig?: string;
  checks: CatalogValidationCheck[];
  generated: GeneratedCatalogCheck[];
  catalogDirectories: CatalogDirectory[];
}

export interface CatalogValidationResult {
  problems: string[];
  sourceCount: number;
  targetCount: number;
  generatedCount: number;
  /** TMS targets whose output file has not been delivered yet. */
  pendingTargetCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) throw new TypeError(`${label} has unknown property "${unknownKey}"`);
}

function validateRepoPath(path: string, label: string): void {
  const segments = path.split("/");
  if (
    !path.trim() ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("~/") ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a repository-relative path without parent traversal`);
  }
}

function parseCatalogReference(value: unknown, label: string): CatalogFileReference {
  const reference = recordValue(value, label);
  rejectUnknownKeys(reference, ["path", "adapter", "locale", "options"], label);
  const path = requiredString(reference.path, `${label}.path`);
  validateRepoPath(path, `${label}.path`);
  const adapter = requiredString(reference.adapter, `${label}.adapter`);
  const locale = requiredString(reference.locale, `${label}.locale`);
  let options: Record<string, unknown> | undefined;
  if (reference.options !== undefined) {
    if (!isRecord(reference.options)) throw new TypeError(`${label}.options must be a JSON object`);
    options = reference.options;
  }
  return { path, adapter, locale, ...(options ? { options } : {}) };
}

function parseGeneratedCheck(value: unknown, label: string): GeneratedCatalogCheck {
  const entry = recordValue(value, label);
  rejectUnknownKeys(
    entry,
    ["path", "adapter", "locale", "options", "role", "command", "args", "updateCommand"],
    label,
  );
  const command = requiredString(entry.command, `${label}.command`);
  if (!Array.isArray(entry.args) || entry.args.some((argument) => typeof argument !== "string")) {
    throw new TypeError(`${label}.args must be an array of strings`);
  }
  const args = entry.args as string[];
  if (!args.some((argument) => argument.includes(OUTPUT_PLACEHOLDER))) {
    throw new TypeError(`${label}.args must include the ${OUTPUT_PLACEHOLDER} placeholder`);
  }
  let updateCommand: string | undefined;
  if (entry.updateCommand !== undefined) {
    updateCommand = requiredString(entry.updateCommand, `${label}.updateCommand`);
  }
  const generator = { command, args, ...(updateCommand ? { updateCommand } : {}) };

  if (entry.adapter === undefined) {
    const catalogKey = ["locale", "role", "options"].find((key) => entry[key] !== undefined);
    if (catalogKey) throw new TypeError(`${label}.${catalogKey} requires an adapter`);
    const path = requiredString(entry.path, `${label}.path`);
    validateRepoPath(path, `${label}.path`);
    return { path, ...generator };
  }

  const reference = parseCatalogReference(
    {
      path: entry.path,
      adapter: entry.adapter,
      locale: entry.locale,
      ...(entry.options === undefined ? {} : { options: entry.options }),
    },
    label,
  );
  if (entry.role !== "source" && entry.role !== "target") {
    throw new TypeError(`${label}.role must be "source" or "target"`);
  }
  return { ...reference, role: entry.role, ...generator };
}

function parseCatalogDirectory(value: unknown, label: string): CatalogDirectory {
  const entry = recordValue(value, label);
  rejectUnknownKeys(entry, ["path", "extension"], label);
  const path = requiredString(entry.path, `${label}.path`);
  validateRepoPath(path, `${label}.path`);
  let extension = DEFAULT_CATALOG_EXTENSION;
  if (entry.extension !== undefined) {
    extension = requiredString(entry.extension, `${label}.extension`);
    if (!/^\.[^/\\]+$/.test(extension)) {
      throw new TypeError(`${label}.extension must start with "." and contain no path separator`);
    }
  }
  return { path, extension };
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

/** Parses and strictly validates the consumer-owned catalog-validation JSON config. */
export function parseCatalogValidationConfig(value: unknown): CatalogValidationConfig {
  const root = recordValue(value, "Catalog validation config");
  rejectUnknownKeys(
    root,
    ["version", "tmsConfig", "checks", "generated", "catalogDirectories"],
    "Catalog validation config",
  );
  if (root.version !== 1) throw new TypeError('Catalog validation config "version" must be 1');

  let tmsConfig: string | undefined;
  if (root.tmsConfig !== undefined) {
    tmsConfig = requiredString(root.tmsConfig, 'Catalog validation config "tmsConfig"');
    validateRepoPath(tmsConfig, 'Catalog validation config "tmsConfig"');
  }

  if (!Array.isArray(root.checks)) {
    throw new TypeError('Catalog validation config "checks" must be an array');
  }
  const checks = root.checks.map((value, index) => {
    const label = `Catalog validation config "checks[${index}]"`;
    const check = recordValue(value, label);
    rejectUnknownKeys(check, ["source", "targets"], label);
    if (!Array.isArray(check.targets)) throw new TypeError(`${label}.targets must be an array`);
    return {
      source: parseCatalogReference(check.source, `${label}.source`),
      targets: check.targets.map((target, targetIndex) =>
        parseCatalogReference(target, `${label}.targets[${targetIndex}]`),
      ),
    };
  });

  const generated = optionalArray(root.generated, 'Catalog validation config "generated"').map(
    (value, index) => parseGeneratedCheck(value, `Catalog validation config "generated[${index}]"`),
  );
  const catalogDirectories = optionalArray(
    root.catalogDirectories,
    'Catalog validation config "catalogDirectories"',
  ).map((value, index) =>
    parseCatalogDirectory(value, `Catalog validation config "catalogDirectories[${index}]"`),
  );

  if (!tmsConfig && !checks.length && !generated.length) {
    throw new TypeError(
      'Catalog validation config needs "tmsConfig" or at least one "checks" or "generated" entry',
    );
  }
  return {
    version: 1,
    ...(tmsConfig ? { tmsConfig } : {}),
    checks,
    generated,
    catalogDirectories,
  };
}

interface LoadedCatalog {
  document: unknown;
  catalog: Catalog;
}

interface PlannedTarget extends CatalogFileReference {
  /** TMS outputs may not exist until the first translation PR lands. */
  optional?: boolean;
}

interface PlannedCheck {
  source: CatalogFileReference;
  targets: PlannedTarget[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contextFor(
  locale: string,
  role: CatalogRole,
  options: Record<string, unknown> | undefined,
): AdapterContext {
  return { locale, role, options: options ?? {} };
}

async function readProjectFile(projectRoot: string, path: string, label: string): Promise<string> {
  try {
    return await readFile(resolve(projectRoot, path), "utf8");
  } catch (error) {
    throw new Error(`${label} "${path}" could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadCatalogFile(
  projectRoot: string,
  path: string,
  label: string,
  adapter: CatalogAdapter,
  context: AdapterContext,
): Promise<LoadedCatalog> {
  const content = await readProjectFile(projectRoot, path, label);

  let document: unknown;
  try {
    document = parseCatalogDocument(content, adapter, context);
  } catch (error) {
    const format = adapter.parseDocument ? `adapter "${adapter.id}"` : "JSON";
    throw new Error(`${label} "${path}" is not valid ${format}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    return { document, catalog: adapter.read(document, context) };
  } catch (error) {
    throw new Error(`${label} "${path}" failed adapter validation: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function loadJsonFile(projectRoot: string, path: string, label: string): Promise<unknown> {
  const content = await readProjectFile(projectRoot, path, label);
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} "${path}" is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/** Turns the TMS source catalog and target locale mapping into one catalog check. */
async function loadTmsCheck(projectRoot: string, path: string): Promise<PlannedCheck> {
  const content = await readProjectFile(projectRoot, path, "TMS config");
  let workflow;
  try {
    workflow = parsePhraseTmsConfig(JSON.parse(content) as unknown).workflow;
  } catch (error) {
    throw new Error(`TMS config "${path}" is invalid: ${errorMessage(error)}`, { cause: error });
  }
  const { sourceCatalog } = workflow;
  return {
    source: {
      path: sourceCatalog.path,
      adapter: sourceCatalog.adapter,
      locale: sourceCatalog.locale,
      ...(sourceCatalog.options ? { options: sourceCatalog.options } : {}),
    },
    targets: workflow.targetLocales.map((target) => ({
      path: target.outputPath,
      adapter: workflow.targetAdapter ?? sourceCatalog.adapter,
      locale: target.repositoryLocale,
      ...(workflow.targetOptions ? { options: workflow.targetOptions } : {}),
      optional: true,
    })),
  };
}

function runGenerator(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", (error) => {
      rejectPromise(
        new Error(`Could not start catalog generator "${command}": ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        rejectPromise(new Error(`Catalog generator "${command}" failed with ${status}`));
      }
    });
  });
}

function comparisonProblems(
  source: Catalog,
  target: Catalog,
  sourcePath: string,
  targetPath: string,
): string[] {
  const result = checkCatalogs(source, target);
  const problems: string[] = [];
  const prefix = `Catalog check ${sourcePath} -> ${targetPath}: `;
  if (result.missingIds.length)
    problems.push(`${prefix}missing from target: ${result.missingIds.join(", ")}`);
  if (result.extraIds.length)
    problems.push(`${prefix}extra in target: ${result.extraIds.join(", ")}`);
  for (const mismatch of result.argumentMismatches) {
    problems.push(
      `${prefix}argument mismatch for "${mismatch.id}": ` +
        `source [${mismatch.source.join(", ")}], target [${mismatch.target.join(", ")}]`,
    );
  }
  return problems;
}

async function checkGeneratedCatalog(
  projectRoot: string,
  entry: GeneratedCatalogCheck,
  registry: Pick<CatalogAdapterRegistry, "get">,
): Promise<boolean> {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "frontend-i18n-"));
  const outputName = basename(entry.path);
  const outputPath = resolve(temporaryDirectory, outputName);
  try {
    const args = entry.args.map((argument) => argument.replaceAll(OUTPUT_PLACEHOLDER, outputPath));
    await runGenerator(entry.command, args, projectRoot);
    if (!entry.adapter) {
      const [checkedIn, generated] = await Promise.all([
        loadJsonFile(projectRoot, entry.path, "Checked-in generated file"),
        loadJsonFile(temporaryDirectory, outputName, "Generated output"),
      ]);
      return isDeepStrictEqual(checkedIn, generated);
    }
    const adapter = registry.get(entry.adapter);
    const context = contextFor(entry.locale ?? "und", entry.role ?? "source", entry.options);
    const [checkedIn, generated] = await Promise.all([
      loadCatalogFile(projectRoot, entry.path, "Checked-in generated catalog", adapter, context),
      loadCatalogFile(temporaryDirectory, outputName, "Generated output", adapter, context),
    ]);
    return isDeepStrictEqual(checkedIn.document, generated.document);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function undeclaredCatalogProblems(
  projectRoot: string,
  directories: CatalogDirectory[],
  declaredPaths: Set<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = (await readdir(resolve(projectRoot, directory.path), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(directory.extension))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      problems.push(
        `Catalog directory "${directory.path}" could not be read: ${errorMessage(error)}`,
      );
      continue;
    }
    for (const name of names) {
      const path = `${directory.path}/${name}`;
      if (!declaredPaths.has(path)) {
        problems.push(
          `Catalog "${path}" is not declared by the validation plan. ` +
            "Add it to the TMS target locales or the validation config, or remove it.",
        );
      }
    }
  }
  return problems;
}

/** Runs every configured catalog comparison and generated-file sync check. */
export async function validateCatalogProject(
  projectRoot: string,
  config: CatalogValidationConfig,
  registry: Pick<CatalogAdapterRegistry, "get">,
): Promise<CatalogValidationResult> {
  const problems: string[] = [];
  let sourceCount = 0;
  let targetCount = 0;
  let generatedCount = 0;
  let pendingTargetCount = 0;

  for (const entry of config.generated) {
    try {
      generatedCount += 1;
      const current = await checkGeneratedCatalog(projectRoot, entry, registry);
      if (!current) {
        const update = entry.updateCommand
          ? `Run \`${entry.updateCommand}\` and commit the result.`
          : "Regenerate the file and commit the result.";
        problems.push(`Generated catalog "${entry.path}" is out of date. ${update}`);
      }
    } catch (error) {
      problems.push(
        `Generated catalog "${entry.path}" could not be checked: ${errorMessage(error)}`,
      );
    }
  }

  const checks: PlannedCheck[] = [...config.checks];
  if (config.tmsConfig) {
    try {
      checks.push(await loadTmsCheck(projectRoot, config.tmsConfig));
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }

  const declaredPaths = new Set(config.generated.map((entry) => entry.path));
  for (const check of checks) {
    declaredPaths.add(check.source.path);
    for (const target of check.targets) declaredPaths.add(target.path);
  }

  for (const check of checks) {
    let source: LoadedCatalog;
    try {
      const sourceAdapter = registry.get(check.source.adapter);
      source = await loadCatalogFile(
        projectRoot,
        check.source.path,
        "Source catalog",
        sourceAdapter,
        contextFor(check.source.locale, "source", check.source.options),
      );
      sourceCount += 1;
    } catch (error) {
      problems.push(errorMessage(error));
      continue;
    }

    for (const targetReference of check.targets) {
      if (
        targetReference.optional &&
        !(await fileExists(resolve(projectRoot, targetReference.path)))
      ) {
        pendingTargetCount += 1;
        continue;
      }
      try {
        const targetAdapter = registry.get(targetReference.adapter);
        const target = await loadCatalogFile(
          projectRoot,
          targetReference.path,
          "Target catalog",
          targetAdapter,
          contextFor(targetReference.locale, "target", targetReference.options),
        );
        targetCount += 1;
        problems.push(
          ...comparisonProblems(
            source.catalog,
            target.catalog,
            check.source.path,
            targetReference.path,
          ),
        );
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
  }

  problems.push(
    ...(await undeclaredCatalogProblems(projectRoot, config.catalogDirectories, declaredPaths)),
  );

  return { problems, sourceCount, targetCount, generatedCount, pendingTargetCount };
}
