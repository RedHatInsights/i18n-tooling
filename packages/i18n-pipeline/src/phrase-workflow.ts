import { createHash } from "node:crypto";
import { checkCatalogs } from "./catalog-check.js";
import { parseCatalogDocument, serializeCatalogDocument } from "./catalog-document.js";
import type { Catalog, CatalogAdapter, CatalogAdapterRegistry } from "./index.js";
import {
  PhraseApiError,
  PhraseAsyncRequestError,
  PhraseAuthError,
  PhraseTransportError,
} from "./phrase-client.js";
import type { CreatePhraseJobInput, PhraseJobCreation, PhraseJobPart } from "./phrase-client.js";
import { validatePhraseWorkflowConfig } from "./phrase-config.js";

export type LocaleCompletionPolicy = "per-locale" | "all-locales";

export interface PhraseTargetLocale {
  phraseLocale: string;
  repositoryLocale: string;
  outputPath: string;
}

export interface PhraseWorkflowConfig {
  projectUid: string;
  region: "eu" | "us";
  sourceCatalog: {
    path: string;
    filename: string;
    adapter: string;
    locale: string;
    options?: Record<string, unknown>;
    importSettingsUid?: string;
    useProjectFileImportSettings?: boolean;
  };
  targetAdapter?: string;
  targetOptions?: Record<string, unknown>;
  targetLocales: PhraseTargetLocale[];
  completionPolicy: {
    default: LocaleCompletionPolicy;
    byLocale?: Record<string, LocaleCompletionPolicy>;
  };
}

/**
 * Batch lifecycle. `completed`, `failed`, and `superseded` are terminal for reconciliation;
 * `creating` and `unknown` need manual recovery before anything else happens.
 */
export type PhraseBatchPhase =
  "creating" | "unknown" | "importing" | "ready" | "completed" | "failed" | "superseded";
export type PhraseLocalePhase =
  "pending" | "exporting" | "failed" | "validation-failed" | "pr-created";

export interface PhraseBatchRecord {
  schema: 1;
  key: string;
  /** Zero for the first submission of a source revision; increments with `retryFailed`. */
  attempt?: number;
  phase: PhraseBatchPhase;
  repository: string;
  baseRef: string;
  sourceCommit: string;
  sourceDigest: string;
  config: PhraseWorkflowConfig;
  createdAt: string;
  jobs: PhraseJobPart[];
  warningCount: number;
  importAsyncRequestId?: string;
  failureReason?: string;
  locales: Record<
    string,
    { phase: PhraseLocalePhase; pullRequestUrl?: string; failureReason?: string }
  >;
}

export interface StoredPhraseBatch {
  record: PhraseBatchRecord;
  revision: string;
}

export interface PhraseBatchStateStore {
  readBatch(key: string): Promise<StoredPhraseBatch | undefined>;
  listBatchKeys(): Promise<string[]>;
  createBatch(record: PhraseBatchRecord): Promise<string>;
  updateBatch(record: PhraseBatchRecord, expectedRevision: string): Promise<string>;
}

export interface PhraseLocalePullRequest {
  repository: string;
  baseRef: string;
  branch: string;
  title: string;
  body: string;
  path: string;
  content: Uint8Array;
}

export interface PhraseWorkflowRepository {
  readFile(path: string, ref: string): Promise<Uint8Array | null>;
  createOrUpdatePullRequest(input: PhraseLocalePullRequest): Promise<string>;
}

export interface PhraseWorkflowDependencies {
  phrase: {
    createJob(input: CreatePhraseJobInput): Promise<PhraseJobCreation>;
    waitForAsyncRequest(
      asyncRequestId: string,
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ): Promise<void>;
    getJob(projectUid: string, jobUid: string): Promise<PhraseJobPart>;
    startTargetDownload(projectUid: string, jobUid: string): Promise<string>;
    downloadTargetFile(
      projectUid: string,
      jobUid: string,
      asyncRequestId: string,
    ): Promise<Uint8Array>;
  };
  state: PhraseBatchStateStore;
  repository: PhraseWorkflowRepository;
  catalogAdapters: Pick<CatalogAdapterRegistry, "get">;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  importTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface PhraseSubmitInput {
  repository: string;
  baseRef: string;
  sourceCommit: string;
  sourceBytes: Uint8Array;
  config: PhraseWorkflowConfig;
  /** Create a new Phrase job for batch- or locale-level failures of this exact source. */
  retryFailed?: boolean;
}

export interface PhraseReconcileResult {
  batchKey: string;
  /** Omitted when the whole batch could not be reconciled on this run. */
  phraseLocale?: string;
  /** `retrying` means a transient failure; the next reconcile run tries again. */
  phase: "pending" | "retrying" | "failed" | "superseded" | "pr-created";
  pullRequestUrl?: string;
  reason?: string;
}

export class PhraseBatchStateConflictError extends Error {
  constructor(message = "Phrase batch state changed concurrently") {
    super(message);
    this.name = "PhraseBatchStateConflictError";
  }
}

export class PhraseWorkflowError extends Error {
  constructor(
    message: string,
    readonly batchKey?: string,
  ) {
    super(message);
    this.name = "PhraseWorkflowError";
  }
}

/** A downloaded target catalog is unusable; retrying the same export cannot fix it. */
export class PhraseCatalogValidationError extends PhraseWorkflowError {
  constructor(message: string, batchKey?: string) {
    super(message, batchKey);
    this.name = "PhraseCatalogValidationError";
  }
}

/** Repository-side failure. `permanent` failures need a human, not another reconcile run. */
export class PhraseRepositoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly permanent = false,
  ) {
    super(message);
    this.name = "PhraseRepositoryError";
  }
}

const MAX_SUBMISSION_ATTEMPTS = 10;
const RECONCILABLE_PHASES: ReadonlySet<PhraseBatchPhase> = new Set(["importing", "ready"]);
const FINAL_LOCALE_PHASES: ReadonlySet<PhraseLocalePhase> = new Set(["pr-created", "failed"]);
const FAILED_JOB_STATUSES = new Set(["CANCELLED", "CANCELED", "DECLINED", "REJECTED"]);

type LocaleReadiness =
  | { phase: "ready"; finalJob: PhraseJobPart }
  | { phase: "pending" }
  | { phase: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFailureReason(error: unknown): string {
  if (error instanceof PhraseAsyncRequestError) return "Phrase asynchronous request failed";
  if (error instanceof PhraseAuthError) return error.message;
  if (error instanceof PhraseApiError) return `Phrase API returned HTTP ${error.status}`;
  if (error instanceof PhraseTransportError) {
    return error.mayHaveExecuted
      ? "Phrase request outcome is unknown; inspect Phrase before retrying"
      : "Could not reach Phrase API";
  }
  if (error instanceof PhraseRepositoryError || error instanceof PhraseBatchStateConflictError) {
    return error.message;
  }
  return "Phrase workflow failed; inspect the action log for the non-secret error summary";
}

function retryableImportFailure(error: unknown): boolean {
  if (error instanceof PhraseAsyncRequestError) return false;
  if (error instanceof PhraseTransportError) return true;
  if (error instanceof PhraseApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof PhraseRepositoryError) return !error.permanent;
  if (error instanceof PhraseWorkflowError)
    return /timed out waiting for Phrase job imports/i.test(error.message);
  return error instanceof Error && /timed out waiting for Phrase request/i.test(error.message);
}

/**
 * Identity of one Phrase submission. The source commit is deliberately excluded so that
 * unrelated commits (or re-dispatches) with unchanged source bytes never create a second
 * Phrase job; repository-side mapping (output paths, adapters, completion policy) is also
 * excluded because it does not change what Phrase translates.
 */
function batchIdentity(input: PhraseSubmitInput, sourceDigest: string): Record<string, unknown> {
  const { sourceCatalog } = input.config;
  return {
    repository: input.repository,
    baseRef: input.baseRef,
    sourceDigest,
    projectUid: input.config.projectUid,
    region: input.config.region,
    sourceCatalog: {
      path: sourceCatalog.path,
      filename: sourceCatalog.filename,
      importSettingsUid: sourceCatalog.importSettingsUid,
      useProjectFileImportSettings: sourceCatalog.useProjectFileImportSettings,
    },
    targetLangs: input.config.targetLocales.map((target) => target.phraseLocale).sort(),
  };
}

function batchKey(identity: Record<string, unknown>, attempt: number): string {
  return createHash("sha256")
    .update(stableJson(attempt ? { ...identity, attempt } : identity))
    .digest("hex");
}

function makeBatchRecord(
  input: PhraseSubmitInput,
  key: string,
  attempt: number,
  sourceDigest: string,
  now: number,
  previousRecord?: PhraseBatchRecord,
): PhraseBatchRecord {
  const locales = Object.fromEntries(
    input.config.targetLocales.map(({ phraseLocale }) => {
      const previousLocale = previousRecord?.locales[phraseLocale];
      return [
        phraseLocale,
        previousLocale?.phase === "pr-created"
          ? { ...previousLocale }
          : { phase: "pending" as const },
      ];
    }),
  );
  return {
    schema: 1,
    key,
    ...(attempt ? { attempt } : {}),
    phase: "creating",
    repository: input.repository,
    baseRef: input.baseRef,
    sourceCommit: input.sourceCommit,
    sourceDigest,
    config: input.config,
    createdAt: new Date(now).toISOString(),
    jobs: [],
    warningCount: 0,
    locales,
  };
}

function localePolicy(record: PhraseBatchRecord, phraseLocale: string): LocaleCompletionPolicy {
  return (
    record.config.completionPolicy.byLocale?.[phraseLocale] ??
    record.config.completionPolicy.default
  );
}

function unresolvedTargets(record: PhraseBatchRecord): PhraseTargetLocale[] {
  return record.config.targetLocales.filter(
    (target) => !FINAL_LOCALE_PHASES.has(record.locales[target.phraseLocale]?.phase ?? "pending"),
  );
}

function hasRetryableFailures(record: PhraseBatchRecord): boolean {
  return (
    record.phase === "failed" ||
    (record.phase === "completed" &&
      Object.values(record.locales).some(
        (locale) => locale.phase === "failed" || locale.phase === "validation-failed",
      ))
  );
}

function needsReconciliation(record: PhraseBatchRecord): boolean {
  return (
    RECONCILABLE_PHASES.has(record.phase) ||
    (record.phase === "completed" &&
      Object.values(record.locales).some((locale) => locale.phase === "validation-failed"))
  );
}

function hasValidationFailure(record: PhraseBatchRecord): boolean {
  return Object.values(record.locales).some((locale) => locale.phase === "validation-failed");
}
function assessReadiness(jobs: PhraseJobPart[]): LocaleReadiness {
  const finalLevel = Math.max(...jobs.map((job) => job.lastWorkflowLevel ?? job.workflowLevel));
  const finalJobs = jobs.filter((job) => job.workflowLevel === finalLevel);
  if (finalJobs.length === 0) {
    return {
      phase: "failed",
      reason: `Phrase returned no job part for final workflow level ${finalLevel}`,
    };
  }
  if (finalJobs.length > 1) {
    return {
      phase: "failed",
      reason: "Multiple final-step job parts are not supported for one catalog and locale",
    };
  }
  const finalJob = finalJobs[0]!;
  if (finalJob.importStatus?.status === "ERROR") {
    return { phase: "failed", reason: `Phrase import failed for job ${finalJob.uid}` };
  }
  if (FAILED_JOB_STATUSES.has(finalJob.status ?? "")) {
    return { phase: "failed", reason: `Final Phrase job ended with status ${finalJob.status}` };
  }
  return finalJob.status === "COMPLETED" ? { phase: "ready", finalJob } : { phase: "pending" };
}

export class PhraseWorkflow {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly importTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly dependencies: PhraseWorkflowDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.importTimeoutMs = dependencies.importTimeoutMs ?? 5 * 60 * 1000;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 2_000;
  }

  async submit(input: PhraseSubmitInput): Promise<PhraseBatchRecord> {
    validatePhraseWorkflowConfig(input.config);
    if (!input.repository.trim() || !input.baseRef.trim() || !input.sourceCommit.trim()) {
      throw new TypeError("Repository, PR base ref, and source commit are required");
    }
    if (!input.sourceBytes.byteLength) throw new TypeError("Source catalog must not be empty");

    const sourceAdapter = this.dependencies.catalogAdapters.get(input.config.sourceCatalog.adapter);
    const sourceContext = {
      locale: input.config.sourceCatalog.locale,
      role: "source" as const,
      options: input.config.sourceCatalog.options ?? {},
    };
    let sourceDocument: unknown;
    try {
      sourceDocument = parseCatalogDocument(
        new TextDecoder().decode(input.sourceBytes),
        sourceAdapter,
        sourceContext,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const format = sourceAdapter.parseDocument ? `adapter "${sourceAdapter.id}" input` : "JSON";
      throw new PhraseWorkflowError(`Source catalog is not valid ${format}: ${detail}`);
    }
    sourceAdapter.read(sourceDocument, sourceContext);
    const targetAdapter = input.config.targetAdapter ?? input.config.sourceCatalog.adapter;
    this.dependencies.catalogAdapters.get(targetAdapter);

    const sourceDigest = digest(input.sourceBytes);
    const pinnedSourceBytes = await this.dependencies.repository.readFile(
      input.config.sourceCatalog.path,
      input.sourceCommit,
    );
    if (!pinnedSourceBytes || digest(pinnedSourceBytes) !== sourceDigest) {
      throw new PhraseWorkflowError(
        "Source bytes do not match the source file at the requested commit",
      );
    }

    const identity = batchIdentity(input, sourceDigest);
    let previousFailedBatch: PhraseBatchRecord | undefined;
    for (let attempt = 0; attempt < MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
      const key = batchKey(identity, attempt);
      const existing = await this.dependencies.state.readBatch(key);
      if (!existing)
        return this.createSubmission(input, key, attempt, sourceDigest, previousFailedBatch);
      if (input.retryFailed && hasRetryableFailures(existing.record)) {
        previousFailedBatch = existing.record;
        continue;
      }
      return this.resumeSubmission(existing, input.config);
    }
    throw new PhraseWorkflowError(
      `Phrase submission failed ${MAX_SUBMISSION_ATTEMPTS} times for this source; fix the Phrase project before retrying`,
    );
  }

  async reconcile(): Promise<PhraseReconcileResult[]> {
    const results: PhraseReconcileResult[] = [];
    for (const key of await this.dependencies.state.listBatchKeys()) {
      try {
        const stored = await this.dependencies.state.readBatch(key);
        if (!stored || !needsReconciliation(stored.record)) continue;
        await this.reconcileBatch(stored, results);
      } catch (error) {
        results.push({ batchKey: key, phase: "retrying", reason: safeFailureReason(error) });
      }
    }
    return results;
  }

  private async createSubmission(
    input: PhraseSubmitInput,
    key: string,
    attempt: number,
    sourceDigest: string,
    previousRecord?: PhraseBatchRecord,
  ): Promise<PhraseBatchRecord> {
    const record = makeBatchRecord(input, key, attempt, sourceDigest, this.now(), previousRecord);
    const targetLangs = input.config.targetLocales
      .filter(({ phraseLocale }) => record.locales[phraseLocale]?.phase === "pending")
      .map(({ phraseLocale }) => phraseLocale);
    if (!targetLangs.length) {
      throw new PhraseWorkflowError("Phrase retry has no locales left to submit", key);
    }
    let revision: string;
    try {
      revision = await this.dependencies.state.createBatch(record);
    } catch (error) {
      const raced = await this.dependencies.state.readBatch(key);
      if (raced) return this.resumeSubmission(raced, input.config);
      throw error;
    }

    let created: PhraseJobCreation;
    try {
      created = await this.dependencies.phrase.createJob({
        projectUid: input.config.projectUid,
        filename: input.config.sourceCatalog.filename,
        sourceBytes: input.sourceBytes,
        targetLangs,
        ...(input.config.sourceCatalog.importSettingsUid
          ? { importSettingsUid: input.config.sourceCatalog.importSettingsUid }
          : {}),
        ...(input.config.sourceCatalog.useProjectFileImportSettings
          ? { useProjectFileImportSettings: true }
          : {}),
      });
    } catch (error) {
      record.phase =
        error instanceof Error &&
        (error as Error & { mayHaveExecuted?: unknown }).mayHaveExecuted === true
          ? "unknown"
          : "failed";
      record.failureReason = safeFailureReason(error);
      await this.dependencies.state.updateBatch(record, revision);
      throw error;
    }

    record.importAsyncRequestId = created.asyncRequest.id;
    record.jobs = created.jobs;
    record.warningCount = created.warnings.length;
    record.phase = "importing";
    revision = await this.dependencies.state.updateBatch(record, revision);

    if (created.unsupportedFiles.length) {
      record.phase = "failed";
      record.failureReason = `Phrase rejected unsupported source files: ${created.unsupportedFiles.join(", ")}`;
      await this.dependencies.state.updateBatch(record, revision);
      throw new PhraseWorkflowError(record.failureReason, key);
    }
    if (!record.jobs.length) {
      record.phase = "failed";
      record.failureReason = "Phrase created no job parts for the requested locales";
      await this.dependencies.state.updateBatch(record, revision);
      throw new PhraseWorkflowError(record.failureReason, key);
    }

    return (await this.finishImport(record, revision)).record;
  }

  private async resumeSubmission(
    stored: StoredPhraseBatch,
    config: PhraseWorkflowConfig,
  ): Promise<PhraseBatchRecord> {
    const { record } = stored;
    let revision = stored.revision;
    if (record.phase === "creating" || record.phase === "unknown") {
      throw new PhraseWorkflowError(
        "Unknown Phrase submission outcome; inspect Phrase and bind or void the batch before retrying",
        record.key,
      );
    }
    if (record.phase === "failed") {
      throw new PhraseWorkflowError(
        "Phrase batch cannot be submitted again from phase failed; rerun with --retry-failed to create a new Phrase job",
        record.key,
      );
    }
    if (record.phase === "completed") return record;

    // Phrase-facing settings are part of the batch key, so a differing config only changes
    // repository-side mapping (output paths, adapters, completion policy). Adopt the latest.
    if (stableJson(record.config) !== stableJson(config)) {
      record.config = config;
      revision = await this.dependencies.state.updateBatch(record, revision);
    }
    if (record.phase === "superseded") {
      // Only ready batches are superseded, so the Phrase jobs still translate these exact bytes.
      // Reconciliation rechecks the base ref before any PR is opened.
      record.phase = "ready";
      record.failureReason = undefined;
      await this.dependencies.state.updateBatch(record, revision);
      return record;
    }
    if (record.phase === "importing") return (await this.finishImport(record, revision)).record;
    return record;
  }

  private async reconcileBatch(
    stored: StoredPhraseBatch,
    results: PhraseReconcileResult[],
  ): Promise<void> {
    let { record, revision } = stored;
    if (record.phase === "importing") {
      try {
        ({ record, revision } = await this.finishImport(record, revision));
      } catch (error) {
        if (record.phase !== "failed") throw error;
        for (const target of record.config.targetLocales) {
          results.push({
            batchKey: record.key,
            phraseLocale: target.phraseLocale,
            phase: "failed",
            ...(record.failureReason ? { reason: record.failureReason } : {}),
          });
        }
        return;
      }
    }

    const sourcePath = record.config.sourceCatalog.path;
    const [pinnedSourceBytes, currentSourceBytes] = await Promise.all([
      this.dependencies.repository.readFile(sourcePath, record.sourceCommit),
      this.dependencies.repository.readFile(sourcePath, record.baseRef),
    ]);
    if (!pinnedSourceBytes || digest(pinnedSourceBytes) !== record.sourceDigest) {
      await this.closeBatch(
        record,
        revision,
        "failed",
        "Could not reproduce the exact source catalog submitted to Phrase",
        results,
      );
      return;
    }
    if (!currentSourceBytes || digest(currentSourceBytes) !== record.sourceDigest) {
      await this.closeBatch(
        record,
        revision,
        "superseded",
        "Source catalog changed on the recorded PR base ref",
        results,
      );
      return;
    }

    const sourceAdapter = this.dependencies.catalogAdapters.get(
      record.config.sourceCatalog.adapter,
    );
    const targetAdapter = this.dependencies.catalogAdapters.get(
      record.config.targetAdapter ?? record.config.sourceCatalog.adapter,
    );
    let sourceCatalog: Catalog;
    try {
      const context = {
        locale: record.config.sourceCatalog.locale,
        role: "source" as const,
        options: record.config.sourceCatalog.options ?? {},
      };
      sourceCatalog = sourceAdapter.read(
        parseCatalogDocument(new TextDecoder().decode(pinnedSourceBytes), sourceAdapter, context),
        context,
      );
    } catch {
      await this.closeBatch(
        record,
        revision,
        "failed",
        "Pinned source catalog no longer passes adapter validation",
        results,
      );
      return;
    }

    const readiness = new Map<string, LocaleReadiness>();
    const refreshedJobs: PhraseJobPart[] = [];
    for (const target of unresolvedTargets(record)) {
      const targetJobs = record.jobs.filter((job) => job.targetLang === target.phraseLocale);
      if (!targetJobs.length) {
        readiness.set(target.phraseLocale, {
          phase: "failed",
          reason: "Phrase returned no job part for this target locale",
        });
        continue;
      }
      const jobs = await Promise.all(
        targetJobs.map((job) => this.dependencies.phrase.getJob(record.config.projectUid, job.uid)),
      );
      refreshedJobs.push(...jobs);
      readiness.set(target.phraseLocale, assessReadiness(jobs));
    }
    if (refreshedJobs.length) {
      const refreshedByUid = new Map(refreshedJobs.map((job) => [job.uid, job]));
      const jobs = record.jobs.map((job) => refreshedByUid.get(job.uid) ?? job);
      // Avoid a state-branch commit on every scheduled run when nothing moved in Phrase.
      if (stableJson(jobs) !== stableJson(record.jobs)) {
        record.jobs = jobs;
        revision = await this.dependencies.state.updateBatch(record, revision);
      }
    }

    const allLocalesReady = record.config.targetLocales.every(
      (target) =>
        record.locales[target.phraseLocale]?.phase === "pr-created" ||
        readiness.get(target.phraseLocale)?.phase === "ready",
    );
    const wasValidationRetry = hasValidationFailure(record);
    if (wasValidationRetry) record.phase = "ready";
    for (const target of record.config.targetLocales) {
      // closeBatch may have run for an earlier locale even if persisting it then failed.
      if (record.phase !== "ready" && !(wasValidationRetry && record.phase === "completed")) return;
      const push = (result: Omit<PhraseReconcileResult, "batchKey" | "phraseLocale">) =>
        results.push({ batchKey: record.key, phraseLocale: target.phraseLocale, ...result });
      const failLocale = async (reason: string) => {
        record.locales[target.phraseLocale] = { phase: "failed", failureReason: reason };
        revision = await this.dependencies.state.updateBatch(record, revision);
        push({ phase: "failed", reason });
      };

      const existingLocale = record.locales[target.phraseLocale];
      if (existingLocale?.phase === "pr-created") {
        if (!wasValidationRetry) {
          push({
            phase: "pr-created",
            ...(existingLocale.pullRequestUrl
              ? { pullRequestUrl: existingLocale.pullRequestUrl }
              : {}),
          });
        }
        continue;
      }
      // Failed locales were reported by the run that failed them; do not fail every later run.
      if (existingLocale?.phase === "failed") continue;
      if (existingLocale?.phase === "validation-failed") {
        // The translator may have corrected the Phrase job since the previous export.
        record.locales[target.phraseLocale] = { phase: "pending" };
      }

      const ready = readiness.get(target.phraseLocale);
      if (ready?.phase === "failed") {
        await failLocale(ready.reason);
        if (wasValidationRetry) record.phase = "completed";
        continue;
      }
      if (localePolicy(record, target.phraseLocale) === "all-locales") {
        const validationFailedLocale = Object.entries(record.locales).find(
          ([, locale]) => locale.phase === "validation-failed",
        )?.[0];
        if (validationFailedLocale) {
          push({ phase: "pending" });
          continue;
        }
        const failedLocale = Object.entries(record.locales).find(
          ([, locale]) => locale.phase === "failed",
        )?.[0];
        if (failedLocale) {
          await failLocale(`Blocked: locale ${failedLocale} failed in this all-locales batch`);
          if (wasValidationRetry) record.phase = "completed";
          continue;
        }
        if (!allLocalesReady) {
          push({ phase: "pending" });
          continue;
        }
      }
      if (ready?.phase !== "ready") {
        push({ phase: "pending" });
        continue;
      }

      record.locales[target.phraseLocale] = { phase: "exporting" };
      revision = await this.dependencies.state.updateBatch(record, revision);
      try {
        const content = await this.exportTarget(
          record,
          target,
          ready.finalJob,
          sourceCatalog,
          targetAdapter,
        );
        const latestSourceBytes = await this.dependencies.repository.readFile(
          sourcePath,
          record.baseRef,
        );
        if (!latestSourceBytes || digest(latestSourceBytes) !== record.sourceDigest) {
          await this.closeBatch(
            record,
            revision,
            "superseded",
            "Source catalog changed before the locale PR was created",
            results,
          );
          return;
        }
        const localeSlug = target.repositoryLocale.replace(/[^A-Za-z0-9._-]+/g, "-");
        const pullRequestUrl = await this.dependencies.repository.createOrUpdatePullRequest({
          repository: record.repository,
          baseRef: record.baseRef,
          branch: `i18n/phrase-${record.key.slice(0, 16)}-${localeSlug}`,
          title: `i18n(${target.repositoryLocale}): Phrase translation update`,
          body:
            `Phrase project: ${record.config.projectUid}\n` +
            `Batch: ${record.key}\n` +
            `Source commit: ${record.sourceCommit}\n` +
            `Source SHA-256: ${record.sourceDigest}\n` +
            `Final job: ${ready.finalJob.uid}\n`,
          path: target.outputPath,
          content,
        });
        record.locales[target.phraseLocale] = { phase: "pr-created", pullRequestUrl };
        revision = await this.dependencies.state.updateBatch(record, revision);
        push({ phase: "pr-created", pullRequestUrl });
      } catch (error) {
        // A stale revision would make every later write in this batch fail; stop here.
        if (error instanceof PhraseBatchStateConflictError) throw error;
        const permanent =
          error instanceof PhraseCatalogValidationError ||
          (error instanceof PhraseRepositoryError && error.permanent);
        if (error instanceof PhraseCatalogValidationError) {
          record.locales[target.phraseLocale] = {
            phase: "validation-failed",
            failureReason: error.message,
          };
          record.phase = "completed";
          revision = await this.dependencies.state.updateBatch(record, revision);
          push({ phase: "failed", reason: error.message });
        } else if (permanent) await failLocale(error.message);
        else push({ phase: "retrying", reason: safeFailureReason(error) });
      }
    }

    if (
      !hasValidationFailure(record) &&
      record.config.targetLocales.every((target) => {
        const phase = record.locales[target.phraseLocale]?.phase;
        return phase === "pr-created" || phase === "failed";
      })
    ) {
      record.phase = "completed";
      await this.dependencies.state.updateBatch(record, revision);
    }
  }

  private async exportTarget(
    record: PhraseBatchRecord,
    target: PhraseTargetLocale,
    finalJob: PhraseJobPart,
    sourceCatalog: Catalog,
    targetAdapter: CatalogAdapter,
  ): Promise<Uint8Array> {
    const exportRequestId = await this.dependencies.phrase.startTargetDownload(
      record.config.projectUid,
      finalJob.uid,
    );
    await this.dependencies.phrase.waitForAsyncRequest(exportRequestId, {
      timeoutMs: this.importTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
    });
    const targetBytes = await this.dependencies.phrase.downloadTargetFile(
      record.config.projectUid,
      finalJob.uid,
      exportRequestId,
    );
    try {
      const context = {
        locale: target.repositoryLocale,
        role: "target" as const,
        options: record.config.targetOptions ?? {},
      };
      const targetCatalog = targetAdapter.read(
        parseCatalogDocument(new TextDecoder().decode(targetBytes), targetAdapter, context),
        context,
      );
      const comparison = checkCatalogs(sourceCatalog, targetCatalog);
      const problems: string[] = [];
      if (comparison.missingIds.length)
        problems.push(`missing IDs: ${comparison.missingIds.join(", ")}`);
      if (comparison.extraIds.length) problems.push(`extra IDs: ${comparison.extraIds.join(", ")}`);
      if (comparison.argumentMismatches.length) {
        problems.push(
          `ICU argument mismatches: ${comparison.argumentMismatches.map((item) => item.id).join(", ")}`,
        );
      }
      if (problems.length) throw new Error(problems.join("; "));
      const serialized = serializeCatalogDocument(
        targetAdapter.write(targetCatalog, context),
        targetAdapter,
        context,
      );
      return new TextEncoder().encode(serialized);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PhraseCatalogValidationError(
        `Downloaded ${target.phraseLocale} catalog failed validation: ${detail}`,
        record.key,
      );
    }
  }

  /** Moves a batch to a terminal phase and reports every locale that was still open. */
  private async closeBatch(
    record: PhraseBatchRecord,
    revision: string,
    phase: "failed" | "superseded",
    reason: string,
    results: PhraseReconcileResult[],
  ): Promise<void> {
    const open = unresolvedTargets(record);
    record.phase = phase;
    record.failureReason = reason;
    await this.dependencies.state.updateBatch(record, revision);
    for (const target of open) {
      results.push({ batchKey: record.key, phraseLocale: target.phraseLocale, phase, reason });
    }
  }

  private async finishImport(
    record: PhraseBatchRecord,
    revision: string,
  ): Promise<StoredPhraseBatch> {
    try {
      if (!record.importAsyncRequestId) {
        throw new PhraseWorkflowError("Phrase batch is missing its import request ID", record.key);
      }
      await this.dependencies.phrase.waitForAsyncRequest(record.importAsyncRequestId, {
        timeoutMs: this.importTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
      });
      const deadline = this.now() + this.importTimeoutMs;
      while (true) {
        const jobs = await Promise.all(
          record.jobs.map((job) =>
            this.dependencies.phrase.getJob(record.config.projectUid, job.uid),
          ),
        );
        record.jobs = jobs;
        const failed = jobs.find((job) => job.importStatus?.status === "ERROR");
        if (failed) {
          throw new PhraseWorkflowError(
            `Phrase failed to import job ${failed.uid}: ${failed.importStatus?.errorMessage ?? "unknown error"}`,
            record.key,
          );
        }
        if (jobs.every((job) => job.importStatus?.status === "OK" || job.imported === true)) break;
        if (this.now() >= deadline) {
          throw new PhraseWorkflowError("Timed out waiting for Phrase job imports", record.key);
        }
        await this.sleep(this.pollIntervalMs);
      }
      record.phase = "ready";
      record.failureReason = undefined;
      return { record, revision: await this.dependencies.state.updateBatch(record, revision) };
    } catch (error) {
      // Rewriting with the same stale revision would only fail again and mask the conflict.
      if (error instanceof PhraseBatchStateConflictError) throw error;
      record.phase = retryableImportFailure(error) ? "importing" : "failed";
      record.failureReason = safeFailureReason(error);
      await this.dependencies.state.updateBatch(record, revision);
      throw error;
    }
  }
}
