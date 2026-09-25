#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  checkCatalogs as compareCatalogs,
  convertCatalog as convertCatalogDocument,
  createCatalogAdapterRegistry,
  type AdapterContext,
  type CatalogRole,
} from "./index.js";

export interface CliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

const ROOT_HELP = `Usage: frontend-i18n <check|validate|convert|version|help> [options]

Commands:
  check     Compare source and target catalogs
  validate  Validate one catalog's format and ICU syntax
  convert   Convert a catalog between adapters
  version   Print the package version
  help      Show help, optionally for one command

Use frontend-i18n <command> --help for command options.`;

const COMMAND_HELP: Record<string, string> = {
  check: `Usage: frontend-i18n check --source <path> --target <path> [options]

Options:
  --source-adapter <id>  Source adapter (default: formatjs-json)
  --target-adapter <id>  Target adapter (default: source adapter)
  --source-locale <tag>  Source locale (default: en)
  --target-locale <tag>  Target locale (default: und)
  --source-config <path> Source adapter JSON config
  --target-config <path> Target adapter JSON config
  -h, --help             Show this help`,
  validate: `Usage: frontend-i18n validate --catalog <path> [options]

Options:
  --adapter <id>  Catalog adapter (default: formatjs-json)
  --locale <tag>  Catalog locale (default: en)
  --role <role>   Catalog role: source or target (default: source)
  --config <path> Adapter JSON config
  -h, --help      Show this help`,
  convert: `Usage: frontend-i18n convert --source <path> --output <path> --source-adapter <id> --target-adapter <id> [options]

Options:
  --locale <tag>         Catalog locale (default: en)
  --source-role <role>   Source role: source or target (default: source)
  --target-role <role>   Target role: source or target (default: target)
  --source-config <path> Source adapter JSON config
  --target-config <path> Target adapter JSON config
  -h, --help             Show this help`,
  version: `Usage: frontend-i18n version

Prints the i18n-pipeline package version.`,
};

function helpText(command?: string): string {
  return command ? (COMMAND_HELP[command] ?? ROOT_HELP) : ROOT_HELP;
}

function parseOptions<T extends Record<string, { type: "string" }>>(
  args: string[],
  options: T,
): Record<keyof T, string | undefined> {
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  return values as unknown as Record<keyof T, string | undefined>;
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

async function validateCatalog(
  args: string[],
  { cwd, env, stdout }: Required<Pick<CliOptions, "cwd" | "env" | "stdout">>,
): Promise<void> {
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
  const [document, options] = await Promise.all([
    readJson(resolve(cwd, catalogPath), "Catalog"),
    readAdapterOptions(cwd, configPath),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const catalog = registry.get(adapterId).read(document, createContext(locale, role, options));
  stdout(
    `Validated ${messageCount(Object.keys(catalog.messages).length)} ` +
      `(adapter=${adapterId}, locale=${locale}, role=${role}).`,
  );
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
  const [sourceDocument, targetDocument, sourceOptions, targetOptions] = await Promise.all([
    readJson(resolve(cwd, sourcePath), "Source catalog"),
    readJson(resolve(cwd, targetPath), "Target catalog"),
    readAdapterOptions(cwd, values["source-config"] ?? env.I18N_SOURCE_CATALOG_CONFIG),
    readAdapterOptions(cwd, values["target-config"] ?? env.I18N_TARGET_CATALOG_CONFIG),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const source = registry
    .get(sourceAdapterId)
    .read(sourceDocument, createContext(sourceLocale, "source", sourceOptions));
  const target = registry
    .get(targetAdapterId)
    .read(targetDocument, createContext(targetLocale, "target", targetOptions));
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
      `Argument mismatch for "${mismatch.id}": source [${mismatch.source.join(", ")}], ` +
        `target [${mismatch.target.join(", ")}]`,
    );
  }

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
  const [document, sourceOptions, targetOptions] = await Promise.all([
    readJson(resolve(cwd, sourcePath), "Source catalog"),
    readAdapterOptions(cwd, values["source-config"]),
    readAdapterOptions(cwd, values["target-config"]),
  ]);
  const registry = await createCatalogAdapterRegistry(cwd);
  const sourceAdapter = registry.get(sourceAdapterId);
  const targetAdapter = registry.get(targetAdapterId);
  const converted = convertCatalogDocument(
    document,
    sourceAdapter,
    targetAdapter,
    createContext(locale, sourceRole, sourceOptions),
    createContext(locale, targetRole, targetOptions),
  );
  const absoluteOutputPath = resolve(cwd, outputPath);
  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, `${JSON.stringify(converted, null, 2)}\n`, "utf8");
  stdout(`Converted catalog from ${sourceAdapterId} to ${targetAdapterId} (locale=${locale}).`);
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    stdout(helpText(command === "help" ? args[0] : undefined));
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    stdout(helpText(command));
    return 0;
  }

  try {
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
      await validateCatalog(args, { cwd, env, stdout });
      return 0;
    }
    if (command === "convert") {
      await convertCatalog(args, { cwd, stdout });
      return 0;
    }
    throw new Error(`Unknown command "${command}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`frontend-i18n: ${message}\n${COMMAND_HELP[command] ?? ROOT_HELP}`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
