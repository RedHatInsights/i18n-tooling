import type { LocaleCompletionPolicy, PhraseWorkflowConfig } from "./phrase-workflow.js";

export interface PhraseTmsConfig {
  workflow: PhraseWorkflowConfig;
  stateBranch: string;
  stateDirectory: string;
}

export const DEFAULT_STATE_BRANCH = "i18n-tms-state";
export const DEFAULT_STATE_DIRECTORY = ".github/i18n-state/batches";

const COMPLETION_POLICIES: readonly LocaleCompletionPolicy[] = ["per-locale", "all-locales"];
const CREDENTIAL_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "authorization",
  "apikey",
  "credential",
  "credentials",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : recordValue(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) throw new TypeError(`${label} has unknown property "${unknownKey}"`);
}

function completionPolicy(value: unknown, label: string): LocaleCompletionPolicy {
  if (!COMPLETION_POLICIES.includes(value as LocaleCompletionPolicy)) {
    throw new TypeError(`${label} must be "per-locale" or "all-locales"`);
  }
  return value as LocaleCompletionPolicy;
}

/** Splits camelCase, snake_case, and kebab-case keys into lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  return words.some(
    (word, index) =>
      CREDENTIAL_WORDS.has(word) ||
      (word === "key" && (words[index - 1] === "api" || words[index - 1] === "private")),
  );
}

/** Rejects credential-like keys anywhere in the config so tokens never reach batch-state files. */
export function rejectCredentialFields(value: unknown, location = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentialFields(item, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isCredentialKey(key)) {
      throw new TypeError(
        `${location}.${key} must not contain credentials; use protected workflow secrets`,
      );
    }
    rejectCredentialFields(child, `${location}.${key}`);
  }
}

export function validateRepoPath(path: string, label: string): void {
  const segments = path.split("/");
  if (
    !path.trim() ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a repository-relative path without parent traversal`);
  }
}

/** Semantic checks shared by the CLI and direct `PhraseWorkflow` callers. */
export function validatePhraseWorkflowConfig(config: PhraseWorkflowConfig): void {
  rejectCredentialFields(config);
  if (!config.projectUid.trim()) throw new TypeError("Phrase project UID is required");
  validateRepoPath(config.sourceCatalog.path, "Source catalog path");
  if (!config.sourceCatalog.filename.trim() || /[\\/]/.test(config.sourceCatalog.filename)) {
    throw new TypeError("Phrase source filename must be a file name, not a path");
  }
  if (!config.sourceCatalog.adapter.trim())
    throw new TypeError("Source catalog adapter is required");
  if (!config.sourceCatalog.locale.trim()) throw new TypeError("Source catalog locale is required");
  if (config.sourceCatalog.importSettingsUid && config.sourceCatalog.useProjectFileImportSettings) {
    throw new TypeError("Choose either an import settings UID or project file import settings");
  }
  if (config.region !== "eu" && config.region !== "us")
    throw new TypeError("Phrase region must be eu or us");
  if (!config.targetLocales.length) throw new TypeError("At least one target locale is required");
  if (!config.completionPolicy || !COMPLETION_POLICIES.includes(config.completionPolicy.default)) {
    throw new TypeError("A valid completion policy is required");
  }
  const phraseLocales = new Set<string>();
  const repositoryLocales = new Set<string>();
  const outputPaths = new Set<string>();
  for (const locale of config.targetLocales) {
    if (!locale.phraseLocale.trim() || !locale.repositoryLocale.trim()) {
      throw new TypeError("Each target locale needs Phrase language and repository locale");
    }
    validateRepoPath(locale.outputPath, "Target output path");
    if (locale.outputPath === config.sourceCatalog.path) {
      throw new TypeError("Target output path must not overwrite the source catalog");
    }
    if (phraseLocales.has(locale.phraseLocale)) {
      throw new TypeError(`Duplicate Phrase target locale: ${locale.phraseLocale}`);
    }
    if (repositoryLocales.has(locale.repositoryLocale)) {
      throw new TypeError(`Duplicate repository target locale: ${locale.repositoryLocale}`);
    }
    if (outputPaths.has(locale.outputPath))
      throw new TypeError(`Duplicate target output path: ${locale.outputPath}`);
    const policy = config.completionPolicy.byLocale?.[locale.phraseLocale];
    if (policy !== undefined && !COMPLETION_POLICIES.includes(policy)) {
      throw new TypeError(`Invalid completion policy for ${locale.phraseLocale}`);
    }
    phraseLocales.add(locale.phraseLocale);
    repositoryLocales.add(locale.repositoryLocale);
    outputPaths.add(locale.outputPath);
  }
  for (const locale of Object.keys(config.completionPolicy.byLocale ?? {})) {
    if (!phraseLocales.has(locale))
      throw new TypeError(`Completion policy references unknown locale: ${locale}`);
  }
}

/**
 * Parses consumer JSON (see schemas/phrase-tms-config.schema.json) into workflow config.
 * Structural checks live here; semantic checks run through `validatePhraseWorkflowConfig`.
 */
export function parsePhraseTmsConfig(value: unknown): PhraseTmsConfig {
  rejectCredentialFields(value);
  const root = recordValue(value, "TMS config");
  rejectUnknownKeys(
    root,
    [
      "provider",
      "project",
      "state",
      "sourceCatalog",
      "targetAdapter",
      "targetOptions",
      "targetLocales",
      "completionPolicy",
    ],
    "TMS config",
  );
  if (root.provider !== "phrase") throw new TypeError('TMS config "provider" must be "phrase"');

  const project = recordValue(root.project, 'TMS config "project"');
  rejectUnknownKeys(project, ["uid", "region"], 'TMS config "project"');
  const region = requiredString(project.region, 'TMS config "project.region"');
  if (region !== "eu" && region !== "us")
    throw new TypeError('TMS config "project.region" must be "eu" or "us"');

  const source = recordValue(root.sourceCatalog, 'TMS config "sourceCatalog"');
  rejectUnknownKeys(
    source,
    [
      "path",
      "filename",
      "adapter",
      "locale",
      "options",
      "importSettingsUid",
      "useProjectFileImportSettings",
    ],
    'TMS config "sourceCatalog"',
  );
  const sourcePath = requiredString(source.path, 'TMS config "sourceCatalog.path"');
  const sourceFilename =
    optionalString(source.filename, 'TMS config "sourceCatalog.filename"') ??
    sourcePath.split(/[\\/]/).at(-1) ??
    "";
  const sourceOptions = optionalRecord(source.options, 'TMS config "sourceCatalog.options"');
  const importSettingsUid = optionalString(
    source.importSettingsUid,
    'TMS config "sourceCatalog.importSettingsUid"',
  );
  if (
    source.useProjectFileImportSettings !== undefined &&
    typeof source.useProjectFileImportSettings !== "boolean"
  ) {
    throw new TypeError(
      'TMS config "sourceCatalog.useProjectFileImportSettings" must be a boolean',
    );
  }

  if (!Array.isArray(root.targetLocales))
    throw new TypeError('TMS config "targetLocales" must be an array');
  const targetLocales = root.targetLocales.map((value, index) => {
    const label = `TMS config "targetLocales[${index}]`;
    const target = recordValue(value, `${label}"`);
    rejectUnknownKeys(target, ["phraseLocale", "repositoryLocale", "outputPath"], `${label}"`);
    return {
      phraseLocale: requiredString(target.phraseLocale, `${label}.phraseLocale"`),
      repositoryLocale: requiredString(target.repositoryLocale, `${label}.repositoryLocale"`),
      outputPath: requiredString(target.outputPath, `${label}.outputPath"`),
    };
  });

  const rawPolicy =
    optionalRecord(root.completionPolicy, 'TMS config "completionPolicy"') ?? ({} as const);
  rejectUnknownKeys(rawPolicy, ["default", "byLocale"], 'TMS config "completionPolicy"');
  const policyDefault = completionPolicy(
    rawPolicy.default ?? "per-locale",
    'TMS config "completionPolicy.default"',
  );
  let byLocale: Record<string, LocaleCompletionPolicy> | undefined;
  if (rawPolicy.byLocale !== undefined) {
    const entries = recordValue(rawPolicy.byLocale, 'TMS config "completionPolicy.byLocale"');
    byLocale = Object.fromEntries(
      Object.entries(entries).map(([locale, policy]) => [
        locale,
        completionPolicy(policy, `Completion policy for target locale "${locale}"`),
      ]),
    );
  }

  const targetOptions = optionalRecord(root.targetOptions, 'TMS config "targetOptions"');
  const targetAdapter = optionalString(root.targetAdapter, 'TMS config "targetAdapter"');
  const workflow: PhraseWorkflowConfig = {
    projectUid: requiredString(project.uid, 'TMS config "project.uid"'),
    region,
    sourceCatalog: {
      path: sourcePath,
      filename: sourceFilename,
      adapter: requiredString(source.adapter, 'TMS config "sourceCatalog.adapter"'),
      locale: requiredString(source.locale, 'TMS config "sourceCatalog.locale"'),
      ...(sourceOptions ? { options: sourceOptions } : {}),
      ...(importSettingsUid ? { importSettingsUid } : {}),
      ...(source.useProjectFileImportSettings === true
        ? { useProjectFileImportSettings: true }
        : {}),
    },
    ...(targetAdapter ? { targetAdapter } : {}),
    ...(targetOptions ? { targetOptions } : {}),
    targetLocales,
    completionPolicy: { default: policyDefault, ...(byLocale ? { byLocale } : {}) },
  };
  validatePhraseWorkflowConfig(workflow);

  const state = optionalRecord(root.state, 'TMS config "state"') ?? {};
  rejectUnknownKeys(state, ["branch", "directory"], 'TMS config "state"');
  const stateBranch =
    optionalString(state.branch, 'TMS config "state.branch"') ?? DEFAULT_STATE_BRANCH;
  const stateDirectory =
    optionalString(state.directory, 'TMS config "state.directory"') ?? DEFAULT_STATE_DIRECTORY;
  validateRepoPath(stateDirectory, 'TMS config "state.directory"');
  return { workflow, stateBranch, stateDirectory };
}
