import { createHash } from "node:crypto";
import { checkCatalogs } from "./catalog-check.js";
import { describeArgumentMismatch, lintTargetCatalog } from "./icu-lint.js";
import { parseCatalogDocument, serializeCatalogDocument } from "./catalog-document.js";
import type { Catalog, CatalogAdapter, CatalogAdapterRegistry } from "./index.js";
import {
  PhraseApiError,
  PhraseAsyncRequestError,
  PhraseAuthError,
  PhraseTransportError,
} from "./phrase-client.js";
import type {
  CreatePhraseJobInput,
  ListPhraseJobsOptions,
  PhraseJobCreation,
  PhraseJobListPart,
  PhraseJobPart,
} from "./phrase-client.js";
import { targetAdapterId, validatePhraseWorkflowConfig } from "./phrase-config.js";
import {
  extractFeoCatalog,
  formatFeoCatalog,
  inlineFeoLocale,
  type FeoCatalog,
} from "./feo-template.js";

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
  frontendTemplate?: { path: string; generateSourceCatalog?: boolean };
  targetLocales: PhraseTargetLocale[];
  completionPolicy: {
    default: LocaleCompletionPolicy;
    byLocale?: Record<string, LocaleCompletionPolicy>;
  };
}

/**
 * Batch lifecycle. `failed` and `superseded` are terminal; `completed` records have no open
 * locale PRs. A legacy completed record with an open PR is reopened during reconciliation.
 * Empty `creating` and `unknown` records can be repaired in a trusted Phrase project and
 * filename scope; unknown records with saved job parts need manual recovery.
 */
export type PhraseBatchPhase =
  "creating" | "unknown" | "importing" | "ready" | "completed" | "failed" | "superseded";
/** `validation-failed` is retained for state written before draft-PR delivery. */
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
  /** Set only when an old empty submission was confirmed to have no Phrase jobs. */
  voidedEmptySubmission?: true;
  retryParentBatchKey?: string;
  retryParentDelegated?: boolean;
  locales: Record<string, PhraseLocaleRecord>;
}

export interface PhraseLocaleRecord {
  phase: PhraseLocalePhase;
  /** Latest export findings; PR creation does not imply a valid translation. */
  validationErrors?: string[];
  validationWarnings?: string[];
  pullRequestUrl?: string;
  failureReason?: string;
  /** Last locale branch commit recorded after its ref update succeeded. */
  toolingCommitSha?: string;
  /** Recent commits created by this tooling for the locale branch, oldest first (at most 20). */
  toolingCommitShas?: string[];
  /** Accepted when reading state written by the previous implementation. */
  pendingToolingCommitSha?: string;
  /** Preserved when a successful locale PR is carried into a retry batch. */
  pullRequestBranch?: string;
  pullRequestBatchKey?: string;
  /** A merged or closed PR was observed; a closed PR can reopen until the batch completes. */
  pullRequestFinalized?: boolean;
  /** A merged PR is permanently final and is not looked up again. */
  pullRequestMerged?: boolean;
  /** Last generated description; missing digest refreshes pre-upgrade PR safety notes once. */
  pullRequestBodyDigest?: string;
  /** Retry the PR title and description update if it failed after a commit. */
  pullRequestBodyPending?: boolean;
  /** A retry batch owns re-exporting this carried PR. */
  pullRequestReexportDelegated?: boolean;
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
  /** Require draft on adoption for invalid content. New PRs are always created as drafts. */
  draft?: boolean;
  repository: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  expectedToolingCommitShas?: string[];
  expectedToolingCommitSha?: string;
  expectedPendingToolingCommitSha?: string;
  recordToolingCommitSha: (toolingSha: string, previousHeadSha: string | null) => Promise<void>;
  recheckOwnedCommitEligibility?: (previousHeadSha: string | null) => Promise<void>;
  title: string;
  body: string;
  path: string;
  content: Uint8Array;
  additionalFiles?: { path: string; content: Uint8Array }[];
}

export type PhrasePullRequestState =
  { state: "open"; headSha: string } | { state: "merged" | "closed" };

export interface PhraseLocalePullRequestCreated {
  pullRequestUrl: string;
  toolingCommitSha?: string;
  pullRequestFinalized?: boolean;
  pullRequestMerged?: boolean;
  bodyError?: unknown;
}

export interface PhraseLocalePullRequestUpdate {
  /** Convert to draft before writing invalid content; never auto-mark ready. */
  draft?: boolean;
  repository: string;
  baseRef: string;
  branch: string;
  pullRequestUrl: string;
  headSha: string;
  expectedToolingCommitShas?: string[];
  expectedToolingCommitSha?: string;
  expectedPendingToolingCommitSha?: string;
  recordToolingCommitSha: (toolingSha: string, previousHeadSha: string | null) => Promise<void>;
  recheckOwnedCommitEligibility?: (previousHeadSha: string | null) => Promise<void>;
  title: string;
  path: string;
  content: Uint8Array;
  body: string;
  additionalFiles?: { path: string; content: Uint8Array }[];
}

export interface PhraseLocalePullRequestUpdateResult {
  changed: boolean;
  toolingCommitSha: string;
  bodyUpdated: boolean;
  pullRequestFinalized?: boolean;
  pullRequestMerged?: boolean;
  bodyError?: unknown;
}

export interface PhraseWorkflowRepository {
  resolveCommit(ref: string): Promise<string>;
  readFile(path: string, ref: string): Promise<Uint8Array | null>;
  getPullRequestState(pullRequestUrl: string): Promise<PhrasePullRequestState>;
  createOrUpdatePullRequest(input: PhraseLocalePullRequest): Promise<string>;
  createOrUpdatePullRequestWithCommit(
    input: PhraseLocalePullRequest,
  ): Promise<PhraseLocalePullRequestCreated>;
  updateOpenPullRequest(
    input: PhraseLocalePullRequestUpdate,
  ): Promise<PhraseLocalePullRequestUpdateResult>;
  updatePullRequestBody(pullRequestUrl: string, body: string, title?: string): Promise<boolean>;
}

export interface PhraseWorkflowDependencies {
  phrase: {
    createJob(input: CreatePhraseJobInput): Promise<PhraseJobCreation>;
    waitForAsyncRequest(
      asyncRequestId: string,
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ): Promise<void>;
    getJob(projectUid: string, jobUid: string): Promise<PhraseJobPart>;
    listJobs(projectUid: string, options: ListPhraseJobsOptions): Promise<PhraseJobListPart[]>;
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
  expectedProjectUid?: string;
  expectedSourceFilename?: string;
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

export interface PhraseReconcileOptions {
  expectedProjectUid?: string;
  expectedSourceFilename?: string;
  repairScope?: PhraseRepairScope;
}

export interface PhraseRepairScope {
  projectUid: string;
  sourceFilename: string;
}

type PhrasePinOptions = Pick<
  PhraseReconcileOptions,
  "expectedProjectUid" | "expectedSourceFilename"
>;

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

class PhraseJobVisibilityError extends PhraseWorkflowError {
  constructor(
    batchKey?: string,
    message = "Phrase has not yet exposed the new jobs; the next run continues this batch",
  ) {
    super(message, batchKey);
    this.name = "PhraseJobVisibilityError";
  }
}

class PhraseAmbiguousRecoveryError extends PhraseWorkflowError {
  constructor(message: string, batchKey?: string) {
    super(message, batchKey);
    this.name = "PhraseAmbiguousRecoveryError";
  }
}

class PhraseStuckBatchVoidedError extends Error {
  constructor(readonly record: PhraseBatchRecord) {
    super("Phrase batch was voided because no Phrase jobs were created");
    this.name = "PhraseStuckBatchVoidedError";
  }
}

class PhrasePinMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhrasePinMismatchError";
  }
}

/** Compatibility error for integrations predating export findings and draft PRs. */
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
const PHRASE_JOB_VISIBILITY_GRACE_MS = 15 * 60 * 1000;
const PHRASE_JOB_CREATION_CLOCK_SKEW_MS = 2 * 60 * 1000;
const FRESH_JOB_VISIBILITY_RETRY_ATTEMPTS = 5;
const FRESH_JOB_VISIBILITY_RETRY_WINDOW_MS = 60 * 1000;
const FRESH_JOB_VISIBILITY_RETRY_INTERVAL_MS = 15 * 1000;
const PHRASE_JOB_FIRST_WORKFLOW_LEVEL = 1;
const PHRASE_JOB_MAX_WORKFLOW_LEVEL = 15;
const PHRASE_JOB_VISIBILITY_GRACE_LABEL = "15 minutes";
const NO_PHRASE_JOB_CREATED_VOID_REASON = `No Phrase job was created for this batch; voided after ${PHRASE_JOB_VISIBILITY_GRACE_LABEL}`;
const DELIVERY_FINAL_LOCALE_PHASES: ReadonlySet<PhraseLocalePhase> = new Set([
  "pr-created",
  "failed",
]);
const FAILED_JOB_STATUSES = new Set(["CANCELLED", "CANCELED", "DECLINED", "REJECTED"]);

type LocaleReadiness =
  | { phase: "ready"; finalJob: PhraseJobPart }
  | { phase: "pending" }
  | { phase: "failed"; reason: string };

interface ImportJobPartObservation {
  requestedJob: PhraseJobPart;
  job?: PhraseJobPart;
  error?: unknown;
}

type ImportLocaleClassification =
  | { phase: "failed"; reason: string }
  | { phase: "retrying"; error: unknown }
  | { phase: "pending"; jobs: PhraseJobPart[] }
  | { phase: "complete" };

interface PhraseReconcileContext {
  pins: PhrasePinOptions;
  repairScope?: PhraseRepairScope;
  verifiedJobs: Map<string, PhraseJobPart[]>;
  jobVerificationFailures: Map<string, Map<string, unknown>>;
  verifiedJobSnapshots: Map<string, { projectUid: string; jobUids: string[] }>;
  pullRequestOwners: Map<string, string>;
  pullRequestStateCache: Map<string, Promise<PhrasePullRequestState>>;
  exportedPullRequestUrls: Set<string>;
  reportedPullRequestStateErrors: Set<string>;
  storedBatches: Map<string, StoredPhraseBatch>;
  unreadableBatchKeys: Set<string>;
}

interface FinishImportOptions {
  pins?: PhrasePinOptions;
  verifiedJobs?: PhraseJobPart[];
  jobVerificationFailures?: Map<string, unknown>;
  asyncRequestIsFresh?: boolean;
  retryableImportFailures?: Map<string, unknown>;
}

interface PinnedJobVerificationOptions {
  retryFresh404?: boolean;
  visibilityGraceCreatedAt?: string;
  batchKey?: string;
}

interface SourceCatalogReadResult {
  bytes: Uint8Array | null;
  formatError?: string;
}

type StuckBatchRepairResult =
  | { kind: "bound"; stored: StoredPhraseBatch }
  | { kind: "voided"; stored: StoredPhraseBatch }
  | { kind: "retrying"; reason: string };

const MAX_PULL_REQUEST_FINDINGS = 50;
// Both sections plus metadata must fit GitHub's PR body limit, including Unicode text.
const MAX_PULL_REQUEST_SECTION_BYTES = 24_000;

function translationFindingsSection(heading: string, findings: string[]): string {
  if (!findings.length) return "";
  const shown = findings.slice(0, MAX_PULL_REQUEST_FINDINGS).map((finding) => `- ${finding}`);
  const hidden = findings.length - shown.length;
  if (hidden > 0) shown.push(`- ...and ${hidden} more`);
  const details = shown.join("\n");
  const bytes = new TextEncoder().encode(details);
  // Streaming decode drops an incomplete trailing UTF-8 code point instead of emitting U+FFFD.
  const bounded =
    bytes.length > MAX_PULL_REQUEST_SECTION_BYTES
      ? `${new TextDecoder().decode(bytes.slice(0, MAX_PULL_REQUEST_SECTION_BYTES), { stream: true })}\n- ...additional detail omitted to fit PR description`
      : details;
  return `\n${heading}:\n${bounded}\n`;
}

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

const TOOLING_COMMIT_SHA_HISTORY_LIMIT = 20;
const TOOLING_COMMIT_STATE_WRITE_ATTEMPTS = 3;

function mergeToolingCommitShas(...lists: (readonly string[] | undefined)[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const sha of list) {
      if (typeof sha !== "string" || !sha.trim() || seen.has(sha)) continue;
      seen.add(sha);
      merged.push(sha);
    }
  }
  return merged;
}

function trimToolingCommitShas(shas: readonly string[], confirmedHeadSha?: string): string[] {
  const ordered = mergeToolingCommitShas(shas);
  if (!confirmedHeadSha) return ordered.slice(-TOOLING_COMMIT_SHA_HISTORY_LIMIT);

  // Keep the confirmed head and every newer candidate; only older history can be trimmed.
  let confirmedIndex = ordered.indexOf(confirmedHeadSha);
  if (confirmedIndex < 0) {
    ordered.unshift(confirmedHeadSha);
    confirmedIndex = 0;
  }
  const confirmedAndNewer = ordered.slice(confirmedIndex);
  const olderHistoryCapacity = Math.max(
    0,
    TOOLING_COMMIT_SHA_HISTORY_LIMIT - confirmedAndNewer.length,
  );
  const olderHistory = ordered.slice(
    Math.max(0, confirmedIndex - olderHistoryCapacity),
    confirmedIndex,
  );
  return [...olderHistory, ...confirmedAndNewer];
}

function appendToolingCommitSha(
  previousLists: (readonly string[] | undefined)[],
  previousHeadSha: string | null,
  toolingSha: string,
  confirmedHeadSha?: string,
): string[] {
  const ordered = mergeToolingCommitShas(...previousLists);
  if (confirmedHeadSha && !ordered.includes(confirmedHeadSha)) ordered.unshift(confirmedHeadSha);
  if (previousHeadSha && !ordered.includes(previousHeadSha)) ordered.push(previousHeadSha);
  // The branch may already include a candidate whose confirmation was not saved.
  if (
    confirmedHeadSha &&
    previousHeadSha &&
    previousHeadSha !== confirmedHeadSha &&
    ordered.indexOf(previousHeadSha) < ordered.indexOf(confirmedHeadSha)
  ) {
    ordered.splice(ordered.indexOf(previousHeadSha), 1);
    ordered.splice(ordered.indexOf(confirmedHeadSha) + 1, 0, previousHeadSha);
  }
  if (toolingSha !== confirmedHeadSha) {
    const existingToolingIndex = ordered.indexOf(toolingSha);
    if (existingToolingIndex >= 0) ordered.splice(existingToolingIndex, 1);
    ordered.push(toolingSha);
  }
  return trimToolingCommitShas(ordered, confirmedHeadSha ?? previousHeadSha ?? undefined);
}

const OWNED_COMMIT_DELIVERY_LOCALE_PHASES: ReadonlySet<PhraseLocalePhase> = new Set([
  "exporting",
  "pr-created",
]);

function ownedCommitEligibilityFailureReason(
  record: PhraseBatchRecord,
  phraseLocale: string,
  loadedLocale: PhraseLocaleRecord,
  currentLocale: PhraseLocaleRecord | undefined,
  previousHeadSha: string | null,
): string | undefined {
  if (record.phase !== "ready" && record.phase !== "importing") {
    return `batch is no longer delivering (phase ${record.phase})`;
  }
  if (!currentLocale) return `locale ${phraseLocale} state is missing`;
  if (currentLocale.pullRequestReexportDelegated) {
    return `locale ${phraseLocale} was handed off to a retry batch`;
  }
  if (
    currentLocale.phase === "failed" &&
    currentLocale.failureReason?.startsWith("Retried in Phrase batch ")
  ) {
    return `locale ${phraseLocale} was handed off to a retry batch (${currentLocale.failureReason})`;
  }
  if (!OWNED_COMMIT_DELIVERY_LOCALE_PHASES.has(currentLocale.phase)) {
    return `locale ${phraseLocale} is no longer deliverable (phase ${currentLocale.phase})`;
  }
  if (currentLocale.pullRequestFinalized || currentLocale.pullRequestMerged) {
    return `locale ${phraseLocale} pull request is recorded as final or merged`;
  }
  if (loadedLocale.pullRequestUrl && currentLocale.pullRequestUrl !== loadedLocale.pullRequestUrl) {
    return `locale ${phraseLocale} pull request ownership changed while this writer was active`;
  }
  if (
    loadedLocale.pullRequestBranch &&
    currentLocale.pullRequestBranch !== loadedLocale.pullRequestBranch
  ) {
    return `locale ${phraseLocale} branch ownership changed while this writer was active`;
  }
  if (
    loadedLocale.pullRequestBatchKey &&
    currentLocale.pullRequestBatchKey !== loadedLocale.pullRequestBatchKey
  ) {
    return `locale ${phraseLocale} batch ownership changed while this writer was active`;
  }
  const recordedOwnedShas = mergeToolingCommitShas(
    currentLocale.toolingCommitShas,
    currentLocale.toolingCommitSha ? [currentLocale.toolingCommitSha] : undefined,
    currentLocale.pendingToolingCommitSha ? [currentLocale.pendingToolingCommitSha] : undefined,
  );
  if (
    previousHeadSha &&
    recordedOwnedShas.length > 0 &&
    !recordedOwnedShas.includes(previousHeadSha)
  ) {
    return `verified branch head ${previousHeadSha} is no longer in locale ${phraseLocale}'s owned commit set`;
  }
  return undefined;
}

function feoTemplateMatchesSourceCatalog(template: string, sourceCatalog: Catalog): boolean {
  const templateMessages = extractFeoCatalog(template);
  const sourcePatterns = Object.fromEntries(
    Object.entries(sourceCatalog.messages).map(([id, message]) => [id, message.pattern]),
  );
  const templatePatterns = Object.fromEntries(
    Object.entries(templateMessages).map(([id, message]) => [id, message.defaultMessage]),
  );
  return stableJson(sourcePatterns) === stableJson(templatePatterns);
}

function sourceInputPath(config: PhraseWorkflowConfig): string {
  return config.frontendTemplate?.generateSourceCatalog
    ? config.frontendTemplate.path
    : config.sourceCatalog.path;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFailureReason(error: unknown): string {
  if (error instanceof PhrasePinMismatchError) return error.message;
  if (error instanceof PhraseJobVisibilityError || error instanceof PhraseAmbiguousRecoveryError) {
    return error.message;
  }
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
  if (error instanceof PhraseJobVisibilityError) return true;
  if (error instanceof PhraseAsyncRequestError) return false;
  if (error instanceof PhraseTransportError) return true;
  if (error instanceof PhraseApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof PhraseRepositoryError) return !error.permanent;
  if (error instanceof PhraseWorkflowError)
    return /timed out waiting for Phrase job imports/i.test(error.message);
  return error instanceof Error && /timed out waiting for Phrase request/i.test(error.message);
}

function firstPhraseJobVisibilityFailure(
  failures: ReadonlyMap<string, unknown>,
): PhraseJobVisibilityError | undefined {
  return [...failures.values()].find(
    (error): error is PhraseJobVisibilityError => error instanceof PhraseJobVisibilityError,
  );
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
    input.config.targetLocales.map((target) => {
      const { phraseLocale } = target;
      const previousLocale = previousRecord?.locales[phraseLocale];
      const previousBranch =
        previousLocale?.phase === "pr-created"
          ? (previousLocale.pullRequestBranch ??
            (previousRecord
              ? localePullRequestBranch(previousRecord.key, target.repositoryLocale)
              : undefined))
          : undefined;
      if (previousLocale?.phase !== "pr-created" || isClosedInvalidPullRequest(previousLocale)) {
        return [phraseLocale, { phase: "pending" as const }];
      }
      const carriedLocale: PhraseLocaleRecord = {
        ...previousLocale,
        ...(previousBranch ? { pullRequestBranch: previousBranch } : {}),
        ...(previousLocale.pullRequestBatchKey || !previousRecord
          ? {}
          : { pullRequestBatchKey: previousRecord.key }),
      };
      const toolingCommitShas = trimToolingCommitShas(
        mergeToolingCommitShas(
          previousLocale.toolingCommitShas,
          previousLocale.pendingToolingCommitSha
            ? [previousLocale.pendingToolingCommitSha]
            : undefined,
        ),
        previousLocale.toolingCommitSha,
      );
      if (toolingCommitShas.length) {
        carriedLocale.toolingCommitShas = toolingCommitShas;
      } else {
        delete carriedLocale.toolingCommitShas;
      }
      delete carriedLocale.pullRequestReexportDelegated;
      return [phraseLocale, carriedLocale];
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
    jobs:
      previousRecord?.jobs.filter((job) => {
        const locale = previousRecord.locales[job.targetLang];
        return locale?.phase === "pr-created" && !isClosedInvalidPullRequest(locale);
      }) ?? [],
    warningCount: 0,
    ...(previousRecord ? { retryParentBatchKey: previousRecord.key } : {}),
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
    (target) =>
      !DELIVERY_FINAL_LOCALE_PHASES.has(record.locales[target.phraseLocale]?.phase ?? "pending"),
  );
}

function pendingTargetLangs(record: PhraseBatchRecord): string[] {
  return record.config.targetLocales
    .filter(({ phraseLocale }) => record.locales[phraseLocale]?.phase === "pending")
    .map(({ phraseLocale }) => phraseLocale);
}

function matchesPhraseRepairScope(
  record: PhraseBatchRecord,
  scope: PhraseRepairScope | undefined,
): scope is PhraseRepairScope {
  return (
    scope !== undefined &&
    record.config.projectUid === scope.projectUid &&
    record.config.sourceCatalog.filename === scope.sourceFilename
  );
}

function isWithinPhraseJobVisibilityGrace(createdAt: string, now: number): boolean {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && now - createdAtMs < PHRASE_JOB_VISIBILITY_GRACE_MS;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeRecoveryCandidates(candidates: readonly PhraseJobListPart[]): string {
  const jobsByCreatedAt = new Map<number | undefined, PhraseJobListPart[]>();
  for (const job of candidates) {
    const createdAtMs =
      typeof job.dateCreated === "string" ? Date.parse(job.dateCreated) : Number.NaN;
    const key = Number.isFinite(createdAtMs) ? createdAtMs : undefined;
    const group = jobsByCreatedAt.get(key) ?? [];
    group.push(job);
    jobsByCreatedAt.set(key, group);
  }

  return [...jobsByCreatedAt.entries()]
    .sort(([left], [right]) => {
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      return left - right;
    })
    .map(([createdAtMs, jobs]) => {
      const groupName =
        createdAtMs === undefined
          ? "unparsable creation time"
          : `creation time ${new Date(createdAtMs).toISOString()}`;
      const entries = jobs
        .sort((left, right) =>
          (left.uid ?? left.listingEntry).localeCompare(right.uid ?? right.listingEntry),
        )
        .map(
          (job) =>
            `uid ${job.uid?.trim() ? job.uid : "<missing>"}, targetLang ${job.targetLang?.trim() ? job.targetLang : "<missing>"}, dateCreated ${job.dateCreated?.trim() ? job.dateCreated : "<missing>"} (${job.listingEntry})`,
        );
      return `${groupName}: ${entries.join("; ")}`;
    })
    .join("; ");
}

function isNoPhraseJobCreatedVoid(record: PhraseBatchRecord): boolean {
  return (
    record.phase === "failed" && record.jobs.length === 0 && record.voidedEmptySubmission === true
  );
}

function localePullRequestBranch(batchKey: string, repositoryLocale: string): string {
  const localeSlug = repositoryLocale.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `i18n/phrase-${batchKey.slice(0, 16)}-${localeSlug}`;
}

function isClosedInvalidPullRequest(locale: PhraseLocaleRecord): boolean {
  return (
    locale.phase === "pr-created" &&
    locale.pullRequestFinalized === true &&
    !locale.pullRequestMerged &&
    Boolean(locale.validationErrors?.length)
  );
}

function hasRetryableFailures(record: PhraseBatchRecord): boolean {
  return (
    record.phase === "failed" ||
    ((record.phase === "completed" || record.phase === "ready") &&
      Object.values(record.locales).some(
        (locale) =>
          locale.phase === "failed" ||
          locale.phase === "validation-failed" ||
          isClosedInvalidPullRequest(locale),
      ))
  );
}

function needsReconciliation(record: PhraseBatchRecord): boolean {
  return (
    RECONCILABLE_PHASES.has(record.phase) ||
    ((record.phase === "creating" || record.phase === "unknown") && record.jobs.length === 0) ||
    (record.phase === "completed" &&
      Object.values(record.locales).some(
        (locale) =>
          locale.phase === "validation-failed" ||
          (locale.phase === "pr-created" && !locale.pullRequestFinalized),
      ))
  );
}

// Legacy records have no PR yet; draft-era findings live on pr-created locales.
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

function classifyImportJobParts(
  observations: readonly ImportJobPartObservation[],
): Map<string, ImportLocaleClassification> {
  const partsByLocale = new Map<
    string,
    { permanentFailure?: string; retryableError?: unknown; pendingJobs: PhraseJobPart[] }
  >();
  for (const observation of observations) {
    const phraseLocale = observation.requestedJob.targetLang;
    let parts = partsByLocale.get(phraseLocale);
    if (!parts) {
      parts = { pendingJobs: [] };
      partsByLocale.set(phraseLocale, parts);
    }
    if (observation.error !== undefined) {
      if (retryableImportFailure(observation.error)) {
        parts.retryableError ??= observation.error;
      } else {
        parts.permanentFailure ??= safeFailureReason(observation.error);
      }
      continue;
    }
    const job = observation.job;
    if (!job) {
      parts.pendingJobs.push(observation.requestedJob);
      continue;
    }
    if (job.importStatus?.status === "ERROR") {
      parts.permanentFailure ??= `Phrase failed to import job ${job.uid}: ${job.importStatus.errorMessage ?? "unknown error"}`;
    } else if (job.importStatus?.status !== "OK" && job.imported !== true) {
      parts.pendingJobs.push(observation.requestedJob);
    }
  }

  const classifications = new Map<string, ImportLocaleClassification>();
  for (const [phraseLocale, parts] of partsByLocale) {
    if (parts.permanentFailure) {
      classifications.set(phraseLocale, { phase: "failed", reason: parts.permanentFailure });
    } else if (parts.retryableError !== undefined) {
      classifications.set(phraseLocale, { phase: "retrying", error: parts.retryableError });
    } else if (parts.pendingJobs.length) {
      classifications.set(phraseLocale, { phase: "pending", jobs: parts.pendingJobs });
    } else {
      classifications.set(phraseLocale, { phase: "complete" });
    }
  }
  return classifications;
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

  private async readSourceCatalog(
    config: PhraseWorkflowConfig,
    ref: string,
  ): Promise<SourceCatalogReadResult> {
    if (config.frontendTemplate?.generateSourceCatalog) {
      const template = await this.dependencies.repository.readFile(
        config.frontendTemplate.path,
        ref,
      );
      if (!template) return { bytes: null };
      try {
        return {
          bytes: new TextEncoder().encode(formatFeoCatalog(new TextDecoder().decode(template))),
        };
      } catch (error) {
        return {
          bytes: null,
          formatError: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { bytes: await this.dependencies.repository.readFile(config.sourceCatalog.path, ref) };
  }

  async submit(input: PhraseSubmitInput): Promise<PhraseBatchRecord> {
    validatePhraseWorkflowConfig(input.config);
    const pins: PhrasePinOptions =
      input.expectedProjectUid !== undefined || input.expectedSourceFilename !== undefined
        ? {
            expectedProjectUid: input.expectedProjectUid ?? input.config.projectUid,
            expectedSourceFilename:
              input.expectedSourceFilename ?? input.config.sourceCatalog.filename,
          }
        : {};
    assertExpectedWorkflowConfig(input.config, pins);
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
    this.dependencies.catalogAdapters.get(targetAdapterId(input.config));

    const sourceDigest = digest(input.sourceBytes);
    const pinnedSource = await this.readSourceCatalog(input.config, input.sourceCommit);
    if (pinnedSource.formatError) {
      throw new PhraseWorkflowError(
        `Frontend template cannot be inlined: ${pinnedSource.formatError}`,
      );
    }
    const pinnedSourceBytes = pinnedSource.bytes;
    if (!pinnedSourceBytes || digest(pinnedSourceBytes) !== sourceDigest) {
      throw new PhraseWorkflowError(
        "Source bytes do not match the source file at the requested commit",
      );
    }
    if (input.config.frontendTemplate && !input.config.frontendTemplate.generateSourceCatalog) {
      const path = input.config.frontendTemplate.path;
      const templateBytes = await this.dependencies.repository.readFile(path, input.sourceCommit);
      if (!templateBytes) throw new PhraseWorkflowError(`Missing Frontend template: ${path}`);
      try {
        extractFeoCatalog(new TextDecoder().decode(templateBytes));
      } catch (error) {
        throw new PhraseWorkflowError(
          `Frontend template cannot be inlined: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const identity = batchIdentity(input, sourceDigest);
    let previousFailedBatch: PhraseBatchRecord | undefined;
    for (let attempt = 0; attempt < MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
      const key = batchKey(identity, attempt);
      const existing = await this.dependencies.state.readBatch(key);
      try {
        if (!existing) {
          return await this.createSubmission(
            input,
            key,
            attempt,
            sourceDigest,
            previousFailedBatch,
            pins,
          );
        }
        if (isNoPhraseJobCreatedVoid(existing.record)) {
          previousFailedBatch = existing.record;
          continue;
        }
        if (input.retryFailed && hasRetryableFailures(existing.record)) {
          previousFailedBatch = existing.record;
          continue;
        }
        return await this.resumeSubmission(existing, input.config, pins);
      } catch (error) {
        if (error instanceof PhraseStuckBatchVoidedError) {
          previousFailedBatch = error.record;
          continue;
        }
        throw error;
      }
    }
    throw new PhraseWorkflowError(
      `Phrase submission failed ${MAX_SUBMISSION_ATTEMPTS} times for this source; fix the Phrase project before retrying`,
    );
  }

  async reconcile(options: PhraseReconcileOptions = {}): Promise<PhraseReconcileResult[]> {
    if (
      hasPhrasePins(options) &&
      (options.expectedProjectUid === undefined || options.expectedSourceFilename === undefined)
    ) {
      throw new PhrasePinMismatchError(
        "Pinned reconciliation requires both an expected Phrase project UID and source filename",
      );
    }
    const results: PhraseReconcileResult[] = [];
    const storedBatches: StoredPhraseBatch[] = [];
    const unreadableBatchKeys = new Set<string>();
    for (const key of await this.dependencies.state.listBatchKeys()) {
      try {
        const stored = await this.dependencies.state.readBatch(key);
        if (stored) storedBatches.push(stored);
      } catch (error) {
        unreadableBatchKeys.add(key);
        results.push({
          batchKey: key,
          phase: error instanceof PhrasePinMismatchError ? "failed" : "retrying",
          reason: safeFailureReason(error),
        });
      }
    }

    const context: PhraseReconcileContext = {
      pins: options,
      repairScope: options.repairScope,
      verifiedJobs: new Map(),
      jobVerificationFailures: new Map(),
      verifiedJobSnapshots: new Map(),
      pullRequestOwners: new Map(),
      pullRequestStateCache: new Map(),
      exportedPullRequestUrls: new Set(),
      reportedPullRequestStateErrors: new Set(),
      storedBatches: new Map(storedBatches.map((stored) => [stored.record.key, stored])),
      unreadableBatchKeys,
    };
    const rejectedBatchKeys = new Set<string>();
    for (let index = 0; index < storedBatches.length; index += 1) {
      let stored = storedBatches[index]!;
      let { record } = stored;
      if (!needsReconciliation(record)) continue;
      try {
        assertExpectedBatchConfig(record, context.pins);
        const needsStuckBatchRepair =
          (record.phase === "creating" || record.phase === "unknown") && !record.jobs.length;
        if (needsStuckBatchRepair) {
          const repairScope = context.repairScope;
          if (!matchesPhraseRepairScope(record, repairScope)) {
            rejectedBatchKeys.add(record.key);
            continue;
          }
          const otherRecords = [...context.storedBatches.values()]
            .filter((other) => other.record.key !== record.key)
            .map((other) => other.record);
          const repair = await this.repairStuckBatch(
            stored,
            context.pins,
            repairScope,
            otherRecords,
            context.unreadableBatchKeys,
          );
          if (repair.kind === "retrying") {
            rejectedBatchKeys.add(record.key);
            results.push({ batchKey: record.key, phase: "retrying", reason: repair.reason });
            continue;
          }
          stored = repair.stored;
          record = stored.record;
          storedBatches[index] = stored;
          context.storedBatches.set(record.key, stored);
          if (repair.kind === "voided") {
            rejectedBatchKeys.add(record.key);
            const openTargets = unresolvedTargets(record);
            if (openTargets.length) {
              for (const target of openTargets) {
                results.push({
                  batchKey: record.key,
                  phraseLocale: target.phraseLocale,
                  phase: "failed",
                  reason: record.failureReason,
                });
              }
            } else {
              results.push({
                batchKey: record.key,
                phase: "failed",
                reason: record.failureReason,
              });
            }
            continue;
          }
        }
        if (hasPhrasePins(context.pins) && record.jobs.length) {
          const failures = new Map<string, unknown>();
          const jobs = await this.verifyPinnedJobs(
            record.config.projectUid,
            record.jobs,
            context.pins.expectedSourceFilename,
            failures,
            {
              visibilityGraceCreatedAt: record.createdAt,
              batchKey: record.key,
            },
          );
          context.verifiedJobs.set(record.key, jobs);
          context.jobVerificationFailures.set(record.key, failures);
          context.verifiedJobSnapshots.set(record.key, {
            projectUid: record.config.projectUid,
            jobUids: record.jobs.map((job) => job.uid),
          });
        }
      } catch (error) {
        rejectedBatchKeys.add(record.key);
        results.push({
          batchKey: record.key,
          phase:
            error instanceof PhrasePinMismatchError || error instanceof PhraseAmbiguousRecoveryError
              ? "failed"
              : "retrying",
          reason: safeFailureReason(error),
        });
      }
    }

    const latestPullRequestRecords = new Map<string, PhraseBatchRecord>();
    const recordsByKey = new Map(storedBatches.map(({ record }) => [record.key, record]));
    for (const { record } of storedBatches) {
      if (!needsReconciliation(record) || rejectedBatchKeys.has(record.key)) continue;
      for (const [phraseLocale, locale] of Object.entries(record.locales)) {
        if (
          locale.phase !== "pr-created" ||
          locale.pullRequestReexportDelegated ||
          !locale.pullRequestUrl
        ) {
          continue;
        }
        const retryParent = record.retryParentBatchKey
          ? recordsByKey.get(record.retryParentBatchKey)
          : undefined;
        const retryParentLocale = retryParent?.locales[phraseLocale];
        // The retry child owns this PR only after its carried commit state is handed off.
        const retryParentStillOwnsPullRequest =
          record.phase === "importing" &&
          !record.retryParentDelegated &&
          retryParent !== undefined &&
          !rejectedBatchKeys.has(retryParent.key) &&
          needsReconciliation(retryParent) &&
          retryParentLocale?.phase === "pr-created" &&
          retryParentLocale.pullRequestUrl === locale.pullRequestUrl &&
          !retryParentLocale.pullRequestReexportDelegated;
        if (retryParentStillOwnsPullRequest) continue;

        const currentOwner = latestPullRequestRecords.get(locale.pullRequestUrl);
        if (
          !currentOwner ||
          (record.attempt ?? 0) > (currentOwner.attempt ?? 0) ||
          ((record.attempt ?? 0) === (currentOwner.attempt ?? 0) &&
            (record.createdAt > currentOwner.createdAt ||
              (record.createdAt === currentOwner.createdAt && record.key > currentOwner.key)))
        ) {
          latestPullRequestRecords.set(locale.pullRequestUrl, record);
        }
      }
    }
    context.pullRequestOwners = new Map(
      [...latestPullRequestRecords].map(([url, record]) => [url, record.key]),
    );

    for (const stored of storedBatches) {
      if (!needsReconciliation(stored.record) || rejectedBatchKeys.has(stored.record.key)) continue;
      try {
        await this.reconcileBatch(stored, results, context);
      } catch (error) {
        results.push({
          batchKey: stored.record.key,
          phase: error instanceof PhrasePinMismatchError ? "failed" : "retrying",
          reason: safeFailureReason(error),
        });
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
    pins: PhrasePinOptions = {},
  ): Promise<PhraseBatchRecord> {
    if (previousRecord && hasPhrasePins(pins)) {
      assertExpectedBatchConfig(previousRecord, pins);
    }
    const record = makeBatchRecord(input, key, attempt, sourceDigest, this.now(), previousRecord);
    const targetLangs = pendingTargetLangs(record);
    if (!targetLangs.length) {
      throw new PhraseWorkflowError("Phrase retry has no locales left to submit", key);
    }
    let revision: string;
    try {
      revision = await this.dependencies.state.createBatch(record);
    } catch (error) {
      const raced = await this.dependencies.state.readBatch(key);
      if (raced) return this.resumeSubmission(raced, input.config, pins);
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

    const carriedJobs = [...record.jobs];
    const combinedJobs = [...carriedJobs, ...created.jobs];
    record.importAsyncRequestId = created.asyncRequest.id;
    record.jobs = combinedJobs;
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

    let jobs = combinedJobs;
    if (hasPhrasePins(pins)) {
      const [verifiedCarriedJobs, verifiedCreatedJobs] = await Promise.all([
        carriedJobs.length
          ? this.verifyPinnedJobs(input.config.projectUid, carriedJobs, pins.expectedSourceFilename)
          : [],
        created.jobs.length
          ? this.verifyPinnedJobs(
              input.config.projectUid,
              created.jobs,
              pins.expectedSourceFilename,
              undefined,
              { retryFresh404: true, batchKey: key },
            )
          : [],
      ]);
      jobs = [...verifiedCarriedJobs, ...verifiedCreatedJobs];
      record.jobs = jobs;
    }

    const retryableImportFailures = new Map<string, unknown>();
    const finished = await this.finishImport(record, revision, {
      pins,
      verifiedJobs: jobs,
      asyncRequestIsFresh: true,
      retryableImportFailures,
    });
    const visibilityError = firstPhraseJobVisibilityFailure(retryableImportFailures);
    if (visibilityError) throw visibilityError;
    await this.delegateRetryParent(finished.record, finished.revision, pins);
    return finished.record;
  }

  private async readOtherBatchRecords(batchKey: string): Promise<{
    records: PhraseBatchRecord[];
    unreadableBatchKeys: Set<string>;
  }> {
    const records: PhraseBatchRecord[] = [];
    const unreadableBatchKeys = new Set<string>();
    for (const key of await this.dependencies.state.listBatchKeys()) {
      if (key === batchKey) continue;
      try {
        const stored = await this.dependencies.state.readBatch(key);
        if (stored) records.push(stored.record);
      } catch {
        unreadableBatchKeys.add(key);
      }
    }
    return { records, unreadableBatchKeys };
  }

  private async repairStuckBatch(
    stored: StoredPhraseBatch,
    pins: PhrasePinOptions,
    repairScope: PhraseRepairScope,
    otherRecords: readonly PhraseBatchRecord[],
    unreadableBatchKeys: ReadonlySet<string>,
  ): Promise<StuckBatchRepairResult> {
    const { record } = stored;
    let revision = stored.revision;
    if ((record.phase !== "creating" && record.phase !== "unknown") || record.jobs.length !== 0) {
      throw new PhraseWorkflowError(
        "Only empty creating or unknown batches can be repaired",
        record.key,
      );
    }
    assertExpectedBatchConfig(record, pins);

    if (!matchesPhraseRepairScope(record, repairScope)) {
      throw new PhraseWorkflowError(
        "Refusing to repair a Phrase batch outside the trusted recovery scope",
        record.key,
      );
    }

    if ([...unreadableBatchKeys].some((key) => key !== record.key)) {
      return {
        kind: "retrying",
        reason:
          "Cannot safely repair this batch while another stored batch cannot be checked for claimed job UIDs",
      };
    }
    const createdAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      return {
        kind: "retrying",
        reason: "Cannot safely repair this batch because its creation time is invalid",
      };
    }

    const filename = repairScope.sourceFilename;
    const listedJobs: PhraseJobListPart[] = [];
    let lastWorkflowLevel: number | undefined;
    for (
      let workflowLevel = PHRASE_JOB_FIRST_WORKFLOW_LEVEL;
      workflowLevel <= PHRASE_JOB_MAX_WORKFLOW_LEVEL;
      workflowLevel += 1
    ) {
      const levelJobs = await this.dependencies.phrase.listJobs(repairScope.projectUid, {
        filename,
        workflowLevel,
      });
      listedJobs.push(...levelJobs);
      const reportedLastLevels = levelJobs
        .map(({ lastWorkflowLevel }) => lastWorkflowLevel)
        .filter(
          (level): level is number =>
            typeof level === "number" &&
            Number.isInteger(level) &&
            level >= PHRASE_JOB_FIRST_WORKFLOW_LEVEL &&
            level <= PHRASE_JOB_MAX_WORKFLOW_LEVEL,
        );
      if (reportedLastLevels.length) {
        lastWorkflowLevel = Math.max(lastWorkflowLevel ?? 0, ...reportedLastLevels);
      }
      if (lastWorkflowLevel !== undefined && workflowLevel >= lastWorkflowLevel) break;
      if (levelJobs.length === 0) break;
    }
    const claimedJobUids = new Set(
      otherRecords.flatMap((other) => other.jobs.map((job) => job.uid)),
    );
    const earliestCandidateTime = createdAtMs - PHRASE_JOB_CREATION_CLOCK_SKEW_MS;
    const candidates = listedJobs.flatMap((job) => {
      if (job.filename !== undefined && job.filename !== filename) return [];
      if (isNonEmptyString(job.uid) && claimedJobUids.has(job.uid)) return [];
      const jobCreatedAtMs =
        typeof job.dateCreated === "string" ? Date.parse(job.dateCreated) : Number.NaN;
      if (Number.isFinite(jobCreatedAtMs) && jobCreatedAtMs < earliestCandidateTime) return [];
      return [
        { job, jobCreatedAtMs: Number.isFinite(jobCreatedAtMs) ? jobCreatedAtMs : undefined },
      ];
    });

    const candidatesMissingMetadata = candidates.filter(
      ({ job, jobCreatedAtMs }) =>
        !isNonEmptyString(job.uid) ||
        !isNonEmptyString(job.targetLang) ||
        jobCreatedAtMs === undefined ||
        !Number.isInteger(job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL) ||
        (job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL) < PHRASE_JOB_FIRST_WORKFLOW_LEVEL ||
        (job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL) > PHRASE_JOB_MAX_WORKFLOW_LEVEL,
    );
    if (candidatesMissingMetadata.length) {
      throw new PhraseAmbiguousRecoveryError(
        `Phrase returned candidate jobs with missing or invalid recovery metadata. Candidate jobs grouped by creation time: ${describeRecoveryCandidates(candidates.map(({ job }) => job))}. Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.`,
        record.key,
      );
    }

    const jobsByCreatedAt = new Map<number, PhraseJobPart[]>();
    for (const { job, jobCreatedAtMs } of candidates) {
      const phraseJob: PhraseJobPart = {
        uid: job.uid!,
        targetLang: job.targetLang!,
        workflowLevel: job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL,
        dateCreated: job.dateCreated!,
        ...(job.filename === undefined ? {} : { filename: job.filename }),
        ...(job.sourceFileUid === undefined ? {} : { sourceFileUid: job.sourceFileUid }),
        ...(job.lastWorkflowLevel === undefined
          ? {}
          : { lastWorkflowLevel: job.lastWorkflowLevel }),
        ...(job.imported === undefined ? {} : { imported: job.imported }),
        ...(job.status === undefined ? {} : { status: job.status }),
        ...(job.importStatus === undefined ? {} : { importStatus: job.importStatus }),
      };
      const group = jobsByCreatedAt.get(jobCreatedAtMs!) ?? [];
      group.push(phraseJob);
      jobsByCreatedAt.set(jobCreatedAtMs!, group);
    }

    const expectedTargetLangs = pendingTargetLangs(record);
    const projectLastWorkflowLevel =
      lastWorkflowLevel ??
      Math.max(...listedJobs.map((job) => job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL));
    const matchingGroups = [...jobsByCreatedAt]
      .filter(([, jobs]) => {
        const jobsByWorkflowLevel = new Map<number, PhraseJobPart[]>();
        for (const job of jobs) {
          const levelJobs = jobsByWorkflowLevel.get(job.workflowLevel) ?? [];
          levelJobs.push(job);
          jobsByWorkflowLevel.set(job.workflowLevel, levelJobs);
        }
        for (
          let workflowLevel = PHRASE_JOB_FIRST_WORKFLOW_LEVEL;
          workflowLevel <= projectLastWorkflowLevel;
          workflowLevel += 1
        ) {
          const levelJobs = jobsByWorkflowLevel.get(workflowLevel);
          if (
            !levelJobs ||
            !sameStringSet(
              levelJobs.map((job) => job.targetLang),
              expectedTargetLangs,
            )
          ) {
            return false;
          }
        }
        return [...jobsByWorkflowLevel.keys()].every(
          (workflowLevel) => workflowLevel <= projectLastWorkflowLevel,
        );
      })
      .map(([createdAtMs, jobs]) => ({ createdAtMs, jobs }))
      .sort((left, right) => left.createdAtMs - right.createdAtMs);

    if (matchingGroups.length > 1 || (candidates.length > 0 && matchingGroups.length === 0)) {
      const reason =
        matchingGroups.length > 1
          ? "More than one Phrase creation-time group matches this batch"
          : "Phrase jobs exist for this batch, but no creation-time group matches its pending locales";
      throw new PhraseAmbiguousRecoveryError(
        `${reason}. Candidate jobs grouped by creation time: ${describeRecoveryCandidates(candidates.map(({ job }) => job))}. Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.`,
        record.key,
      );
    }
    if (matchingGroups.length === 1) {
      record.jobs = matchingGroups[0]!.jobs;
      record.phase = "importing";
      delete record.failureReason;
      delete record.importAsyncRequestId;
      delete record.voidedEmptySubmission;
      revision = await this.dependencies.state.updateBatch(record, revision);
      return { kind: "bound", stored: { record, revision } };
    }

    if (isWithinPhraseJobVisibilityGrace(record.createdAt, this.now())) {
      return {
        kind: "retrying",
        reason: "Phrase job may still be appearing in Phrase; the next run will check again",
      };
    }

    record.phase = "failed";
    record.failureReason = NO_PHRASE_JOB_CREATED_VOID_REASON;
    record.voidedEmptySubmission = true;
    revision = await this.dependencies.state.updateBatch(record, revision);
    return { kind: "voided", stored: { record, revision } };
  }

  private async resumeSubmission(
    stored: StoredPhraseBatch,
    config: PhraseWorkflowConfig,
    pins: PhrasePinOptions = {},
  ): Promise<PhraseBatchRecord> {
    let { record, revision } = stored;
    if (hasPhrasePins(pins)) assertExpectedBatchConfig(record, pins);
    if (record.phase === "creating" || record.phase === "unknown") {
      if (record.jobs.length) {
        throw new PhraseWorkflowError(
          "Unknown Phrase submission outcome; inspect Phrase and bind or void the batch before retrying",
          record.key,
        );
      }
      const repairPins = {
        ...pins,
        expectedProjectUid: pins.expectedProjectUid ?? config.projectUid,
        expectedSourceFilename: pins.expectedSourceFilename ?? config.sourceCatalog.filename,
      };
      assertExpectedBatchConfig(record, repairPins);
      const { records, unreadableBatchKeys } = await this.readOtherBatchRecords(record.key);
      const repair = await this.repairStuckBatch(
        { record, revision },
        repairPins,
        { projectUid: config.projectUid, sourceFilename: config.sourceCatalog.filename },
        records,
        unreadableBatchKeys,
      );
      if (repair.kind === "retrying") {
        throw new PhraseJobVisibilityError(record.key, repair.reason);
      }
      if (repair.kind === "voided") throw new PhraseStuckBatchVoidedError(repair.stored.record);
      ({ record, revision } = repair.stored);
    }
    if (record.phase === "failed") {
      throw new PhraseWorkflowError(
        "Phrase batch cannot be submitted again from phase failed; rerun with --retry-failed to create a new Phrase job",
        record.key,
      );
    }
    if (record.phase === "completed") return record;

    let verifiedJobs: PhraseJobPart[] | undefined;
    const configChanged = stableJson(record.config) !== stableJson(config);
    if (
      hasPhrasePins(pins) &&
      (record.phase === "importing" || record.phase === "superseded" || configChanged)
    ) {
      if (record.jobs.length) {
        verifiedJobs = await this.verifyPinnedJobs(
          record.config.projectUid,
          record.jobs,
          pins.expectedSourceFilename,
          undefined,
          {
            visibilityGraceCreatedAt: record.createdAt,
            batchKey: record.key,
          },
        );
        record.jobs = verifiedJobs;
      } else if (record.phase === "importing") {
        throw new PhrasePinMismatchError(
          "Refusing to poll a Phrase import request without verifiable job UIDs",
        );
      }
    }

    // Phrase-facing settings are part of the batch key, so a differing config only changes
    // repository-side mapping (output paths, adapters, completion policy). Adopt the latest.
    if (configChanged) {
      record.config = config;
      revision = await this.dependencies.state.updateBatch(record, revision);
    }
    if (record.phase === "superseded") {
      // Superseded batches may still have imports waiting; resume those through finishImport.
      const hasPendingImport = record.jobs.some(
        (job) =>
          record.locales[job.targetLang]?.phase !== "failed" &&
          record.locales[job.targetLang]?.phase !== "pr-created" &&
          job.importStatus?.status !== "OK" &&
          job.imported !== true,
      );
      record.phase = hasPendingImport ? "importing" : "ready";
      record.failureReason = undefined;
      await this.dependencies.state.updateBatch(record, revision);
      return record;
    }
    if (record.phase === "importing") {
      const retryableImportFailures = new Map<string, unknown>();
      const finished = await this.finishImport(record, revision, {
        pins,
        verifiedJobs,
        retryableImportFailures,
      });
      const visibilityError = firstPhraseJobVisibilityFailure(retryableImportFailures);
      if (visibilityError) throw visibilityError;
      return finished.record;
    }
    return record;
  }

  private async reconcileBatch(
    stored: StoredPhraseBatch,
    results: PhraseReconcileResult[],
    context: PhraseReconcileContext,
  ): Promise<void> {
    let { record, revision } = stored;
    const pins = context.pins;
    let pinnedJobs = context.verifiedJobs.get(record.key);
    let jobVerificationFailures = context.jobVerificationFailures.get(record.key) ?? new Map();
    if (hasPhrasePins(pins)) {
      pinnedJobs = await this.ensurePinnedReconcileJobs(record, pins, context);
      jobVerificationFailures = context.jobVerificationFailures.get(record.key) ?? new Map();
    }
    const retryableImportFailures =
      record.phase === "importing" ? new Map<string, unknown>() : new Map(jobVerificationFailures);
    if (record.phase === "importing") {
      const failedBeforeImport = new Set(
        Object.entries(record.locales)
          .filter(([, locale]) => locale.phase === "failed")
          .map(([phraseLocale]) => phraseLocale),
      );
      try {
        ({ record, revision } = await this.finishImport(record, revision, {
          pins,
          verifiedJobs: pinnedJobs,
          jobVerificationFailures,
          retryableImportFailures,
        }));
        if (hasPhrasePins(pins)) pinnedJobs = record.jobs;
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
      for (const target of record.config.targetLocales) {
        const locale = record.locales[target.phraseLocale];
        if (
          locale?.phase === "failed" &&
          !failedBeforeImport.has(target.phraseLocale) &&
          locale.failureReason
        ) {
          results.push({
            batchKey: record.key,
            phraseLocale: target.phraseLocale,
            phase: "failed",
            reason: locale.failureReason,
          });
        }
      }
    }
    if (
      record.retryParentBatchKey &&
      !record.retryParentDelegated &&
      (record.phase === "ready" || record.phase === "completed")
    ) {
      revision = await this.delegateRetryParent(record, revision, pins, context);
    }

    const pullRequestStates = new Map<string, PhrasePullRequestState>();
    const pullRequestStateErrors = new Map<string, unknown>();
    let stateChanged = false;
    for (const target of record.config.targetLocales) {
      const locale = record.locales[target.phraseLocale];
      if (locale?.phase !== "pr-created") continue;
      if (locale.pullRequestMerged) {
        if (!locale.pullRequestFinalized) {
          locale.pullRequestFinalized = true;
          stateChanged = true;
        }
        continue;
      }
      if (!locale.pullRequestUrl) {
        pullRequestStateErrors.set(
          target.phraseLocale,
          new PhraseRepositoryError("Phrase locale record is missing its pull request URL", 0),
        );
        continue;
      }
      try {
        let stateRequest = context.pullRequestStateCache.get(locale.pullRequestUrl);
        if (!stateRequest) {
          stateRequest = this.dependencies.repository.getPullRequestState(locale.pullRequestUrl);
          context.pullRequestStateCache.set(locale.pullRequestUrl, stateRequest);
        }
        const pullRequestState = await stateRequest;
        pullRequestStates.set(target.phraseLocale, pullRequestState);
        if (pullRequestState.state === "merged") {
          if (!locale.pullRequestFinalized || !locale.pullRequestMerged) {
            locale.pullRequestFinalized = true;
            locale.pullRequestMerged = true;
            stateChanged = true;
          }
        } else if (pullRequestState.state === "closed") {
          if (!locale.pullRequestFinalized || locale.pullRequestMerged) {
            locale.pullRequestFinalized = true;
            delete locale.pullRequestMerged;
            stateChanged = true;
          }
        } else if (locale.pullRequestFinalized || locale.pullRequestMerged) {
          delete locale.pullRequestFinalized;
          delete locale.pullRequestMerged;
          stateChanged = true;
        }
      } catch (error) {
        pullRequestStateErrors.set(target.phraseLocale, error);
      }
    }

    const allLocalesFinal = record.config.targetLocales.every((target) => {
      const locale = record.locales[target.phraseLocale];
      return (
        locale?.phase === "failed" ||
        (locale?.phase === "pr-created" && locale.pullRequestFinalized === true)
      );
    });
    const hasOpenPullRequest = [...pullRequestStates.values()].some(
      (pullRequestState) => pullRequestState.state === "open",
    );
    const needsMoreWork =
      hasValidationFailure(record) || pullRequestStateErrors.size > 0 || hasOpenPullRequest;
    if (record.phase === "completed" && needsMoreWork) {
      record.phase = "ready";
      stateChanged = true;
    }
    if (allLocalesFinal && pullRequestStateErrors.size === 0 && !hasOpenPullRequest) {
      if (record.phase !== "completed") {
        record.phase = "completed";
        stateChanged = true;
      }
      if (stateChanged) await this.dependencies.state.updateBatch(record, revision);
      return;
    }
    if (stateChanged) revision = await this.dependencies.state.updateBatch(record, revision);

    for (const [phraseLocale, error] of pullRequestStateErrors) {
      const pullRequestUrl = record.locales[phraseLocale]?.pullRequestUrl;
      if (
        pullRequestUrl &&
        (context.pullRequestOwners.get(pullRequestUrl) !== record.key ||
          context.reportedPullRequestStateErrors.has(pullRequestUrl))
      ) {
        continue;
      }
      if (pullRequestUrl) context.reportedPullRequestStateErrors.add(pullRequestUrl);
      results.push({
        batchKey: record.key,
        phraseLocale,
        phase: "retrying",
        reason: safeFailureReason(error),
      });
    }

    const targetsToReconcile = record.config.targetLocales.filter((target) => {
      const locale = record.locales[target.phraseLocale];
      if (locale?.phase === "pr-created") {
        return (
          pullRequestStates.get(target.phraseLocale)?.state === "open" &&
          !locale.pullRequestReexportDelegated &&
          Boolean(locale.pullRequestUrl) &&
          context.pullRequestOwners.get(locale.pullRequestUrl!) === record.key &&
          !context.exportedPullRequestUrls.has(locale.pullRequestUrl!)
        );
      }
      return locale?.phase !== "failed";
    });
    if (!targetsToReconcile.length) return;

    const pushRetryingForTargets = (error: unknown) => {
      const reason = safeFailureReason(error);
      for (const target of targetsToReconcile) {
        results.push({
          batchKey: record.key,
          phraseLocale: target.phraseLocale,
          phase: "retrying",
          reason,
        });
      }
    };
    const baseCommit = await this.dependencies.repository.resolveCommit(record.baseRef);
    let pinnedSource: SourceCatalogReadResult;
    let currentSource: SourceCatalogReadResult;
    try {
      [pinnedSource, currentSource] = await Promise.all([
        this.readSourceCatalog(record.config, record.sourceCommit),
        this.readSourceCatalog(record.config, baseCommit),
      ]);
    } catch (error) {
      pushRetryingForTargets(error);
      return;
    }
    const invalidTemplateRead = pinnedSource.formatError
      ? { ref: record.sourceCommit, error: pinnedSource.formatError }
      : currentSource.formatError
        ? { ref: baseCommit, error: currentSource.formatError }
        : undefined;
    if (invalidTemplateRead) {
      await this.closeBatch(
        record,
        revision,
        "superseded",
        `Frontend template cannot be inlined on ${invalidTemplateRead.ref}: ${invalidTemplateRead.error}`,
        results,
      );
      return;
    }
    const pinnedSourceBytes = pinnedSource.bytes;
    const currentSourceBytes = currentSource.bytes;
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
    if (!currentSourceBytes) {
      pushRetryingForTargets(
        new PhraseRepositoryError(
          `Could not read source input ${sourceInputPath(record.config)} on ${baseCommit}`,
          404,
        ),
      );
      return;
    }
    if (digest(currentSourceBytes) !== record.sourceDigest) {
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
    const targetAdapter = this.dependencies.catalogAdapters.get(targetAdapterId(record.config));
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
    if (record.config.frontendTemplate && !record.config.frontendTemplate.generateSourceCatalog) {
      let templateBytes: Uint8Array | null;
      try {
        templateBytes = await this.dependencies.repository.readFile(
          record.config.frontendTemplate.path,
          baseCommit,
        );
      } catch (error) {
        pushRetryingForTargets(error);
        return;
      }
      if (!templateBytes) {
        pushRetryingForTargets(
          new PhraseRepositoryError(
            `Could not read Frontend template ${record.config.frontendTemplate.path} on ${baseCommit}`,
            404,
          ),
        );
        return;
      }
      let matchesSource: boolean;
      try {
        matchesSource = feoTemplateMatchesSourceCatalog(
          new TextDecoder().decode(templateBytes),
          sourceCatalog,
        );
      } catch (error) {
        pushRetryingForTargets(error);
        return;
      }
      if (!matchesSource) {
        const reason =
          `Frontend source catalog is stale on ${baseCommit}: ` +
          "template English does not match the committed FEO source catalog";
        await this.closeBatch(record, revision, "superseded", reason, results);
        for (const target of targetsToReconcile) {
          if (record.locales[target.phraseLocale]?.phase !== "pr-created") continue;
          results.push({
            batchKey: record.key,
            phraseLocale: target.phraseLocale,
            phase: "superseded",
            reason,
          });
        }
        return;
      }
    }

    const readiness = new Map<string, LocaleReadiness>();
    const jobRefreshFailures = new Map<string, unknown>(retryableImportFailures);
    const refreshedJobs: PhraseJobPart[] = [];
    for (const target of targetsToReconcile) {
      if (jobRefreshFailures.has(target.phraseLocale)) continue;
      const targetJobs = (pinnedJobs ?? record.jobs).filter(
        (job) => job.targetLang === target.phraseLocale,
      );
      if (!targetJobs.length) {
        readiness.set(target.phraseLocale, {
          phase: "failed",
          reason: "Phrase returned no job part for this target locale",
        });
        continue;
      }
      try {
        const jobs = pinnedJobs
          ? pinnedJobs.filter((job) => job.targetLang === target.phraseLocale)
          : await Promise.all(targetJobs.map((job) => this.getImportJob(record, job, pins)));
        for (const [index, job] of jobs.entries()) {
          assertExpectedJobUid(job, targetJobs[index]!.uid);
          assertExpectedJobFilename(job, pins.expectedSourceFilename);
        }
        refreshedJobs.push(...jobs);
        readiness.set(target.phraseLocale, assessReadiness(jobs));
      } catch (error) {
        if (error instanceof PhrasePinMismatchError) throw error;
        jobRefreshFailures.set(target.phraseLocale, error);
      }
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
    for (const target of record.config.targetLocales) {
      // closeBatch may have run for an earlier locale even if persisting it then failed.
      if (record.phase !== "ready" && record.phase !== "importing") return;
      const push = (result: Omit<PhraseReconcileResult, "batchKey" | "phraseLocale">) =>
        results.push({ batchKey: record.key, phraseLocale: target.phraseLocale, ...result });
      const jobRefreshFailure = jobRefreshFailures.get(target.phraseLocale);
      if (jobRefreshFailures.has(target.phraseLocale)) {
        push({ phase: "retrying", reason: safeFailureReason(jobRefreshFailure) });
        continue;
      }
      const failLocale = async (reason: string) => {
        record.locales[target.phraseLocale] = { phase: "failed", failureReason: reason };
        revision = await this.dependencies.state.updateBatch(record, revision);
        push({ phase: "failed", reason });
      };

      const existingLocale = record.locales[target.phraseLocale];
      const existingPullRequestState = pullRequestStates.get(target.phraseLocale);
      const reexportingOpenPullRequest =
        existingLocale?.phase === "pr-created" &&
        existingPullRequestState?.state === "open" &&
        !existingLocale.pullRequestReexportDelegated &&
        Boolean(existingLocale.pullRequestUrl) &&
        context.pullRequestOwners.get(existingLocale.pullRequestUrl!) === record.key &&
        !context.exportedPullRequestUrls.has(existingLocale.pullRequestUrl!);
      if (existingLocale?.phase === "pr-created" && !reexportingOpenPullRequest) {
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
        if (reexportingOpenPullRequest) push({ phase: "failed", reason: ready.reason });
        else await failLocale(ready.reason);
        continue;
      }
      if (
        !reexportingOpenPullRequest &&
        localePolicy(record, target.phraseLocale) === "all-locales"
      ) {
        const validationFailedLocale = Object.entries(record.locales).find(
          ([, locale]) =>
            locale.phase === "validation-failed" || Boolean(locale.validationErrors?.length),
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

      if (!reexportingOpenPullRequest) {
        record.locales[target.phraseLocale] = existingLocale
          ? { ...existingLocale, phase: "exporting" }
          : { phase: "exporting" };
        revision = await this.dependencies.state.updateBatch(record, revision);
      }
      try {
        if (reexportingOpenPullRequest && existingLocale?.pullRequestUrl) {
          context.exportedPullRequestUrls.add(existingLocale.pullRequestUrl);
        }
        const { content, warnings, errors } = await this.exportTarget(
          record,
          target,
          ready.finalJob,
          sourceCatalog,
          targetAdapter,
        );
        const latestSource = await this.readSourceCatalog(record.config, baseCommit);
        if (latestSource.formatError) {
          await this.closeBatch(
            record,
            revision,
            "superseded",
            `Frontend template cannot be inlined on ${baseCommit}: ${latestSource.formatError}`,
            results,
          );
          return;
        }
        const latestSourceBytes = latestSource.bytes;
        if (!latestSourceBytes) {
          push({
            phase: "retrying",
            reason: `Could not read source input ${sourceInputPath(record.config)} on ${baseCommit}`,
          });
          continue;
        }
        if (digest(latestSourceBytes) !== record.sourceDigest) {
          await this.closeBatch(
            record,
            revision,
            "superseded",
            "Source catalog changed before the locale PR was created",
            results,
          );
          return;
        }
        const additionalFiles: { path: string; content: Uint8Array }[] = [];
        let frontendTemplateData:
          | {
              path: string;
              descriptors: FeoCatalog;
              translated: Record<string, string>;
            }
          | undefined;
        // Invalid exports remain reviewable, but must not enter generated runtime files.
        if (record.config.frontendTemplate && errors.length === 0) {
          const path = record.config.frontendTemplate.path;
          const templateRef =
            reexportingOpenPullRequest && existingPullRequestState?.state === "open"
              ? existingPullRequestState.headSha
              : baseCommit;
          const templateBytes = await this.dependencies.repository.readFile(path, templateRef);
          try {
            if (!templateBytes) throw new Error(`Missing Frontend template: ${path}`);
            const template = new TextDecoder().decode(templateBytes);
            const descriptors = JSON.parse(
              new TextDecoder().decode(pinnedSourceBytes),
            ) as FeoCatalog;
            const translated = JSON.parse(new TextDecoder().decode(content)) as Record<
              string,
              string
            >;
            additionalFiles.push({
              path,
              content: new TextEncoder().encode(
                inlineFeoLocale(template, descriptors, translated, target.repositoryLocale),
              ),
            });
            frontendTemplateData = { path, descriptors, translated };
          } catch (error) {
            errors.push(
              `Frontend template inline failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const latestBaseCommit = await this.dependencies.repository.resolveCommit(record.baseRef);
        if (latestBaseCommit !== baseCommit) {
          const latestSource = await this.readSourceCatalog(record.config, latestBaseCommit);
          if (latestSource.formatError) {
            await this.closeBatch(
              record,
              revision,
              "superseded",
              `Frontend template cannot be inlined on ${latestBaseCommit}: ${latestSource.formatError}`,
              results,
            );
            return;
          }
          const latestSourceBytes = latestSource.bytes;
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
          if (record.config.frontendTemplate) {
            const templatePath = record.config.frontendTemplate.path;
            const latestTemplateBytes = await this.dependencies.repository.readFile(
              templatePath,
              latestBaseCommit,
            );
            if (!latestTemplateBytes) {
              push({
                phase: "retrying",
                reason: `Could not read Frontend template ${templatePath} on ${latestBaseCommit}`,
              });
              continue;
            }
            const latestTemplate = new TextDecoder().decode(latestTemplateBytes);
            if (
              !record.config.frontendTemplate.generateSourceCatalog &&
              !feoTemplateMatchesSourceCatalog(latestTemplate, sourceCatalog)
            ) {
              await this.closeBatch(
                record,
                revision,
                "superseded",
                `Frontend source catalog is stale on ${latestBaseCommit}: template English does not match the committed FEO source catalog`,
                results,
              );
              return;
            }
            if (frontendTemplateData) {
              try {
                inlineFeoLocale(
                  latestTemplate,
                  frontendTemplateData.descriptors,
                  frontendTemplateData.translated,
                  target.repositoryLocale,
                );
              } catch (error) {
                await this.closeBatch(
                  record,
                  revision,
                  "superseded",
                  `Frontend template changed on the recorded PR base ref: ${error instanceof Error ? error.message : String(error)}`,
                  results,
                );
                return;
              }
            }
          }
        }
        const branch =
          existingLocale?.pullRequestBranch ??
          localePullRequestBranch(record.key, target.repositoryLocale);
        const pullRequestBatchKey = existingLocale?.pullRequestBatchKey ?? record.key;
        const body =
          `Phrase project: ${record.config.projectUid}\n` +
          `Batch: ${pullRequestBatchKey}\n` +
          `Source commit: ${record.sourceCommit}\n` +
          `Source SHA-256: ${record.sourceDigest}\n` +
          `Final job: ${ready.finalJob.uid}\n` +
          "\nReview validation findings before marking ready or merging. " +
          "Corrections in Phrase are pulled into this PR on later reconciliation runs. " +
          "Tooling never marks this PR ready automatically.\n" +
          (record.config.frontendTemplate && errors.length
            ? "\nGenerated Frontend YAML was not updated for this export. Any existing locale block may reflect an earlier valid export and must not be merged with this catalog.\n"
            : "") +
          translationFindingsSection("Translation errors (do not merge)", errors) +
          translationFindingsSection("Translation warnings (review before merging)", warnings);
        const deliveryMetadata = {
          validationErrors: errors,
          validationWarnings: warnings,
          pullRequestBodyDigest: digest(new TextEncoder().encode(body)),
        };
        const metadataChanged =
          existingLocale?.pullRequestBodyDigest !== deliveryMetadata.pullRequestBodyDigest ||
          stableJson(existingLocale?.validationErrors ?? []) !== stableJson(errors) ||
          stableJson(existingLocale?.validationWarnings ?? []) !== stableJson(warnings);
        const reportDelivery = (pullRequestUrl: string) =>
          push({
            phase: errors.length ? "failed" : "pr-created",
            pullRequestUrl,
            ...(errors.length ? { reason: errors.join("; ") } : {}),
          });
        const sourcePath = sourceInputPath(record.config);
        // Resubmission can adopt a moved generated-source template path within this batch.
        const title = `i18n(${target.repositoryLocale}): Phrase translation update for ${sourcePath}`;
        // Persist ownership before the ref update so an interrupted final save can still recover.
        const loadedLocale = structuredClone(
          record.locales[target.phraseLocale] ?? { phase: "exporting" as const },
        );
        const assertOwnedCommitEligibility = async (
          candidateRecord: PhraseBatchRecord,
          previousHeadSha: string | null,
        ): Promise<void> => {
          if (hasPhrasePins(pins)) {
            await this.ensurePinnedReconcileJobs(candidateRecord, pins, context);
          }
          const reason = ownedCommitEligibilityFailureReason(
            candidateRecord,
            target.phraseLocale,
            loadedLocale,
            candidateRecord.locales[target.phraseLocale],
            previousHeadSha,
          );
          if (reason) {
            throw new PhraseRepositoryError(
              `Locale ${target.phraseLocale} commit was skipped and is retryable: ${reason}`,
              409,
            );
          }
        };
        const recheckOwnedCommitEligibility = async (previousHeadSha: string | null) => {
          const latest = await this.dependencies.state.readBatch(record.key);
          if (!latest) {
            throw new PhraseRepositoryError(
              `Locale ${target.phraseLocale} commit was skipped and is retryable because its batch record disappeared`,
              409,
            );
          }
          record = latest.record;
          revision = latest.revision;
          await assertOwnedCommitEligibility(record, previousHeadSha);
          const cached = context.storedBatches.get(record.key);
          if (cached) {
            cached.record = record;
            cached.revision = revision;
          }
        };
        const recordToolingCommitSha = async (
          toolingSha: string,
          previousHeadSha: string | null,
        ) => {
          const locale = record.locales[target.phraseLocale];
          let ownershipShas = mergeToolingCommitShas(
            locale?.toolingCommitShas,
            locale?.toolingCommitSha ? [locale.toolingCommitSha] : undefined,
            locale?.pendingToolingCommitSha ? [locale.pendingToolingCommitSha] : undefined,
          );
          for (let attempt = 1; attempt <= TOOLING_COMMIT_STATE_WRITE_ATTEMPTS; attempt += 1) {
            await assertOwnedCommitEligibility(record, previousHeadSha);
            const localeRecord: PhraseLocaleRecord = record.locales[target.phraseLocale] ?? {
              phase: "exporting",
            };
            const toolingCommitShas = appendToolingCommitSha(
              [ownershipShas, localeRecord.toolingCommitShas],
              previousHeadSha,
              toolingSha,
              localeRecord.toolingCommitSha,
            );
            const updatedRecord: PhraseBatchRecord = {
              ...record,
              locales: {
                ...record.locales,
                [target.phraseLocale]: { ...localeRecord, toolingCommitShas },
              },
            };
            try {
              revision = await this.dependencies.state.updateBatch(updatedRecord, revision);
              record = updatedRecord;
              const cached = context.storedBatches.get(record.key);
              if (cached) {
                cached.record = record;
                cached.revision = revision;
              }
              return;
            } catch (error) {
              if (
                !(error instanceof PhraseBatchStateConflictError) ||
                attempt === TOOLING_COMMIT_STATE_WRITE_ATTEMPTS
              ) {
                throw error;
              }
              // A concurrent reconcile may have added another owned SHA at this revision.
              const latest = await this.dependencies.state.readBatch(record.key);
              if (!latest) {
                throw new PhraseRepositoryError(
                  `Locale ${target.phraseLocale} commit was skipped and is retryable because its batch record disappeared`,
                  409,
                );
              }
              record = latest.record;
              revision = latest.revision;
              await assertOwnedCommitEligibility(record, previousHeadSha);
              const latestLocale = latest.record.locales[target.phraseLocale];
              ownershipShas = mergeToolingCommitShas(
                toolingCommitShas,
                latestLocale?.toolingCommitShas,
                latestLocale?.toolingCommitSha ? [latestLocale.toolingCommitSha] : undefined,
                latestLocale?.pendingToolingCommitSha
                  ? [latestLocale.pendingToolingCommitSha]
                  : undefined,
              );
            }
          }
        };
        const pullRequestInput: PhraseLocalePullRequest = {
          // Creation is always draft; adoption only requires conversion for errors.
          draft: errors.length > 0,
          ...(additionalFiles.length ? { additionalFiles } : {}),
          repository: record.repository,
          baseRef: record.baseRef,
          baseCommit,
          branch,
          ...(existingLocale?.toolingCommitShas !== undefined
            ? { expectedToolingCommitShas: existingLocale.toolingCommitShas }
            : {}),
          ...(existingLocale?.toolingCommitSha !== undefined
            ? { expectedToolingCommitSha: existingLocale.toolingCommitSha }
            : {}),
          ...(existingLocale?.pendingToolingCommitSha !== undefined
            ? { expectedPendingToolingCommitSha: existingLocale.pendingToolingCommitSha }
            : {}),
          recordToolingCommitSha,
          recheckOwnedCommitEligibility,
          title,
          body,
          path: target.outputPath,
          content,
        };
        if (reexportingOpenPullRequest && existingPullRequestState?.state === "open") {
          if (existingLocale?.phase !== "pr-created" || !existingLocale.pullRequestUrl) {
            throw new PhraseRepositoryError(
              "Open Phrase pull request is missing its locale record",
              0,
            );
          }
          const update = await this.dependencies.repository.updateOpenPullRequest({
            ...(errors.length ? { draft: true } : {}),
            repository: record.repository,
            baseRef: record.baseRef,
            branch,
            pullRequestUrl: existingLocale.pullRequestUrl,
            headSha: existingPullRequestState.headSha,
            title,
            ...(existingLocale.toolingCommitShas !== undefined
              ? { expectedToolingCommitShas: existingLocale.toolingCommitShas }
              : {}),
            ...(existingLocale.toolingCommitSha !== undefined
              ? { expectedToolingCommitSha: existingLocale.toolingCommitSha }
              : {}),
            ...(existingLocale.pendingToolingCommitSha !== undefined
              ? { expectedPendingToolingCommitSha: existingLocale.pendingToolingCommitSha }
              : {}),
            recordToolingCommitSha,
            recheckOwnedCommitEligibility,
            ...(additionalFiles.length ? { additionalFiles } : {}),
            path: target.outputPath,
            content,
            body,
          });
          const updatedLocale: PhraseLocaleRecord = {
            ...(record.locales[target.phraseLocale] ?? existingLocale),
            toolingCommitSha: update.toolingCommitSha,
            pullRequestBranch: branch,
            pullRequestBatchKey,
            ...deliveryMetadata,
          };
          delete updatedLocale.pendingToolingCommitSha;
          if (update.pullRequestFinalized) {
            updatedLocale.pullRequestFinalized = true;
            if (update.pullRequestMerged) updatedLocale.pullRequestMerged = true;
            else delete updatedLocale.pullRequestMerged;
            updatedLocale.pullRequestBodyPending = true;
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
          } else if (update.changed) {
            if (update.bodyUpdated) delete updatedLocale.pullRequestBodyPending;
            else updatedLocale.pullRequestBodyPending = true;
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
            if (update.bodyError) {
              push({ phase: "retrying", reason: safeFailureReason(update.bodyError) });
            } else if (!update.bodyUpdated) {
              push({
                phase: "retrying",
                reason: "GitHub did not confirm the updated locale pull request description",
              });
            } else {
              reportDelivery(existingLocale.pullRequestUrl);
            }
          } else if (existingLocale.pullRequestBodyPending || metadataChanged) {
            const bodyUpdated = await this.dependencies.repository.updatePullRequestBody(
              existingLocale.pullRequestUrl,
              body,
              title,
            );
            if (bodyUpdated) delete updatedLocale.pullRequestBodyPending;
            else updatedLocale.pullRequestFinalized = true;
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
            if (bodyUpdated) reportDelivery(existingLocale.pullRequestUrl);
          } else {
            if (
              existingLocale.toolingCommitSha !== update.toolingCommitSha ||
              existingLocale.pendingToolingCommitSha !== undefined
            ) {
              record.locales[target.phraseLocale] = updatedLocale;
              revision = await this.dependencies.state.updateBatch(record, revision);
            }
            reportDelivery(existingLocale.pullRequestUrl);
          }
        } else {
          const created =
            await this.dependencies.repository.createOrUpdatePullRequestWithCommit(
              pullRequestInput,
            );
          if (!created.toolingCommitSha && !created.pullRequestFinalized) {
            throw new PhraseRepositoryError(
              "GitHub did not return the commit written for the locale pull request",
              500,
            );
          }
          const localeRecord: PhraseLocaleRecord = {
            ...(record.locales[target.phraseLocale] ?? { phase: "exporting" }),
            phase: "pr-created",
            ...deliveryMetadata,
            pullRequestUrl: created.pullRequestUrl,
            pullRequestBranch: branch,
            pullRequestBatchKey,
            ...(created.toolingCommitSha ? { toolingCommitSha: created.toolingCommitSha } : {}),
            ...(created.pullRequestFinalized ? { pullRequestFinalized: true } : {}),
            ...(created.pullRequestMerged ? { pullRequestMerged: true } : {}),
            ...(created.bodyError || created.pullRequestFinalized
              ? { pullRequestBodyPending: true }
              : {}),
          };
          delete localeRecord.pendingToolingCommitSha;
          record.locales[target.phraseLocale] = localeRecord;
          revision = await this.dependencies.state.updateBatch(record, revision);
          if (created.bodyError) {
            push({ phase: "retrying", reason: safeFailureReason(created.bodyError) });
          } else {
            reportDelivery(created.pullRequestUrl);
          }
        }
      } catch (error) {
        // A stale revision would make every later write in this batch fail; stop here.
        if (
          error instanceof PhraseBatchStateConflictError ||
          error instanceof PhrasePinMismatchError
        ) {
          throw error;
        }
        const permanent =
          error instanceof PhraseCatalogValidationError ||
          (error instanceof PhraseRepositoryError && error.permanent);
        // Compatibility with injected integrations that still throw this public error.
        if (error instanceof PhraseCatalogValidationError) {
          if (!reexportingOpenPullRequest) {
            record.locales[target.phraseLocale] = {
              phase: "validation-failed",
              failureReason: error.message,
            };
            revision = await this.dependencies.state.updateBatch(record, revision);
          }
          push({ phase: "failed", reason: error.message });
        } else if (permanent) await failLocale(error.message);
        else push({ phase: "retrying", reason: safeFailureReason(error) });
      }
    }

    if (
      !hasValidationFailure(record) &&
      record.config.targetLocales.every((target) => {
        const locale = record.locales[target.phraseLocale];
        return (
          locale?.phase === "failed" ||
          (locale?.phase === "pr-created" && locale.pullRequestFinalized === true)
        );
      })
    ) {
      record.phase = "completed";
      await this.dependencies.state.updateBatch(record, revision);
    }
  }

  private async ensurePinnedReconcileJobs(
    record: PhraseBatchRecord,
    pins: PhrasePinOptions,
    context: PhraseReconcileContext,
  ): Promise<PhraseJobPart[]> {
    assertExpectedBatchConfig(record, pins);
    const snapshot = context.verifiedJobSnapshots.get(record.key);
    const jobUids = record.jobs.map((job) => job.uid);
    if (
      snapshot &&
      snapshot.projectUid === record.config.projectUid &&
      snapshot.jobUids.length === jobUids.length &&
      snapshot.jobUids.every((jobUid, index) => jobUid === jobUids[index])
    ) {
      return context.verifiedJobs.get(record.key) ?? [];
    }

    const failures = new Map<string, unknown>();
    const jobs = record.jobs.length
      ? await this.verifyPinnedJobs(
          record.config.projectUid,
          record.jobs,
          pins.expectedSourceFilename,
          failures,
          {
            visibilityGraceCreatedAt: record.createdAt,
            batchKey: record.key,
          },
        )
      : [];
    context.verifiedJobs.set(record.key, jobs);
    context.jobVerificationFailures.set(record.key, failures);
    context.verifiedJobSnapshots.set(record.key, {
      projectUid: record.config.projectUid,
      jobUids,
    });
    if (snapshot) {
      throw new PhraseBatchStateConflictError(
        "Phrase batch jobs changed while reconciliation was in progress",
      );
    }
    return jobs;
  }

  private async delegateRetryParent(
    record: PhraseBatchRecord,
    revision: string,
    pins: PhrasePinOptions = {},
    context?: PhraseReconcileContext,
  ): Promise<string> {
    if (hasPhrasePins(pins)) {
      if (context) await this.ensurePinnedReconcileJobs(record, pins, context);
      else assertExpectedBatchConfig(record, pins);
    }
    const parentKey = record.retryParentBatchKey;
    if (!parentKey || record.retryParentDelegated) return revision;

    const parentStored = await this.dependencies.state.readBatch(parentKey);
    if (parentStored && hasPhrasePins(pins)) {
      if (context && !["failed", "superseded"].includes(parentStored.record.phase)) {
        await this.ensurePinnedReconcileJobs(parentStored.record, pins, context);
      } else {
        assertExpectedBatchConfig(parentStored.record, pins);
      }
    }
    if (parentStored && !["failed", "superseded"].includes(parentStored.record.phase)) {
      const parent = parentStored.record;
      const retryLocales = new Set(
        record.config.targetLocales.map(({ phraseLocale }) => phraseLocale),
      );
      for (const target of parent.config.targetLocales) {
        if (!retryLocales.has(target.phraseLocale)) continue;
        const locale = parent.locales[target.phraseLocale];
        if (!locale) continue;
        if (locale.phase === "pr-created") {
          const carriedLocale = record.locales[target.phraseLocale];
          if (
            carriedLocale?.phase === "pr-created" &&
            carriedLocale.pullRequestUrl === locale.pullRequestUrl
          ) {
            const carriedLocaleUpdate: PhraseLocaleRecord = { ...carriedLocale };
            if (locale.toolingCommitSha) {
              carriedLocaleUpdate.toolingCommitSha = locale.toolingCommitSha;
            }
            if (locale.pendingToolingCommitSha) {
              carriedLocaleUpdate.pendingToolingCommitSha = locale.pendingToolingCommitSha;
            } else {
              delete carriedLocaleUpdate.pendingToolingCommitSha;
            }
            const toolingCommitShas = trimToolingCommitShas(
              mergeToolingCommitShas(
                carriedLocaleUpdate.toolingCommitShas,
                locale.toolingCommitShas,
                carriedLocaleUpdate.pendingToolingCommitSha
                  ? [carriedLocaleUpdate.pendingToolingCommitSha]
                  : undefined,
              ),
              carriedLocaleUpdate.toolingCommitSha,
            );
            if (toolingCommitShas.length) {
              carriedLocaleUpdate.toolingCommitShas = toolingCommitShas;
            } else {
              delete carriedLocaleUpdate.toolingCommitShas;
            }
            const ownershipChanged =
              JSON.stringify(carriedLocaleUpdate.toolingCommitShas ?? []) !==
              JSON.stringify(carriedLocale.toolingCommitShas ?? []);
            if (
              carriedLocaleUpdate.toolingCommitSha !== carriedLocale.toolingCommitSha ||
              carriedLocaleUpdate.pendingToolingCommitSha !==
                carriedLocale.pendingToolingCommitSha ||
              ownershipChanged
            ) {
              record.locales[target.phraseLocale] = carriedLocaleUpdate;
            }
            if (!locale.pullRequestReexportDelegated) {
              locale.pullRequestReexportDelegated = true;
            }
          } else if (isClosedInvalidPullRequest(locale)) {
            // A replacement job owns this locale now; reopening the old PR must not
            // resume a second exporter while the parent has other active locales.
            locale.pullRequestReexportDelegated = true;
          }
        } else if (locale.phase !== "failed") {
          parent.locales[target.phraseLocale] = {
            phase: "failed",
            failureReason: `Retried in Phrase batch ${record.key}`,
          };
        }
      }

      const parentHasOpenPullRequest = parent.config.targetLocales.some((target) => {
        const locale = parent.locales[target.phraseLocale];
        return locale?.phase === "pr-created" && !locale.pullRequestFinalized;
      });
      if (parentHasOpenPullRequest && parent.phase === "completed") {
        parent.phase = "ready";
      }

      // Fence the child's ownership snapshot against the exact parent revision it copied.
      // Even if the handoff marker is already present, a concurrent parent SHA write must
      // conflict before the child record can be saved with a stale owned set.
      const parentRevision = await this.dependencies.state.updateBatch(
        parent,
        parentStored.revision,
      );
      const cachedParent = context?.storedBatches.get(parentKey);
      if (cachedParent) {
        cachedParent.record = parent;
        cachedParent.revision = parentRevision;
      }
    }

    record.retryParentDelegated = true;
    const nextRevision = await this.dependencies.state.updateBatch(record, revision);
    const cachedRecord = context?.storedBatches.get(record.key);
    if (cachedRecord) {
      cachedRecord.record = record;
      cachedRecord.revision = nextRevision;
    }
    if (context) {
      for (const locale of Object.values(record.locales)) {
        if (locale.phase === "pr-created" && locale.pullRequestUrl) {
          context.pullRequestOwners.set(locale.pullRequestUrl, record.key);
        }
      }
    }
    return nextRevision;
  }

  private async exportTarget(
    record: PhraseBatchRecord,
    target: PhraseTargetLocale,
    finalJob: PhraseJobPart,
    sourceCatalog: Catalog,
    targetAdapter: CatalogAdapter,
  ): Promise<{ content: Uint8Array; warnings: string[]; errors: string[] }> {
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
          `ICU argument mismatches: ${comparison.argumentMismatches
            .map((item) => describeArgumentMismatch(sourceCatalog.messages[item.id]!.pattern, item))
            .join(", ")}`,
        );
      }
      const warnings: string[] = [];
      for (const finding of lintTargetCatalog(sourceCatalog, targetCatalog)) {
        (finding.severity === "error" ? problems : warnings).push(finding.message);
      }
      const serialized = serializeCatalogDocument(
        targetAdapter.write(targetCatalog, context),
        targetAdapter,
        context,
      );
      return { content: new TextEncoder().encode(serialized), warnings, errors: problems };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        content: targetBytes,
        warnings: [],
        errors: [`Downloaded ${target.phraseLocale} catalog failed validation: ${detail}`],
      };
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
    options: FinishImportOptions = {},
  ): Promise<StoredPhraseBatch> {
    const pins = options.pins ?? {};
    let verifiedJobs = options.verifiedJobs;
    const jobVerificationFailures = options.jobVerificationFailures ?? new Map<string, unknown>();
    const asyncRequestIsFresh = options.asyncRequestIsFresh ?? false;
    const retryableImportFailures = options.retryableImportFailures ?? new Map<string, unknown>();
    if (hasPhrasePins(pins)) {
      assertExpectedBatchConfig(record, pins);
      if (!record.jobs.length) {
        throw new PhrasePinMismatchError(
          "Refusing to poll a Phrase import request without verifiable job UIDs",
        );
      }
      verifiedJobs ??= await this.verifyPinnedJobs(
        record.config.projectUid,
        record.jobs,
        pins.expectedSourceFilename,
        jobVerificationFailures,
        {
          visibilityGraceCreatedAt: record.createdAt,
          batchKey: record.key,
        },
      );
      const verifiedByUid = new Map(verifiedJobs.map((job) => [job.uid, job]));
      record.jobs = record.jobs.map((job) => verifiedByUid.get(job.uid) ?? job);
    }
    try {
      const shouldPollAsyncRequest =
        Boolean(record.importAsyncRequestId) && (!hasPhrasePins(pins) || asyncRequestIsFresh);
      // PhraseAsyncRequest exposes only id, action, and asyncResponse, with no project/job reference.
      // Pinned resumes skip its global endpoint; fresh IDs are polled only after job checks above.
      // If polled, only the status of a request whose ID the attacker already knows is observable;
      // no translation data is read.
      if (shouldPollAsyncRequest) {
        await this.dependencies.phrase.waitForAsyncRequest(record.importAsyncRequestId!, {
          timeoutMs: this.importTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
        });
      }
      const deadline = this.now() + this.importTimeoutMs;
      const failedLocales = new Map<string, string>();
      const verifiedByUid = new Map((verifiedJobs ?? []).map((job) => [job.uid, job]));
      const initialObservations = record.jobs.map((requestedJob) => {
        const job = verifiedByUid.get(requestedJob.uid);
        if (job) return { requestedJob, job };
        const error = jobVerificationFailures.get(requestedJob.targetLang);
        return error === undefined ? { requestedJob } : { requestedJob, error };
      });
      const initialClassifications = classifyImportJobParts(initialObservations);
      for (const [phraseLocale, classification] of initialClassifications) {
        if (record.locales[phraseLocale]?.phase === "pr-created") {
          const error = jobVerificationFailures.get(phraseLocale);
          if (error !== undefined) retryableImportFailures.set(phraseLocale, error);
          continue;
        }
        if (classification.phase === "failed") {
          retryableImportFailures.delete(phraseLocale);
          failedLocales.set(phraseLocale, classification.reason);
        } else if (classification.phase === "retrying") {
          retryableImportFailures.set(phraseLocale, classification.error);
        }
      }
      for (const [phraseLocale, failureReason] of failedLocales) {
        record.locales[phraseLocale] = {
          ...record.locales[phraseLocale],
          phase: "failed",
          failureReason,
        };
      }
      let pendingJobs = record.jobs.filter(
        (job) =>
          record.locales[job.targetLang]?.phase !== "pr-created" &&
          record.locales[job.targetLang]?.phase !== "failed" &&
          !retryableImportFailures.has(job.targetLang),
      );
      while (pendingJobs.length) {
        const settled = await Promise.allSettled(
          pendingJobs.map((job) => this.getImportJob(record, job, pins)),
        );
        const refreshedByUid = new Map<string, PhraseJobPart>();
        const observations: ImportJobPartObservation[] = [];
        for (const [index, result] of settled.entries()) {
          const requestedJob = pendingJobs[index]!;
          if (result.status === "rejected") {
            if (result.reason instanceof PhrasePinMismatchError) throw result.reason;
            observations.push({ requestedJob, error: result.reason });
            continue;
          }
          const job = result.value;
          assertExpectedJobUid(job, requestedJob.uid);
          assertExpectedJobFilename(job, pins.expectedSourceFilename);
          refreshedByUid.set(job.uid, job);
          observations.push({ requestedJob, job });
        }
        const classifications = classifyImportJobParts(observations);
        const nextPendingJobs: PhraseJobPart[] = [];
        for (const [phraseLocale, classification] of classifications) {
          if (classification.phase === "failed") {
            retryableImportFailures.delete(phraseLocale);
            failedLocales.set(phraseLocale, classification.reason);
          } else if (classification.phase === "retrying") {
            if (!failedLocales.has(phraseLocale)) {
              retryableImportFailures.set(phraseLocale, classification.error);
            }
          } else if (classification.phase === "pending") {
            nextPendingJobs.push(...classification.jobs);
          }
        }
        record.jobs = record.jobs.map((job) => refreshedByUid.get(job.uid) ?? job);
        for (const [phraseLocale, failureReason] of failedLocales) {
          record.locales[phraseLocale] = {
            ...record.locales[phraseLocale],
            phase: "failed",
            failureReason,
          };
        }
        pendingJobs = nextPendingJobs.filter(
          (job) =>
            !failedLocales.has(job.targetLang) && !retryableImportFailures.has(job.targetLang),
        );
        if (!pendingJobs.length) break;
        if (this.now() >= deadline) {
          const timeoutError = new PhraseWorkflowError(
            "Timed out waiting for Phrase job imports",
            record.key,
          );
          for (const job of pendingJobs) {
            if (retryableImportFailure(timeoutError)) {
              retryableImportFailures.set(job.targetLang, timeoutError);
            } else {
              failedLocales.set(job.targetLang, safeFailureReason(timeoutError));
            }
          }
          for (const [phraseLocale, failureReason] of failedLocales) {
            record.locales[phraseLocale] = {
              ...record.locales[phraseLocale],
              phase: "failed",
              failureReason,
            };
          }
          break;
        }
        await this.sleep(this.pollIntervalMs);
      }
      record.phase = retryableImportFailures.size ? "importing" : "ready";
      record.failureReason = undefined;
      return { record, revision: await this.dependencies.state.updateBatch(record, revision) };
    } catch (error) {
      // Rewriting with the same stale revision would only fail again and mask the conflict.
      if (error instanceof PhraseBatchStateConflictError || error instanceof PhrasePinMismatchError)
        throw error;
      record.phase = retryableImportFailure(error) ? "importing" : "failed";
      record.failureReason = safeFailureReason(error);
      await this.dependencies.state.updateBatch(record, revision);
      throw error;
    }
  }

  private async getPinnedJob(
    projectUid: string,
    requestedJob: PhraseJobPart,
    expectedSourceFilename?: string,
    options: PinnedJobVerificationOptions = {},
  ): Promise<PhraseJobPart> {
    if (!requestedJob || typeof requestedJob.uid !== "string" || !requestedJob.uid.trim()) {
      throw new PhrasePinMismatchError("Stored Phrase job UID is invalid");
    }
    const retryStartedAt = this.now();
    let attempt = 0;
    let job: PhraseJobPart | undefined;
    for (;;) {
      try {
        job = await this.dependencies.phrase.getJob(projectUid, requestedJob.uid);
        break;
      } catch (error) {
        if (
          error instanceof PhraseApiError &&
          error.message === "Phrase returned an invalid job UID"
        ) {
          throw new PhrasePinMismatchError(
            "Phrase returned an invalid job UID in the pinned project",
          );
        }
        if (!(error instanceof PhraseApiError) || error.status !== 404) throw error;
        if (options.retryFresh404) {
          const remaining = FRESH_JOB_VISIBILITY_RETRY_WINDOW_MS - (this.now() - retryStartedAt);
          if (attempt + 1 < FRESH_JOB_VISIBILITY_RETRY_ATTEMPTS && remaining > 0) {
            await this.sleep(Math.min(FRESH_JOB_VISIBILITY_RETRY_INTERVAL_MS, remaining));
            attempt += 1;
            continue;
          }
          throw new PhraseJobVisibilityError(options.batchKey);
        }
        if (
          options.visibilityGraceCreatedAt &&
          isWithinPhraseJobVisibilityGrace(options.visibilityGraceCreatedAt, this.now())
        ) {
          throw new PhraseJobVisibilityError(options.batchKey);
        }
        throw new PhrasePinMismatchError(
          "Stored Phrase jobs could not be verified in the pinned project",
        );
      }
    }
    assertExpectedJobUid(job, requestedJob.uid);
    assertExpectedJobFilename(job, expectedSourceFilename);
    return job;
  }

  private async getImportJob(
    record: PhraseBatchRecord,
    requestedJob: PhraseJobPart,
    pins: PhrasePinOptions,
  ): Promise<PhraseJobPart> {
    if (hasPhrasePins(pins)) {
      return this.getPinnedJob(
        record.config.projectUid,
        requestedJob,
        pins.expectedSourceFilename,
        {
          visibilityGraceCreatedAt: record.createdAt,
          batchKey: record.key,
        },
      );
    }
    try {
      return await this.dependencies.phrase.getJob(record.config.projectUid, requestedJob.uid);
    } catch (error) {
      if (
        error instanceof PhraseApiError &&
        error.status === 404 &&
        isWithinPhraseJobVisibilityGrace(record.createdAt, this.now())
      ) {
        throw new PhraseJobVisibilityError(record.key);
      }
      throw error;
    }
  }

  private async verifyPinnedJobs(
    projectUid: string,
    requestedJobs: readonly PhraseJobPart[],
    expectedSourceFilename?: string,
    failuresByLocale?: Map<string, unknown>,
    options: PinnedJobVerificationOptions = {},
  ): Promise<PhraseJobPart[]> {
    if (requestedJobs.some(({ uid }) => typeof uid !== "string" || !uid.trim())) {
      throw new PhrasePinMismatchError("Pinned Phrase batch contains an invalid job UID");
    }
    const settled = await Promise.allSettled(
      requestedJobs.map((requestedJob) =>
        this.getPinnedJob(projectUid, requestedJob, expectedSourceFilename, options),
      ),
    );
    const verifiedJobs: PhraseJobPart[] = [];
    const failures = failuresByLocale ?? new Map<string, unknown>();
    let firstFailureLocale: string | undefined;
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        verifiedJobs.push(result.value);
        continue;
      }
      if (result.reason instanceof PhrasePinMismatchError) throw result.reason;
      const phraseLocale = requestedJobs[index]!.targetLang;
      if (!failures.has(phraseLocale)) {
        failures.set(phraseLocale, result.reason);
        firstFailureLocale ??= phraseLocale;
      } else if (
        retryableImportFailure(failures.get(phraseLocale)) &&
        !retryableImportFailure(result.reason)
      ) {
        failures.set(phraseLocale, result.reason);
      }
    }
    if (!failuresByLocale && firstFailureLocale !== undefined)
      throw failures.get(firstFailureLocale);
    return verifiedJobs;
  }
}

function assertExpectedBatchConfig(record: PhraseBatchRecord, options: PhrasePinOptions): void {
  assertExpectedWorkflowConfig(record.config, options);
}

function assertExpectedWorkflowConfig(
  config: PhraseWorkflowConfig,
  options: PhrasePinOptions,
): void {
  const mismatches: string[] = [];
  if (
    options.expectedProjectUid !== undefined &&
    config.projectUid !== options.expectedProjectUid
  ) {
    mismatches.push(
      `project UID expected ${JSON.stringify(options.expectedProjectUid)}, actual ${JSON.stringify(config.projectUid)}`,
    );
  }
  if (
    options.expectedSourceFilename !== undefined &&
    config.sourceCatalog.filename !== options.expectedSourceFilename
  ) {
    mismatches.push(
      `source filename expected ${JSON.stringify(options.expectedSourceFilename)}, actual ${JSON.stringify(config.sourceCatalog.filename)}`,
    );
  }
  if (mismatches.length) {
    throw new PhrasePinMismatchError(`Batch config mismatch: ${mismatches.join("; ")}`);
  }
}

function hasPhrasePins(options: PhrasePinOptions): boolean {
  return options.expectedProjectUid !== undefined || options.expectedSourceFilename !== undefined;
}

function assertExpectedJobUid(
  job: PhraseJobPart | undefined,
  expectedJobUid: string,
): asserts job is PhraseJobPart {
  if (typeof expectedJobUid !== "string" || !expectedJobUid.trim()) {
    throw new PhrasePinMismatchError("Stored Phrase job UID is invalid");
  }
  if (!job || typeof job.uid !== "string" || !job.uid.trim()) {
    throw new PhrasePinMismatchError(
      `Phrase returned an invalid job UID for requested UID ${JSON.stringify(expectedJobUid)}`,
    );
  }
  if (job.uid === expectedJobUid) return;
  throw new PhrasePinMismatchError(
    `Phrase returned job UID ${JSON.stringify(job.uid)} for requested UID ${JSON.stringify(expectedJobUid)}`,
  );
}

function assertExpectedJobFilename(job: PhraseJobPart, expectedSourceFilename?: string): void {
  if (expectedSourceFilename === undefined || job.filename === expectedSourceFilename) return;
  throw new PhrasePinMismatchError(
    `Phrase job ${job.uid} source filename mismatch: expected ${JSON.stringify(expectedSourceFilename)}, actual ${job.filename === undefined ? "(missing)" : JSON.stringify(job.filename)}`,
  );
}
