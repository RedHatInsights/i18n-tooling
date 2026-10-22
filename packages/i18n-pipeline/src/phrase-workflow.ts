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
import { overlongFeoTranslationsWarning, suggestFeoLocale } from "./feo-locale.js";
import { targetAdapterId, validatePhraseWorkflowConfig } from "./phrase-config.js";
import {
  extractFeoCatalog,
  formatFeoCatalog,
  inlineFeoLocale,
  type FeoCatalog,
} from "./feo-template.js";

export type LocaleCompletionPolicy = "per-locale" | "all-locales";

export interface TranslationFinding {
  severity: "error" | "warning";
  messageId?: string;
  problem: string;
  source?: string;
  translation?: string;
}

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
  /** The superseded-PR notice was successfully posted. */
  pullRequestSupersededNoticePosted?: true;
  /** Reviewer commits were found on a superseded PR, so it must stay open. */
  pullRequestSupersededReviewerCommits?: true;
  /**
   * Messages whose translation on this superseded PR its replacement does not carry, as of the
   * last notice; the PR stays open until the list is empty. An empty list records that the
   * closing notice for a previously divergent PR was posted.
   */
  pullRequestSupersededDivergentIds?: string[];
  /** Last generated description; missing digest refreshes pre-upgrade PR safety notes once. */
  pullRequestBodyDigest?: string;
  /** Retry the PR title and description update if it failed after a commit. */
  pullRequestBodyPending?: boolean;
  /** Retry the translation findings comment on the next export for this open PR. */
  pullRequestCommentPending?: boolean;
  /** Retry the initial best-effort assignee update for this newly created PR. */
  pullRequestAssigneesPending?: boolean;
  /** Logins returned by the successful first assignment attempt for this PR. */
  pullRequestAssignees?: string[];
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
  | { state: "open"; headSha: string }
  /** `mergeCommitSha` holds the tree that landed, including reviewer commits. */
  | { state: "merged"; headSha?: string; mergeCommitSha?: string }
  | { state: "closed"; headSha?: string };

export interface PhraseLocalePullRequestCreated {
  pullRequestUrl: string;
  /** True only when this call created the PR rather than finding or adopting one. */
  pullRequestCreated?: boolean;
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
  listSourceChangeAuthors(input: {
    path: string;
    headCommit: string;
    baseCommit?: string;
  }): Promise<string[]>;
  addPullRequestAssignees(pullRequestUrl: string, logins: string[]): Promise<string[]>;
  getPullRequestState(pullRequestUrl: string): Promise<PhrasePullRequestState>;
  closePullRequest(pullRequestUrl: string): Promise<void>;
  createOrUpdatePullRequest(input: PhraseLocalePullRequest): Promise<string>;
  createOrUpdatePullRequestWithCommit(
    input: PhraseLocalePullRequest,
  ): Promise<PhraseLocalePullRequestCreated>;
  updateOpenPullRequest(
    input: PhraseLocalePullRequestUpdate,
  ): Promise<PhraseLocalePullRequestUpdateResult>;
  updatePullRequestBody(pullRequestUrl: string, body: string, title?: string): Promise<boolean>;
  findLatestBotPullRequestComment(
    pullRequestUrl: string,
    bodyPrefix: string,
  ): Promise<string | undefined>;
  createPullRequestComment(pullRequestUrl: string, body: string): Promise<boolean>;
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

export interface PhraseSubmitOutcome {
  batch: PhraseBatchRecord;
  /** True only when this call created the batch record instead of resuming an existing one. */
  createdThisRun: boolean;
}

export interface PhraseReconcileResult {
  batchKey: string;
  /** Omitted when the whole batch could not be reconciled on this run. */
  phraseLocale?: string;
  /**
   * `retrying` means a transient failure; the next reconcile run tries again.
   * `invalid-translation` means a locale PR was delivered with translation validation errors.
   */
  phase: "pending" | "retrying" | "failed" | "superseded" | "pr-created" | "invalid-translation";
  repositoryLocale?: string;
  jobUid?: string;
  jobStatus?: string;
  projectUid?: string;
  region?: "eu" | "us";
  sourceCommit?: string;
  createdAt?: string;
  validationErrorCount?: number;
  validationWarningCount?: number;
  pullRequestAssignees?: string[];
  pullRequestUrl?: string;
  reason?: string;
}

export interface PhraseReconcileOptions {
  expectedProjectUid?: string;
  expectedSourceFilename?: string;
  fallbackAssignees?: string[];
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
// Phrase can timestamp parts of one create request seconds apart across a second boundary.
const PHRASE_JOB_RECOVERY_CLUSTER_GAP_MS = 5_000;
const PHRASE_JOB_VISIBILITY_GRACE_LABEL = "15 minutes";
export const NO_PHRASE_JOB_CREATED_VOID_REASON = `No Phrase job was created for this batch; voided after ${PHRASE_JOB_VISIBILITY_GRACE_LABEL}`;
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
  fallbackAssignees: string[];
  repairScope?: PhraseRepairScope;
  assignmentWarnings: Map<string, { batchKey: string; phraseLocale: string; reason: string }>;
  supersededPullRequestWarnings: Map<
    string,
    { batchKey: string; phraseLocale: string; reason: string }
  >;
  /** Source-change authors per batch key, resolved once per run for all of its locales. */
  sourceChangeAuthors: Map<string, Promise<string[]>>;
  verifiedJobs: Map<string, PhraseJobPart[]>;
  /** Latest job statuses seen this run, for reporting only; never treated as pin-verified. */
  reportedJobs: Map<string, PhraseJobPart[]>;
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
// Two report tables plus metadata stay below GitHub's 65,536-character PR comment limit.
const MAX_PULL_REQUEST_SECTION_BYTES = 24_000;
const TRANSLATION_FINDINGS_COMMENT_MARKER = "<!-- i18n-pipeline:translation-findings";

function findingCount(icon: string, count: number, noun: string): string {
  return `${icon} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

function translationFindingsStatusLine(findings: TranslationFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  if (!errors && !warnings) return "✅ No translation errors or warnings.";
  if (!errors) {
    return `${findingCount("⚠️", warnings, "warning")} — see the latest 🌐 Translation check comment.`;
  }
  const counts = [findingCount("❌", errors, "error")];
  if (warnings) counts.push(findingCount("⚠️", warnings, "warning"));
  return `${counts.join(" · ")} — see the latest 🌐 Translation check comment.`;
}

export function normalizeTableCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("|", "\\|");
}

export function codeSpan(value: string): string {
  const normalized = normalizeTableCell(value);
  const backtickRuns = normalized.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(1, ...backtickRuns.map((run) => run.length + 1)));
  const padding =
    normalized &&
    (normalized.startsWith("`") ||
      normalized.endsWith("`") ||
      normalized.startsWith(" ") ||
      normalized.endsWith(" "))
      ? " "
      : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function truncatePattern(pattern: string): string {
  const normalized = pattern.replace(/[\r\n]+/g, " ");
  const characters = [...normalized];
  return characters.length > 300 ? `${characters.slice(0, 299).join("")}…` : normalized;
}

function renderFindingRow(finding: TranslationFinding, prefix: "E" | "W", index: number): string {
  const message = finding.messageId ? codeSpan(finding.messageId) : "—";
  const source = finding.source === undefined ? "—" : codeSpan(truncatePattern(finding.source));
  const translation =
    finding.translation === undefined ? "—" : codeSpan(truncatePattern(finding.translation));
  return `| **${prefix}${index + 1}** | ${message} | ${normalizeTableCell(finding.problem)} | ${source} | ${translation} |`;
}

function translationFindingsTable(
  heading: string,
  prefix: "E" | "W",
  findings: TranslationFinding[],
): string {
  if (!findings.length) return "";
  const tableHeader = [
    "| # | Message | Problem | English source | Translation |",
    "| :-: | --- | --- | --- | --- |",
  ];
  const rows: string[] = [];
  const maxRows = Math.min(findings.length, MAX_PULL_REQUEST_FINDINGS);
  for (let index = 0; index < maxRows; index += 1) {
    const candidate = [...rows, renderFindingRow(findings[index]!, prefix, index)];
    const bytes = new TextEncoder().encode([heading, "", ...tableHeader, ...candidate].join("\n"));
    if (bytes.length > MAX_PULL_REQUEST_SECTION_BYTES) break;
    rows.push(candidate.at(-1)!);
  }
  const hidden = findings.length - rows.length;
  return [
    heading,
    "",
    ...tableHeader,
    ...rows,
    ...(hidden ? ["", `…and ${hidden} more`] : []),
  ].join("\n");
}

function translationFindingsComment(
  input: {
    locale: string;
    batchKey: string;
    sourceCommit: string;
    projectUid: string;
    finalJobUid: string;
    findings: TranslationFinding[];
    generatedYamlNote?: string;
  },
  findingsDigest: string,
): string {
  const errors = input.findings.filter((finding) => finding.severity === "error");
  const warnings = input.findings.filter((finding) => finding.severity === "warning");
  const lines = [
    `<!-- i18n-pipeline:translation-findings digest=${findingsDigest} -->`,
    `## 🌐 Translation check · ${codeSpan(input.locale)}`,
    "",
  ];
  if (errors.length) {
    lines.push(
      "> [!CAUTION]",
      `> **${findingCount("❌", errors.length, "error")}** ${errors.length === 1 ? "blocks" : "block"} merging.${
        warnings.length
          ? ` **${findingCount("⚠️", warnings.length, "warning")}** ${warnings.length === 1 ? "needs" : "need"} a reviewer's judgment.`
          : ""
      }`,
    );
  } else if (warnings.length) {
    lines.push(
      "> [!WARNING]",
      `> **${findingCount("⚠️", warnings.length, "warning")}** ${warnings.length === 1 ? "needs" : "need"} a reviewer's judgment.`,
    );
  } else {
    lines.push("> [!TIP]", "> **✅ No translation errors or warnings.**");
  }
  if (input.generatedYamlNote) {
    lines.push("", "> [!NOTE]", `> ${normalizeTableCell(input.generatedYamlNote)}`);
  }
  if (errors.length) {
    lines.push(
      "",
      translationFindingsTable("### ❌ Errors — must be fixed before merging", "E", errors),
    );
  }
  if (warnings.length) {
    lines.push(
      "",
      translationFindingsTable("### ⚠️ Warnings — review before merging", "W", warnings),
    );
  }
  lines.push(
    "",
    "<details>",
    "<summary>ℹ️ Batch details</summary>",
    "",
    "| | |",
    "| --- | --- |",
    `| Phrase project | ${codeSpan(input.projectUid)} |`,
    `| Batch | ${codeSpan(input.batchKey.slice(0, 12))} |`,
    `| Source commit | ${codeSpan(input.sourceCommit.slice(0, 7))} |`,
    `| Final job | ${codeSpan(input.finalJobUid)} |`,
    "",
    "</details>",
    "",
    "<sub>🤖 Posted by i18n-pipeline. A new run with changed findings adds a new report; this PR stays a draft and is never marked ready automatically.</sub>",
  );
  return lines.join("\n");
}

function capitalizeFirst(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function commentDigest(comment: string | undefined): string | undefined {
  return comment?.match(/^<!-- i18n-pipeline:translation-findings digest=([a-f0-9]{64}) -->/)?.[1];
}

function argumentMismatchProblem(mismatch: { source: string[]; target: string[] }): string {
  const sourceArguments = new Set(mismatch.source);
  const targetArguments = new Set(mismatch.target);
  const missing = mismatch.source.filter((argument) => !targetArguments.has(argument));
  const extra = mismatch.target.filter((argument) => !sourceArguments.has(argument));
  const formatNames = (names: string[]) =>
    names.length < 2
      ? `{${names[0]}}`
      : `${names
          .slice(0, -1)
          .map((name) => `{${name}}`)
          .join(", ")} and {${names.at(-1)}}`;
  const problems: string[] = [];
  if (missing.length) {
    problems.push(
      `${missing.length === 1 ? "Argument" : "Arguments"} ${formatNames(missing)} ${
        missing.length === 1 ? "is" : "are"
      } missing from the translation.`,
    );
  }
  if (extra.length) {
    problems.push(
      `Translation adds ${extra.length === 1 ? "argument" : "arguments"} ${formatNames(extra)} that the source does not have.`,
    );
  }
  return problems.join(" ");
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

function earlierMatchingSourceBatches(
  record: PhraseBatchRecord,
  candidates: readonly PhraseBatchRecord[],
): PhraseBatchRecord[] {
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) return [];
  return candidates
    .filter((candidate) => {
      const candidateCreatedAt = Date.parse(candidate.createdAt);
      return (
        candidate.key !== record.key &&
        candidate.repository === record.repository &&
        candidate.baseRef === record.baseRef &&
        candidate.config.projectUid === record.config.projectUid &&
        candidate.config.sourceCatalog.filename === record.config.sourceCatalog.filename &&
        candidate.sourceCommit !== record.sourceCommit &&
        Number.isFinite(candidateCreatedAt) &&
        candidateCreatedAt < createdAt
      );
    })
    .sort((left, right) => {
      const byCreatedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return byCreatedAt || right.key.localeCompare(left.key);
    });
}

function previousSourceCommit(
  record: PhraseBatchRecord,
  candidates: readonly PhraseBatchRecord[],
): string | undefined {
  return earlierMatchingSourceBatches(record, candidates)[0]?.sourceCommit;
}

function assignmentWarningKey(batchKey: string, phraseLocale: string): string {
  return JSON.stringify([batchKey, phraseLocale]);
}

const MAX_SUPERSEDED_PULL_REQUESTS_PER_LOCALE = 5;
const MAX_LISTED_DIVERGENT_MESSAGE_IDS = 20;

export interface SupersededTranslationCatalogs {
  oldSource: Catalog;
  oldTarget: Catalog;
  newSource: Catalog;
  newTarget: Catalog;
}

/**
 * Message IDs whose translation in the superseded PR would be lost by closing it: the English
 * is identical in both sources, the old translation is valid and differs from the English, and
 * the replacement does not carry the same translation.
 */
export function divergentSupersededMessageIds({
  oldSource,
  oldTarget,
  newSource,
  newTarget,
}: SupersededTranslationCatalogs): string[] {
  const invalidIds = new Set(
    checkCatalogs(oldSource, oldTarget).argumentMismatches.map((mismatch) => mismatch.id),
  );
  for (const finding of lintTargetCatalog(oldSource, oldTarget)) {
    if (finding.severity === "error") invalidIds.add(finding.id);
  }
  return Object.keys(oldTarget.messages)
    .filter((id) => {
      const english = oldSource.messages[id]?.pattern;
      const translation = oldTarget.messages[id]!.pattern;
      return (
        english !== undefined &&
        newSource.messages[id]?.pattern === english &&
        translation !== english &&
        !invalidIds.has(id) &&
        newTarget.messages[id]?.pattern !== translation
      );
    })
    .sort();
}

function divergentMessageList(ids: readonly string[]): string {
  const listed = ids
    .slice(0, MAX_LISTED_DIVERGENT_MESSAGE_IDS)
    .map((id) => "`" + id.replaceAll("`", "'") + "`")
    .join(", ");
  const more = ids.length - MAX_LISTED_DIVERGENT_MESSAGE_IDS;
  return more > 0 ? `${listed}, and ${more} more` : listed;
}

function pullRequestNumberFromUrl(pullRequestUrl: string): string {
  const segments = new URL(pullRequestUrl).pathname.split("/").filter(Boolean);
  const [, , resource, number] = segments;
  if (resource !== "pull" || !number || !/^\d+$/.test(number)) {
    throw new TypeError("Phrase pull request URL is invalid");
  }
  return number;
}

function isTransientAssignmentError(error: unknown): boolean {
  return (
    error instanceof PhraseRepositoryError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
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
      // The previous batch may predate a rename of the repository locale (such as zh-cn to zh-CN).
      const previousRepositoryLocale =
        previousRecord?.config.targetLocales.find((entry) => entry.phraseLocale === phraseLocale)
          ?.repositoryLocale ?? target.repositoryLocale;
      const previousBranch =
        previousLocale?.phase === "pr-created"
          ? (previousLocale.pullRequestBranch ??
            (previousRecord
              ? localePullRequestBranch(previousRecord.key, previousRepositoryLocale)
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deduplicateListedJobsByUid(jobs: readonly PhraseJobListPart[]): PhraseJobListPart[] {
  const jobsByUid = new Map<string, PhraseJobListPart>();
  const jobsWithoutUid: PhraseJobListPart[] = [];
  for (const job of jobs) {
    if (!isNonEmptyString(job.uid)) {
      jobsWithoutUid.push(job);
      continue;
    }
    const existing = jobsByUid.get(job.uid);
    if (!existing) {
      jobsByUid.set(job.uid, job);
      continue;
    }
    const existingLevelReported = existing.workflowLevelReported === true;
    const currentLevelReported = job.workflowLevelReported === true;
    const existingLevel = existing.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL;
    const currentLevel = job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL;
    if (
      (currentLevelReported && !existingLevelReported) ||
      (!currentLevelReported && !existingLevelReported && currentLevel < existingLevel)
    ) {
      jobsByUid.set(job.uid, job);
    }
  }
  return [...jobsByUid.values(), ...jobsWithoutUid];
}

function groupRecoveryCandidates<T>(
  candidates: readonly T[],
  getCreatedAtMs: (candidate: T) => number | undefined,
): T[][] {
  const datedCandidates: Array<{ candidate: T; createdAtMs: number }> = [];
  const candidatesWithoutDate: T[] = [];
  for (const candidate of candidates) {
    const createdAtMs = getCreatedAtMs(candidate);
    if (createdAtMs !== undefined && Number.isFinite(createdAtMs)) {
      datedCandidates.push({ candidate, createdAtMs });
    } else {
      candidatesWithoutDate.push(candidate);
    }
  }
  datedCandidates.sort((left, right) => left.createdAtMs - right.createdAtMs);

  const groups: T[][] = [];
  let previousCreatedAtMs: number | undefined;
  for (const { candidate, createdAtMs } of datedCandidates) {
    let group = groups[groups.length - 1];
    if (
      !group ||
      previousCreatedAtMs === undefined ||
      createdAtMs - previousCreatedAtMs > PHRASE_JOB_RECOVERY_CLUSTER_GAP_MS
    ) {
      group = [];
      groups.push(group);
    }
    group.push(candidate);
    previousCreatedAtMs = createdAtMs;
  }
  if (candidatesWithoutDate.length) groups.push(candidatesWithoutDate);
  return groups;
}

function describeRecoveryCandidates(candidates: readonly PhraseJobListPart[]): string {
  const uniqueCandidates = deduplicateListedJobsByUid(candidates);
  return groupRecoveryCandidates(uniqueCandidates, (job) => {
    const createdAtMs =
      typeof job.dateCreated === "string" ? Date.parse(job.dateCreated) : Number.NaN;
    return Number.isFinite(createdAtMs) ? createdAtMs : undefined;
  })
    .map((jobs) => {
      const firstCreatedAt = jobs[0]?.dateCreated;
      const firstCreatedAtMs =
        typeof firstCreatedAt === "string" ? Date.parse(firstCreatedAt) : Number.NaN;
      const groupName = !Number.isFinite(firstCreatedAtMs)
        ? "unparsable creation time"
        : `creation time ${new Date(firstCreatedAtMs).toISOString()}`;
      const entries = [...jobs]
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
  const finalJobs = finalWorkflowJobs(jobs);
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

function finalWorkflowJobs(jobs: readonly PhraseJobPart[]): PhraseJobPart[] {
  const finalLevel = Math.max(...jobs.map((job) => job.lastWorkflowLevel ?? job.workflowLevel));
  return jobs.filter((job) => job.workflowLevel === finalLevel);
}

export function phraseFinalWorkflowJob(
  jobs: readonly PhraseJobPart[],
  phraseLocale: string,
): PhraseJobPart | undefined {
  const finalJobs = finalWorkflowJobs(jobs.filter((job) => job.targetLang === phraseLocale));
  return finalJobs.length === 1 ? finalJobs[0] : undefined;
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
    return (await this.submitWithOutcome(input)).batch;
  }

  async submitWithOutcome(input: PhraseSubmitInput): Promise<PhraseSubmitOutcome> {
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
        return {
          batch: await this.resumeSubmission(existing, input.config, pins),
          createdThisRun: false,
        };
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
      fallbackAssignees: options.fallbackAssignees ?? [],
      repairScope: options.repairScope,
      assignmentWarnings: new Map(),
      supersededPullRequestWarnings: new Map(),
      sourceChangeAuthors: new Map(),
      verifiedJobs: new Map(),
      reportedJobs: new Map(),
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

    for (const stored of storedBatches) {
      const cached = context.storedBatches.get(stored.record.key);
      if (!cached || rejectedBatchKeys.has(cached.record.key)) continue;
      let { record, revision } = cached;
      for (const [phraseLocale, locale] of Object.entries(record.locales)) {
        if (locale.pullRequestAssigneesPending !== true) {
          continue;
        }
        ({ record, revision } = await this.assignPullRequestBestEffort(
          context,
          record,
          revision,
          phraseLocale,
        ));
        cached.record = record;
        cached.revision = revision;
      }
    }

    const prepassCandidates = [...context.storedBatches.values()].sort((left, right) => {
      const byCreatedAt = Date.parse(right.record.createdAt) - Date.parse(left.record.createdAt);
      return byCreatedAt || right.record.key.localeCompare(left.record.key);
    });
    const prepassCleanupCounts = new Map<string, number>();
    const prepassReplacementUrls = new Set<string>();
    for (const stored of prepassCandidates) {
      const cached = context.storedBatches.get(stored.record.key);
      if (!cached || rejectedBatchKeys.has(cached.record.key)) continue;
      const { record } = cached;
      if (record.phase === "superseded") continue;
      if (hasPhrasePins(context.pins)) {
        try {
          assertExpectedBatchConfig(record, context.pins);
        } catch {
          continue;
        }
      }
      for (const [phraseLocale, locale] of Object.entries(record.locales)) {
        if (
          locale.phase !== "pr-created" ||
          !locale.pullRequestUrl ||
          locale.pullRequestReexportDelegated ||
          (locale.pullRequestBatchKey && locale.pullRequestBatchKey !== record.key)
        ) {
          continue;
        }
        const replacementKey = JSON.stringify([phraseLocale, locale.pullRequestUrl]);
        if (prepassReplacementUrls.has(replacementKey)) continue;
        prepassReplacementUrls.add(replacementKey);
        const alreadyProcessed = prepassCleanupCounts.get(phraseLocale) ?? 0;
        const remaining = MAX_SUPERSEDED_PULL_REQUESTS_PER_LOCALE - alreadyProcessed;
        if (remaining <= 0) continue;
        const processed = await this.processSupersededPullRequestsForLocale(
          context,
          record,
          phraseLocale,
          locale.pullRequestUrl,
          remaining,
        );
        prepassCleanupCounts.set(phraseLocale, alreadyProcessed + processed);
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
    for (const warning of context.assignmentWarnings.values()) {
      let matchingResult: PhraseReconcileResult | undefined;
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index]!;
        if (result.batchKey === warning.batchKey && result.phraseLocale === warning.phraseLocale) {
          matchingResult = result;
          break;
        }
      }
      if (matchingResult) {
        matchingResult.reason = [matchingResult.reason, warning.reason].filter(Boolean).join("; ");
        continue;
      }
      const locale = context.storedBatches.get(warning.batchKey)?.record.locales[
        warning.phraseLocale
      ];
      if (locale?.phase === "pr-created") {
        results.push({
          batchKey: warning.batchKey,
          phraseLocale: warning.phraseLocale,
          phase: "pr-created",
          ...(locale.pullRequestUrl ? { pullRequestUrl: locale.pullRequestUrl } : {}),
          reason: warning.reason,
        });
      }
    }
    for (const warning of context.supersededPullRequestWarnings.values()) {
      let matchingResult: PhraseReconcileResult | undefined;
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index]!;
        if (result.batchKey === warning.batchKey && result.phraseLocale === warning.phraseLocale) {
          matchingResult = result;
          break;
        }
      }
      if (matchingResult) {
        matchingResult.reason = [matchingResult.reason, warning.reason].filter(Boolean).join("; ");
        continue;
      }
      const locale = context.storedBatches.get(warning.batchKey)?.record.locales[
        warning.phraseLocale
      ];
      if (locale?.phase === "pr-created") {
        results.push({
          batchKey: warning.batchKey,
          phraseLocale: warning.phraseLocale,
          phase: "pr-created",
          ...(locale.pullRequestUrl ? { pullRequestUrl: locale.pullRequestUrl } : {}),
          reason: warning.reason,
        });
      }
    }
    return results.map((result) => {
      const stored = context.storedBatches.get(result.batchKey);
      if (!stored) return result;
      const { record } = stored;
      const locale = result.phraseLocale ? record.locales[result.phraseLocale] : undefined;
      const target = result.phraseLocale
        ? record.config.targetLocales.find(
            (candidate) => candidate.phraseLocale === result.phraseLocale,
          )
        : undefined;
      const jobs =
        context.reportedJobs.get(record.key) ?? context.verifiedJobs.get(record.key) ?? record.jobs;
      const finalJob = result.phraseLocale
        ? phraseFinalWorkflowJob(jobs, result.phraseLocale)
        : undefined;
      const validationErrorCount = locale?.validationErrors?.length ?? 0;
      const validationWarningCount = locale?.validationWarnings?.length ?? 0;
      return {
        ...result,
        ...(result.phase === "pr-created" && validationErrorCount
          ? { phase: "invalid-translation" as const }
          : {}),
        ...(target ? { repositoryLocale: result.repositoryLocale ?? target.repositoryLocale } : {}),
        ...(finalJob?.uid || result.jobUid ? { jobUid: result.jobUid ?? finalJob?.uid } : {}),
        ...(finalJob?.status || result.jobStatus
          ? { jobStatus: result.jobStatus ?? finalJob?.status }
          : {}),
        projectUid: result.projectUid ?? record.config.projectUid,
        region: result.region ?? record.config.region,
        sourceCommit: result.sourceCommit ?? record.sourceCommit,
        createdAt: result.createdAt ?? record.createdAt,
        validationErrorCount: result.validationErrorCount ?? validationErrorCount,
        validationWarningCount: result.validationWarningCount ?? validationWarningCount,
        ...(result.pullRequestUrl || locale?.pullRequestUrl
          ? { pullRequestUrl: result.pullRequestUrl ?? locale?.pullRequestUrl }
          : {}),
        ...(result.pullRequestAssignees?.length || locale?.pullRequestAssignees?.length
          ? {
              pullRequestAssignees: result.pullRequestAssignees ?? locale?.pullRequestAssignees,
            }
          : {}),
      };
    });
  }

  /** Never throws: assignment problems become warnings on this locale's result. */
  private async assignPullRequestBestEffort(
    context: PhraseReconcileContext,
    record: PhraseBatchRecord,
    revision: string,
    phraseLocale: string,
  ): Promise<{ record: PhraseBatchRecord; revision: string }> {
    let warning: string | undefined;
    try {
      const assignment = await this.assignPendingPullRequest(
        context,
        record,
        revision,
        phraseLocale,
      );
      ({ record, revision, warning } = assignment);
    } catch (error) {
      warning = `Could not persist locale PR assignment status for ${phraseLocale}; assignment will retry on the next reconcile: ${safeFailureReason(error)}`;
    }
    if (warning) {
      context.assignmentWarnings.set(assignmentWarningKey(record.key, phraseLocale), {
        batchKey: record.key,
        phraseLocale,
        reason: warning,
      });
    }
    return { record, revision };
  }

  private async assignPendingPullRequest(
    context: PhraseReconcileContext,
    record: PhraseBatchRecord,
    revision: string,
    phraseLocale: string,
  ): Promise<{ record: PhraseBatchRecord; revision: string; warning?: string }> {
    const fallbackAssignees = context.fallbackAssignees;
    const locale = record.locales[phraseLocale];
    if (!locale || locale.pullRequestAssigneesPending !== true) return { record, revision };

    const warningReasons: string[] = [];
    let authorLogins: string[] = [];
    let assignedLogins: string[] = [];
    const transientWarning = (error: unknown) =>
      `Could not assign locale PR for ${phraseLocale}; assignment will retry on the next reconcile: ${[
        ...warningReasons,
        safeFailureReason(error),
      ].join("; ")}`;

    if (!locale.pullRequestUrl) {
      warningReasons.push("locale PR URL is missing");
    } else {
      try {
        let authors = context.sourceChangeAuthors.get(record.key);
        if (!authors) {
          const baseCommit = previousSourceCommit(
            record,
            [...context.storedBatches.values()].map(({ record: candidate }) => candidate),
          );
          authors = this.dependencies.repository.listSourceChangeAuthors({
            path: sourceInputPath(record.config),
            headCommit: record.sourceCommit,
            ...(baseCommit ? { baseCommit } : {}),
          });
          context.sourceChangeAuthors.set(record.key, authors);
        }
        authorLogins = await authors;
      } catch (error) {
        if (isTransientAssignmentError(error)) {
          return { record, revision, warning: transientWarning(error) };
        }
        warningReasons.push(safeFailureReason(error));
      }

      if (authorLogins.length) {
        try {
          assignedLogins = await this.dependencies.repository.addPullRequestAssignees(
            locale.pullRequestUrl,
            authorLogins,
          );
        } catch (error) {
          if (isTransientAssignmentError(error)) {
            return { record, revision, warning: transientWarning(error) };
          }
          warningReasons.push(safeFailureReason(error));
        }
      }

      if (!assignedLogins.length && fallbackAssignees.length) {
        try {
          assignedLogins = await this.dependencies.repository.addPullRequestAssignees(
            locale.pullRequestUrl,
            fallbackAssignees,
          );
        } catch (error) {
          if (isTransientAssignmentError(error)) {
            return { record, revision, warning: transientWarning(error) };
          }
          warningReasons.push(safeFailureReason(error));
        }
      }

      if (
        !assignedLogins.length &&
        !warningReasons.length &&
        (authorLogins.length > 0 || fallbackAssignees.length > 0)
      ) {
        warningReasons.push("GitHub did not assign any of the requested users");
      }
    }

    const warning = warningReasons.length
      ? `Could not assign locale PR for ${phraseLocale}: ${warningReasons.join("; ")}`
      : undefined;
    const updatedLocale = { ...locale };
    delete updatedLocale.pullRequestAssigneesPending;
    if (assignedLogins.length) updatedLocale.pullRequestAssignees = [...assignedLogins];
    const updatedRecord: PhraseBatchRecord = {
      ...record,
      locales: { ...record.locales, [phraseLocale]: updatedLocale },
    };
    const updatedRevision = await this.dependencies.state.updateBatch(updatedRecord, revision);
    return {
      record: updatedRecord,
      revision: updatedRevision,
      ...(warning ? { warning } : {}),
    };
  }

  private async processSupersededPullRequestsForLocale(
    context: PhraseReconcileContext,
    replacementRecord: PhraseBatchRecord,
    phraseLocale: string,
    replacementPullRequestUrl: string,
    limit = MAX_SUPERSEDED_PULL_REQUESTS_PER_LOCALE,
  ): Promise<number> {
    let replacementNumber: string;
    try {
      replacementNumber = pullRequestNumberFromUrl(replacementPullRequestUrl);
    } catch (error) {
      this.addSupersededPullRequestWarning(
        context,
        replacementRecord,
        phraseLocale,
        replacementPullRequestUrl,
        error,
      );
      return 0;
    }

    const candidateRecords = earlierMatchingSourceBatches(
      replacementRecord,
      [...context.storedBatches.values()].map(({ record }) => record),
    )
      .filter((record) => record.phase === "superseded")
      .map((record) => context.storedBatches.get(record.key))
      .filter((stored): stored is StoredPhraseBatch => stored !== undefined)
      .filter((stored) => {
        const locale = stored.record.locales[phraseLocale];
        return (
          locale !== undefined &&
          Boolean(locale.pullRequestUrl) &&
          locale.pullRequestUrl !== replacementPullRequestUrl &&
          !locale.pullRequestMerged &&
          !locale.pullRequestFinalized &&
          !locale.pullRequestReexportDelegated &&
          locale.pullRequestSupersededReviewerCommits !== true
        );
      })
      .slice(0, limit);

    let replacementSnapshot: Promise<string | undefined> | undefined;
    const replacementSnapshotSha = () =>
      (replacementSnapshot ??= this.supersedingReplacementSnapshot(replacementPullRequestUrl));

    const replacementNotice = `Replaced by #${replacementNumber} (batch \`${replacementRecord.key.slice(0, 12)}\`, source \`${replacementRecord.sourceCommit.slice(0, 7)}\`).`;

    for (const stored of candidateRecords) {
      const oldLocale = stored.record.locales[phraseLocale];
      if (!oldLocale?.pullRequestUrl) continue;
      try {
        const pullRequestState = await this.dependencies.repository.getPullRequestState(
          oldLocale.pullRequestUrl,
        );
        if (pullRequestState.state !== "open") {
          await this.saveSupersededLocaleState(context, stored, phraseLocale, {
            pullRequestFinalized: true,
            ...(pullRequestState.state === "merged" ? { pullRequestMerged: true } : {}),
          });
          continue;
        }

        const ownedCommitShas = mergeToolingCommitShas(
          oldLocale.toolingCommitSha ? [oldLocale.toolingCommitSha] : undefined,
          oldLocale.toolingCommitShas,
          oldLocale.pendingToolingCommitSha ? [oldLocale.pendingToolingCommitSha] : undefined,
        );
        const headIsToolingOwned = ownedCommitShas.includes(pullRequestState.headSha);
        if (headIsToolingOwned) {
          const divergentIds = await this.divergentSupersededTranslations(
            stored.record,
            replacementRecord,
            phraseLocale,
            pullRequestState.headSha,
            replacementPullRequestUrl,
            replacementSnapshotSha,
          );
          // A replacement closed without merging delivered nothing, so this PR stays open until
          // a later replacement carries its translations.
          if (divergentIds === undefined) continue;
          if (divergentIds.length) {
            if (
              stableJson(oldLocale.pullRequestSupersededDivergentIds ?? []) !==
              stableJson(divergentIds)
            ) {
              const notice =
                `${replacementNotice} Left open because #${replacementNumber} has different ` +
                `translations for ${divergentIds.length} message${divergentIds.length === 1 ? "" : "s"} ` +
                `whose English did not change: ${divergentMessageList(divergentIds)}. ` +
                `Copy the translations you want to keep into the newer Phrase job; this PR closes ` +
                `once #${replacementNumber} carries them. Close it yourself if the newer ` +
                `translations are intended.`;
              const posted = await this.postSupersededPullRequestNotice(
                context,
                stored,
                phraseLocale,
                oldLocale.pullRequestUrl,
                notice,
              );
              if (!posted) continue;
              await this.saveSupersededLocaleState(context, stored, phraseLocale, {
                pullRequestSupersededNoticePosted: true,
                pullRequestSupersededDivergentIds: divergentIds,
              });
            }
            continue;
          }
          if (oldLocale.pullRequestSupersededDivergentIds?.length) {
            const notice = `${replacementNotice} This PR is closed because #${replacementNumber} now carries every translation from it.`;
            const posted = await this.postSupersededPullRequestNotice(
              context,
              stored,
              phraseLocale,
              oldLocale.pullRequestUrl,
              notice,
            );
            if (!posted) continue;
            await this.saveSupersededLocaleState(context, stored, phraseLocale, {
              pullRequestSupersededDivergentIds: [],
            });
          } else if (oldLocale.pullRequestSupersededNoticePosted !== true) {
            const notice = `${replacementNotice} This PR is closed because a newer source catalog superseded batch \`${stored.record.key.slice(0, 12)}\`.`;
            const posted = await this.postSupersededPullRequestNotice(
              context,
              stored,
              phraseLocale,
              oldLocale.pullRequestUrl,
              notice,
            );
            if (!posted) continue;
            await this.saveSupersededLocaleState(context, stored, phraseLocale, {
              pullRequestSupersededNoticePosted: true,
            });
          }
          await this.dependencies.repository.closePullRequest(oldLocale.pullRequestUrl);
          await this.saveSupersededLocaleState(context, stored, phraseLocale, {
            pullRequestFinalized: true,
          });
          continue;
        }

        if (oldLocale.pullRequestSupersededNoticePosted !== true) {
          const notice = `${replacementNotice} Left open because it has commits not made by i18n-pipeline; close it when you no longer need them.`;
          const posted = await this.postSupersededPullRequestNotice(
            context,
            stored,
            phraseLocale,
            oldLocale.pullRequestUrl,
            notice,
          );
          if (!posted) continue;
        }
        await this.saveSupersededLocaleState(context, stored, phraseLocale, {
          pullRequestSupersededNoticePosted: true,
          pullRequestSupersededReviewerCommits: true,
        });
      } catch (error) {
        this.addSupersededPullRequestWarning(
          context,
          replacementRecord,
          phraseLocale,
          oldLocale.pullRequestUrl,
          error,
        );
      }
    }
    return candidateRecords.length;
  }

  /**
   * The commit holding what the replacement PR delivers: its head while open, the merge commit
   * once merged (so reviewer changes count), and `undefined` when it was closed without merging.
   * Throws when a merged PR reports no commit, so cleanup retries instead of guessing.
   */
  private async supersedingReplacementSnapshot(
    replacementPullRequestUrl: string,
  ): Promise<string | undefined> {
    const state = await this.dependencies.repository.getPullRequestState(replacementPullRequestUrl);
    if (state.state === "open") return state.headSha;
    if (state.state === "closed") return undefined;
    const sha = state.mergeCommitSha ?? state.headSha;
    if (!sha) {
      throw new PhraseRepositoryError(
        `Could not find the merged commit of ${replacementPullRequestUrl} to compare translations`,
        404,
      );
    }
    return sha;
  }

  /**
   * Compares the superseded PR's catalog with its replacement's before closing it. A missing
   * old catalog has nothing to lose; a replacement closed without merging carries nothing and
   * returns `undefined`; any other unreadable input throws, so the PR stays open and cleanup
   * retries on the next reconcile.
   */
  private async divergentSupersededTranslations(
    oldRecord: PhraseBatchRecord,
    replacementRecord: PhraseBatchRecord,
    phraseLocale: string,
    oldHeadSha: string,
    replacementPullRequestUrl: string,
    replacementSnapshotSha: () => Promise<string | undefined>,
  ): Promise<string[] | undefined> {
    const oldTarget = oldRecord.config.targetLocales.find(
      (target) => target.phraseLocale === phraseLocale,
    );
    const newTarget = replacementRecord.config.targetLocales.find(
      (target) => target.phraseLocale === phraseLocale,
    );
    if (!oldTarget || !newTarget) return [];
    const oldTargetBytes = await this.dependencies.repository.readFile(
      oldTarget.outputPath,
      oldHeadSha,
    );
    if (!oldTargetBytes) return [];
    const replacementSha = await replacementSnapshotSha();
    if (!replacementSha) return undefined;

    const [oldSource, newSource, newTargetBytes] = await Promise.all([
      this.readSourceCatalog(oldRecord.config, oldRecord.sourceCommit),
      this.readSourceCatalog(replacementRecord.config, replacementRecord.sourceCommit),
      this.dependencies.repository.readFile(newTarget.outputPath, replacementSha),
    ]);
    const missing = !oldSource.bytes
      ? `source catalog at ${oldRecord.sourceCommit}`
      : !newSource.bytes
        ? `source catalog at ${replacementRecord.sourceCommit}`
        : !newTargetBytes
          ? `${newTarget.outputPath} at ${replacementSha.slice(0, 7)} of ${replacementPullRequestUrl}`
          : undefined;
    if (missing) {
      throw new PhraseRepositoryError(`Could not read the ${missing} to compare translations`, 404);
    }
    return divergentSupersededMessageIds({
      oldSource: this.readCatalog(oldRecord.config, "source", oldSource.bytes!),
      oldTarget: this.readCatalog(oldRecord.config, oldTarget, oldTargetBytes),
      newSource: this.readCatalog(replacementRecord.config, "source", newSource.bytes!),
      newTarget: this.readCatalog(replacementRecord.config, newTarget, newTargetBytes!),
    });
  }

  private readCatalog(
    config: PhraseWorkflowConfig,
    target: PhraseTargetLocale | "source",
    bytes: Uint8Array,
  ): Catalog {
    const adapter = this.dependencies.catalogAdapters.get(
      target === "source" ? config.sourceCatalog.adapter : targetAdapterId(config),
    );
    const context =
      target === "source"
        ? {
            locale: config.sourceCatalog.locale,
            role: "source" as const,
            options: config.sourceCatalog.options ?? {},
          }
        : {
            locale: target.repositoryLocale,
            role: "target" as const,
            options: config.targetOptions ?? {},
          };
    return adapter.read(
      parseCatalogDocument(new TextDecoder().decode(bytes), adapter, context),
      context,
    );
  }

  private async postSupersededPullRequestNotice(
    context: PhraseReconcileContext,
    stored: StoredPhraseBatch,
    phraseLocale: string,
    pullRequestUrl: string,
    body: string,
  ): Promise<boolean> {
    const posted = await this.dependencies.repository.createPullRequestComment(
      pullRequestUrl,
      body,
    );
    if (posted) return true;

    const state = await this.dependencies.repository.getPullRequestState(pullRequestUrl);
    if (state.state === "open") {
      throw new PhraseRepositoryError(
        "GitHub did not confirm the superseded locale PR comment",
        500,
      );
    }
    await this.saveSupersededLocaleState(context, stored, phraseLocale, {
      pullRequestFinalized: true,
      ...(state.state === "merged" ? { pullRequestMerged: true } : {}),
    });
    return false;
  }

  private async saveSupersededLocaleState(
    context: PhraseReconcileContext,
    stored: StoredPhraseBatch,
    phraseLocale: string,
    update: Partial<PhraseLocaleRecord>,
  ): Promise<void> {
    const locale = stored.record.locales[phraseLocale];
    if (!locale) return;
    const updatedRecord: PhraseBatchRecord = {
      ...stored.record,
      locales: {
        ...stored.record.locales,
        [phraseLocale]: { ...locale, ...update },
      },
    };
    const revision = await this.dependencies.state.updateBatch(updatedRecord, stored.revision);
    stored.record = updatedRecord;
    stored.revision = revision;
    context.storedBatches.set(updatedRecord.key, stored);
  }

  private addSupersededPullRequestWarning(
    context: PhraseReconcileContext,
    replacementRecord: PhraseBatchRecord,
    phraseLocale: string,
    oldPullRequestUrl: string,
    error: unknown,
  ): void {
    const key = assignmentWarningKey(replacementRecord.key, phraseLocale);
    const warning = {
      batchKey: replacementRecord.key,
      phraseLocale,
      reason: `Could not process superseded locale PR ${oldPullRequestUrl}; cleanup will retry on the next reconcile: ${safeFailureReason(error)}`,
    };
    const existing = context.supersededPullRequestWarnings.get(key);
    if (existing) {
      existing.reason = [existing.reason, warning.reason].join("; ");
    } else {
      context.supersededPullRequestWarnings.set(key, warning);
    }
  }

  private async createSubmission(
    input: PhraseSubmitInput,
    key: string,
    attempt: number,
    sourceDigest: string,
    previousRecord?: PhraseBatchRecord,
    pins: PhrasePinOptions = {},
  ): Promise<PhraseSubmitOutcome> {
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
      if (raced) {
        return {
          batch: await this.resumeSubmission(raced, input.config, pins),
          createdThisRun: false,
        };
      }
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
    return { batch: finished.record, createdThisRun: true };
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
    const listedJobUids = new Set<string>();
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
      let newUidCount = 0;
      for (const job of levelJobs) {
        if (isNonEmptyString(job.uid) && !listedJobUids.has(job.uid)) {
          listedJobUids.add(job.uid);
          newUidCount += 1;
        }
      }
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
      if (newUidCount === 0) break;
      if (lastWorkflowLevel !== undefined && workflowLevel >= lastWorkflowLevel) break;
    }
    const uniqueListedJobs = deduplicateListedJobsByUid(listedJobs);
    const claimedJobUids = new Set(
      otherRecords.flatMap((other) => other.jobs.map((job) => job.uid)),
    );
    const earliestCandidateTime = createdAtMs - PHRASE_JOB_CREATION_CLOCK_SKEW_MS;
    const candidates = uniqueListedJobs.flatMap((job) => {
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

    const expectedTargetLangs = pendingTargetLangs(record);
    const effectiveLastWorkflowLevel =
      lastWorkflowLevel ??
      Math.max(
        PHRASE_JOB_FIRST_WORKFLOW_LEVEL,
        ...uniqueListedJobs.map((job) => job.workflowLevel ?? PHRASE_JOB_FIRST_WORKFLOW_LEVEL),
      );
    const expectedTargetLangSet = new Set(expectedTargetLangs);
    let hasDuplicateLocale = false;
    const recoveryCandidates = candidates.map(({ job, jobCreatedAtMs }) => {
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
      return { job: phraseJob, jobCreatedAtMs: jobCreatedAtMs! };
    });
    const matchingGroups = groupRecoveryCandidates(
      recoveryCandidates,
      (candidate) => candidate.jobCreatedAtMs,
    ).flatMap((jobs) => {
      const jobsByWorkflowLevel = new Map<number, PhraseJobPart[]>();
      for (const { job } of jobs) {
        const levelJobs = jobsByWorkflowLevel.get(job.workflowLevel) ?? [];
        levelJobs.push(job);
        jobsByWorkflowLevel.set(job.workflowLevel, levelJobs);
      }
      let matches = true;
      for (
        let workflowLevel = PHRASE_JOB_FIRST_WORKFLOW_LEVEL;
        workflowLevel <= effectiveLastWorkflowLevel;
        workflowLevel += 1
      ) {
        const levelJobs = jobsByWorkflowLevel.get(workflowLevel);
        if (!levelJobs) {
          matches = false;
          continue;
        }
        const localeCounts = new Map<string, number>();
        for (const job of levelJobs) {
          localeCounts.set(job.targetLang, (localeCounts.get(job.targetLang) ?? 0) + 1);
        }
        if ([...localeCounts.values()].some((count) => count > 1)) hasDuplicateLocale = true;
        if (
          levelJobs.length !== expectedTargetLangs.length ||
          expectedTargetLangs.some((targetLang) => localeCounts.get(targetLang) !== 1) ||
          [...localeCounts.keys()].some((targetLang) => !expectedTargetLangSet.has(targetLang))
        ) {
          matches = false;
        }
      }
      if ([...jobsByWorkflowLevel.keys()].some((level) => level > effectiveLastWorkflowLevel)) {
        matches = false;
      }
      return matches ? [{ jobs: jobs.map(({ job }) => job) }] : [];
    });

    if (matchingGroups.length > 1 || (candidates.length > 0 && matchingGroups.length === 0)) {
      const reason =
        matchingGroups.length > 1
          ? "More than one Phrase creation-time group matches this batch"
          : hasDuplicateLocale
            ? "More than one Phrase job matches a locale within a Phrase creation-time group"
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
      // Older records inferred the PR branch from the config's repository locale. Preserve it
      // before a canonical locale rename changes that inference.
      for (const target of record.config.targetLocales) {
        const locale = record.locales[target.phraseLocale];
        if (locale?.phase === "pr-created" && !locale.pullRequestBranch) {
          locale.pullRequestBranch = localePullRequestBranch(
            locale.pullRequestBatchKey ?? record.key,
            target.repositoryLocale,
          );
        }
      }
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
      context.reportedJobs.set(record.key, jobs);
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
        const { content, warnings, errors, findings } = await this.exportTarget(
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
        // Batches submitted before FEO locale ids had to be canonical may hold `zh-cn`; inline those
        // under the canonical id, which also renames an existing block.
        const feoLocale = suggestFeoLocale(target.repositoryLocale) ?? target.repositoryLocale;
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
                inlineFeoLocale(template, descriptors, translated, feoLocale),
              ),
            });
            frontendTemplateData = { path, descriptors, translated };
            const overlong = overlongFeoTranslationsWarning(feoLocale, translated);
            if (overlong) {
              warnings.push(overlong);
              findings.push({ severity: "warning", problem: overlong });
            }
          } catch (error) {
            const problem = `Frontend template inline failed: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(problem);
            findings.push({ severity: "error", problem });
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
                  feoLocale,
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
        const generatedYamlNote =
          record.config.frontendTemplate && errors.length
            ? "Generated Frontend YAML was not updated for this export. Any existing locale block may reflect an earlier valid export and must not be merged with this catalog."
            : undefined;
        const body =
          `Phrase project: ${record.config.projectUid}\n` +
          `Batch: ${pullRequestBatchKey}\n` +
          `Source commit: ${record.sourceCommit}\n` +
          `Source SHA-256: ${record.sourceDigest}\n` +
          `Final job: ${ready.finalJob.uid}\n` +
          "\nReview validation findings before marking ready or merging. " +
          "Corrections in Phrase are pulled into this PR on later reconciliation runs. " +
          "Tooling never marks this PR ready automatically.\n" +
          (generatedYamlNote ? `\n${generatedYamlNote}\n` : "\n") +
          translationFindingsStatusLine(findings);
        const findingsDigest = digest(
          new TextEncoder().encode(
            stableJson({
              locale: target.repositoryLocale,
              batchKey: record.key,
              finalJobUid: ready.finalJob.uid,
              findings,
            }),
          ),
        );
        const reportComment = translationFindingsComment(
          {
            locale: target.repositoryLocale,
            batchKey: pullRequestBatchKey,
            sourceCommit: record.sourceCommit,
            projectUid: record.config.projectUid,
            finalJobUid: ready.finalJob.uid,
            findings,
            generatedYamlNote:
              record.config.frontendTemplate && errors.length ? generatedYamlNote : undefined,
          },
          findingsDigest,
        );
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
            phase: errors.length ? "invalid-translation" : "pr-created",
            pullRequestUrl,
            ...(errors.length ? { reason: errors.join("; ") } : {}),
          });
        const setPullRequestCommentPending = async (pending: boolean) => {
          const locale = record.locales[target.phraseLocale];
          if (
            !locale ||
            (pending
              ? locale.pullRequestCommentPending === true
              : locale.pullRequestCommentPending !== true)
          ) {
            return;
          }
          const updatedLocale = { ...locale };
          if (pending) updatedLocale.pullRequestCommentPending = true;
          else delete updatedLocale.pullRequestCommentPending;
          const updatedRecord: PhraseBatchRecord = {
            ...record,
            locales: { ...record.locales, [target.phraseLocale]: updatedLocale },
          };
          revision = await this.dependencies.state.updateBatch(updatedRecord, revision);
          record = updatedRecord;
          const cached = context.storedBatches.get(record.key);
          if (cached) {
            cached.record = record;
            cached.revision = revision;
          }
        };
        const finishDelivery = async (pullRequestUrl: string, pendingErrors: unknown[] = []) => {
          let commentFailure: { error: unknown } | undefined;
          try {
            const latestComment =
              await this.dependencies.repository.findLatestBotPullRequestComment(
                pullRequestUrl,
                TRANSLATION_FINDINGS_COMMENT_MARKER,
              );
            if (commentDigest(latestComment) !== findingsDigest) {
              await this.dependencies.repository.createPullRequestComment(
                pullRequestUrl,
                reportComment,
              );
            }
          } catch (error) {
            commentFailure = { error };
          }
          await setPullRequestCommentPending(Boolean(commentFailure));
          const failures = [...pendingErrors, ...(commentFailure ? [commentFailure.error] : [])];
          if (failures.length) {
            push({ phase: "retrying", reason: failures.map(safeFailureReason).join("; ") });
          } else {
            reportDelivery(pullRequestUrl);
          }
        };
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
            delete updatedLocale.pullRequestCommentPending;
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
          } else if (update.changed) {
            if (update.bodyUpdated) delete updatedLocale.pullRequestBodyPending;
            else updatedLocale.pullRequestBodyPending = true;
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
            await finishDelivery(
              existingLocale.pullRequestUrl,
              update.bodyError
                ? [update.bodyError]
                : update.bodyUpdated
                  ? []
                  : [
                      new PhraseRepositoryError(
                        "GitHub did not confirm the updated locale pull request description",
                        500,
                      ),
                    ],
            );
          } else if (existingLocale.pullRequestBodyPending || metadataChanged) {
            let bodyUpdated = false;
            let bodyError: unknown;
            try {
              bodyUpdated = await this.dependencies.repository.updatePullRequestBody(
                existingLocale.pullRequestUrl,
                body,
                title,
              );
            } catch (error) {
              bodyError = error;
            }
            if (bodyUpdated) delete updatedLocale.pullRequestBodyPending;
            else if (bodyError) updatedLocale.pullRequestBodyPending = true;
            else {
              updatedLocale.pullRequestFinalized = true;
              delete updatedLocale.pullRequestCommentPending;
            }
            record.locales[target.phraseLocale] = updatedLocale;
            revision = await this.dependencies.state.updateBatch(record, revision);
            if (bodyUpdated || bodyError) {
              await finishDelivery(existingLocale.pullRequestUrl, bodyError ? [bodyError] : []);
            }
          } else {
            if (
              existingLocale.toolingCommitSha !== update.toolingCommitSha ||
              existingLocale.pendingToolingCommitSha !== undefined
            ) {
              record.locales[target.phraseLocale] = updatedLocale;
              revision = await this.dependencies.state.updateBatch(record, revision);
            }
            await finishDelivery(existingLocale.pullRequestUrl);
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
            ...(created.pullRequestCreated ? { pullRequestAssigneesPending: true } : {}),
            ...(created.toolingCommitSha ? { toolingCommitSha: created.toolingCommitSha } : {}),
            ...(created.pullRequestFinalized ? { pullRequestFinalized: true } : {}),
            ...(created.pullRequestMerged ? { pullRequestMerged: true } : {}),
            ...(created.bodyError || created.pullRequestFinalized
              ? { pullRequestBodyPending: true }
              : {}),
          };
          delete localeRecord.pendingToolingCommitSha;
          if (created.pullRequestFinalized) delete localeRecord.pullRequestCommentPending;
          record.locales[target.phraseLocale] = localeRecord;
          revision = await this.dependencies.state.updateBatch(record, revision);
          const cached = context.storedBatches.get(record.key);
          if (cached) {
            cached.record = record;
            cached.revision = revision;
          }
          if (created.pullRequestCreated) {
            ({ record, revision } = await this.assignPullRequestBestEffort(
              context,
              record,
              revision,
              target.phraseLocale,
            ));
            if (cached) {
              cached.record = record;
              cached.revision = revision;
            }
            await this.processSupersededPullRequestsForLocale(
              context,
              record,
              target.phraseLocale,
              created.pullRequestUrl,
            );
          }
          if (created.pullRequestFinalized) {
            if (created.bodyError) {
              push({ phase: "retrying", reason: safeFailureReason(created.bodyError) });
            } else {
              reportDelivery(created.pullRequestUrl);
            }
          } else {
            await finishDelivery(
              created.pullRequestUrl,
              created.bodyError ? [created.bodyError] : [],
            );
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
  ): Promise<{
    content: Uint8Array;
    warnings: string[];
    errors: string[];
    findings: TranslationFinding[];
  }> {
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
      const findings: TranslationFinding[] = [];
      if (comparison.missingIds.length)
        problems.push(`missing IDs: ${comparison.missingIds.join(", ")}`);
      for (const id of comparison.missingIds) {
        findings.push({
          severity: "error",
          messageId: id,
          problem: "Message is missing from the translation.",
          source: sourceCatalog.messages[id]!.pattern,
        });
      }
      if (comparison.extraIds.length) problems.push(`extra IDs: ${comparison.extraIds.join(", ")}`);
      for (const id of comparison.extraIds) {
        findings.push({
          severity: "error",
          messageId: id,
          problem: "Translation has a message the source does not have.",
          translation: targetCatalog.messages[id]!.pattern,
        });
      }
      if (comparison.argumentMismatches.length) {
        problems.push(
          `ICU argument mismatches: ${comparison.argumentMismatches
            .map((item) => describeArgumentMismatch(sourceCatalog.messages[item.id]!.pattern, item))
            .join(", ")}`,
        );
      }
      for (const mismatch of comparison.argumentMismatches) {
        findings.push({
          severity: "error",
          messageId: mismatch.id,
          problem: argumentMismatchProblem(mismatch),
          source: sourceCatalog.messages[mismatch.id]!.pattern,
          translation: targetCatalog.messages[mismatch.id]!.pattern,
        });
      }
      const warnings: string[] = [];
      for (const finding of lintTargetCatalog(sourceCatalog, targetCatalog)) {
        (finding.severity === "error" ? problems : warnings).push(finding.message);
        findings.push({
          severity: finding.severity,
          messageId: finding.id,
          problem: capitalizeFirst(
            finding.message.startsWith(`"${finding.id}": `)
              ? finding.message.slice(finding.id.length + 4)
              : finding.message,
          ),
          source: sourceCatalog.messages[finding.id]!.pattern,
          translation: targetCatalog.messages[finding.id]!.pattern,
        });
      }
      const serialized = serializeCatalogDocument(
        targetAdapter.write(targetCatalog, context),
        targetAdapter,
        context,
      );
      return {
        content: new TextEncoder().encode(serialized),
        warnings,
        errors: problems,
        findings,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const problem = `Downloaded ${target.phraseLocale} catalog failed validation: ${detail}`;
      return {
        content: targetBytes,
        warnings: [],
        errors: [problem],
        findings: [{ severity: "error", problem }],
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
