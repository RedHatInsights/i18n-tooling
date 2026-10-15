import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { checkCatalogs } from "./catalog-check.js";
import { parseCatalogDocument } from "./catalog-document.js";
import {
  extractFeoCatalog,
  feoTemplateLocales,
  inlineFeoLocale,
  serializeFeoCatalog,
  type FeoCatalog,
} from "./feo-template.js";
import { describeArgumentMismatch, lintSourceCatalog, lintTargetCatalog } from "./icu-lint.js";
import { parsePhraseTmsConfig, targetAdapterId } from "./phrase-config.js";
import type {
  AdapterContext,
  Catalog,
  CatalogAdapter,
  CatalogAdapterRegistry,
  CatalogRole,
} from "./index.js";

const OUTPUT_PLACEHOLDER = "{output}";
const DEFAULT_CATALOG_EXTENSION = ".json";
const FEO_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/;

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

export interface FeoTemplateValidation {
  template: string;
  source: string;
  locales: Record<string, string>;
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
  /** Built-in FEO extraction and locale inlining checks. */
  feo?: FeoTemplateValidation[];
  /** Optional source-code lint settings used by `validate-ci`; `validate-project` ignores them. */
  sourceLint?: SourceLintConfig;
}

export interface SourceLintConfig {
  files?: string[];
  catalog?: string;
}

export interface CatalogValidationResult {
  problems: string[];
  /** Lint findings that do not fail validation; see {@link lintSourceCatalog}. */
  warnings: string[];
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

function parseSourceLintConfig(value: unknown): SourceLintConfig {
  const sourceLint = recordValue(value, 'Catalog validation config "sourceLint"');
  const label = 'Catalog validation config "sourceLint"';
  rejectUnknownKeys(sourceLint, ["files", "catalog"], label);

  let files: string[] | undefined;
  if (sourceLint.files !== undefined) {
    if (!Array.isArray(sourceLint.files)) {
      throw new TypeError(`${label}.files must be an array`);
    }
    files = sourceLint.files.map((value, index) => {
      const path = requiredString(value, `${label}.files[${index}]`);
      validateRepoPath(path, `${label}.files[${index}]`);
      return path;
    });
  }

  let catalog: string | undefined;
  if (sourceLint.catalog !== undefined) {
    catalog = requiredString(sourceLint.catalog, `${label}.catalog`);
    validateRepoPath(catalog, `${label}.catalog`);
  }

  return { ...(files === undefined ? {} : { files }), ...(catalog ? { catalog } : {}) };
}

function parseFeoTemplateValidation(value: unknown, index: number): FeoTemplateValidation {
  const label = `Catalog validation config "feo[${index}]"`;
  const entry = recordValue(value, label);
  rejectUnknownKeys(entry, ["template", "source", "locales"], label);

  const template = requiredString(entry.template, `${label}.template`);
  validateRepoPath(template, `${label}.template`);
  const source = requiredString(entry.source, `${label}.source`);
  validateRepoPath(source, `${label}.source`);
  const localeEntries = recordValue(entry.locales, `${label}.locales`);
  const locales = Object.fromEntries(
    Object.entries(localeEntries).map(([locale, value]) => {
      const localeLabel = `${label}.locales[${JSON.stringify(locale)}]`;
      if (!FEO_LOCALE_PATTERN.test(locale) || locale === "en") {
        throw new TypeError(`${localeLabel} must be a non-English FEO locale tag`);
      }
      const path = requiredString(value, localeLabel);
      validateRepoPath(path, localeLabel);
      return [locale, path] as const;
    }),
  );

  return { template, source, locales };
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
    ["version", "tmsConfig", "checks", "generated", "catalogDirectories", "feo", "sourceLint"],
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
  const feo =
    root.feo === undefined
      ? undefined
      : optionalArray(root.feo, 'Catalog validation config "feo"').map((value, index) =>
          parseFeoTemplateValidation(value, index),
        );
  const sourceLint =
    root.sourceLint === undefined ? undefined : parseSourceLintConfig(root.sourceLint);

  if (!tmsConfig && !checks.length && !generated.length && !feo?.length) {
    const alternatives =
      feo === undefined ? '"checks" or "generated"' : '"checks", "generated", or "feo"';
    throw new TypeError(
      `Catalog validation config needs "tmsConfig" or at least one ${alternatives} entry`,
    );
  }
  return {
    version: 1,
    ...(tmsConfig ? { tmsConfig } : {}),
    checks,
    generated,
    catalogDirectories,
    ...(feo === undefined ? {} : { feo }),
    ...(sourceLint === undefined ? {} : { sourceLint }),
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

async function readProjectFileBytes(
  projectRoot: string,
  path: string,
  label: string,
): Promise<Buffer> {
  try {
    return await readFile(resolve(projectRoot, path));
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
      adapter: targetAdapterId(workflow),
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
      `${prefix}argument mismatch for ` +
        describeArgumentMismatch(source.messages[mismatch.id]!.pattern, mismatch),
    );
  }
  return problems;
}

async function checkGeneratedCatalog(
  projectRoot: string,
  entry: GeneratedCatalogCheck,
  registry: Pick<CatalogAdapterRegistry, "get">,
): Promise<boolean> {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "i18n-pipeline-"));
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

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function feoExtractCommand(entry: FeoTemplateValidation): string {
  return (
    `i18n-pipeline feo extract --template ${shellArgument(entry.template)} ` +
    `--output ${shellArgument(entry.source)}`
  );
}

function feoInlineCommand(entry: FeoTemplateValidation, locale: string, path: string): string {
  return (
    `i18n-pipeline feo inline --template ${shellArgument(entry.template)} ` +
    `--source ${shellArgument(entry.source)} --target ${shellArgument(path)} ` +
    `--locale ${locale}`
  );
}

function feoSourceProblem(entry: FeoTemplateValidation, detail: string): string {
  return (
    `FEO source catalog "${entry.source}" for template "${entry.template}" could not be ` +
    `checked: ${detail}. Run \`${feoExtractCommand(entry)}\` to update it.`
  );
}

function feoLocaleProblem(
  entry: FeoTemplateValidation,
  locale: string,
  path: string,
  detail: string,
  englishDrift: boolean,
): string {
  const fix = englishDrift
    ? `Fix the locale file, then run \`${feoExtractCommand(entry)}\` followed by ` +
      `\`${feoInlineCommand(entry, locale, path)}\` to update the source and template.`
    : `Fix the locale file, then run \`${feoInlineCommand(entry, locale, path)}\` to update the template.`;
  return (
    `FEO locale "${locale}" in "${path}" could not be checked against ` +
    `template "${entry.template}" and source catalog "${entry.source}": ${detail}. ${fix}`
  );
}

async function checkFeoTemplate(
  projectRoot: string,
  entry: FeoTemplateValidation,
): Promise<string[]> {
  const problems: string[] = [];
  let templateBytes: Buffer;
  let template: string;
  try {
    templateBytes = await readProjectFileBytes(projectRoot, entry.template, "FEO template");
    template = templateBytes.toString("utf8");
  } catch (error) {
    problems.push(
      `FEO template "${entry.template}" for source catalog "${entry.source}" could not be ` +
        `read: ${errorMessage(error)}. Restore or fix the template, then run ` +
        `\`${feoExtractCommand(entry)}\` to regenerate the source catalog.`,
    );
    return problems;
  }

  let currentCatalog: FeoCatalog;
  let expectedSource: string;
  let templateLocales: string[];
  try {
    currentCatalog = extractFeoCatalog(template);
    expectedSource = serializeFeoCatalog(currentCatalog);
    templateLocales = feoTemplateLocales(template);
  } catch (error) {
    problems.push(
      `FEO template "${entry.template}" and source catalog "${entry.source}" could not be ` +
        `checked: ${errorMessage(error)}. Fix the template, then run ` +
        `\`${feoExtractCommand(entry)}\` to regenerate the source catalog.`,
    );
    return problems;
  }

  let sourceContents: string;
  let sourceBytes: Buffer;
  let sourceValue: unknown;
  try {
    sourceBytes = await readProjectFileBytes(projectRoot, entry.source, "FEO source catalog");
    sourceContents = sourceBytes.toString("utf8");
    try {
      sourceValue = JSON.parse(sourceContents) as unknown;
    } catch (error) {
      throw new Error(
        `FEO source catalog "${entry.source}" is not valid JSON: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (!isRecord(sourceValue)) {
      throw new TypeError(`FEO source catalog "${entry.source}" must be a JSON object`);
    }
  } catch (error) {
    problems.push(feoSourceProblem(entry, errorMessage(error)));
    return problems;
  }

  const source = sourceValue as FeoCatalog;
  const englishDrift = !sourceBytes.equals(Buffer.from(expectedSource, "utf8"));
  if (englishDrift) {
    problems.push(
      `FEO source catalog "${entry.source}" is not byte-identical to the extraction output ` +
        `from "${entry.template}". Run \`${feoExtractCommand(entry)}\` to update it.`,
    );
  }

  for (const [locale, localePath] of Object.entries(entry.locales)) {
    let target: Record<string, unknown>;
    try {
      const targetContents = await readProjectFile(
        projectRoot,
        localePath,
        `FEO locale "${locale}" catalog`,
      );
      let targetValue: unknown;
      try {
        targetValue = JSON.parse(targetContents) as unknown;
      } catch (error) {
        throw new Error(
          `FEO locale "${locale}" catalog "${localePath}" is not valid JSON: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (!isRecord(targetValue)) {
        throw new TypeError(`FEO locale "${locale}" catalog "${localePath}" must be a JSON object`);
      }
      target = targetValue;
    } catch (error) {
      problems.push(feoLocaleProblem(entry, locale, localePath, errorMessage(error), englishDrift));
      continue;
    }

    // Only visible until the source catalog is re-extracted; afterwards nothing in the files
    // shows that the translation predates the new English.
    const staleKeys = Object.keys(target).filter(
      (key) =>
        Object.hasOwn(source, key) &&
        Object.hasOwn(currentCatalog, key) &&
        source[key]?.defaultMessage !== currentCatalog[key]!.defaultMessage,
    );
    if (staleKeys.length) {
      problems.push(
        `FEO locale "${locale}" in "${localePath}" still has translations for English that ` +
          `changed in template "${entry.template}": ${staleKeys.join(", ")}. Remove these keys ` +
          `from the locale file so they are translated again, then run ` +
          `\`${feoExtractCommand(entry)}\` followed by ` +
          `\`${feoInlineCommand(entry, locale, localePath)}\`.`,
      );
    }

    // Inlining against the template's own English keeps source drift, reported above, from
    // repeating as a stale-English error for every locale.
    let expectedTemplate: string;
    try {
      expectedTemplate = inlineFeoLocale(
        template,
        currentCatalog,
        target as Record<string, string>,
        locale,
      );
    } catch (error) {
      problems.push(feoLocaleProblem(entry, locale, localePath, errorMessage(error), englishDrift));
      continue;
    }

    if (!templateBytes.equals(Buffer.from(expectedTemplate, "utf8"))) {
      const updateCommand = englishDrift
        ? `Run \`${feoExtractCommand(entry)}\`, then \`${feoInlineCommand(entry, locale, localePath)}\` to update the source and template.`
        : `Run \`${feoInlineCommand(entry, locale, localePath)}\` to update the template.`;
      problems.push(
        `FEO locale "${locale}" in "${localePath}" is not byte-identical to the ` +
          `inlined output for template "${entry.template}" and source catalog "${entry.source}". ` +
          updateCommand,
      );
    }
  }

  for (const locale of templateLocales) {
    if (Object.hasOwn(entry.locales, locale)) continue;
    problems.push(
      `FEO template "${entry.template}" has spec.locales for "${locale}", but its "feo" entry ` +
        `does not list that locale, so it is not checked. Add "${locale}" with its locale file ` +
        `to the entry's "locales", or remove the block from the template.`,
    );
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
  const warnings: string[] = [];
  const lintedSources = new Set<string>();
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

  for (const entry of config.feo ?? []) {
    problems.push(...(await checkFeoTemplate(projectRoot, entry)));
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
  for (const entry of config.feo ?? []) {
    declaredPaths.add(entry.source);
    for (const localePath of Object.values(entry.locales)) declaredPaths.add(localePath);
  }
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
    if (!lintedSources.has(check.source.path)) {
      lintedSources.add(check.source.path);
      warnings.push(
        ...lintSourceCatalog(source.catalog).map(
          (warning) => `Source catalog ${check.source.path}: ${warning.message}`,
        ),
      );
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
        for (const finding of lintTargetCatalog(source.catalog, target.catalog)) {
          const message = `Target catalog ${targetReference.path}: ${finding.message}`;
          (finding.severity === "error" ? problems : warnings).push(message);
        }
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
  }

  problems.push(
    ...(await undeclaredCatalogProblems(projectRoot, config.catalogDirectories, declaredPaths)),
  );

  return { problems, warnings, sourceCount, targetCount, generatedCount, pendingTargetCount };
}
