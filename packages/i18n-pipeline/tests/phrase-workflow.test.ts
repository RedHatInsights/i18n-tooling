import { describe, expect, it } from "vitest";
import { CatalogAdapterRegistry } from "../src/index.js";
import { PhraseApiError, PhraseAuthError, type PhraseJobListPart } from "../src/phrase-client.js";
import {
  PhraseBatchStateConflictError,
  PhraseRepositoryError,
  PhraseWorkflow,
  PhraseWorkflowError,
  type PhraseBatchRecord,
  type PhraseBatchStateStore,
  type PhraseLocalePullRequestCreated,
  type PhraseLocalePullRequest,
  type PhraseLocalePullRequestUpdate,
  type PhraseLocalePullRequestUpdateResult,
  type PhrasePullRequestState,
  type PhraseWorkflowConfig,
  type PhraseWorkflowRepository,
} from "../src/phrase-workflow.js";

const sourceBytes = new TextEncoder().encode(
  '{"greeting":{"defaultMessage":"Hello {name}","description":"Greeting"}}',
);
const config: PhraseWorkflowConfig = {
  projectUid: "project-uid",
  region: "us",
  sourceCatalog: {
    path: "locales/translation-template.json",
    filename: "translation-template.json",
    adapter: "formatjs-json",
    locale: "en",
    importSettingsUid: "formatjs-settings",
  },
  targetAdapter: "formatjs-json",
  targetLocales: [{ phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" }],
  completionPolicy: { default: "per-locale" },
};

class MemoryStateStore implements PhraseBatchStateStore {
  readonly records = new Map<string, { record: PhraseBatchRecord; revision: string }>();
  readonly corruptKeys = new Set<string>();
  conflictOnPhase?: string;
  failUpdateMatching?: (record: PhraseBatchRecord) => boolean;
  beforeNextUpdateConflict?: (store: MemoryStateStore, record: PhraseBatchRecord) => void;
  beforeEveryUpdateConflict?: (store: MemoryStateStore, record: PhraseBatchRecord) => void;
  writes = 0;

  constructor(private readonly events: string[] = []) {}

  async readBatch(key: string) {
    if (this.corruptKeys.has(key)) throw new Error("Phrase state file is not valid JSON");
    const stored = this.records.get(key);
    return stored && { record: structuredClone(stored.record), revision: stored.revision };
  }

  async listBatchKeys() {
    return [...this.records.keys()];
  }

  async listBatches() {
    return [...this.records.values()];
  }

  async createBatch(record: PhraseBatchRecord): Promise<string> {
    if (this.records.has(record.key)) throw new Error("batch already exists");
    this.events.push(`state:${record.phase}`);
    this.writes += 1;
    this.records.set(record.key, { record: structuredClone(record), revision: "1" });
    return "1";
  }

  async updateBatch(record: PhraseBatchRecord, expectedRevision: string): Promise<string> {
    if (this.beforeEveryUpdateConflict) {
      this.beforeEveryUpdateConflict(this, record);
    } else if (this.beforeNextUpdateConflict) {
      const beforeConflict = this.beforeNextUpdateConflict;
      this.beforeNextUpdateConflict = undefined;
      beforeConflict(this, record);
    }
    const current = this.records.get(record.key);
    if (!current || current.revision !== expectedRevision)
      throw new PhraseBatchStateConflictError();
    if (record.phase === this.conflictOnPhase) throw new PhraseBatchStateConflictError();
    if (this.failUpdateMatching?.(record)) {
      this.failUpdateMatching = undefined;
      throw new Error("state save failed");
    }
    this.events.push(`state:${record.phase}`);
    this.writes += 1;
    const revision = String(Number(expectedRevision) + 1);
    this.records.set(record.key, { record: structuredClone(record), revision });
    return revision;
  }
}

class FakePhrase {
  readonly events: string[];
  readonly callOrder: string[] = [];
  readonly getJobCalls: Array<{ projectUid: string; jobUid: string }> = [];
  readonly listJobCalls: Array<{ projectUid: string; filename: string; workflowLevel?: number }> =
    [];
  readonly asyncRequestIds: string[] = [];
  readonly inaccessibleJobUids = new Set<string>();
  readonly targetDownloadJobUids: string[] = [];
  readonly targetDownloadProjectUids: string[] = [];
  readonly targetFileDownloadJobUids: string[] = [];
  createJobCalls = 0;
  targetDownloadCalls = 0;
  createError?: Error & { mayHaveExecuted?: boolean };
  waitError?: Error;
  exportError?: Error;
  getJobError?: Error;
  readonly getJobErrors = new Map<string, Error>();
  getJobErrorOnCall?: (projectUid: string, uid: string, callNumber: number) => Error | undefined;
  jobStatus = "NEW";
  importStatus: "RUNNING" | "ERROR" | "OK" = "OK";
  readonly importStatuses = new Map<string, "RUNNING" | "ERROR" | "OK">();
  expectedTargetLangs = ["fr"];
  expectedFilename = "translation-template.json";
  unsupportedFiles: string[] = [];
  warnings: unknown[] = [];
  onDownloadTargetFile?: () => void;
  readonly jobStatuses = new Map<string, string>();
  readonly jobFilenamesByUid = new Map<string, string | undefined>();
  ignoreWorkflowLevelFilter = false;
  private readonly knownJobParts = new Map<
    string,
    {
      uid: string;
      targetLang: string;
      workflowLevel: number;
      filename?: string;
      lastWorkflowLevel?: number;
    }
  >();
  jobParts: Array<{
    uid: string;
    targetLang: string;
    workflowLevel: number;
    filename?: string;
    lastWorkflowLevel?: number;
  }> = [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1 }];
  listedJobs: PhraseJobListPart[] = [];
  targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
  readonly targetBytesByJob = new Map<string, Uint8Array>();

  constructor(events: string[] = []) {
    this.events = events;
  }

  async createJob(input: { targetLangs: string[]; filename: string }) {
    this.createJobCalls += 1;
    this.events.push("phrase:create");
    if (this.createError) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    expect(input.filename).toBe(this.expectedFilename);
    expect(input.targetLangs).toEqual(this.expectedTargetLangs);
    for (const job of this.jobParts) this.knownJobParts.set(job.uid, job);
    return {
      asyncRequest: { id: "import-1", action: "IMPORT_JOB" },
      jobs: this.jobParts,
      unsupportedFiles: this.unsupportedFiles,
      warnings: this.warnings,
    };
  }

  async waitForAsyncRequest(id: string) {
    this.callOrder.push(`wait:${id}`);
    this.asyncRequestIds.push(id);
    this.events.push(`phrase:wait:${id}`);
    if (this.waitError) {
      const error = this.waitError;
      this.waitError = undefined;
      throw error;
    }
  }

  async getJob(projectUid: string, uid: string) {
    this.callOrder.push(`get:${projectUid}:${uid}`);
    this.getJobCalls.push({ projectUid, jobUid: uid });
    const callError = this.getJobErrorOnCall?.(projectUid, uid, this.getJobCalls.length);
    if (callError) throw callError;
    if (this.inaccessibleJobUids.has(uid)) {
      throw new PhraseApiError("Phrase API returned HTTP 404", 404);
    }
    const jobError = this.getJobErrors.get(uid);
    if (jobError) throw jobError;
    if (this.getJobError) throw this.getJobError;
    const knownJob = this.jobParts.find((part) => part.uid === uid) ?? this.knownJobParts.get(uid);
    if (!knownJob && !this.jobFilenamesByUid.has(uid)) {
      throw new Error(`Unexpected job ${uid}`);
    }
    const job = knownJob ?? {
      uid,
      targetLang: "fr",
      workflowLevel: 1,
    };
    const filename = this.jobFilenamesByUid.has(uid)
      ? this.jobFilenamesByUid.get(uid)
      : (job.filename ?? "translation-template.json");
    return {
      ...job,
      ...(filename === undefined ? {} : { filename }),
      lastWorkflowLevel: job.lastWorkflowLevel ?? job.workflowLevel,
      status: this.jobStatuses.get(uid) ?? this.jobStatus,
      importStatus: { status: this.importStatuses.get(uid) ?? this.importStatus },
    };
  }

  async listJobs(
    projectUid: string,
    options: { filename: string; workflowLevel?: number },
  ): Promise<PhraseJobListPart[]> {
    this.listJobCalls.push({ projectUid, ...options });
    for (const job of this.listedJobs) {
      if (typeof job.uid === "string" && typeof job.targetLang === "string") {
        this.knownJobParts.set(job.uid, {
          uid: job.uid,
          targetLang: job.targetLang,
          workflowLevel: job.workflowLevel ?? 1,
          ...(job.filename === undefined ? {} : { filename: job.filename }),
          ...(job.lastWorkflowLevel === undefined
            ? {}
            : { lastWorkflowLevel: job.lastWorkflowLevel }),
        });
      }
    }
    return structuredClone(
      this.ignoreWorkflowLevelFilter
        ? this.listedJobs.map((job) => ({
            ...job,
            workflowLevel:
              job.workflowLevelReported === true
                ? (job.workflowLevel ?? options.workflowLevel ?? 1)
                : (options.workflowLevel ?? 1),
          }))
        : this.listedJobs.filter(
            (job) => (job.workflowLevel ?? 1) === (options.workflowLevel ?? 1),
          ),
    );
  }

  async startTargetDownload(projectUid: string, jobUid: string) {
    this.targetDownloadCalls += 1;
    this.targetDownloadProjectUids.push(projectUid);
    this.targetDownloadJobUids.push(jobUid);
    this.events.push(`phrase:export:${jobUid}`);
    if (this.exportError) throw this.exportError;
    return `export-${jobUid}`;
  }

  async downloadTargetFile(_projectUid: string, jobUid: string, _asyncRequestId: string) {
    this.targetFileDownloadJobUids.push(jobUid);
    this.events.push("phrase:download");
    this.onDownloadTargetFile?.();
    return this.targetBytesByJob.get(jobUid) ?? this.targetBytes;
  }
}

class FakeRepository implements PhraseWorkflowRepository {
  readonly pullRequests: Omit<
    PhraseLocalePullRequest,
    "recordToolingCommitSha" | "recheckOwnedCommitEligibility"
  >[] = [];
  readonly createDraftRequirements: Array<boolean | undefined> = [];
  readonly resolvedRefs: string[] = [];
  readonly pullRequestStates = new Map<string, "open" | "merged" | "closed">();
  pullRequestStateCalls = 0;
  readonly branchHeads = new Map<string, string>();
  readonly branchFiles = new Map<string, Map<string, Uint8Array>>();
  readonly branchCommits = new Map<string, { sha: string; paths: string[] }[]>();
  readonly pullRequestBranches = new Map<string, string>();
  readonly pullRequestBodies = new Map<string, string>();
  readonly pullRequestComments: Array<{
    pullRequestUrl: string;
    body: string;
    authorType: "Bot" | "User";
  }> = [];
  readonly sourceAuthorRequests: Array<{
    path: string;
    headCommit: string;
    baseCommit?: string;
  }> = [];
  sourceChangeAuthors: string[] = [];
  readonly sourceAuthorErrors: Error[] = [];
  readonly assigneeRequests: Array<{ pullRequestUrl: string; logins: string[] }> = [];
  readonly assigneeResponses: string[][] = [];
  readonly assigneeErrors: Error[] = [];
  readonly assignedLogins = new Map<string, string[]>();
  baseCommit = "resolved-base-commit";
  baseSourceBytes = sourceBytes;
  pinnedSourceBytes = sourceBytes;
  pullRequestError?: Error;
  bodyUpdateError?: Error;
  commentError?: Error;
  refUpdateError?: Error;
  preverifiedRefUpdateHeadSha?: string;
  closeOnNextOpenPullRequestUpdate = false;
  beforeOpenPullRequestRefRecheck?: () => void;
  readFileCalls = 0;
  private commitNumber = 0;
  onReadFile?: (path: string, ref: string, call: number) => Uint8Array | null;

  async readFile(path: string, ref: string) {
    this.readFileCalls += 1;
    if (this.onReadFile) return this.onReadFile(path, ref, this.readFileCalls);
    for (const [branch, headSha] of this.branchHeads) {
      if (headSha === ref) return this.branchFiles.get(branch)?.get(path) ?? null;
    }
    return ref === "abc123" ? this.pinnedSourceBytes : this.baseSourceBytes;
  }

  async listSourceChangeAuthors(input: { path: string; headCommit: string; baseCommit?: string }) {
    this.sourceAuthorRequests.push(input);
    const error = this.sourceAuthorErrors.shift();
    if (error) throw error;
    return [...this.sourceChangeAuthors];
  }

  async addPullRequestAssignees(pullRequestUrl: string, logins: string[]) {
    this.assigneeRequests.push({ pullRequestUrl, logins: [...logins] });
    const error = this.assigneeErrors.shift();
    if (error) throw error;
    const assigned = this.assigneeResponses.shift() ?? [...logins];
    this.assignedLogins.set(pullRequestUrl, [
      ...new Set([...(this.assignedLogins.get(pullRequestUrl) ?? []), ...assigned]),
    ]);
    return assigned;
  }

  async resolveCommit(ref: string) {
    this.resolvedRefs.push(ref);
    return this.baseCommit;
  }

  async createOrUpdatePullRequest(input: PhraseLocalePullRequest) {
    return (await this.createOrUpdatePullRequestWithCommit(input)).pullRequestUrl;
  }

  async getPullRequestState(pullRequestUrl: string): Promise<PhrasePullRequestState> {
    this.pullRequestStateCalls += 1;
    const state = this.pullRequestStates.get(pullRequestUrl) ?? "open";
    if (state !== "open") return { state };
    const branch = this.pullRequestBranches.get(pullRequestUrl);
    const headSha =
      this.preverifiedRefUpdateHeadSha ?? (branch ? this.branchHeads.get(branch) : undefined);
    if (!headSha) throw new PhraseRepositoryError("Fake pull request has no branch head", 500);
    return { state: "open", headSha };
  }

  async createOrUpdatePullRequestWithCommit(
    input: PhraseLocalePullRequest,
  ): Promise<PhraseLocalePullRequestCreated> {
    if (this.pullRequestError) throw this.pullRequestError;
    this.createDraftRequirements.push(input.draft);
    const pullRequestUrl = `https://github.com/example/app/pull/${42 + this.pullRequests.length}`;
    const files = [{ path: input.path, content: input.content }, ...(input.additionalFiles ?? [])];
    const previousHeadSha = this.branchHeads.get(input.branch) ?? null;
    const toolingCommitSha = this.createCommitSha();
    await input.recordToolingCommitSha(toolingCommitSha, previousHeadSha);
    if (previousHeadSha) await input.recheckOwnedCommitEligibility?.(previousHeadSha);
    if ((this.branchHeads.get(input.branch) ?? null) !== previousHeadSha) {
      throw new PhraseRepositoryError(
        "Phrase locale branch changed while applying the update; refusing to overwrite reviewer changes",
        409,
      );
    }
    this.pushCommit(
      input.branch,
      toolingCommitSha,
      files.map((file) => file.path),
      files,
    );
    const { recordToolingCommitSha, recheckOwnedCommitEligibility, ...storedInput } = input;
    void recordToolingCommitSha;
    void recheckOwnedCommitEligibility;
    this.pullRequests.push({ ...storedInput, draft: true });
    this.pullRequestBranches.set(pullRequestUrl, input.branch);
    this.pullRequestBodies.set(pullRequestUrl, input.body);
    return { pullRequestUrl, pullRequestCreated: true, toolingCommitSha };
  }

  async updateOpenPullRequest(
    input: PhraseLocalePullRequestUpdate,
  ): Promise<PhraseLocalePullRequestUpdateResult> {
    if (this.pullRequestError) throw this.pullRequestError;
    if (this.closeOnNextOpenPullRequestUpdate) {
      this.closeOnNextOpenPullRequestUpdate = false;
      this.pullRequestStates.set(input.pullRequestUrl, "closed");
      return {
        changed: false,
        toolingCommitSha: input.headSha,
        bodyUpdated: false,
        pullRequestFinalized: true,
      };
    }
    const headSha = this.branchHeads.get(input.branch);
    if (!headSha || (this.preverifiedRefUpdateHeadSha === undefined && headSha !== input.headSha)) {
      throw new PhraseRepositoryError("Phrase locale branch moved during re-export", 409);
    }
    const commits = this.branchCommits.get(input.branch) ?? [];
    const expectedPaths = new Set([
      input.path,
      ...(input.additionalFiles ?? []).map((file) => file.path),
    ]);
    const expectedToolingShas = new Set(
      [
        ...(Array.isArray(input.expectedToolingCommitShas) ? input.expectedToolingCommitShas : []),
        input.expectedToolingCommitSha,
        input.expectedPendingToolingCommitSha,
      ].filter((sha): sha is string => typeof sha === "string" && Boolean(sha.trim())),
    );
    const toolingOwned = expectedToolingShas.size
      ? expectedToolingShas.has(headSha)
      : commits.length === 1 &&
        Boolean(commits[0]?.paths.length) &&
        commits[0]?.paths.every((path) => expectedPaths.has(path));
    if (!toolingOwned) {
      throw new PhraseRepositoryError(
        "Phrase locale branch moved after the last tooling commit; refusing to overwrite reviewer changes",
        409,
      );
    }
    const files = [{ path: input.path, content: input.content }, ...(input.additionalFiles ?? [])];
    const currentFiles = this.branchFiles.get(input.branch) ?? new Map<string, Uint8Array>();
    const changedFiles = files.filter((file) => {
      const current = currentFiles.get(file.path);
      return !current || !Buffer.from(current).equals(Buffer.from(file.content));
    });
    if (!changedFiles.length) {
      return { changed: false, toolingCommitSha: headSha, bodyUpdated: false };
    }
    const toolingCommitSha = this.createCommitSha();
    await input.recordToolingCommitSha(toolingCommitSha, input.headSha);
    this.beforeOpenPullRequestRefRecheck?.();
    await input.recheckOwnedCommitEligibility?.(input.headSha);
    if (this.refUpdateError) {
      const error = this.refUpdateError;
      this.refUpdateError = undefined;
      throw error;
    }
    if (this.preverifiedRefUpdateHeadSha !== undefined) {
      throw new PhraseRepositoryError(
        "Phrase locale branch changed while applying the update; refusing to overwrite reviewer changes",
        409,
      );
    }
    if (this.branchHeads.get(input.branch) !== headSha) {
      throw new PhraseRepositoryError(
        "Phrase locale branch changed while applying the update; refusing to overwrite reviewer changes",
        409,
      );
    }
    this.pushCommit(
      input.branch,
      toolingCommitSha,
      changedFiles.map((file) => file.path),
      files,
    );
    try {
      await this.updatePullRequestBody(input.pullRequestUrl, input.body, input.title);
      return { changed: true, toolingCommitSha, bodyUpdated: true };
    } catch (bodyError) {
      return { changed: true, toolingCommitSha, bodyUpdated: false, bodyError };
    }
  }

  async updatePullRequestBody(
    pullRequestUrl: string,
    body: string,
    title?: string,
  ): Promise<boolean> {
    if (this.bodyUpdateError) throw this.bodyUpdateError;
    this.pullRequestBodies.set(pullRequestUrl, body);
    const branch = this.pullRequestBranches.get(pullRequestUrl);
    const index = branch ? this.pullRequests.findIndex((input) => input.branch === branch) : -1;
    if (index !== -1) {
      this.pullRequests[index] = {
        ...this.pullRequests[index]!,
        ...(title === undefined ? {} : { title }),
        body,
      };
    }
    return true;
  }

  async findLatestBotPullRequestComment(
    pullRequestUrl: string,
    bodyPrefix: string,
  ): Promise<string | undefined> {
    return this.pullRequestComments
      .slice()
      .reverse()
      .find(
        (comment) =>
          comment.pullRequestUrl === pullRequestUrl &&
          comment.authorType === "Bot" &&
          comment.body.startsWith(bodyPrefix),
      )?.body;
  }

  async createPullRequestComment(pullRequestUrl: string, body: string): Promise<boolean> {
    if (this.commentError) throw this.commentError;
    if ((this.pullRequestStates.get(pullRequestUrl) ?? "open") !== "open") return false;
    this.pullRequestComments.push({ pullRequestUrl, body, authorType: "Bot" });
    return true;
  }

  pushHumanCommit(branch: string, paths: string[] = ["reviewer.md"]) {
    const sha = `human-${++this.commitNumber}`;
    this.branchHeads.set(branch, sha);
    const commits = this.branchCommits.get(branch) ?? [];
    commits.push({ sha, paths });
    this.branchCommits.set(branch, commits);
  }

  commitCount(branch: string): number {
    return this.branchCommits.get(branch)?.length ?? 0;
  }

  private createCommitSha(): string {
    return `tooling-${++this.commitNumber}`;
  }

  private pushCommit(
    branch: string,
    sha: string,
    paths: string[],
    files?: { path: string; content: Uint8Array }[],
  ): void {
    this.branchHeads.set(branch, sha);
    const commits = this.branchCommits.get(branch) ?? [];
    commits.push({ sha, paths });
    this.branchCommits.set(branch, commits);
    const storedFiles = this.branchFiles.get(branch) ?? new Map<string, Uint8Array>();
    for (const file of files ?? []) storedFiles.set(file.path, new Uint8Array(file.content));
    this.branchFiles.set(branch, storedFiles);
  }
}

async function makeFindingsScenario(
  sourceMessages: Record<string, unknown>,
  targetMessages: Record<string, unknown>,
  workflowConfig: PhraseWorkflowConfig = config,
  frontendTemplate?: string,
) {
  const scenarioSourceBytes = new TextEncoder().encode(JSON.stringify(sourceMessages));
  const phrase = new FakePhrase();
  phrase.targetBytes = new TextEncoder().encode(JSON.stringify(targetMessages));
  const state = new MemoryStateStore();
  const repository = new FakeRepository();
  repository.baseSourceBytes = scenarioSourceBytes;
  repository.pinnedSourceBytes = scenarioSourceBytes;
  if (frontendTemplate) {
    repository.onReadFile = (path) =>
      path === workflowConfig.frontendTemplate?.path
        ? new TextEncoder().encode(frontendTemplate)
        : scenarioSourceBytes;
  }
  const workflow = new PhraseWorkflow({
    phrase,
    state,
    repository,
    catalogAdapters: new CatalogAdapterRegistry(),
  });
  const batch = await workflow.submit({
    repository: "example/app",
    baseRef: "phrase-pilot",
    sourceCommit: "abc123",
    sourceBytes: scenarioSourceBytes,
    config: workflowConfig,
  });
  phrase.jobStatus = "COMPLETED";
  return { batch, phrase, repository, state, workflow };
}

const japaneseConfig: PhraseWorkflowConfig = {
  ...config,
  targetLocales: [
    ...config.targetLocales,
    { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
  ],
};

const recoveryLocaleTags = ["fr", "ja", "ko", "zh_cn"] as const;

function configureRecoveryLocales(scenario: ReturnType<typeof makeJapaneseWorkflowScenario>): void {
  scenario.input.config = {
    ...scenario.input.config,
    targetLocales: recoveryLocaleTags.map((phraseLocale) => ({
      phraseLocale,
      repositoryLocale: phraseLocale,
      outputPath: `locales/${phraseLocale}.json`,
    })),
  };
  scenario.phrase.expectedTargetLangs = [...recoveryLocaleTags];
}

const phrasePins = {
  expectedProjectUid: "project-uid",
  expectedSourceFilename: "translation-template.json",
};
const phraseRepairScope = {
  projectUid: "project-uid",
  sourceFilename: "translation-template.json",
};

function makeJapaneseWorkflowScenario(
  timing: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
) {
  const state = new MemoryStateStore();
  const phrase = new FakePhrase();
  phrase.expectedTargetLangs = ["fr", "ja"];
  phrase.jobParts = [
    { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
    { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
  ];
  phrase.jobStatus = "COMPLETED";
  phrase.targetBytesByJob.set(
    "job-ja",
    new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
  );
  const repository = new FakeRepository();
  const workflow = new PhraseWorkflow({
    phrase,
    state,
    repository,
    catalogAdapters: new CatalogAdapterRegistry(),
    ...timing,
  });
  const input = {
    repository: "example/app",
    baseRef: "phrase-pilot",
    sourceCommit: "abc123",
    sourceBytes,
    config: japaneseConfig,
  };
  return { state, phrase, repository, workflow, input };
}

const PHRASE_JOB_VISIBILITY_GRACE_TEST_MS = 15 * 60 * 1000;

function listedPhraseJob(
  uid: string,
  targetLang: string,
  sourceFileUid: string | undefined,
  dateCreated: string,
  workflowLevel = 1,
  workflowLevelReported = true,
): PhraseJobListPart {
  return {
    uid,
    targetLang,
    workflowLevel,
    workflowLevelReported,
    filename: "translation-template.json",
    dateCreated,
    listingEntry: `job ${uid}`,
    ...(sourceFileUid === undefined ? {} : { sourceFileUid }),
  };
}

async function storeStuckBatch(
  scenario: ReturnType<typeof makeJapaneseWorkflowScenario>,
  phase: "creating" | "unknown",
  createdAt?: string,
): Promise<PhraseBatchRecord> {
  scenario.phrase.createError = new PhraseApiError("Phrase API returned HTTP 500", 500, true);
  await scenario.workflow.submit(scenario.input).catch(() => undefined);
  const [stored] = await scenario.state.listBatches();
  if (!stored) throw new Error("Expected the interrupted submission to store a batch");
  const record = structuredClone(stored.record);
  record.phase = phase;
  record.jobs = [];
  record.importAsyncRequestId = undefined;
  record.failureReason = "submission outcome was not saved";
  if (createdAt) record.createdAt = createdAt;
  scenario.state.records.set(record.key, { record, revision: stored.revision });
  return record;
}

describe("Phrase stuck batch recovery", () => {
  it.each([
    ["creating", true],
    ["unknown", false],
  ] as const)(
    "binds a matching creation-time group with different source file UIDs for a %s batch",
    async (phase, pinned) => {
      const clock = Date.parse("2026-10-19T10:00:00Z");
      const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
      scenario.input.config = {
        ...scenario.input.config,
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr-CA", outputPath: "locales/fr-CA.json" },
          { phraseLocale: "ja", repositoryLocale: "ja-JP", outputPath: "locales/ja-JP.json" },
        ],
      };
      const stuck = await storeStuckBatch(scenario, phase, new Date(clock).toISOString());
      const createdAt = new Date(clock - 30_000).toISOString();
      scenario.phrase.listedJobs = [
        listedPhraseJob("recovered-fr", "fr", "source-file-a", createdAt),
        listedPhraseJob("recovered-ja", "ja", "source-file-b", "2026-10-19T11:59:30+02:00"),
      ];
      scenario.phrase.jobStatus = "COMPLETED";

      const recovered = await scenario.workflow.submit(
        pinned ? { ...scenario.input, ...phrasePins } : scenario.input,
      );
      const stored = await scenario.state.readBatch(stuck.key);

      expect(recovered.key).toBe(stuck.key);
      expect(recovered.phase).toBe("ready");
      expect(recovered.jobs.map(({ uid, targetLang }) => [uid, targetLang])).toEqual([
        ["recovered-fr", "fr"],
        ["recovered-ja", "ja"],
      ]);
      expect(recovered.importAsyncRequestId).toBeUndefined();
      expect(recovered.failureReason).toBeUndefined();
      expect(stored?.record.phase).toBe("ready");
      expect(scenario.phrase.asyncRequestIds).toEqual([]);
      expect(scenario.phrase.listJobCalls).toEqual([
        {
          projectUid: "project-uid",
          filename: "translation-template.json",
          workflowLevel: 1,
        },
        {
          projectUid: "project-uid",
          filename: "translation-template.json",
          workflowLevel: 2,
        },
      ]);
      expect(scenario.phrase.getJobCalls.map(({ jobUid }) => jobUid)).toEqual(
        expect.arrayContaining(["recovered-fr", "recovered-ja"]),
      );
    },
  );

  it("binds four locales whose jobs span adjacent creation seconds", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    configureRecoveryLocales(scenario);
    const stuck = await storeStuckBatch(scenario, "creating", new Date(clock).toISOString());
    const firstCreatedAt = new Date(clock).toISOString();
    const secondCreatedAt = new Date(clock + 1000).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("recovered-fr", "fr", "source-fr", firstCreatedAt),
      listedPhraseJob("recovered-zh-cn", "zh_cn", "source-zh-cn", firstCreatedAt),
      listedPhraseJob("recovered-ja", "ja", "source-ja", secondCreatedAt),
      listedPhraseJob("recovered-ko", "ko", "source-ko", secondCreatedAt),
    ];
    scenario.phrase.getJobError = new PhraseApiError("Phrase API returned HTTP 503", 503);

    const recovered = await scenario.workflow.submit(scenario.input);

    expect(recovered.key).toBe(stuck.key);
    expect(recovered.phase).toBe("importing");
    expect(recovered.jobs).toHaveLength(4);
    for (const uid of ["recovered-fr", "recovered-zh-cn", "recovered-ja", "recovered-ko"]) {
      expect(recovered.jobs.filter((job) => job.uid === uid)).toHaveLength(1);
    }
  });

  it("deduplicates repeated listed UIDs and stops after the first repeated workflow level", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    configureRecoveryLocales(scenario);
    const stuck = await storeStuckBatch(scenario, "creating", new Date(clock).toISOString());
    const createdAt = new Date(clock).toISOString();
    scenario.phrase.ignoreWorkflowLevelFilter = true;
    scenario.phrase.listedJobs = recoveryLocaleTags.map((targetLang) => ({
      ...listedPhraseJob(`recovered-${targetLang}`, targetLang, `source-${targetLang}`, createdAt),
      workflowLevelReported: false,
    }));
    scenario.phrase.getJobError = new PhraseApiError("Phrase API returned HTTP 503", 503);

    const recovered = await scenario.workflow.submit(scenario.input);

    expect(recovered.key).toBe(stuck.key);
    expect(recovered.phase).toBe("importing");
    expect(recovered.jobs).toHaveLength(4);
    expect(recovered.jobs.map(({ workflowLevel }) => workflowLevel)).toEqual([1, 1, 1, 1]);
    expect(new Set(recovered.jobs.map(({ uid }) => uid)).size).toBe(4);
    expect(scenario.phrase.listJobCalls.map(({ workflowLevel }) => workflowLevel)).toEqual([1, 2]);
  });

  it("recovers the adjacent-second batch when Phrase ignores workflow-level filters", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    configureRecoveryLocales(scenario);
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const firstCreatedAt = new Date(clock).toISOString();
    const secondCreatedAt = new Date(clock + 1000).toISOString();
    scenario.phrase.ignoreWorkflowLevelFilter = true;
    scenario.phrase.listedJobs = [
      {
        ...listedPhraseJob("recovered-fr", "fr", "source-fr", firstCreatedAt),
        workflowLevelReported: false,
      },
      {
        ...listedPhraseJob("recovered-zh-cn", "zh_cn", "source-zh-cn", firstCreatedAt),
        workflowLevelReported: false,
      },
      {
        ...listedPhraseJob("recovered-ja", "ja", "source-ja", secondCreatedAt),
        workflowLevelReported: false,
      },
      {
        ...listedPhraseJob("recovered-ko", "ko", "source-ko", secondCreatedAt),
        workflowLevelReported: false,
      },
    ];
    scenario.phrase.getJobError = new PhraseApiError("Phrase API returned HTTP 503", 503);

    const recovered = await scenario.workflow.submit(scenario.input);

    expect(recovered.key).toBe(stuck.key);
    expect(recovered.phase).toBe("importing");
    expect(recovered.jobs).toHaveLength(4);
    expect(new Set(recovered.jobs.map(({ uid }) => uid)).size).toBe(4);
    expect(recovered.jobs.map(({ workflowLevel }) => workflowLevel)).toEqual([1, 1, 1, 1]);
    expect(scenario.phrase.listJobCalls.map(({ workflowLevel }) => workflowLevel)).toEqual([1, 2]);
  });

  it("binds a creation-time group when sourceFileUid is absent", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const createdAt = new Date(clock - 30_000).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("recovered-fr", "fr", undefined, createdAt),
      listedPhraseJob("recovered-ja", "ja", undefined, createdAt),
    ];

    const recovered = await scenario.workflow.submit({ ...scenario.input, ...phrasePins });

    expect(recovered.key).toBe(stuck.key);
    expect(recovered.phase).toBe("ready");
    expect(recovered.jobs.map(({ uid }) => uid)).toEqual(["recovered-fr", "recovered-ja"]);
  });

  it("binds all workflow levels and reconciles from the final-step job parts", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "creating", new Date(clock).toISOString());
    const createdAt = new Date(clock).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("step-one-fr", "fr", "source-a", createdAt),
      listedPhraseJob("step-one-ja", "ja", "source-b", createdAt),
      listedPhraseJob("step-two-fr", "fr", "source-c", createdAt, 2),
      listedPhraseJob("step-two-ja", "ja", "source-d", createdAt, 2),
    ];
    scenario.phrase.jobStatus = "COMPLETED";

    const results = await scenario.workflow.reconcile({ repairScope: phraseRepairScope });
    const repaired = await scenario.state.readBatch(stuck.key);

    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "pr-created"],
      ["ja", "pr-created"],
    ]);
    expect(repaired?.record.phase).toBe("ready");
    expect(repaired?.record.jobs.map(({ uid, workflowLevel }) => [uid, workflowLevel])).toEqual([
      ["step-one-fr", 1],
      ["step-one-ja", 1],
      ["step-two-fr", 2],
      ["step-two-ja", 2],
    ]);
    expect(scenario.phrase.listJobCalls.map(({ workflowLevel }) => workflowLevel)).toEqual([
      1, 2, 3,
    ]);
    expect(scenario.phrase.targetDownloadJobUids).toEqual(["step-two-fr", "step-two-ja"]);
  });

  it("fails closed when a creation-time group has inconsistent locale sets across levels", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const createdAt = new Date(clock).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("step-one-fr", "fr", "source-a", createdAt),
      listedPhraseJob("step-one-ja", "ja", "source-b", createdAt),
      listedPhraseJob("step-two-fr", "fr", "source-c", createdAt, 2),
    ];
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile({ repairScope: phraseRepairScope });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      batchKey: stuck.key,
      phase: "failed",
      reason: expect.stringContaining("no creation-time group matches its pending locales"),
    });
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("reports a young empty batch as retrying without changing its record", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile({
      ...phrasePins,
      repairScope: phraseRepairScope,
    });

    expect(results).toEqual([
      {
        batchKey: stuck.key,
        phase: "retrying",
        reason: "Phrase job may still be appearing in Phrase; the next run will check again",
      },
    ]);
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
  });

  it("does not query Phrase for a stuck batch without an explicit repair scope", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    scenario.phrase.listedJobs = [
      listedPhraseJob("recovered-fr", "fr", "source-file-a", new Date(clock).toISOString()),
      listedPhraseJob("recovered-ja", "ja", "source-file-a", new Date(clock).toISOString()),
    ];
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile();

    expect(results).toEqual([]);
    expect(scenario.phrase.listJobCalls).toEqual([]);
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
  });

  it("voids only when there are zero candidate jobs and submits the next attempt", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(
      scenario,
      "unknown",
      new Date(clock - PHRASE_JOB_VISIBILITY_GRACE_TEST_MS - 1).toISOString(),
    );
    scenario.phrase.jobStatus = "COMPLETED";

    const submitted = await scenario.workflow.submit(scenario.input);
    const voided = await scenario.state.readBatch(stuck.key);

    expect(submitted.key).not.toBe(stuck.key);
    expect(submitted.attempt).toBe(1);
    expect(submitted.phase).toBe("ready");
    expect(voided?.record).toMatchObject({
      phase: "failed",
      failureReason: "No Phrase job was created for this batch; voided after 15 minutes",
      voidedEmptySubmission: true,
    });
    expect(scenario.phrase.createJobCalls).toBe(2);
  });

  it("does not auto-advance on the void reason when real jobs have no void marker", async () => {
    const scenario = makeJapaneseWorkflowScenario();
    const submitted = await scenario.workflow.submit(scenario.input);
    const stored = scenario.state.records.get(submitted.key)!;
    stored.record.phase = "failed";
    stored.record.failureReason =
      "No Phrase job was created for this batch; voided after 15 minutes";
    delete stored.record.voidedEmptySubmission;

    const error = await scenario.workflow.submit(scenario.input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PhraseWorkflowError",
      message: expect.stringContaining("rerun with --retry-failed"),
    });
    expect(stored.record.jobs.map(({ uid }) => uid)).toEqual(["job-fr", "job-ja"]);
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("marks an old empty batch failed during reconcile", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(
      scenario,
      "creating",
      new Date(clock - PHRASE_JOB_VISIBILITY_GRACE_TEST_MS - 1).toISOString(),
    );

    const results = await scenario.workflow.reconcile({
      ...phrasePins,
      repairScope: phraseRepairScope,
    });
    const stored = await scenario.state.readBatch(stuck.key);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.phase === "failed")).toBe(true);
    expect(results.every((result) => result.reason === stored?.record.failureReason)).toBe(true);
    expect(stored?.record).toMatchObject({
      phase: "failed",
      failureReason: "No Phrase job was created for this batch; voided after 15 minutes",
      voidedEmptySubmission: true,
    });
    expect(scenario.phrase.createJobCalls).toBe(1);

    const submitted = await scenario.workflow.submit(scenario.input);

    expect(submitted.key).not.toBe(stuck.key);
    expect(submitted.attempt).toBe(1);
    expect(scenario.phrase.createJobCalls).toBe(2);
  });

  it("fails closed when two submissions fall within one recovery group and lists each candidate once", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const firstCreatedAt = new Date(clock).toISOString();
    const secondCreatedAt = new Date(clock + 1000).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("fr-a", "fr", "source-a", firstCreatedAt),
      listedPhraseJob("ja-a", "ja", "source-b", firstCreatedAt),
      listedPhraseJob("fr-b", "fr", "source-a", secondCreatedAt),
      listedPhraseJob("ja-b", "ja", "source-b", secondCreatedAt),
    ];
    const before = await scenario.state.readBatch(stuck.key);

    const error = await scenario.workflow.submit(scenario.input).catch((caught: unknown) => caught);
    const errorMessage = error instanceof Error ? error.message : "";

    expect(error).toMatchObject({
      name: "PhraseAmbiguousRecoveryError",
      message: expect.stringContaining(
        "More than one Phrase job matches a locale within a Phrase creation-time group",
      ),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining(
        `creation time ${firstCreatedAt}: uid fr-a, targetLang fr, dateCreated ${firstCreatedAt}`,
      ),
    });
    for (const uid of ["fr-a", "ja-a", "fr-b", "ja-b"]) {
      expect(errorMessage.match(new RegExp(`uid ${uid}`, "g"))).toHaveLength(1);
    }
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.",
      ),
    });
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("fails closed when more than one distant group matches the batch", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const firstCreatedAt = new Date(clock).toISOString();
    const secondCreatedAt = new Date(clock + 10_000).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("fr-a", "fr", "source-a", firstCreatedAt),
      listedPhraseJob("ja-a", "ja", "source-b", firstCreatedAt),
      listedPhraseJob("fr-b", "fr", "source-c", secondCreatedAt),
      listedPhraseJob("ja-b", "ja", "source-d", secondCreatedAt),
    ];
    const before = await scenario.state.readBatch(stuck.key);

    const error = await scenario.workflow.submit(scenario.input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PhraseAmbiguousRecoveryError",
      message: expect.stringContaining(
        "More than one Phrase creation-time group matches this batch",
      ),
    });
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
  });

  it("excludes a creation-time group whose UIDs are claimed by another stored batch", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
    const createdAt = new Date(clock).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("claimed-fr", "fr", "source-file-a", createdAt),
      listedPhraseJob("claimed-ja", "ja", "source-file-b", createdAt),
    ];
    const other = structuredClone(stuck);
    other.key = "other-batch";
    other.phase = "failed";
    other.jobs = [
      { uid: "claimed-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "claimed-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    scenario.state.records.set(other.key, { record: other, revision: "1" });
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile({
      ...phrasePins,
      repairScope: phraseRepairScope,
    });

    expect(results).toContainEqual(
      expect.objectContaining({ batchKey: stuck.key, phase: "retrying" }),
    );
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
  });

  it.each([
    ["partial locale group", ["fr"]],
    ["extra-locale group", ["fr", "ja", "es"]],
  ] as const)("does not void an old batch with %s candidates", async (_caseName, targetLangs) => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(
      scenario,
      "creating",
      new Date(clock - PHRASE_JOB_VISIBILITY_GRACE_TEST_MS - 1).toISOString(),
    );
    const createdAt = new Date(clock).toISOString();
    scenario.phrase.listedJobs = targetLangs.map((targetLang, index) =>
      listedPhraseJob(
        `candidate-${targetLang}-${index}`,
        targetLang,
        `source-file-${index}`,
        createdAt,
      ),
    );
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile({
      ...phrasePins,
      repairScope: phraseRepairScope,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      batchKey: stuck.key,
      phase: "failed",
      reason: expect.stringContaining("Phrase jobs exist for this batch"),
    });
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("leaves a young batch retrying when all listed jobs predate the clock-skew window", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const stuck = await storeStuckBatch(scenario, "creating", new Date(clock).toISOString());
    const createdAt = new Date(clock - 2 * 60 * 1000 - 1).toISOString();
    scenario.phrase.listedJobs = [
      listedPhraseJob("candidate-fr", "fr", "source-file-a", createdAt),
      listedPhraseJob("candidate-ja", "ja", "source-file-b", createdAt),
    ];
    const before = await scenario.state.readBatch(stuck.key);

    const results = await scenario.workflow.reconcile({
      ...phrasePins,
      repairScope: phraseRepairScope,
    });

    expect(results).toContainEqual(
      expect.objectContaining({ batchKey: stuck.key, phase: "retrying" }),
    );
    expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
  });

  it.each([
    ["uid", (job: PhraseJobListPart) => ({ ...job, uid: undefined })],
    ["targetLang", (job: PhraseJobListPart) => ({ ...job, targetLang: undefined })],
    ["dateCreated", (job: PhraseJobListPart) => ({ ...job, dateCreated: "not-a-timestamp" })],
  ] as const)(
    "fails closed when a candidate has missing or invalid %s metadata",
    async (field, edit) => {
      const clock = Date.parse("2026-10-19T10:00:00Z");
      const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
      const stuck = await storeStuckBatch(scenario, "unknown", new Date(clock).toISOString());
      scenario.phrase.listedJobs = [
        edit(listedPhraseJob("candidate-fr", "fr", undefined, new Date(clock).toISOString())),
      ];
      const before = await scenario.state.readBatch(stuck.key);

      const error = await scenario.workflow
        .submit(scenario.input)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "PhraseAmbiguousRecoveryError" });
      expect(error).toMatchObject({ message: expect.stringContaining("job candidate-fr") });
      expect(error).toMatchObject({
        message: expect.stringContaining(
          field === "uid"
            ? "uid <missing>"
            : field === "targetLang"
              ? "targetLang <missing>"
              : "dateCreated not-a-timestamp",
        ),
      });
      expect(await scenario.state.readBatch(stuck.key)).toEqual(before);
      expect(scenario.phrase.createJobCalls).toBe(1);
    },
  );
});

async function submitWithJapaneseImportRetrying(
  scenario: ReturnType<typeof makeJapaneseWorkflowScenario>,
) {
  scenario.phrase.getJobErrors.set(
    "job-ja",
    new PhraseApiError("Phrase API returned HTTP 503", 503),
  );
  return scenario.workflow.submit(scenario.input);
}

function failJobLookupAt(
  phrase: FakePhrase,
  jobUid: string,
  callNumber: number,
  error: Error,
): void {
  phrase.getJobErrorOnCall = (_projectUid, requestedJobUid, currentCall) =>
    requestedJobUid === jobUid && currentCall === callNumber ? error : undefined;
}

describe("PhraseWorkflow submission", () => {
  it("records a creating batch before uploading, waits for import, and resumes idempotently", async () => {
    const events: string[] = [];
    const state = new MemoryStateStore(events);
    const phrase = new FakePhrase(events);
    phrase.warnings = ["warning details remain in Phrase; do not persist the text"];
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    const result = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });

    expect(result.phase).toBe("ready");
    expect(result.jobs.map((job) => job.uid)).toEqual(["job-fr"]);
    expect(result.warningCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("warning details remain");
    expect(events.slice(0, 2)).toEqual(["state:creating", "phrase:create"]);
    expect(phrase.callOrder.slice(0, 2)).toEqual(["wait:import-1", "get:project-uid:job-fr"]);
    expect(phrase.createJobCalls).toBe(1);

    const repeated = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });

    expect(repeated.key).toBe(result.key);
    expect(phrase.createJobCalls).toBe(1);
  });

  it("saves created jobs before rejecting an immediate pinned filename mismatch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobFilenamesByUid.set("job-fr", "other-consumer.json");
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await expect(
      workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      }),
    ).rejects.toThrow('expected "translation-template.json", actual "other-consumer.json"');

    const [stored] = await state.listBatches();
    expect(stored?.record.phase).toBe("importing");
    expect(stored?.record.jobs).toMatchObject([{ uid: "job-fr", targetLang: "fr" }]);
    expect(stored?.record.importAsyncRequestId).toBe("import-1");
    expect(state.writes).toBe(2);
    expect(phrase.callOrder).toEqual(["get:project-uid:job-fr"]);
    expect(phrase.asyncRequestIds).toEqual([]);
  });

  it("treats an invalid returned pinned job UID as an immediate pin mismatch", async () => {
    const scenario = makeJapaneseWorkflowScenario();
    scenario.phrase.getJobErrors.set(
      "job-fr",
      new PhraseApiError("Phrase returned an invalid job UID", 200),
    );

    const error = await scenario.workflow
      .submit({ ...scenario.input, ...phrasePins })
      .catch((caught: unknown) => caught);
    const [stored] = await scenario.state.listBatches();

    expect(error).toMatchObject({ name: "PhrasePinMismatchError" });
    expect(scenario.phrase.getJobCalls.filter(({ jobUid }) => jobUid === "job-fr")).toHaveLength(1);
    expect(stored?.record).toMatchObject({
      phase: "importing",
      jobs: [{ uid: "job-fr" }, { uid: "job-ja" }],
      importAsyncRequestId: "import-1",
    });
  });

  it("retries a fresh pinned job lookup after a brief 404", async () => {
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const delays: number[] = [];
    const scenario = makeJapaneseWorkflowScenario({
      now: () => clock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    });
    scenario.phrase.jobStatus = "COMPLETED";
    scenario.phrase.getJobErrorOnCall = (_projectUid, jobUid, callNumber) =>
      jobUid === "job-fr" && callNumber === 1
        ? new PhraseApiError("Phrase API returned HTTP 404", 404)
        : undefined;

    const submitted = await scenario.workflow.submit({ ...scenario.input, ...phrasePins });

    expect(submitted.phase).toBe("ready");
    expect(submitted.jobs.map(({ uid }) => uid)).toEqual(["job-fr", "job-ja"]);
    expect(delays).toEqual([15_000]);
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("saves jobs after repeated fresh 404s and resumes within the visibility grace period", async () => {
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    scenario.phrase.inaccessibleJobUids.add("job-fr");

    const error = await scenario.workflow
      .submit({ ...scenario.input, ...phrasePins })
      .catch((caught: unknown) => caught);
    const [stored] = await scenario.state.listBatches();

    expect(error).toBeInstanceOf(PhraseWorkflowError);
    expect(error).toMatchObject({
      name: "PhraseJobVisibilityError",
      message: "Phrase has not yet exposed the new jobs; the next run continues this batch",
    });
    expect(stored?.record).toMatchObject({
      phase: "importing",
      jobs: [{ uid: "job-fr" }, { uid: "job-ja" }],
      importAsyncRequestId: "import-1",
    });
    expect(scenario.phrase.getJobCalls.filter(({ jobUid }) => jobUid === "job-fr")).toHaveLength(5);

    scenario.phrase.inaccessibleJobUids.delete("job-fr");
    const resumed = await scenario.workflow.submit({ ...scenario.input, ...phrasePins });

    expect(resumed.key).toBe(stored?.record.key);
    expect(resumed.phase).toBe("ready");
    expect(scenario.phrase.createJobCalls).toBe(1);
  });

  it("returns the same retryable visibility error for pinned and unpinned fresh 404s", async () => {
    const errors: unknown[] = [];
    for (const pinned of [true, false]) {
      let clock = Date.parse("2026-10-19T10:00:00Z");
      const scenario = makeJapaneseWorkflowScenario({
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      });
      scenario.phrase.inaccessibleJobUids.add("job-fr");

      const error = await scenario.workflow
        .submit(pinned ? { ...scenario.input, ...phrasePins } : scenario.input)
        .catch((caught: unknown) => caught);
      const [stored] = await scenario.state.listBatches();
      errors.push(error);

      expect(error).toMatchObject({
        name: "PhraseJobVisibilityError",
        message: "Phrase has not yet exposed the new jobs; the next run continues this batch",
      });
      expect(stored?.record).toMatchObject({
        phase: "importing",
        jobs: [{ uid: "job-fr" }, { uid: "job-ja" }],
      });
    }

    expect(errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual(
      [
        "Phrase has not yet exposed the new jobs; the next run continues this batch",
        "Phrase has not yet exposed the new jobs; the next run continues this batch",
      ],
    );
  });

  it("keeps a stored pinned 404 as a mismatch after the visibility grace period", async () => {
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const submitted = await submitWithJapaneseImportRetrying(scenario);
    expect(submitted.phase).toBe("importing");
    scenario.phrase.getJobErrors.delete("job-ja");
    clock += PHRASE_JOB_VISIBILITY_GRACE_TEST_MS + 1;
    scenario.phrase.inaccessibleJobUids.add("job-fr");

    const results = await scenario.workflow.reconcile(phrasePins);

    expect(results).toEqual([
      {
        batchKey: submitted.key,
        phase: "failed",
        reason: "Stored Phrase jobs could not be verified in the pinned project",
      },
    ]);
  });

  it("reports a young ready batch's pinned 404 as retrying", async () => {
    const clock = Date.parse("2026-10-19T10:00:00Z");
    const scenario = makeJapaneseWorkflowScenario({ now: () => clock });
    const submitted = await scenario.workflow.submit({ ...scenario.input, ...phrasePins });
    expect(submitted.phase).toBe("ready");
    scenario.phrase.inaccessibleJobUids.add("job-fr");

    const results = await scenario.workflow.reconcile(phrasePins);

    expect(results).toContainEqual({
      batchKey: submitted.key,
      phraseLocale: "fr",
      phase: "retrying",
      reason: "Phrase has not yet exposed the new jobs; the next run continues this batch",
    });
    expect(results).toContainEqual(
      expect.objectContaining({ batchKey: submitted.key, phraseLocale: "ja", phase: "pr-created" }),
    );
  });

  it("treats a young pinned submit-resume 404 as retryable within the pinned project", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const submitted = await workflow.submit(input);
    const stored = state.records.get(submitted.key)!;
    stored.record.phase = "importing";
    stored.record.importAsyncRequestId = "other-consumer-import";
    stored.record.jobs[0]!.uid = "other-consumer-job";
    phrase.inaccessibleJobUids.add("other-consumer-job");
    const forgedRecord = structuredClone(stored.record);
    const forgedRevision = stored.revision;
    const writesBeforeResume = state.writes;
    phrase.callOrder.length = 0;
    phrase.getJobCalls.length = 0;
    phrase.asyncRequestIds.length = 0;

    await expect(
      workflow.submit({
        ...input,
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      }),
    ).rejects.toThrow("Phrase has not yet exposed the new jobs; the next run continues this batch");

    expect(phrase.getJobCalls).toEqual([
      { projectUid: "project-uid", jobUid: "other-consumer-job" },
    ]);
    expect(phrase.asyncRequestIds).toEqual([]);
    expect(phrase.callOrder).toEqual(["get:project-uid:other-consumer-job"]);
    expect(state.writes).toBe(writesBeforeResume);
    expect(state.records.get(submitted.key)?.record).toEqual(forgedRecord);
    expect(state.records.get(submitted.key)?.revision).toBe(forgedRevision);
  });

  it("refuses a pinned resume whose same-project job has another consumer's filename", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const submitted = await workflow.submit(input);
    const stored = state.records.get(submitted.key)!;
    stored.record.phase = "importing";
    stored.record.importAsyncRequestId = "other-consumer-import";
    stored.record.jobs[0]!.uid = "other-consumer-job";
    phrase.jobFilenamesByUid.set("other-consumer-job", "other-consumer.json");
    const forgedRecord = structuredClone(stored.record);
    const forgedRevision = stored.revision;
    const writesBeforeResume = state.writes;
    phrase.callOrder.length = 0;
    phrase.getJobCalls.length = 0;
    phrase.asyncRequestIds.length = 0;

    await expect(
      workflow.submit({
        ...input,
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      }),
    ).rejects.toThrow(
      'Phrase job other-consumer-job source filename mismatch: expected "translation-template.json", actual "other-consumer.json"',
    );

    expect(phrase.getJobCalls).toEqual([
      { projectUid: "project-uid", jobUid: "other-consumer-job" },
    ]);
    expect(phrase.asyncRequestIds).toEqual([]);
    expect(phrase.callOrder).toEqual(["get:project-uid:other-consumer-job"]);
    expect(state.writes).toBe(writesBeforeResume);
    expect(state.records.get(submitted.key)?.record).toEqual(forgedRecord);
    expect(state.records.get(submitted.key)?.revision).toBe(forgedRevision);
  });

  it("does not poll an untrusted async request ID when pinned jobs are genuine", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const submitted = await workflow.submit(input);
    const stored = state.records.get(submitted.key)!;
    stored.record.phase = "importing";
    stored.record.importAsyncRequestId = "other-consumer-import";
    phrase.callOrder.length = 0;
    phrase.asyncRequestIds.length = 0;

    const resumed = await workflow.submit({
      ...input,
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    });

    expect(resumed.phase).toBe("ready");
    expect(phrase.callOrder).toEqual(["get:project-uid:job-fr", "get:project-uid:job-fr"]);
    expect(phrase.asyncRequestIds).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(0);
  });

  it("refuses a pinned importing batch without job UIDs before polling its async request", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const submitted = await workflow.submit(input);
    const stored = state.records.get(submitted.key)!;
    stored.record.phase = "importing";
    stored.record.importAsyncRequestId = "other-consumer-import";
    stored.record.jobs = [];
    const forgedRecord = structuredClone(stored.record);
    const writesBeforeResume = state.writes;
    phrase.callOrder.length = 0;
    phrase.asyncRequestIds.length = 0;

    await expect(
      workflow.submit({
        ...input,
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      }),
    ).rejects.toThrow("without verifiable job UIDs");

    expect(phrase.callOrder).toEqual([]);
    expect(phrase.asyncRequestIds).toEqual([]);
    expect(state.writes).toBe(writesBeforeResume);
    expect(state.records.get(submitted.key)?.record).toEqual(forgedRecord);
  });

  it.each([
    ["empty Phrase project UID", { ...config, projectUid: "" }, /Phrase project UID is required/],
    [
      "parent-traversing source path",
      { ...config, sourceCatalog: { ...config.sourceCatalog, path: "../source.json" } },
      /Source catalog path must be a repository-relative path/,
    ],
    [
      "path as Phrase filename",
      { ...config, sourceCatalog: { ...config.sourceCatalog, filename: "nested/source.json" } },
      /filename must be a file name/,
    ],
    [
      "invalid Phrase region",
      { ...config, region: "apac" as unknown as "us" },
      /region must be eu or us/,
    ],
    ["no targets", { ...config, targetLocales: [] }, /At least one target locale/],
    [
      "duplicate Phrase locale",
      {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "fr", repositoryLocale: "fr-CA", outputPath: "locales/fr-CA.json" },
        ],
      },
      /Duplicate Phrase target locale/,
    ],
    [
      "duplicate repository locale",
      {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "fr-CA", repositoryLocale: "fr", outputPath: "locales/fr-CA.json" },
        ],
      },
      /Duplicate repository target locale/,
    ],
    [
      "source overwrite",
      {
        ...config,
        targetLocales: [
          { phraseLocale: "fr", repositoryLocale: "fr", outputPath: config.sourceCatalog.path },
        ],
      },
      /must not overwrite the source catalog/,
    ],
    [
      "duplicate output path",
      {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/fr.json" },
        ],
      },
      /Duplicate target output path/,
    ],
    [
      "ambiguous import settings",
      {
        ...config,
        sourceCatalog: {
          ...config.sourceCatalog,
          useProjectFileImportSettings: true,
        },
      },
      /Choose either an import settings UID/,
    ],
    [
      "credential-like adapter options",
      { ...config, targetOptions: { apiToken: "never persist" } },
      /must not contain credentials/,
    ],
    [
      "unknown completion-policy locale",
      { ...config, completionPolicy: { default: "per-locale", byLocale: { ja: "all-locales" } } },
      /unknown locale: ja/,
    ],
    [
      "invalid locale completion policy",
      {
        ...config,
        completionPolicy: {
          default: "per-locale",
          byLocale: { fr: "global" as unknown as "per-locale" },
        },
      },
      /Invalid completion policy for fr/,
    ],
  ] as Array<[string, PhraseWorkflowConfig, RegExp]>)(
    "rejects %s before writing state or calling Phrase",
    async (_label, invalidConfig, expectedError) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository: new FakeRepository(),
        catalogAdapters: new CatalogAdapterRegistry(),
      });

      await expect(
        workflow.submit({
          repository: "example/app",
          baseRef: "phrase-pilot",
          sourceCommit: "abc123",
          sourceBytes,
          config: invalidConfig,
        }),
      ).rejects.toThrow(expectedError);
      expect(phrase.createJobCalls).toBe(0);
      expect(await state.listBatches()).toHaveLength(0);
    },
  );

  it.each([
    ["empty bytes", new Uint8Array(), /must not be empty/],
    ["malformed JSON", new TextEncoder().encode("{"), /not valid JSON/],
    [
      "invalid source shape",
      new TextEncoder().encode('{"greeting":"Hello"}'),
      /must be a descriptor object/,
    ],
  ])(
    "rejects %s before making a Phrase request",
    async (_label, invalidSourceBytes, expectedError) => {
      const phrase = new FakePhrase();
      const workflow = new PhraseWorkflow({
        phrase,
        state: new MemoryStateStore(),
        repository: new FakeRepository(),
        catalogAdapters: new CatalogAdapterRegistry(),
      });

      await expect(
        workflow.submit({
          repository: "example/app",
          baseRef: "phrase-pilot",
          sourceCommit: "abc123",
          sourceBytes: invalidSourceBytes,
          config,
        }),
      ).rejects.toThrow(expectedError);
      expect(phrase.createJobCalls).toBe(0);
    },
  );

  it.each([
    ["unsupported source file", "unsupported"],
    ["missing job parts", "empty"],
  ])("records a rejected Phrase batch for %s", async (_label, failureMode) => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    if (failureMode === "unsupported") phrase.unsupportedFiles = ["translation-template.json"];
    else phrase.jobParts = [];
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await expect(
      workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      }),
    ).rejects.toThrow(/Phrase (rejected unsupported source files|created no job parts)/i);
    const [stored] = await state.listBatches();
    expect(stored?.record.phase).toBe("failed");
    expect(phrase.createJobCalls).toBe(1);
  });

  it("resumes a timed-out import wait without submitting a duplicate job", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.waitError = new Error("Timed out waiting for Phrase request import-1");
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };

    await expect(workflow.submit(input)).rejects.toThrow(/timed out waiting/i);
    const [pending] = await state.listBatches();
    expect(pending?.record.phase).toBe("importing");

    const reconciled = await workflow.reconcile();

    expect(reconciled.map((result) => result.phase)).toEqual(["pending"]);
    expect((await state.listBatches())[0]?.record.phase).toBe("ready");
    const resumed = await workflow.submit(input);
    expect(resumed.phase).toBe("ready");
    expect(phrase.createJobCalls).toBe(1);
  });

  it("isolates an import failure to its locale and retries that locale in a new attempt", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.importStatus = "ERROR";
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };

    const submitted = await workflow.submit(input);
    const [stored] = await state.listBatches();
    expect(submitted.phase).toBe("ready");
    expect(submitted.locales.fr).toMatchObject({
      phase: "failed",
      failureReason: "Phrase failed to import job job-fr: unknown error",
    });
    expect(stored?.record.phase).toBe("ready");
    expect(stored?.record.locales.fr?.phase).toBe("failed");
    expect((await workflow.submit(input)).key).toBe(submitted.key);
    expect(phrase.createJobCalls).toBe(1);

    phrase.importStatus = "OK";
    const retried = await workflow.submit({ ...input, retryFailed: true });

    expect(retried.phase).toBe("ready");
    expect(retried.attempt).toBe(1);
    expect(retried.key).not.toBe(stored?.record.key);
    expect(phrase.createJobCalls).toBe(2);
    await expect(workflow.submit({ ...input, retryFailed: true })).resolves.toMatchObject({
      key: retried.key,
    });
    expect(phrase.createJobCalls).toBe(2);
  });

  it("keeps a transient initial import lookup failure retryable while a sibling reconciles", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatus = "COMPLETED";
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 503", 503));
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    const submitted = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    const [stored] = await state.listBatches();
    const results = await workflow.reconcile();
    const [afterReconcile] = await state.listBatches();

    expect(submitted.phase).toBe("importing");
    expect(submitted.locales.fr).toEqual({ phase: "pending" });
    expect(stored?.record.phase).toBe("importing");
    expect(stored?.record.locales.fr).toEqual({ phase: "pending" });
    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(results[0]?.reason).toBe("Phrase API returned HTTP 503");
    expect(afterReconcile?.record.phase).toBe("importing");
    expect(afterReconcile?.record.locales.fr).toEqual({ phase: "pending" });
    expect(repository.pullRequests.map(({ path }) => path)).toEqual(["locales/ja.json"]);

    const japaneseBranch = afterReconcile?.record.locales.ja?.pullRequestBranch;
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"ようこそ {name}"}'),
    );
    const reexportResults = await workflow.reconcile();
    const [afterReexport] = await state.listBatches();

    expect(reexportResults.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(reexportResults[0]?.reason).toBe("Phrase API returned HTTP 503");
    expect(afterReexport?.record.phase).toBe("importing");
    expect(repository.commitCount(japaneseBranch!)).toBe(2);
    expect(
      new TextDecoder().decode(repository.branchFiles.get(japaneseBranch!)?.get("locales/ja.json")),
    ).toContain("ようこそ");
  });

  it("keeps a young 404 import lookup retrying without affecting siblings", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatus = "COMPLETED";
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 503", 503));
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    const submitted = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 404", 404));
    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(submitted.phase).toBe("importing");
    expect(submitted.locales.fr).toEqual({ phase: "pending" });
    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(results[0]?.reason).toBe(
      "Phrase has not yet exposed the new jobs; the next run continues this batch",
    );
    expect(stored?.record.phase).toBe("importing");
    expect(stored?.record.locales.fr).toEqual({ phase: "pending" });
    expect(repository.pullRequests.map(({ path }) => path)).toEqual(["locales/ja.json"]);
  });

  it("retries a transient import lookup on the next reconcile without creating another job", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatus = "COMPLETED";
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 503", 503));
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    const submitted = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    phrase.getJobErrors.delete("job-fr");
    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(submitted.phase).toBe("importing");
    expect(submitted.locales.fr).toEqual({ phase: "pending" });
    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "pr-created"],
      ["ja", "pr-created"],
    ]);
    expect(phrase.getJobCalls.filter(({ jobUid }) => jobUid === "job-fr")).toHaveLength(3);
    expect(stored?.record.phase).toBe("ready");
    expect(phrase.createJobCalls).toBe(1);
    expect(stored?.record.jobs.map(({ uid, targetLang }) => [uid, targetLang])).toEqual([
      ["job-fr", "fr"],
      ["job-ja", "ja"],
    ]);
    expect(repository.pullRequests.map(({ path }) => path)).toEqual([
      "locales/fr.json",
      "locales/ja.json",
    ]);
  });

  it("settles replacement import jobs per locale while carrying an open locale PR", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        { phraseLocale: "ko", repositoryLocale: "ko", outputPath: "locales/ko.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja", "ko"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
      { uid: "job-ko", targetLang: "ko", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "CANCELLED");
    phrase.jobStatuses.set("job-ko", "CANCELLED");
    phrase.targetBytesByJob.set(
      "job-ko",
      new TextEncoder().encode('{"greeting":"안녕하세요 {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    };
    await workflow.submit(input);
    await workflow.reconcile();

    phrase.expectedTargetLangs = ["ja", "ko"];
    phrase.jobParts = [
      { uid: "job-ja-retry", targetLang: "ja", workflowLevel: 1 },
      { uid: "job-ko-retry", targetLang: "ko", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-ko-retry", "COMPLETED");
    phrase.getJobErrors.set(
      "job-ja-retry",
      new PhraseApiError("Phrase API returned HTTP 503", 503),
    );
    phrase.targetBytesByJob.set(
      "job-ko-retry",
      new TextEncoder().encode('{"greeting":"안녕하세요 {name}"}'),
    );

    const retry = await workflow.submit({ ...input, retryFailed: true });
    const results = await workflow.reconcile();

    expect(retry.locales.fr?.phase).toBe("pr-created");
    expect(retry.locales.ja).toEqual({ phase: "pending" });
    expect(retry.locales.ko?.phase).toBe("pending");
    expect(results).toContainEqual({
      batchKey: retry.key,
      phraseLocale: "ja",
      phase: "retrying",
      reason: "Phrase API returned HTTP 503",
    });
    expect(
      results.some(({ phraseLocale, phase }) => phraseLocale === "ko" && phase === "pr-created"),
    ).toBe(true);
    expect(repository.pullRequests.map(({ path }) => path)).toContain("locales/ko.json");
  });

  it("retries only failed locales after completion while preserving successful locale PRs", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "CANCELLED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
      },
    };

    const first = await workflow.submit(input);
    const firstResults = await workflow.reconcile();
    const firstBatches = await state.listBatches();

    expect(firstResults.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "pr-created"],
      ["ja", "failed"],
    ]);
    expect(firstBatches[0]?.record.phase).toBe("ready");
    expect(firstBatches[0]?.record.locales.fr).toMatchObject({ phase: "pr-created" });
    expect(firstBatches[0]?.record.locales.ja).toMatchObject({ phase: "failed" });
    expect(repository.pullRequests.map(({ path }) => path)).toEqual(["locales/fr.json"]);
    const frBranch = firstBatches[0]?.record.locales.fr?.pullRequestBranch;

    const existing = await workflow.submit(input);
    expect(existing.key).toBe(first.key);
    expect(phrase.createJobCalls).toBe(1);

    phrase.expectedTargetLangs = ["ja"];
    phrase.jobParts = [{ uid: "job-ja-retry", targetLang: "ja", workflowLevel: 1 }];
    phrase.jobStatuses.set("job-ja-retry", "COMPLETED");
    phrase.targetBytesByJob.set(
      "job-ja-retry",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase job was not found", 404));
    const retried = await workflow.submit({ ...input, retryFailed: true });

    expect(retried.key).not.toBe(first.key);
    expect(retried.attempt).toBe(1);
    expect(retried.jobs.map(({ uid, targetLang }) => [uid, targetLang])).toEqual([
      ["job-fr", "fr"],
      ["job-ja-retry", "ja"],
    ]);
    expect(retried.locales.fr).toMatchObject({
      phase: "pr-created",
      pullRequestUrl: "https://github.com/example/app/pull/42",
    });
    expect(retried.locales.ja).toEqual({ phase: "pending" });
    expect(phrase.createJobCalls).toBe(2);

    const retryResults = await workflow.reconcile();
    const repeated = await workflow.submit({ ...input, retryFailed: true });

    expect(retryResults.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(retryResults[0]?.reason).toBe(
      "Phrase has not yet exposed the new jobs; the next run continues this batch",
    );
    expect(repository.pullRequests.map(({ path }) => path)).toEqual([
      "locales/fr.json",
      "locales/ja.json",
    ]);
    expect(repository.commitCount(frBranch!)).toBe(1);
    expect(phrase.targetDownloadCalls).toBe(2);
    expect(repository.pullRequestStateCalls).toBe(1);
    expect(repeated.key).toBe(retried.key);
    expect(phrase.createJobCalls).toBe(2);
  });

  it("re-exports a carried PR while the retry batch import is pending", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "CANCELLED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
      },
    };

    await workflow.submit(input);
    expect(
      (await workflow.reconcile()).map(({ phraseLocale, phase }) => [phraseLocale, phase]),
    ).toEqual([
      ["fr", "pr-created"],
      ["ja", "failed"],
    ]);
    const [parent] = await state.listBatches();
    const frenchBranch = parent?.record.locales.fr?.pullRequestBranch;

    phrase.expectedTargetLangs = ["ja"];
    phrase.jobParts = [{ uid: "job-ja-retry", targetLang: "ja", workflowLevel: 1 }];
    phrase.jobStatuses.set("job-ja-retry", "COMPLETED");
    phrase.targetBytesByJob.set(
      "job-ja-retry",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    phrase.getJobErrors.set(
      "job-ja-retry",
      new PhraseApiError("Phrase API returned HTTP 503", 503),
    );
    const retried = await workflow.submit({ ...input, retryFailed: true });

    expect(retried.phase).toBe("importing");
    expect(retried.locales.fr?.phase).toBe("pr-created");

    phrase.targetBytesByJob.set("job-fr", new TextEncoder().encode('{"greeting":"Salut {name}"}'));
    const results = await workflow.reconcile();
    const updatedRetry = await state.readBatch(retried.key);

    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "pr-created"],
      ["ja", "retrying"],
    ]);
    expect(results[1]?.reason).toBe("Phrase API returned HTTP 503");
    expect(updatedRetry?.record.phase).toBe("importing");
    expect(repository.commitCount(frenchBranch!)).toBe(2);
    expect(
      new TextDecoder().decode(repository.branchFiles.get(frenchBranch!)?.get("locales/fr.json")),
    ).toContain("Salut");
  });

  it("refreshes a carried locale SHA when retry ownership transfers after import", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "CANCELLED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
      },
    };
    await workflow.submit(input);
    await workflow.reconcile();
    const [parent] = await state.listBatches();
    const branch = parent?.record.locales.fr?.pullRequestBranch;
    const initialSha = parent?.record.locales.fr?.toolingCommitSha;
    const handoffPendingSha = "unreferenced-pending-commit";
    const handoffOwnedSha = "older-owned-tooling-commit";
    const parentWithPending = structuredClone(parent!.record);
    parentWithPending.locales.fr!.pendingToolingCommitSha = handoffPendingSha;
    parentWithPending.locales.fr!.toolingCommitShas = [
      ...(parentWithPending.locales.fr!.toolingCommitShas ?? []),
      handoffOwnedSha,
    ];
    await state.updateBatch(parentWithPending, parent!.revision);

    phrase.expectedTargetLangs = ["ja"];
    phrase.jobParts = [{ uid: "job-ja-retry", targetLang: "ja", workflowLevel: 1 }];
    phrase.jobStatuses.set("job-ja-retry", "NEW");
    phrase.waitError = new PhraseWorkflowError("Timed out waiting for Phrase job imports");
    await expect(workflow.submit({ ...input, retryFailed: true })).rejects.toThrow(
      "Timed out waiting for Phrase job imports",
    );
    const retryAfterTimeout = (await state.listBatches()).find(
      ({ record }) => record.retryParentBatchKey === parent?.record.key,
    );
    expect(retryAfterTimeout?.record.locales.fr).toMatchObject({
      toolingCommitSha: initialSha,
      pendingToolingCommitSha: handoffPendingSha,
    });
    expect(retryAfterTimeout?.record.locales.fr?.toolingCommitShas).toContain(handoffOwnedSha);

    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.targetBytesByJob.set("job-fr", new TextEncoder().encode('{"greeting":"Salut {name}"}'));
    phrase.jobStatuses.set("job-ja-retry", "COMPLETED");
    await workflow.reconcile();
    const batchesAfterHandoff = await state.listBatches();
    const updatedParent = batchesAfterHandoff.find(
      ({ record }) => record.key === parent?.record.key,
    );
    const retry = batchesAfterHandoff.find(
      ({ record }) => record.retryParentBatchKey === parent?.record.key,
    );
    const pushedSha = repository.branchHeads.get(branch!);

    expect(pushedSha).not.toBe(initialSha);
    expect(updatedParent?.record.locales.fr?.toolingCommitSha).toBe(pushedSha);
    expect(updatedParent?.record.locales.fr?.toolingCommitShas).toContain(handoffOwnedSha);
    expect(updatedParent?.record.locales.fr?.pullRequestReexportDelegated).toBe(true);
    expect(retry?.record.locales.fr?.toolingCommitSha).toBe(pushedSha);
    expect(retry?.record.locales.fr?.toolingCommitShas).toContain(handoffOwnedSha);

    const retryResults = await workflow.reconcile();
    const afterRetry = await state.readBatch(retry!.record.key);
    expect(
      retryResults.some(({ phraseLocale, phase }) => phraseLocale === "fr" && phase === "retrying"),
    ).toBe(false);
    expect(afterRetry?.record.locales.fr?.toolingCommitSha).toBe(pushedSha);
    expect(afterRetry?.record.locales.fr?.pendingToolingCommitSha).toBeUndefined();
    expect(repository.commitCount(branch!)).toBe(2);
  });

  it("reuses one Phrase job when the same source is submitted from a later commit", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };

    const first = await workflow.submit(input);
    const later = await workflow.submit({
      ...input,
      sourceCommit: "def456",
      config: {
        ...config,
        targetLocales: [{ ...config.targetLocales[0]!, outputPath: "src/locales/fr.json" }],
        completionPolicy: { default: "all-locales" },
      },
    });

    expect(later.key).toBe(first.key);
    expect(later.sourceCommit).toBe("abc123");
    expect(phrase.createJobCalls).toBe(1);
    expect(later.config.targetLocales[0]?.outputPath).toBe("src/locales/fr.json");
    expect((await state.listBatches())[0]?.record.config.completionPolicy.default).toBe(
      "all-locales",
    );
  });

  it("does not mask a state conflict while finishing the import", async () => {
    const state = new MemoryStateStore();
    state.conflictOnPhase = "ready";
    const workflow = new PhraseWorkflow({
      phrase: new FakePhrase(),
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await expect(
      workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      }),
    ).rejects.toBeInstanceOf(PhraseBatchStateConflictError);
    expect((await state.listBatches())[0]?.record.phase).toBe("importing");
  });

  it("rejects source bytes that do not belong to the requested commit before creating a Phrase job", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.pinnedSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Different"}}',
    );
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await expect(
      workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      }),
    ).rejects.toThrow(/do not match the source file at the requested commit/i);
    expect(phrase.createJobCalls).toBe(0);
    expect(await state.listBatches()).toHaveLength(0);
  });

  it("fails closed after an upload whose remote outcome is unknown", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.createError = Object.assign(new Error("connection reset"), { mayHaveExecuted: true });
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };

    await expect(workflow.submit(input)).rejects.toThrow("connection reset");
    const [stored] = await state.listBatches();
    expect(stored?.record.phase).toBe("unknown");
    await expect(workflow.submit(input)).rejects.toThrow(
      "Phrase job may still be appearing in Phrase; the next run will check again",
    );
    expect(phrase.createJobCalls).toBe(1);
  });

  it("lists translation lint warnings in the locale pull request", async () => {
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({ greeting: { defaultMessage: "Bonjour {name} !", description: "Greeting" } }),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const [result] = await workflow.reconcile();

    expect(result?.phase).toBe("pr-created");
    expect(repository.pullRequests[0]?.body).toContain(
      "⚠️ 1 warning — see the latest 🌐 Translation check comment.",
    );
  });

  it("renders the exact error and warning report comment", async () => {
    const scenario = await makeFindingsScenario(
      { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
      { greeting: "Bonjour !" },
    );

    const [result] = await scenario.workflow.reconcile();
    const report = scenario.repository.pullRequestComments[0]?.body;

    expect(result?.phase).toBe("failed");
    expect(report).toBe(
      [
        "<!-- i18n-pipeline:translation-findings digest=b136d1e56363762a2337ae834338591e8e24ce1d6aa087f87d320ad7e122b708 -->",
        "## 🌐 Translation check · `fr`",
        "",
        "> [!CAUTION]",
        "> **❌ 1 error** blocks merging. **⚠️ 1 warning** needs a reviewer's judgment.",
        "",
        "### ❌ Errors — must be fixed before merging",
        "",
        "| # | Message | Problem | English source | Translation |",
        "| :-: | --- | --- | --- | --- |",
        "| **E1** | `greeting` | Argument {name} is missing from the translation. | `Hello {name}` | `Bonjour !` |",
        "",
        "### ⚠️ Warnings — review before merging",
        "",
        "| # | Message | Problem | English source | Translation |",
        "| :-: | --- | --- | --- | --- |",
        "| **W1** | `greeting` | A regular space precedes : ; ! ? or » (or follows «), so the line can break before the punctuation. Use a non-breaking space (U+00A0, or narrow U+202F). | `Hello {name}` | `Bonjour !` |",
        "",
        "<details>",
        "<summary>ℹ️ Batch details</summary>",
        "",
        "| | |",
        "| --- | --- |",
        "| Phrase project | `project-uid` |",
        `| Batch | \`${scenario.batch.key.slice(0, 12)}\` |`,
        "| Source commit | `abc123` |",
        "| Final job | `job-fr` |",
        "",
        "</details>",
        "",
        "<sub>🤖 Posted by i18n-pipeline. A new run with changed findings adds a new report; this PR stays a draft and is never marked ready automatically.</sub>",
      ].join("\n"),
    );
  });

  it("renders warning-only and clean reports with the matching summary boxes", async () => {
    const warningScenario = await makeFindingsScenario(
      { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
      { greeting: "Bonjour {name} !" },
    );
    const [warningResult] = await warningScenario.workflow.reconcile();
    const warningReport = warningScenario.repository.pullRequestComments[0]?.body ?? "";
    expect(warningResult?.phase).toBe("pr-created");
    expect(warningReport).toContain(
      "> [!WARNING]\n> **⚠️ 1 warning** needs a reviewer's judgment.",
    );
    expect(warningReport).not.toContain("### ❌ Errors");
    expect(warningReport).toContain("### ⚠️ Warnings — review before merging");

    const cleanScenario = await makeFindingsScenario(
      { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
      { greeting: "Bonjour {name}" },
    );
    const [cleanResult] = await cleanScenario.workflow.reconcile();
    const cleanReport = cleanScenario.repository.pullRequestComments[0]?.body ?? "";
    expect(cleanResult?.phase).toBe("pr-created");
    expect(cleanScenario.repository.pullRequestComments).toHaveLength(1);
    expect(cleanReport).toContain("> [!TIP]\n> **✅ No translation errors or warnings.**");
    expect(cleanReport).not.toContain("| # | Message |");
    expect(cleanScenario.repository.pullRequests[0]?.body).toContain(
      "✅ No translation errors or warnings.",
    );
  });

  it("includes the generated-YAML note in FEO reports and keeps it in the PR description", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const feoConfig: PhraseWorkflowConfig = {
      ...config,
      targetAdapter: "icu-json",
      frontendTemplate: { path: "deploy/frontend.yaml" },
    };
    const scenario = await makeFindingsScenario(
      { "searchEntries.roles.title": { defaultMessage: "Roles" } },
      { "searchEntries.roles.title": "Rôles {missing}" },
      feoConfig,
      template,
    );
    const [firstResult] = await scenario.workflow.reconcile();
    const note =
      "Generated Frontend YAML was not updated for this export. Any existing locale block may reflect an earlier valid export and must not be merged with this catalog.";
    const firstReport = scenario.repository.pullRequestComments[0]?.body ?? "";

    expect(firstResult?.phase).toBe("failed");
    expect(firstReport).toContain(`> [!NOTE]\n> ${note}`);
    expect(firstReport).toContain(
      `> [!CAUTION]\n> **❌ 1 error** blocks merging.\n\n> [!NOTE]\n> ${note}`,
    );
    expect(scenario.repository.pullRequests[0]?.body).toContain(note);

    scenario.phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({ "searchEntries.roles.title": "Salut {missing}" }),
    );
    await scenario.workflow.reconcile();
    expect(scenario.repository.pullRequestComments).toHaveLength(2);
    expect(scenario.repository.pullRequestComments[1]?.body).toContain(`> [!NOTE]\n> ${note}`);
  });

  it("numbers error and warning rows independently", async () => {
    const scenario = await makeFindingsScenario(
      {
        aWarning: { defaultMessage: "Goodbye" },
        bWarning: { defaultMessage: "Welcome" },
        requestCount: {
          defaultMessage: "{count, plural, one {# request} other {# requests}}",
        },
        zName: { defaultMessage: "Hello {name}" },
      },
      {
        aWarning: "Au revoir !",
        bWarning: "Bienvenue !",
        requestCount: "{count, plural, one {# élément} other {éléments}}",
        zName: "Bonjour",
      },
    );

    await scenario.workflow.reconcile();
    const report = scenario.repository.pullRequestComments[0]?.body ?? "";

    expect(report).toContain("| **E1** |");
    expect(report).toContain("| **E2** |");
    expect(report).not.toContain("| **E3** |");
    expect(report).toContain("| **W1** |");
    expect(report).toContain("| **W2** |");
    expect(report).not.toContain("| **W3** |");
  });

  it("escapes table pipes and backticks, replaces newlines, and truncates patterns", async () => {
    const sourcePattern = `Source | \`quoted\`\n${"s".repeat(350)}`;
    const translationPattern = `Translation | \`value\`\n${"t".repeat(350)}`;
    const scenario = await makeFindingsScenario(
      { "draft|id`quoted": { defaultMessage: sourcePattern } },
      { "extra|id": translationPattern },
    );

    await scenario.workflow.reconcile();
    const report = scenario.repository.pullRequestComments[0]?.body ?? "";
    const expectedSourceValue = `Source | \`quoted\` ${"s".repeat(350)}`;
    const expectedTranslationValue = `Translation | \`value\` ${"t".repeat(350)}`;
    const expectedSource = `${[...expectedSourceValue].slice(0, 299).join("")}…`;
    const expectedTranslation = `${[...expectedTranslationValue].slice(0, 299).join("")}…`;

    expect(report).toContain("``draft\\|id`quoted``");
    expect(report).toContain(`\`\`${expectedSource.replace("|", "\\|")}\`\``);
    expect(report).toContain("`extra\\|id`");
    expect(report).toContain(`\`\`${expectedTranslation.replace("|", "\\|")}\`\``);
    expect(report).not.toContain(`quoted\n${"s".repeat(10)}`);
  });

  it("caps each findings table at MAX_PULL_REQUEST_FINDINGS and reports omitted rows", async () => {
    const sourceMessages = Object.fromEntries(
      Array.from({ length: 52 }, (_, index) => [
        `missing-${String(index).padStart(2, "0")}`,
        { defaultMessage: `Source ${index}` },
      ]),
    );
    const scenario = await makeFindingsScenario(sourceMessages, {});

    await scenario.workflow.reconcile();
    const report = scenario.repository.pullRequestComments[0]?.body ?? "";

    expect(report).toContain("| **E50** |");
    expect(report).not.toContain("| **E51** |");
    expect(report).toContain("…and 2 more");
    expect(report.indexOf("…and 2 more")).toBeGreaterThan(report.indexOf("| **E50** |"));
  });

  it("deduplicates identical reports and posts changed and clean findings", async () => {
    const scenario = await makeFindingsScenario(
      { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
      { greeting: "Bonjour" },
    );

    await scenario.workflow.reconcile();
    await scenario.workflow.reconcile();
    expect(scenario.repository.pullRequestComments).toHaveLength(1);

    scenario.phrase.targetBytes = new TextEncoder().encode(JSON.stringify({ greeting: "Salut" }));
    await scenario.workflow.reconcile();
    expect(scenario.repository.pullRequestComments).toHaveLength(2);

    scenario.phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({ greeting: "Salut {name}" }),
    );
    const [cleanResult] = await scenario.workflow.reconcile();
    expect(cleanResult?.phase).toBe("pr-created");
    expect(scenario.repository.pullRequestComments).toHaveLength(3);
    expect(scenario.repository.pullRequestComments[2]?.body).toContain(
      "> [!TIP]\n> **✅ No translation errors or warnings.**",
    );
  });

  it.each(["closed", "merged"] as const)(
    "does not post another report after the PR is %s",
    async (pullRequestState) => {
      const scenario = await makeFindingsScenario(
        { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
        { greeting: "Bonjour" },
      );
      const [created] = await scenario.workflow.reconcile();
      const commentCount = scenario.repository.pullRequestComments.length;
      scenario.repository.pullRequestStates.set(created!.pullRequestUrl!, pullRequestState);

      await scenario.workflow.reconcile();

      expect(commentCount).toBe(1);
      expect(scenario.repository.pullRequestComments).toHaveLength(commentCount);
    },
  );

  it("keeps a committed export retryable when report comment delivery fails", async () => {
    const scenario = await makeFindingsScenario(
      { greeting: { defaultMessage: "Hello {name}", description: "Greeting" } },
      { greeting: "Bonjour" },
    );
    scenario.repository.commentError = new PhraseRepositoryError("comment API failed", 500);

    const [failed] = await scenario.workflow.reconcile();
    const storedAfterFailure = await scenario.state.readBatch(scenario.batch.key);
    const branch = storedAfterFailure?.record.locales.fr?.pullRequestBranch;

    expect(failed?.phase).toBe("retrying");
    expect(storedAfterFailure?.record.locales.fr?.phase).toBe("pr-created");
    expect(storedAfterFailure?.record.locales.fr?.toolingCommitSha).toBeDefined();
    expect(storedAfterFailure?.record.locales.fr?.pullRequestCommentPending).toBe(true);
    expect(scenario.repository.commitCount(branch!)).toBe(1);

    scenario.repository.commentError = undefined;
    const [retried] = await scenario.workflow.reconcile();
    const storedAfterRetry = await scenario.state.readBatch(scenario.batch.key);
    expect(retried?.phase).toBe("failed");
    expect(scenario.repository.pullRequestComments).toHaveLength(1);
    expect(storedAfterRetry?.record.locales.fr?.pullRequestCommentPending).toBeUndefined();
    expect(scenario.repository.commitCount(branch!)).toBe(1);
  });

  it("reconciles a completed final job into a validated locale pull request", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        greeting: {
          defaultMessage: "Bonjour {name}",
          description: "Greeting",
        },
      }),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results).toEqual([
      {
        batchKey: expect.any(String),
        phraseLocale: "fr",
        phase: "pr-created",
        pullRequestUrl: "https://github.com/example/app/pull/42",
      },
    ]);
    expect(phrase.targetDownloadCalls).toBe(1);
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.path).toBe("locales/fr.json");
    expect(repository.pullRequests[0]?.baseRef).toBe("phrase-pilot");
    expect(JSON.parse(new TextDecoder().decode(repository.pullRequests[0]?.content))).toEqual({
      greeting: "Bonjour {name}",
    });
    expect(repository.pullRequests[0]?.body).not.toContain("Translation warnings");

    expect((await state.listBatches())[0]?.record.phase).toBe("ready");

    repository.baseSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Welcome {name}","description":"Greeting"}}',
    );
    const repeated = await workflow.reconcile();
    expect(repeated).toEqual([]);
    expect((await state.listBatches())[0]?.record.phase).toBe("superseded");
    expect(phrase.targetDownloadCalls).toBe(1);
    expect(repository.pullRequests).toHaveLength(1);
  });

  it("re-exports corrected Phrase content to the existing open locale PR branch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const [created] = await state.listBatches();
    const branch = created?.record.locales.fr?.pullRequestBranch;
    expect(branch).toBeDefined();
    expect(repository.commitCount(branch!)).toBe(1);
    expect(repository.pullRequests[0]?.title).toBe(
      "i18n(fr): Phrase translation update for locales/translation-template.json",
    );
    repository.pullRequests[0] = {
      ...repository.pullRequests[0]!,
      title: "i18n(fr): Phrase translation update",
    };

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    const results = await workflow.reconcile();
    const [updated] = await state.listBatches();

    expect(results).toEqual([
      expect.objectContaining({
        batchKey: created?.record.key,
        phraseLocale: "fr",
        phase: "pr-created",
        pullRequestUrl: "https://github.com/example/app/pull/42",
      }),
    ]);
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.branch).toBe(branch);
    expect(repository.pullRequests[0]?.title).toBe(
      "i18n(fr): Phrase translation update for locales/translation-template.json",
    );
    expect(repository.commitCount(branch!)).toBe(2);
    expect(
      new TextDecoder().decode(repository.branchFiles.get(branch!)?.get("locales/fr.json")),
    ).toContain("Salut {name}");
    expect(updated?.record.phase).toBe("ready");
    expect(updated?.record.locales.fr?.toolingCommitSha).toBe(repository.branchHeads.get(branch!));
    expect(phrase.targetDownloadCalls).toBe(2);
  });

  it("unions owned SHAs after a concurrent state writer moves the branch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const created = (await state.listBatches())[0]!;
    const branch = created.record.locales.fr!.pullRequestBranch!;
    const initialHead = repository.branchHeads.get(branch)!;
    const concurrentHead = "concurrent-tooling-commit";

    state.beforeEveryUpdateConflict = (store, candidate) => {
      const current = store.records.get(candidate.key)!;
      const currentShas = current.record.locales.fr?.toolingCommitShas ?? [];
      const candidateShas = candidate.locales.fr?.toolingCommitShas ?? [];
      if (!candidateShas.some((sha) => !currentShas.includes(sha))) return;
      store.beforeEveryUpdateConflict = undefined;
      const concurrentRecord = structuredClone(current.record);
      const locale = concurrentRecord.locales.fr!;
      concurrentRecord.locales.fr = {
        ...locale,
        toolingCommitShas: [
          ...new Set([...(locale.toolingCommitShas ?? []), concurrentHead]),
        ].slice(-20),
      };
      store.records.set(candidate.key, {
        record: concurrentRecord,
        revision: String(Number(current.revision) + 1),
      });
      repository.branchHeads.set(branch, concurrentHead);
    };
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');

    expect((await workflow.reconcile())[0]?.phase).toBe("retrying");
    const afterConflict = await state.readBatch(created.record.key);
    const concurrentWriteShas = afterConflict?.record.locales.fr?.toolingCommitShas ?? [];
    const failedWriterSha = concurrentWriteShas.find(
      (sha) => sha !== initialHead && sha !== concurrentHead,
    );
    expect(concurrentWriteShas).toHaveLength(3);
    expect(concurrentWriteShas).toContain(initialHead);
    expect(concurrentWriteShas).toContain(concurrentHead);
    expect(failedWriterSha).toBeDefined();
    expect(repository.branchHeads.get(branch)).toBe(concurrentHead);

    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const recovered = await state.readBatch(created.record.key);
    const recoveredHead = repository.branchHeads.get(branch)!;
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(concurrentHead);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(failedWriterSha);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(recoveredHead);
    expect(recovered?.record.locales.fr?.toolingCommitSha).toBe(recoveredHead);
  });

  it("bounds retries when owned-SHA state writes keep conflicting", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const created = (await state.listBatches())[0]!;
    const branch = created.record.locales.fr!.pullRequestBranch!;
    const initialHead = repository.branchHeads.get(branch)!;
    let conflicts = 0;
    state.beforeEveryUpdateConflict = (store, candidate) => {
      const current = store.records.get(candidate.key)!;
      const currentShas = current.record.locales.fr?.toolingCommitShas ?? [];
      const candidateShas = candidate.locales.fr?.toolingCommitShas ?? [];
      if (!candidateShas.some((sha) => !currentShas.includes(sha))) return;
      conflicts += 1;
      const concurrentRecord = structuredClone(current.record);
      const locale = concurrentRecord.locales.fr!;
      concurrentRecord.locales.fr = {
        ...locale,
        toolingCommitShas: [
          ...new Set([...(locale.toolingCommitShas ?? []), `concurrent-${conflicts}`]),
        ].slice(-20),
      };
      store.records.set(candidate.key, {
        record: concurrentRecord,
        revision: String(Number(current.revision) + 1),
      });
    };
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');

    expect((await workflow.reconcile())[0]).toMatchObject({ phase: "retrying" });
    expect(conflicts).toBe(3);
    expect(repository.branchHeads.get(branch)).toBe(initialHead);
    const latest = await state.readBatch(created.record.key);
    expect(latest?.record.locales.fr?.toolingCommitShas).toEqual(
      expect.arrayContaining(["concurrent-1", "concurrent-2", "concurrent-3"]),
    );
  });

  it("keeps ownership across a failed final save and a later failed ref update", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const created = (await state.listBatches())[0]!;
    const branch = created.record.locales.fr!.pullRequestBranch!;
    const initialHead = repository.branchHeads.get(branch)!;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    state.failUpdateMatching = (record) =>
      record.locales.fr?.phase === "pr-created" &&
      record.locales.fr.toolingCommitSha !== initialHead;

    expect((await workflow.reconcile())[0]?.phase).toBe("retrying");
    const afterFinalSaveFailure = await state.readBatch(created.record.key);
    const pushedHead = repository.branchHeads.get(branch)!;
    expect(pushedHead).not.toBe(initialHead);
    expect(afterFinalSaveFailure?.record.locales.fr?.toolingCommitSha).toBe(initialHead);
    expect(afterFinalSaveFailure?.record.locales.fr?.toolingCommitShas).toContain(pushedHead);

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour encore {name}"}');
    repository.refUpdateError = new PhraseRepositoryError("ref update failed", 503);
    expect((await workflow.reconcile())[0]?.phase).toBe("retrying");
    const afterRefFailure = await state.readBatch(created.record.key);
    const interruptedHead = afterRefFailure?.record.locales.fr?.toolingCommitShas?.find(
      (sha) =>
        !afterFinalSaveFailure?.record.locales.fr?.toolingCommitShas?.includes(sha) &&
        sha !== pushedHead,
    );
    expect(interruptedHead).toBeDefined();
    expect(repository.branchHeads.get(branch)).toBe(pushedHead);
    expect(afterRefFailure?.record.locales.fr?.toolingCommitSha).toBe(initialHead);
    expect(afterRefFailure?.record.locales.fr?.toolingCommitShas).toContain(pushedHead);
    expect(afterRefFailure?.record.locales.fr?.toolingCommitShas).toContain(interruptedHead);

    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const recovered = await state.readBatch(created.record.key);
    const recoveredHead = repository.branchHeads.get(branch)!;
    expect(recoveredHead).not.toBe(pushedHead);
    expect(recovered?.record.locales.fr?.toolingCommitSha).toBe(recoveredHead);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(pushedHead);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(interruptedHead);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(recoveredHead);
  });

  it("bounds older confirmed history at 20 while keeping the current branch head", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const created = (await state.listBatches())[0]!;
    const branch = created.record.locales.fr!.pullRequestBranch!;
    const initialHead = repository.branchHeads.get(branch)!;

    for (let version = 1; version <= 21; version += 1) {
      phrase.targetBytes = new TextEncoder().encode(
        JSON.stringify({ greeting: `Salut ${version} {name}` }),
      );
      expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    }
    const capped = await state.readBatch(created.record.key);
    const currentHead = repository.branchHeads.get(branch)!;
    expect(capped?.record.locales.fr?.toolingCommitShas).toHaveLength(20);
    expect(capped?.record.locales.fr?.toolingCommitShas?.at(-1)).toBe(currentHead);
    expect(capped?.record.locales.fr?.toolingCommitShas).toContain(currentHead);
    expect(capped?.record.locales.fr?.toolingCommitShas).not.toContain(initialHead);

    phrase.targetBytes = new TextEncoder().encode(JSON.stringify({ greeting: "Salut 22 {name}" }));
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const afterNextExport = await state.readBatch(created.record.key);
    const nextHead = repository.branchHeads.get(branch)!;
    expect(afterNextExport?.record.locales.fr?.toolingCommitShas).toHaveLength(20);
    expect(afterNextExport?.record.locales.fr?.toolingCommitShas).toContain(nextHead);
    expect(afterNextExport?.record.locales.fr?.toolingCommitSha).toBe(nextHead);
  });

  it("keeps the confirmed head and all newer SHAs across 21 overlapping writers", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const created = (await state.listBatches())[0]!;
    const branch = created.record.locales.fr!.pullRequestBranch!;
    const confirmedHead = repository.branchHeads.get(branch)!;

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut pushed {name}"}');
    state.failUpdateMatching = (record) =>
      record.locales.fr?.phase === "pr-created" &&
      record.locales.fr.toolingCommitSha !== confirmedHead;
    expect((await workflow.reconcile())[0]?.phase).toBe("retrying");
    const afterUnconfirmedPush = await state.readBatch(created.record.key);
    const pushedHead = repository.branchHeads.get(branch)!;
    expect(pushedHead).not.toBe(confirmedHead);
    expect(afterUnconfirmedPush?.record.locales.fr?.toolingCommitSha).toBe(confirmedHead);
    expect(afterUnconfirmedPush?.record.locales.fr?.toolingCommitShas).toContain(pushedHead);

    // These writers all verified the old head before the first writer advanced the ref.
    repository.preverifiedRefUpdateHeadSha = confirmedHead;
    for (let writer = 1; writer <= 20; writer += 1) {
      phrase.targetBytes = new TextEncoder().encode(
        JSON.stringify({ greeting: `Salut stale ${writer} {name}` }),
      );
      expect((await workflow.reconcile())[0]?.phase).toBe("retrying");
    }

    const afterOverlappingWriters = await state.readBatch(created.record.key);
    const ownedShas = afterOverlappingWriters?.record.locales.fr?.toolingCommitShas ?? [];
    expect(repository.branchHeads.get(branch)).toBe(pushedHead);
    expect(afterOverlappingWriters?.record.locales.fr?.toolingCommitSha).toBe(confirmedHead);
    expect(ownedShas).toContain(confirmedHead);
    expect(ownedShas).toContain(pushedHead);
    expect(ownedShas).toHaveLength(22);
  });

  it("refreshes the open PR warning list after re-export", async () => {
    const source = new TextEncoder().encode(
      JSON.stringify({
        requests: {
          defaultMessage: "{count, plural, one {# request} other {# requests}}",
          description: "Request count",
        },
      }),
    );
    const warningConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        requests: {
          defaultMessage: "{count, plural, one {# élément} other {# éléments}}",
          description: "Request count",
        },
      }),
    );
    const repository = new FakeRepository();
    repository.baseSourceBytes = source;
    repository.pinnedSourceBytes = source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: warningConfig,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    expect(
      repository.pullRequestBodies.get("https://github.com/example/app/pull/42"),
    ).not.toContain("Translation warnings");

    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        requests: {
          defaultMessage: "{count, plural, one {élément} other {# éléments}}",
          description: "Request count",
        },
      }),
    );
    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("pr-created");
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequestComments.at(-1)?.body).toContain(
      'The source "one" branch of plural {count} shows the count',
    );
  });

  it("recovers a tooling commit when its final state save fails after the push", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const branch = created?.record.locales.fr?.pullRequestBranch;
    const recordedSha = created?.record.locales.fr?.toolingCommitSha;
    const recordedShas = created?.record.locales.fr?.toolingCommitShas ?? [];
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    state.failUpdateMatching = (record) =>
      record.locales.fr?.phase === "pr-created" &&
      record.locales.fr.toolingCommitSha !== recordedSha &&
      !recordedShas.includes(record.locales.fr.toolingCommitSha ?? "");

    const failedSave = await workflow.reconcile();
    const [afterFailedSave] = await state.listBatches();
    const pushedSha = repository.branchHeads.get(branch!);

    expect(failedSave[0]).toMatchObject({ phase: "retrying" });
    expect(pushedSha).not.toBe(recordedSha);
    expect(afterFailedSave?.record.locales.fr?.toolingCommitSha).toBe(recordedSha);
    expect(afterFailedSave?.record.locales.fr?.toolingCommitShas).toContain(pushedSha);
    expect(repository.commitCount(branch!)).toBe(2);

    const retried = await workflow.reconcile();
    const [recovered] = await state.listBatches();

    expect(retried[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(branch!)).toBe(2);
    expect(recovered?.record.locales.fr?.toolingCommitSha).toBe(pushedSha);
    expect(recovered?.record.locales.fr?.toolingCommitShas).toContain(pushedSha);
    expect(recovered?.record.locales.fr?.pendingToolingCommitSha).toBeUndefined();
  });

  it("isolates one Phrase job lookup failure while sibling locales still reconcile", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "COMPLETED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    await workflow.reconcile();
    const frBranch = (await state.listBatches())[0]?.record.locales.fr?.pullRequestBranch;
    const jaBranch = (await state.listBatches())[0]?.record.locales.ja?.pullRequestBranch;
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase job was not found", 404));
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんばんは {name}"}'),
    );

    const results = await workflow.reconcile();

    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(results[0]?.reason).toBe(
      "Phrase has not yet exposed the new jobs; the next run continues this batch",
    );
    expect(repository.commitCount(frBranch!)).toBe(1);
    expect(repository.commitCount(jaBranch!)).toBe(2);
  });

  it("does not write a commit or state when an open PR export is unchanged", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [stored] = await state.listBatches();
    const branch = stored?.record.locales.fr?.pullRequestBranch;
    const writes = state.writes;

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(branch!)).toBe(1);
    expect(repository.pullRequests).toHaveLength(1);
    expect(state.writes).toBe(writes);
    expect(phrase.targetDownloadCalls).toBe(2);
  });

  it.each(["merged", "closed"] as const)(
    "skips Phrase export and completes the batch when its PR is %s",
    async (pullRequestState) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      await workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      });
      phrase.jobStatus = "COMPLETED";
      await workflow.reconcile();
      repository.pullRequests[0] = {
        ...repository.pullRequests[0]!,
        title: "i18n(fr): Phrase translation update",
      };
      const pullRequestBeforeFinalization = structuredClone(repository.pullRequests[0]);
      repository.pullRequestStates.set("https://github.com/example/app/pull/42", pullRequestState);

      expect(await workflow.reconcile()).toEqual([]);
      const [completed] = await state.listBatches();
      expect(completed?.record.phase).toBe("completed");
      expect(completed?.record.locales.fr?.phase).toBe("pr-created");
      expect(completed?.record.locales.fr?.pullRequestFinalized).toBe(true);
      expect(repository.pullRequests[0]).toEqual(pullRequestBeforeFinalization);
      expect(phrase.targetDownloadCalls).toBe(1);
      expect(repository.pullRequestStateCalls).toBe(1);
      expect(await workflow.reconcile()).toEqual([]);
      expect(repository.pullRequestStateCalls).toBe(1);
    },
  );

  it("resumes a reopened PR while its batch is open, then stays complete after all PRs close", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "COMPLETED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const frUrl = "https://github.com/example/app/pull/42";
    const jaUrl = "https://github.com/example/app/pull/43";
    const frBranch = created?.record.locales.fr?.pullRequestBranch;
    const jaBranch = created?.record.locales.ja?.pullRequestBranch;
    repository.pullRequestStates.set(frUrl, "closed");

    await workflow.reconcile();
    const [closedLocale] = await state.listBatches();
    expect(closedLocale?.record.phase).toBe("ready");
    expect(closedLocale?.record.locales.fr?.pullRequestFinalized).toBe(true);
    expect(repository.commitCount(frBranch!)).toBe(1);

    repository.pullRequestStates.set(frUrl, "open");
    phrase.targetBytesByJob.set("job-fr", new TextEncoder().encode('{"greeting":"Salut {name}"}'));
    expect((await workflow.reconcile()).some((result) => result.phraseLocale === "fr")).toBe(true);
    expect(repository.commitCount(frBranch!)).toBe(2);

    repository.pullRequestStates.set(frUrl, "closed");
    repository.pullRequestStates.set(jaUrl, "closed");
    const downloadsBeforeCompletion = phrase.targetDownloadCalls;
    expect(await workflow.reconcile()).toEqual([]);
    const [completed] = await state.listBatches();
    expect(completed?.record.phase).toBe("completed");
    expect(phrase.targetDownloadCalls).toBe(downloadsBeforeCompletion);

    repository.pullRequestStates.set(frUrl, "open");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bienvenue {name}"}'),
    );
    expect(await workflow.reconcile()).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(downloadsBeforeCompletion);
    expect(repository.commitCount(frBranch!)).toBe(2);
    expect(repository.commitCount(jaBranch!)).toBe(1);
  });

  it("does not recheck a merged locale while a sibling PR keeps the batch active", async () => {
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "COMPLETED");
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    });
    await workflow.reconcile();
    const frUrl = "https://github.com/example/app/pull/42";
    repository.pullRequestStates.set(frUrl, "merged");

    await workflow.reconcile();
    const [afterMerge] = await state.listBatches();
    expect(afterMerge?.record.locales.fr).toMatchObject({
      pullRequestFinalized: true,
      pullRequestMerged: true,
    });
    expect(repository.pullRequestStateCalls).toBe(2);

    await workflow.reconcile();

    expect(repository.pullRequestStateCalls).toBe(3);
  });

  it("finalizes an open PR that closes during export without writing its branch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const branch = created?.record.locales.fr?.pullRequestBranch;
    repository.closeOnNextOpenPullRequestUpdate = true;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');

    const results = await workflow.reconcile();
    const [completed] = await state.listBatches();

    expect(results).toEqual([]);
    expect(repository.commitCount(branch!)).toBe(1);
    expect(completed?.record.phase).toBe("completed");
    expect(completed?.record.locales.fr?.pullRequestFinalized).toBe(true);
  });

  it("reports a branch conflict without pushing or stopping later re-exports", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const branch = created?.record.locales.fr?.pullRequestBranch;
    repository.pushHumanCommit(branch!, ["locales/fr.json"]);
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');

    const first = await workflow.reconcile();
    const second = await workflow.reconcile();
    const [stillOpen] = await state.listBatches();

    expect(first[0]?.phase).toBe("retrying");
    expect(first[0]?.reason).toContain("refusing to overwrite reviewer changes");
    expect(second[0]?.phase).toBe("retrying");
    expect(repository.commitCount(branch!)).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);
    expect(stillOpen?.record.locales.fr?.phase).toBe("pr-created");
    expect(phrase.targetDownloadCalls).toBe(3);
  });

  it("re-exports a legacy open PR when its branch is one tooling commit", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [stored] = await state.listBatches();
    const branch = stored?.record.locales.fr?.pullRequestBranch;
    delete stored?.record.locales.fr?.toolingCommitSha;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');

    const results = await workflow.reconcile();
    const [updated] = await state.listBatches();

    expect(results[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(branch!)).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);
    expect(updated?.record.locales.fr?.toolingCommitSha).toBe(repository.branchHeads.get(branch!));
  });

  it("shows invalid re-exports in the same draft PR and repairs them on the next run", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const branch = created?.record.locales.fr?.pullRequestBranch;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour"}');

    const failed = await workflow.reconcile();
    const [afterFailure] = await state.listBatches();

    expect(failed[0]?.phase).toBe("failed");
    expect(failed[0]?.reason).toContain("ICU argument mismatches");
    expect(afterFailure?.record.phase).toBe("ready");
    expect(afterFailure?.record.locales.fr?.phase).toBe("pr-created");
    expect(afterFailure?.record.locales.fr?.toolingCommitSha).toBe(
      repository.branchHeads.get(branch!),
    );
    expect(afterFailure?.record.locales.fr?.validationErrors).toEqual([
      expect.stringContaining("ICU argument mismatches"),
    ]);
    expect(repository.pullRequestBodies.get(failed[0]!.pullRequestUrl!)).toContain(
      "❌ 1 error — see the latest 🌐 Translation check comment.",
    );
    expect(repository.pullRequestComments.at(-1)?.body).toContain(
      "Argument {name} is missing from the translation.",
    );
    expect(repository.commitCount(branch!)).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(branch!)).toBe(3);
    expect(phrase.targetDownloadCalls).toBe(3);
  });

  it("does not re-export a superseded batch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [stored] = await state.listBatches();
    stored!.record.phase = "superseded";
    await state.updateBatch(stored!.record, stored!.revision);
    const downloads = phrase.targetDownloadCalls;

    expect(await workflow.reconcile()).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(downloads);
    expect(repository.pullRequestStateCalls).toBe(0);
  });

  it("fails an initial locale when the translated other branch drops the count", async () => {
    const source = new TextEncoder().encode(
      JSON.stringify({
        requests: {
          defaultMessage: "{count, plural, one {# request} other {# requests}}",
          description: "Request count",
        },
      }),
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        { phraseLocale: "zh_cn", repositoryLocale: "zh-CN", outputPath: "locales/zh-CN.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        requests: { defaultMessage: "{count, plural, other {请求}}", description: "Request count" },
      }),
    );
    const repository = new FakeRepository();
    repository.baseSourceBytes = source;
    repository.pinnedSourceBytes = source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("failed");
    expect(results[0]?.reason).toContain("Use # where the number belongs");
    expect(stored?.record.phase).toBe("ready");
    expect(stored?.record.locales.zh_cn?.phase).toBe("pr-created");
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.draft).toBe(true);
    expect(repository.pullRequestComments[0]?.body).toContain("Use # where the number belongs");
  });

  it("keeps invalid FEO catalogs visible without writing generated YAML until fixed", async () => {
    const source = new TextEncoder().encode(
      '{"searchEntries.roles.title":{"defaultMessage":"Roles"}}',
    );
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.onReadFile = (path, ref) => {
      for (const [branch, head] of repository.branchHeads) {
        if (head === ref)
          return (
            repository.branchFiles.get(branch)?.get(path) ??
            (path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : null)
          );
      }
      return path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : source;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: {
        ...config,
        frontendTemplate: { path: "deploy/frontend.yaml" },
        targetAdapter: "icu-json",
      },
    });
    phrase.jobStatus = "COMPLETED";
    phrase.targetBytes = new TextEncoder().encode(
      '{"searchEntries.roles.title":"Rôles {missing}"}',
    );
    const [invalid] = await workflow.reconcile();
    const pr = repository.pullRequests[0]!;
    expect(pr.draft).toBe(true);
    expect(pr.additionalFiles).toBeUndefined();
    expect(invalid?.phase).toBe("failed");
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"Rôles"}');
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.pullRequests).toHaveLength(1);
    expect(
      new TextDecoder().decode(repository.branchFiles.get(pr.branch)?.get("deploy/frontend.yaml")),
    ).toContain("Rôles");
    expect(repository.pullRequestBodies.get(invalid!.pullRequestUrl!)).not.toContain(
      "Translation errors",
    );

    const validYaml = repository.branchFiles.get(pr.branch)!.get("deploy/frontend.yaml");
    phrase.targetBytes = new TextEncoder().encode(
      '{"searchEntries.roles.title":"Rôles {missing}"}',
    );
    expect((await workflow.reconcile())[0]?.phase).toBe("failed");
    expect(repository.branchFiles.get(pr.branch)!.get("deploy/frontend.yaml")).toEqual(validYaml);
    expect(repository.pullRequestBodies.get(invalid!.pullRequestUrl!)).toContain(
      "Generated Frontend YAML was not updated",
    );
    expect(repository.pullRequestBodies.get(invalid!.pullRequestUrl!)).toContain(
      "earlier valid export",
    );
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"Rôles"}');
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");

    // A template-only problem must update findings even when catalog bytes do not change.
    const validRead = repository.onReadFile!;
    const head = repository.branchHeads.get(pr.branch)!;
    const commits = repository.commitCount(pr.branch);
    repository.onReadFile = (path, ref, call) =>
      path === "deploy/frontend.yaml" && ref === head ? null : validRead(path, ref, call);
    expect((await workflow.reconcile())[0]?.phase).toBe("failed");
    expect(repository.commitCount(pr.branch)).toBe(commits);
    expect(repository.pullRequestComments.at(-1)?.body).toContain("Missing Frontend template");
    repository.onReadFile = validRead;
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(pr.branch)).toBe(commits);
    expect(repository.pullRequestBodies.get(invalid!.pullRequestUrl!)).not.toContain(
      "Translation errors",
    );
  });

  it("adds the Frontend template to the same locale PR and blocks stale English", async () => {
    const source = new TextEncoder().encode(
      '{"searchEntries.roles.title":{"defaultMessage":"Roles","description":"Search result"}}',
    );
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
      frontendTemplate: { path: "deploy/frontend.yaml" },
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.pullRequests[0]?.path).toBe("deploy/locales/zh-CN.json");
    expect(repository.pullRequests[0]?.additionalFiles?.[0]?.path).toBe("deploy/frontend.yaml");
    expect(
      new TextDecoder().decode(repository.pullRequests[0]?.additionalFiles?.[0]?.content),
    ).toContain("zh-CN:\n          searchEntries.roles.title: 角色");
    const [initialBatch] = await state.listBatches();
    const localeBranch = initialBatch?.record.locales.zh_cn?.pullRequestBranch;
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"职务"}');
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.commitCount(localeBranch!)).toBe(2);
    expect(repository.branchCommits.get(localeBranch!)?.[1]?.paths).toEqual([
      "deploy/locales/zh-CN.json",
      "deploy/frontend.yaml",
    ]);
    expect(
      new TextDecoder().decode(
        repository.branchFiles.get(localeBranch!)?.get("deploy/locales/zh-CN.json"),
      ),
    ).toContain("职务");
    expect(
      new TextDecoder().decode(
        repository.branchFiles.get(localeBranch!)?.get("deploy/frontend.yaml"),
      ),
    ).toContain("zh-CN:\n          searchEntries.roles.title: 职务");

    const staleRepository = new FakeRepository();
    staleRepository.onReadFile = (path) =>
      path === "deploy/frontend.yaml"
        ? new TextEncoder().encode(template.replace("title: Roles", "title: Users"))
        : source;
    const staleState = new MemoryStateStore();
    const stalePhrase = new FakePhrase();
    stalePhrase.expectedTargetLangs = ["zh_cn"];
    stalePhrase.jobParts = phrase.jobParts;
    stalePhrase.targetBytes = phrase.targetBytes;
    const staleWorkflow = new PhraseWorkflow({
      phrase: stalePhrase,
      state: staleState,
      repository: staleRepository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await staleWorkflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    stalePhrase.jobStatus = "COMPLETED";
    expect((await staleWorkflow.reconcile())[0]?.phase).toBe("superseded");
    expect(staleRepository.pullRequests).toHaveLength(0);
  });

  it("refreshes FEO YAML from the locale branch head and preserves unrelated branch metadata", async () => {
    const template =
      "kind: Template\nmetadata:\n  name: original\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    let baseTemplate = template;
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/feo-en.json",
        filename: "feo-en.json",
      },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path, ref) => {
      if (path !== "deploy/frontend.yaml") return source;
      for (const [branch, headSha] of repository.branchHeads) {
        if (headSha === ref) return repository.branchFiles.get(branch)?.get(path) ?? null;
      }
      return new TextEncoder().encode(ref === "abc123" ? template : baseTemplate);
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    const [created] = await state.listBatches();
    const branch = created?.record.locales.zh_cn?.pullRequestBranch;
    baseTemplate = template.replace("name: original", "name: base-updated");
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"职务"}');

    const results = await workflow.reconcile();
    const yaml = new TextDecoder().decode(
      repository.branchFiles.get(branch!)?.get("deploy/frontend.yaml"),
    );

    expect(results[0]?.phase).toBe("pr-created");
    expect(repository.branchCommits.get(branch!)?.[1]?.paths).toEqual([
      "deploy/locales/zh-CN.json",
      "deploy/frontend.yaml",
    ]);
    expect(yaml).toContain("name: original");
    expect(yaml).not.toContain("base-updated");
    expect(yaml).toContain("zh-CN:\n          searchEntries.roles.title: 职务");
  });

  it("inlines a batch stored with a legacy non-canonical FEO locale under the canonical id", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      locales:\n        zh-cn:\n          searchEntries.roles.title: 旧\n      searchEntries:\n        - id: roles\n          title: Roles\n        - id: users\n          title: Users\n";
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  },\n' +
        '  "searchEntries.users.title": {\n    "defaultMessage": "Users",\n    "description": "title of searchEntries.users"\n  }\n}\n',
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/feo-en.json",
        filename: "feo-en.json",
      },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-cn.json",
        },
      ],
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        "searchEntries.roles.title": "角色",
        "searchEntries.users.title": "用".repeat(4097),
      }),
    );
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    // Batches submitted before canonical ids were enforced keep the old spelling in their config.
    const [stored] = await state.listBatches();
    stored!.record.config.targetLocales[0]!.repositoryLocale = "zh-cn";
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("pr-created");
    const pullRequest = repository.pullRequests[0];
    expect(pullRequest?.branch).toMatch(/-zh-cn$/);
    const yaml = new TextDecoder().decode(
      pullRequest?.additionalFiles?.find((file) => file.path === "deploy/frontend.yaml")?.content,
    );
    expect(yaml).toContain("zh-CN:\n          searchEntries.roles.title: 角色\n");
    expect(yaml).not.toContain("zh-cn:");
    expect(yaml).not.toContain("searchEntries.users.title: 用");
    expect(pullRequest?.body).toContain(
      "⚠️ 1 warning — see the latest 🌐 Translation check comment.",
    );
    const report = repository.pullRequestComments.at(-1)?.body ?? "";
    expect(report).toContain("> [!WARNING]");
    expect(report).toContain("| **W1** | — |");
    expect(report).toContain("fall back to English: searchEntries.users.title");
  });

  it("preserves an implicit legacy PR branch when resubmitting canonical FEO config", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      module:\n        defaultDocumentTitle: Home\n";
    const source = new TextEncoder().encode(
      `${JSON.stringify({ "module.defaultDocumentTitle": { defaultMessage: "Home", description: "defaultDocumentTitle of module" } }, null, 2)}\n`,
    );
    const canonicalConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "locales/feo-en.json",
        filename: "feo-en.json",
      },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
      targetLocales: [
        { phraseLocale: "he", repositoryLocale: "he", outputPath: "locales/he.json" },
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-en.json";
    phrase.expectedTargetLangs = ["he", "fr"];
    phrase.jobParts = [
      { uid: "job-he", targetLang: "he", workflowLevel: 1 },
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
    ];
    phrase.jobStatuses.set("job-he", "COMPLETED");
    phrase.targetBytes = new TextEncoder().encode('{"module.defaultDocumentTitle":"Hebrew home"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: canonicalConfig,
    };
    await workflow.submit(input);
    let stored = (await state.listBatches())[0]!;
    stored.record.config.targetLocales[0]!.repositoryLocale = "iw";
    await workflow.reconcile();
    stored = (await state.listBatches())[0]!;
    const originalBranch = stored.record.locales.he!.pullRequestBranch!;
    expect(originalBranch).toMatch(/-iw$/);
    // Older records identify the PR only by URL; its branch must be recovered before config adoption.
    delete stored.record.locales.he!.pullRequestBranch;

    await workflow.submit(input);
    phrase.targetBytes = new TextEncoder().encode(
      '{"module.defaultDocumentTitle":"Updated Hebrew home"}',
    );
    const results = await workflow.reconcile();

    expect(results.find((result) => result.phraseLocale === "he")?.phase).toBe("pr-created");
    expect((await state.listBatches())[0]!.record.locales.he!.pullRequestBranch).toBe(
      originalBranch,
    );
    expect(repository.commitCount(originalBranch)).toBe(2);
    expect(repository.branchHeads.size).toBe(1);
    expect(phrase.createJobCalls).toBe(1);
  });

  it("supersedes an open FEO re-export when base English drifts from committed source", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    let baseTemplate = template;
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n' +
        '    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const feoConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/feo-en.json",
        filename: "feo-en.json",
      },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
      frontendTemplate: { path: "deploy/frontend.yaml" },
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path, ref) => {
      if (path !== "deploy/frontend.yaml") return source;
      for (const [branch, headSha] of repository.branchHeads) {
        if (headSha === ref) return repository.branchFiles.get(branch)?.get(path) ?? null;
      }
      return new TextEncoder().encode(ref === "abc123" ? template : baseTemplate);
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: feoConfig,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    const [created] = await state.listBatches();
    const branch = created?.record.locales.zh_cn?.pullRequestBranch;
    expect(repository.commitCount(branch!)).toBe(1);

    baseTemplate = template.replace("title: Roles", "title: Policies");
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"政策"}');
    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results).toEqual([
      expect.objectContaining({
        phraseLocale: "zh_cn",
        phase: "superseded",
        reason: expect.stringContaining("source catalog"),
      }),
    ]);
    expect(stored?.record.phase).toBe("superseded");
    expect(repository.commitCount(branch!)).toBe(1);
  });

  it.each(["source catalog", "Frontend template"] as const)(
    "retries the locale when the current-base %s read returns HTTP 503",
    async (failedRead) => {
      const template =
        "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
      const source = new TextEncoder().encode(
        '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n' +
          '    "description": "title of searchEntries.roles"\n  }\n}\n',
      );
      const feoConfig: PhraseWorkflowConfig = {
        ...config,
        sourceCatalog: {
          ...config.sourceCatalog,
          path: "deploy/locales/feo-en.json",
          filename: "feo-en.json",
        },
        targetLocales: [
          {
            phraseLocale: "zh_cn",
            repositoryLocale: "zh-CN",
            outputPath: "deploy/locales/zh-CN.json",
          },
        ],
        frontendTemplate: { path: "deploy/frontend.yaml" },
      };
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      phrase.expectedFilename = "feo-en.json";
      phrase.expectedTargetLangs = ["zh_cn"];
      phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
      phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
      const repository = new FakeRepository();
      repository.onReadFile = (path, ref) => {
        if (
          ref === repository.baseCommit &&
          ((failedRead === "source catalog" && path === feoConfig.sourceCatalog.path) ||
            (failedRead === "Frontend template" && path === feoConfig.frontendTemplate?.path))
        ) {
          throw new PhraseRepositoryError("GitHub API returned HTTP 503", 503);
        }
        if (path === "deploy/frontend.yaml") return new TextEncoder().encode(template);
        return source;
      };
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      await workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes: source,
        config: feoConfig,
      });
      phrase.jobStatus = "COMPLETED";

      const results = await workflow.reconcile();
      const [stored] = await state.listBatches();

      expect(results).toEqual([
        expect.objectContaining({
          phraseLocale: "zh_cn",
          phase: "retrying",
          reason: "GitHub API returned HTTP 503",
        }),
      ]);
      expect(stored?.record.phase).toBe("ready");
      expect(repository.pullRequests).toHaveLength(0);
    },
  );

  it("retitles an open PR from the batch's current generated-source template path", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const baseConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/feo-en.json",
        filename: "feo-en.json",
      },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
      frontendTemplate: { path: "deploy/old-frontend.yaml", generateSourceCatalog: true },
    };
    const movedConfig: PhraseWorkflowConfig = {
      ...baseConfig,
      frontendTemplate: { path: "deploy/new-frontend.yaml", generateSourceCatalog: true },
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/old-frontend.yaml" || path === "deploy/new-frontend.yaml"
        ? new TextEncoder().encode(template)
        : source;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: baseConfig,
    };
    await workflow.submit(input);
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    expect(repository.pullRequests[0]?.title).toBe(
      "i18n(zh-CN): Phrase translation update for deploy/old-frontend.yaml",
    );

    await workflow.submit({ ...input, sourceCommit: "def456", config: movedConfig });
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"职务"}');
    await workflow.reconcile();

    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.title).toBe(
      "i18n(zh-CN): Phrase translation update for deploy/new-frontend.yaml",
    );
  });

  it("submits and reconciles zh-CN from pinned Frontend YAML without a committed source catalog", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/insights-rbac-ui-feo-frontend-en.json",
        filename: "insights-rbac-ui-feo-frontend-en.json",
      },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "insights-rbac-ui-feo-frontend-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    const reads: { path: string; ref: string }[] = [];
    repository.onReadFile = (path, ref) => {
      reads.push({ path, ref });
      return path === "deploy/frontend.yaml" ? new TextEncoder().encode(template) : null;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    };

    await workflow.submit(input);
    expect(phrase.createJobCalls).toBe(1);
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.path).toBe("deploy/locales/zh-CN.json");
    expect(repository.pullRequests[0]?.title).toBe(
      "i18n(zh-CN): Phrase translation update for deploy/frontend.yaml",
    );
    expect(
      new TextDecoder().decode(repository.pullRequests[0]?.additionalFiles?.[0]?.content),
    ).toContain("zh-CN:\n          searchEntries.roles.title: 角色");
    expect(reads).toContainEqual({ path: "deploy/frontend.yaml", ref: "abc123" });
    expect(reads).toContainEqual({
      path: "deploy/frontend.yaml",
      ref: repository.baseCommit,
    });
    expect(reads.every(({ path }) => path !== zhConfig.sourceCatalog.path)).toBe(true);
    await workflow.submit({ ...input, sourceCommit: "def456" });
    expect(phrase.createJobCalls).toBe(1);
  });

  it("wraps an invalid generated Frontend template as a workflow error at submit", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/frontend.yaml"
        ? new TextEncoder().encode("kind: Template\nobjects: [\n")
        : null;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    const error = await workflow
      .submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config: {
          ...config,
          frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PhraseWorkflowError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/^Frontend template cannot be inlined:/),
    });
    expect(phrase.createJobCalls).toBe(0);
    expect(await state.listBatches()).toHaveLength(0);
  });

  it("supersedes a generated Frontend batch when the template is invalid on the base commit", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const invalidTemplate = "kind: Template\nobjects: [\n";
    const feoSourceBytes = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/feo-frontend-en.json",
        filename: "feo-frontend-en.json",
      },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "feo-frontend-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    repository.onReadFile = (path, ref) => {
      if (path !== "deploy/frontend.yaml") return null;
      return new TextEncoder().encode(ref === "abc123" ? template : invalidTemplate);
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: feoSourceBytes,
      config: zhConfig,
    });
    phrase.jobStatus = "COMPLETED";

    const [result] = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(result).toMatchObject({
      phase: "superseded",
      reason: expect.stringMatching(
        /^Frontend template cannot be inlined on resolved-base-commit:/,
      ),
    });
    expect(stored?.record.phase).toBe("superseded");
    expect(phrase.targetDownloadCalls).toBe(0);
    expect(repository.pullRequests).toHaveLength(0);
  });

  it("pins stale checks, Frontend reads, and the locale commit to one resolved base SHA", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const movedTemplate = template.replace(
      "          title: Roles\n",
      "          title: Roles\n      permissions:\n        - view:roles\n",
    );
    const source = new TextEncoder().encode(
      '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
    );
    const zhConfig: PhraseWorkflowConfig = {
      ...config,
      sourceCatalog: {
        ...config.sourceCatalog,
        path: "deploy/locales/insights-rbac-ui-feo-frontend-en.json",
        filename: "insights-rbac-ui-feo-frontend-en.json",
      },
      frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
      targetLocales: [
        {
          phraseLocale: "zh_cn",
          repositoryLocale: "zh-CN",
          outputPath: "deploy/locales/zh-CN.json",
        },
      ],
    };
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedFilename = "insights-rbac-ui-feo-frontend-en.json";
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode('{"searchEntries.roles.title":"角色"}');
    const repository = new FakeRepository();
    const reads: { path: string; ref: string }[] = [];
    repository.onReadFile = (path, ref) => {
      reads.push({ path, ref });
      if (path !== "deploy/frontend.yaml") return null;
      return new TextEncoder().encode(
        ref === "abc123" || ref === repository.baseCommit ? template : movedTemplate,
      );
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: zhConfig,
    });
    phrase.jobStatus = "COMPLETED";

    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(repository.resolvedRefs).toEqual(["phrase-pilot", "phrase-pilot"]);
    expect(reads).toContainEqual({ path: "deploy/frontend.yaml", ref: repository.baseCommit });
    expect(reads).not.toContainEqual({ path: "deploy/frontend.yaml", ref: "phrase-pilot" });
    expect(
      new TextDecoder().decode(repository.pullRequests[0]?.additionalFiles?.[0]?.content),
    ).not.toContain("permissions:");
    expect(repository.pullRequests[0]).toHaveProperty("baseCommit", repository.baseCommit);
  });

  it("rejects non-empty flow-style FEO locales at submit before creating a Phrase job", async () => {
    const flowTemplate =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n      locales: { fr: { searchEntries.roles.title: Rôles } }\n";
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.onReadFile = (path) =>
      path === "deploy/frontend.yaml" ? new TextEncoder().encode(flowTemplate) : sourceBytes;
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await expect(
      workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config: { ...config, frontendTemplate: { path: "deploy/frontend.yaml" } },
      }),
    ).rejects.toThrow(/spec\.locales.*block|flow-style.*locales/i);
    expect(phrase.createJobCalls).toBe(0);
    expect(await state.listBatches()).toHaveLength(0);
  });

  it("supersedes generated Frontend source when English YAML changes before zh-CN reconciliation", async () => {
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const repository = new FakeRepository();
    repository.onReadFile = (path, ref) =>
      path === "deploy/frontend.yaml"
        ? new TextEncoder().encode(ref === "abc123" ? template : template.replace("Roles", "Users"))
        : null;
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: new TextEncoder().encode(
        '{\n  "searchEntries.roles.title": {\n    "defaultMessage": "Roles",\n    "description": "title of searchEntries.roles"\n  }\n}\n',
      ),
      config: {
        ...config,
        frontendTemplate: { path: "deploy/frontend.yaml", generateSourceCatalog: true },
        targetLocales: [
          {
            phraseLocale: "zh_cn",
            repositoryLocale: "zh-CN",
            outputPath: "deploy/locales/zh-CN.json",
          },
        ],
      },
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("superseded");
    expect(repository.pullRequests).toHaveLength(0);
  });

  it("fails a locale on a permanent repository error before creating its PR", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.pullRequestError = new PhraseRepositoryError(
      "GitHub rejected locale PR creation",
      409,
      true,
    );
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results).toEqual([
      expect.objectContaining({
        phase: "failed",
        reason: "GitHub rejected locale PR creation",
      }),
    ]);
    expect((await state.listBatches())[0]?.record.phase).toBe("completed");
    expect(await workflow.reconcile()).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(1);
  });

  it("reports a Phrase failure for one batch without blocking the others", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const corrupt = await workflow.submit(input);
    const healthy = await workflow.submit({ ...input, baseRef: "release" });
    state.corruptKeys.add(corrupt.key);
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results).toContainEqual({
      batchKey: corrupt.key,
      phase: "retrying",
      reason: "Phrase workflow failed; inspect the action log for the non-secret error summary",
    });
    expect(results).toContainEqual(
      expect.objectContaining({ batchKey: healthy.key, phase: "pr-created" }),
    );

    state.corruptKeys.clear();
    repository.pullRequestStates.set("https://github.com/example/app/pull/42", "merged");
    phrase.getJobError = new PhraseApiError("Phrase API returned HTTP 404", 404);
    expect(await workflow.reconcile()).toEqual([
      {
        batchKey: corrupt.key,
        phraseLocale: "fr",
        phase: "retrying",
        reason: "Phrase has not yet exposed the new jobs; the next run continues this batch",
      },
    ]);

    const authMessage =
      "Phrase Platform OAuth returned HTTP 401 for the service account credentials";
    phrase.getJobError = new PhraseAuthError(authMessage, 401);
    expect(await workflow.reconcile()).toEqual([
      { batchKey: corrupt.key, phraseLocale: "fr", phase: "retrying", reason: authMessage },
    ]);

    phrase.getJobError = undefined;
    expect(await workflow.reconcile()).toContainEqual(
      expect.objectContaining({ batchKey: corrupt.key, phraseLocale: "fr", phase: "pr-created" }),
    );
    expect((await state.readBatch(corrupt.key))?.record.locales.fr?.phase).toBe("pr-created");
  });

  it.each([
    ["project", "completed"],
    ["project", "failed"],
    ["project", "superseded"],
    ["source filename", "completed"],
    ["source filename", "failed"],
    ["source filename", "superseded"],
  ] as const)(
    "skips a terminal batch with a %s mismatch in phase %s, while rejecting a pending batch",
    async (pin, terminalPhase) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const input = {
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      };
      const terminal = await workflow.submit(input);
      const pending = await workflow.submit({ ...input, baseRef: "release" });
      const terminalStored = state.records.get(terminal.key)!;
      const pendingStored = state.records.get(pending.key)!;
      terminalStored.record.phase = terminalPhase;

      for (const stored of [terminalStored, pendingStored]) {
        if (pin === "project") stored.record.config.projectUid = "foreign-project";
        else stored.record.config.sourceCatalog.filename = "foreign.json";
      }

      const phraseEvents = [...phrase.events];
      const phraseJobCalls = [...phrase.getJobCalls];
      const repositoryReadFileCalls = repository.readFileCalls;
      const repositoryPullRequests = [...repository.pullRequests];
      const options = {
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      };

      const results = await workflow.reconcile(options);

      expect(results).toEqual([
        {
          batchKey: pending.key,
          phase: "failed",
          reason:
            pin === "project"
              ? 'Batch config mismatch: project UID expected "project-uid", actual "foreign-project"'
              : 'Batch config mismatch: source filename expected "translation-template.json", actual "foreign.json"',
        },
      ]);
      expect(phrase.events).toEqual(phraseEvents);
      expect(phrase.getJobCalls).toEqual(phraseJobCalls);
      expect(repository.readFileCalls).toBe(repositoryReadFileCalls);
      expect(repository.pullRequests).toEqual(repositoryPullRequests);
    },
  );

  it.each(["project", "source filename"] as const)(
    "rejects a forged batch %s without processing it or blocking other batches",
    async (pin) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const input = {
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      };
      const forged = await workflow.submit(input);
      const healthy = await workflow.submit({ ...input, baseRef: "release" });
      const stored = state.records.get(forged.key)!;
      const forgedJobUid = `job-forged-${pin.replace(" ", "-")}`;
      stored.record.jobs[0]!.uid = forgedJobUid;
      if (pin === "project") stored.record.config.projectUid = "foreign-project";
      else stored.record.config.sourceCatalog.filename = "foreign.json";
      const originalRecord = structuredClone(stored.record);
      const originalRevision = stored.revision;
      phrase.jobStatus = "COMPLETED";
      phrase.getJobCalls.length = 0;

      const results = await workflow.reconcile({
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      });

      const rejected = results.find((result) => result.batchKey === forged.key);
      expect(rejected).toMatchObject({ batchKey: forged.key, phase: "failed" });
      expect(rejected?.reason).toContain(
        pin === "project"
          ? 'project UID expected "project-uid", actual "foreign-project"'
          : 'source filename expected "translation-template.json", actual "foreign.json"',
      );
      expect(results).toContainEqual(
        expect.objectContaining({ batchKey: healthy.key, phase: "pr-created" }),
      );
      expect(phrase.getJobCalls.map((call) => call.jobUid)).toEqual(["job-fr"]);
      expect(state.records.get(forged.key)?.record).toEqual(originalRecord);
      expect(state.records.get(forged.key)?.revision).toBe(originalRevision);
      expect(repository.pullRequests).toHaveLength(1);
      expect(repository.pullRequests[0]?.baseRef).toBe("release");
    },
  );

  it.each([
    ["other-catalog.json", '"other-catalog.json"'],
    [undefined, "(missing)"],
  ] as const)(
    "rejects a Phrase job filename mismatch (%s) before downloading or writing that batch",
    async (filename, actual) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const input = {
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      };
      const mismatched = await workflow.submit(input);
      const healthy = await workflow.submit({ ...input, baseRef: "release" });
      const stored = state.records.get(mismatched.key)!;
      const mismatchedJobUid = "job-fr-wrong-filename";
      stored.record.jobs[0]!.uid = mismatchedJobUid;
      phrase.jobFilenamesByUid.set(mismatchedJobUid, filename);
      const originalRecord = structuredClone(stored.record);
      const originalRevision = stored.revision;
      phrase.jobStatus = "COMPLETED";
      phrase.getJobCalls.length = 0;

      const results = await workflow.reconcile({
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      });

      expect(results).toContainEqual(
        expect.objectContaining({
          batchKey: mismatched.key,
          phase: "failed",
          reason: expect.stringContaining(`expected "translation-template.json", actual ${actual}`),
        }),
      );
      expect(results).toContainEqual(
        expect.objectContaining({ batchKey: healthy.key, phase: "pr-created" }),
      );
      expect(phrase.targetDownloadJobUids).not.toContain(mismatchedJobUid);
      expect(phrase.targetFileDownloadJobUids).not.toContain(mismatchedJobUid);
      expect(phrase.targetDownloadJobUids).toEqual(["job-fr"]);
      expect(phrase.targetFileDownloadJobUids).toEqual(["job-fr"]);
      expect(state.records.get(mismatched.key)?.record).toEqual(originalRecord);
      expect(state.records.get(mismatched.key)?.revision).toBe(originalRevision);
      expect(repository.pullRequests).toHaveLength(1);
      expect(repository.pullRequests[0]?.baseRef).toBe("release");
    },
  );

  it("rejects an open-PR re-export with a pinned job filename mismatch before download or commit", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const pins = {
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    };
    const submitted = await workflow.submit({ ...input, ...pins });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile(pins);

    const stored = state.records.get(submitted.key)!;
    const originalRecord = structuredClone(stored.record);
    const originalRevision = stored.revision;
    const branch = stored.record.locales.fr?.pullRequestBranch;
    expect(branch).toBeDefined();
    const commitsBefore = repository.commitCount(branch!);
    const downloadsBefore = phrase.targetDownloadCalls;
    const fileReadsBefore = repository.readFileCalls;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    phrase.jobFilenamesByUid.set("job-fr", "other-catalog.json");

    const results = await workflow.reconcile(pins);

    expect(results).toContainEqual(
      expect.objectContaining({
        batchKey: submitted.key,
        phase: "failed",
        reason: expect.stringContaining(
          'source filename mismatch: expected "translation-template.json", actual "other-catalog.json"',
        ),
      }),
    );
    expect(phrase.targetDownloadCalls).toBe(downloadsBefore);
    expect(phrase.targetDownloadJobUids).toEqual(["job-fr"]);
    expect(phrase.targetFileDownloadJobUids).toEqual(["job-fr"]);
    expect(repository.commitCount(branch!)).toBe(commitsBefore);
    expect(repository.readFileCalls).toBe(fileReadsBefore);
    expect(repository.pullRequests).toHaveLength(1);
    expect(state.records.get(submitted.key)?.record).toEqual(originalRecord);
    expect(state.records.get(submitted.key)?.revision).toBe(originalRevision);
  });

  it("fails before creating a PR when a project pin changes during an owned-SHA conflict", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatus = "COMPLETED";
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const pins = {
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    };
    const submitted = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
      ...pins,
    });
    let conflicts = 0;
    state.beforeEveryUpdateConflict = (store, candidate) => {
      const current = store.records.get(candidate.key)!;
      const currentShas = Object.values(current.record.locales).flatMap(
        (locale) => locale?.toolingCommitShas ?? [],
      );
      const candidateShas = Object.values(candidate.locales).flatMap(
        (locale) => locale?.toolingCommitShas ?? [],
      );
      if (!candidateShas.some((sha) => !currentShas.includes(sha))) return;
      conflicts += 1;
      store.beforeEveryUpdateConflict = undefined;
      const concurrentRecord = structuredClone(current.record);
      concurrentRecord.config.projectUid = "foreign-project";
      store.records.set(candidate.key, {
        record: concurrentRecord,
        revision: String(Number(current.revision) + 1),
      });
    };

    const results = await workflow.reconcile(pins);

    expect(conflicts).toBe(1);
    expect(results).toEqual([
      expect.objectContaining({
        batchKey: submitted.key,
        phase: "failed",
        reason:
          'Batch config mismatch: project UID expected "project-uid", actual "foreign-project"',
      }),
    ]);
    expect(repository.pullRequests).toHaveLength(0);
    expect(phrase.targetDownloadJobUids).toEqual(["job-fr"]);
    expect(phrase.targetDownloadProjectUids).toEqual(["project-uid"]);
  });

  it("fails before moving an open PR when the source filename pin changes at ref recheck", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobStatus = "COMPLETED";
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const pins = {
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    };
    const submitted = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
      ...pins,
    });
    expect((await workflow.reconcile(pins))[0]).toMatchObject({ phase: "pr-created" });
    const stored = state.records.get(submitted.key)!;
    const branch = stored.record.locales.fr?.pullRequestBranch;
    expect(branch).toBeDefined();
    const headBefore = repository.branchHeads.get(branch!);
    const commitsBefore = repository.commitCount(branch!);
    const downloadsBefore = phrase.targetDownloadCalls;
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    repository.beforeOpenPullRequestRefRecheck = () => {
      const current = state.records.get(submitted.key)!;
      const concurrentRecord = structuredClone(current.record);
      concurrentRecord.config.sourceCatalog.filename = "foreign.json";
      state.records.set(submitted.key, {
        record: concurrentRecord,
        revision: String(Number(current.revision) + 1),
      });
    };

    const results = await workflow.reconcile(pins);

    expect(results).toContainEqual(
      expect.objectContaining({
        batchKey: submitted.key,
        phase: "failed",
        reason: expect.stringContaining(
          'source filename expected "translation-template.json", actual "foreign.json"',
        ),
      }),
    );
    expect(repository.branchHeads.get(branch!)).toBe(headBefore);
    expect(repository.commitCount(branch!)).toBe(commitsBefore);
    expect(repository.pullRequests).toHaveLength(1);
    expect(phrase.targetDownloadCalls).toBe(downloadsBefore + 1);
  });

  it("keeps a transient pinned job lookup failure local to its locale", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.jobStatus = "COMPLETED";
    phrase.targetBytesByJob.set(
      "job-fr",
      new TextEncoder().encode('{"greeting":"Bonjour {name}"}'),
    );
    phrase.targetBytesByJob.set(
      "job-ja",
      new TextEncoder().encode('{"greeting":"こんにちは {name}"}'),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const localesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
    };
    const pins = {
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    };
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: localesConfig,
    };
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 503", 503));
    const submitted = await workflow.submit(input);
    expect(submitted.phase).toBe("importing");

    const results = await workflow.reconcile(pins);

    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(results[0]?.reason).toBe("Phrase API returned HTTP 503");
    expect(repository.pullRequests.map(({ path }) => path)).toEqual(["locales/ja.json"]);
  });

  it("treats a young pinned finishImport 404 as retrying while delivering healthy locales", async () => {
    const scenario = makeJapaneseWorkflowScenario();
    const submitted = await submitWithJapaneseImportRetrying(scenario);
    expect(submitted.phase).toBe("importing");
    scenario.phrase.getJobErrors.delete("job-ja");
    const firstReconcileCall = scenario.phrase.getJobCalls.length + 1;
    failJobLookupAt(
      scenario.phrase,
      "job-fr",
      firstReconcileCall + 2,
      new PhraseApiError("Phrase API returned HTTP 404", 404),
    );

    const results = await scenario.workflow.reconcile(phrasePins);

    expect(results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
      ["fr", "retrying"],
      ["ja", "pr-created"],
    ]);
    expect(results[0]?.reason).toBe(
      "Phrase has not yet exposed the new jobs; the next run continues this batch",
    );
    expect(scenario.phrase.targetDownloadCalls).toBe(1);
    expect(scenario.repository.pullRequests.map(({ path }) => path)).toEqual(["locales/ja.json"]);
  });

  it("preserves an open locale PR when pinned verification returns a permanent error", async () => {
    const run = async (pinned: boolean) => {
      const scenario = makeJapaneseWorkflowScenario();
      const submitted = await submitWithJapaneseImportRetrying(scenario);
      const firstResults = await scenario.workflow.reconcile();
      expect(firstResults.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
        ["fr", "pr-created"],
        ["ja", "retrying"],
      ]);
      const pullRequestUrl = scenario.state.records.get(submitted.key)?.record.locales.fr
        ?.pullRequestUrl;
      expect(pullRequestUrl).toBeDefined();
      scenario.phrase.getJobErrors.delete("job-ja");
      scenario.phrase.getJobErrors.set(
        "job-fr",
        new PhraseAuthError(
          "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
          401,
        ),
      );

      const results = await scenario.workflow.reconcile(pinned ? phrasePins : {});
      const stored = await scenario.state.readBatch(submitted.key);
      return {
        results,
        originalPullRequestUrl: pullRequestUrl,
        locale: stored?.record.locales.fr,
        repository: scenario.repository,
      };
    };

    const pinned = await run(true);
    const unpinned = await run(false);

    for (const outcome of [pinned, unpinned]) {
      expect(outcome.results.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
        ["fr", "retrying"],
        ["ja", "pr-created"],
      ]);
      expect(outcome.locale?.phase).toBe("pr-created");
      expect(outcome.locale?.pullRequestUrl).toBe(outcome.originalPullRequestUrl);
      expect(outcome.repository.pullRequests).toHaveLength(2);
    }
  });

  it.each([
    [
      "503 then 401",
      new PhraseApiError("Phrase API returned HTTP 503", 503),
      new PhraseAuthError(
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
        401,
      ),
    ],
    [
      "401 then 503",
      new PhraseAuthError(
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
        401,
      ),
      new PhraseApiError("Phrase API returned HTTP 503", 503),
    ],
  ] as const)(
    "prefers a permanent pinned verification error for one locale regardless of order (%s)",
    async (_order, firstError, secondError) => {
      const run = async (pinned: boolean) => {
        const state = new MemoryStateStore();
        const phrase = new FakePhrase();
        phrase.jobParts = [
          { uid: "job-fr-first", targetLang: "fr", workflowLevel: 1 },
          { uid: "job-fr-second", targetLang: "fr", workflowLevel: 2 },
        ];
        phrase.jobStatus = "COMPLETED";
        phrase.getJobErrors.set(
          "job-fr-first",
          new PhraseApiError("Phrase API returned HTTP 503", 503),
        );
        const repository = new FakeRepository();
        const workflow = new PhraseWorkflow({
          phrase,
          state,
          repository,
          catalogAdapters: new CatalogAdapterRegistry(),
        });
        const submitted = await workflow.submit({
          repository: "example/app",
          baseRef: "phrase-pilot",
          sourceCommit: "abc123",
          sourceBytes,
          config,
        });
        expect(submitted.phase).toBe("importing");
        phrase.getJobErrors.clear();
        phrase.getJobErrors.set("job-fr-first", firstError);
        phrase.getJobErrors.set("job-fr-second", secondError);

        const results = await workflow.reconcile(pinned ? phrasePins : {});
        const stored = await state.readBatch(submitted.key);
        return { results, locale: stored?.record.locales.fr };
      };

      const pinned = await run(true);
      const unpinned = await run(false);
      const authMessage =
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials";

      for (const outcome of [pinned, unpinned]) {
        expect(outcome.results).toContainEqual({
          batchKey: expect.any(String),
          phraseLocale: "fr",
          phase: "failed",
          reason: authMessage,
        });
        expect(outcome.locale).toMatchObject({ phase: "failed", failureReason: authMessage });
      }
    },
  );

  it.each([
    [
      "503+ERROR",
      { kind: "lookup", error: new PhraseApiError("Phrase API returned HTTP 503", 503) },
      { kind: "import", status: "ERROR" },
      "failed",
      "Phrase failed to import job job-fr-second: unknown error",
    ],
    [
      "ERROR+503",
      { kind: "import", status: "ERROR" },
      { kind: "lookup", error: new PhraseApiError("Phrase API returned HTTP 503", 503) },
      "failed",
      "Phrase failed to import job job-fr-first: unknown error",
    ],
    [
      "503+401",
      { kind: "lookup", error: new PhraseApiError("Phrase API returned HTTP 503", 503) },
      {
        kind: "lookup",
        error: new PhraseAuthError(
          "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
          401,
        ),
      },
      "failed",
      "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
    ],
    [
      "401+503",
      {
        kind: "lookup",
        error: new PhraseAuthError(
          "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
          401,
        ),
      },
      { kind: "lookup", error: new PhraseApiError("Phrase API returned HTTP 503", 503) },
      "failed",
      "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
    ],
    [
      "503+COMPLETED",
      { kind: "lookup", error: new PhraseApiError("Phrase API returned HTTP 503", 503) },
      { kind: "job", status: "COMPLETED" },
      "retrying",
      "Phrase API returned HTTP 503",
    ],
  ] as const)(
    "matches pinned and unpinned per-locale outcomes across mixed job parts (%s)",
    async (_case, firstSignal, secondSignal, expectedPhase, expectedReason) => {
      const applySignal = (
        phrase: FakePhrase,
        jobUid: string,
        signal:
          | { kind: "lookup"; error: Error }
          | { kind: "import"; status: "ERROR" }
          | { kind: "job"; status: "COMPLETED" },
      ) => {
        if (signal.kind === "lookup") phrase.getJobErrors.set(jobUid, signal.error);
        else if (signal.kind === "import") phrase.importStatuses.set(jobUid, signal.status);
        else phrase.jobStatuses.set(jobUid, signal.status);
      };
      const run = async (pinned: boolean) => {
        const scenario = makeJapaneseWorkflowScenario();
        scenario.phrase.jobStatus = "NEW";
        scenario.phrase.jobParts = [
          { uid: "job-fr-first", targetLang: "fr", workflowLevel: 1 },
          { uid: "job-fr-second", targetLang: "fr", workflowLevel: 2 },
          { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
        ];
        scenario.phrase.getJobErrors.set(
          "job-fr-first",
          new PhraseApiError("Phrase API returned HTTP 503", 503),
        );
        scenario.phrase.jobStatuses.set("job-ja", "COMPLETED");
        const submitted = await scenario.workflow.submit(scenario.input);
        expect(submitted.phase).toBe("importing");
        scenario.phrase.getJobErrors.clear();
        applySignal(scenario.phrase, "job-fr-first", firstSignal);
        applySignal(scenario.phrase, "job-fr-second", secondSignal);

        const results = await scenario.workflow.reconcile(pinned ? phrasePins : {});
        const stored = await scenario.state.readBatch(submitted.key);
        return {
          results,
          locale: stored?.record.locales.fr,
          batchPhase: stored?.record.phase,
          pullRequestPaths: scenario.repository.pullRequests.map(({ path }) => path),
        };
      };

      const pinned = await run(true);
      const unpinned = await run(false);
      const phases = (results: typeof pinned.results) =>
        results.map(({ phraseLocale, phase }) => [phraseLocale, phase]);
      const resultPhase = expectedPhase === "failed" ? "failed" : "retrying";
      const localePhase = expectedPhase === "failed" ? "failed" : "pending";

      for (const outcome of [pinned, unpinned]) {
        expect(phases(outcome.results)).toEqual([
          ["fr", resultPhase],
          ["ja", "pr-created"],
        ]);
        expect(outcome.locale?.phase).toBe(localePhase);
        expect(outcome.results[0]?.reason).toBe(expectedReason);
        expect(outcome.pullRequestPaths).toEqual(["locales/ja.json"]);
        expect(outcome.batchPhase === "importing").toBe(expectedPhase === "retrying");
      }
      expect(phases(pinned.results)).toEqual(phases(unpinned.results));
    },
  );

  it.each([
    ["preverification", "503", new PhraseApiError("Phrase API returned HTTP 503", 503), "retrying"],
    [
      "preverification",
      "401",
      new PhraseAuthError(
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
        401,
      ),
      "failed",
    ],
    ["preverification", "404", new PhraseApiError("Phrase API returned HTTP 404", 404), "failed"],
    ["finishImport", "503", new PhraseApiError("Phrase API returned HTTP 503", 503), "retrying"],
    [
      "finishImport",
      "401",
      new PhraseAuthError(
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials",
        401,
      ),
      "failed",
    ],
    ["finishImport", "404", new PhraseApiError("Phrase API returned HTTP 404", 404), "failed"],
  ] as const)(
    "matches unpinned outcomes for %s lookup errors with HTTP %s",
    async (lookupPoint, _status, error, expectedLocalePhase) => {
      const run = async (pinned: boolean) => {
        const scenario = makeJapaneseWorkflowScenario();
        const submitted = await submitWithJapaneseImportRetrying(scenario);
        scenario.phrase.getJobErrors.delete("job-ja");
        const firstReconcileCall = scenario.phrase.getJobCalls.length + 1;
        const failedCall = firstReconcileCall + (lookupPoint === "finishImport" && pinned ? 2 : 0);
        failJobLookupAt(scenario.phrase, "job-fr", failedCall, error);
        const results = await scenario.workflow.reconcile(pinned ? phrasePins : {});
        return {
          submitted,
          results,
          pullRequestPaths: scenario.repository.pullRequests.map(({ path }) => path),
        };
      };

      const pinned = await run(true);
      const unpinned = await run(false);
      const phases = (results: typeof pinned.results) =>
        results.map(({ phraseLocale, phase }) => [phraseLocale ?? "batch", phase]);

      if (error instanceof PhraseApiError && error.status === 404) {
        const expected = [
          ["fr", "retrying"],
          ["ja", "pr-created"],
        ];
        expect(phases(pinned.results)).toEqual(expected);
        expect(pinned.results[0]?.reason).toBe(
          "Phrase has not yet exposed the new jobs; the next run continues this batch",
        );
        expect(phases(unpinned.results)).toEqual(expected);
        expect(unpinned.results[0]?.reason).toBe(pinned.results[0]?.reason);
        expect(pinned.pullRequestPaths).toEqual(["locales/ja.json"]);
        expect(unpinned.pullRequestPaths).toEqual(["locales/ja.json"]);
      } else {
        const expected = [
          ["fr", expectedLocalePhase],
          ["ja", "pr-created"],
        ];
        expect(phases(pinned.results)).toEqual(expected);
        expect(phases(unpinned.results)).toEqual(expected);
        expect(pinned.pullRequestPaths).toEqual(["locales/ja.json"]);
        expect(unpinned.pullRequestPaths).toEqual(["locales/ja.json"]);
      }
    },
  );

  it.each(["job-fr", "job-ja-retry"] as const)(
    "verifies both carried and new jobs before finishing a pinned retry (%s filename mismatch)",
    async (mismatchedJobUid) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      phrase.jobParts = [
        { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
        { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
      ];
      phrase.expectedTargetLangs = ["fr", "ja"];
      phrase.jobStatuses.set("job-fr", "COMPLETED");
      phrase.jobStatuses.set("job-ja", "CANCELLED");
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const retryConfig: PhraseWorkflowConfig = {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
      };
      const input = {
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config: retryConfig,
      };
      const pins = {
        expectedProjectUid: "project-uid",
        expectedSourceFilename: "translation-template.json",
      };

      const parent = await workflow.submit({ ...input, ...pins });
      phrase.jobStatus = "COMPLETED";
      const parentResults = await workflow.reconcile(pins);
      expect(parentResults.map(({ phraseLocale, phase }) => [phraseLocale, phase])).toEqual([
        ["fr", "pr-created"],
        ["ja", "failed"],
      ]);

      phrase.expectedTargetLangs = ["ja"];
      phrase.jobParts = [{ uid: "job-ja-retry", targetLang: "ja", workflowLevel: 1 }];
      phrase.jobStatuses.set("job-ja-retry", "COMPLETED");
      phrase.jobFilenamesByUid.set(mismatchedJobUid, "other-catalog.json");
      phrase.getJobCalls.length = 0;
      phrase.asyncRequestIds.length = 0;
      const writesBeforeRetry = state.writes;
      const downloadsBeforeRetry = phrase.targetDownloadCalls;

      await expect(workflow.submit({ ...input, ...pins, retryFailed: true })).rejects.toThrow(
        'source filename mismatch: expected "translation-template.json", actual "other-catalog.json"',
      );

      const retry = [...state.records.values()].find(
        ({ record }) => record.retryParentBatchKey === parent.key,
      );
      expect(phrase.getJobCalls.map(({ jobUid }) => jobUid)).toEqual(["job-fr", "job-ja-retry"]);
      expect(phrase.asyncRequestIds).toEqual([]);
      expect(phrase.targetDownloadCalls).toBe(downloadsBeforeRetry);
      expect(state.writes).toBe(writesBeforeRetry + 2);
      expect(retry?.record.phase).toBe("importing");
      expect(retry?.record.jobs.map(({ uid }) => uid)).toEqual(["job-fr", "job-ja-retry"]);
      expect(retry?.record.importAsyncRequestId).toBe("import-1");
    },
  );

  it("continues a two-batch re-export when one batch fails its pinned job check", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    const pins = {
      expectedProjectUid: "project-uid",
      expectedSourceFilename: "translation-template.json",
    };
    const mismatched = await workflow.submit({ ...input, baseRef: "phrase-pilot", ...pins });
    const healthy = await workflow.submit({ ...input, baseRef: "release", ...pins });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile(pins);

    const mismatchedStored = state.records.get(mismatched.key)!;
    const healthyStored = state.records.get(healthy.key)!;
    const mismatchedBranch = mismatchedStored.record.locales.fr?.pullRequestBranch;
    const healthyBranch = healthyStored.record.locales.fr?.pullRequestBranch;
    expect(mismatchedBranch).toBeDefined();
    expect(healthyBranch).toBeDefined();
    mismatchedStored.record.jobs[0]!.uid = "job-fr-mismatched";
    const mismatchedRecord = structuredClone(mismatchedStored.record);
    const mismatchedRevision = mismatchedStored.revision;
    phrase.jobFilenamesByUid.set("job-fr-mismatched", "other-catalog.json");
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
    const mismatchedCommitsBefore = repository.commitCount(mismatchedBranch!);
    const healthyCommitsBefore = repository.commitCount(healthyBranch!);
    const downloadsBefore = phrase.targetDownloadJobUids.length;

    const results = await workflow.reconcile(pins);

    expect(results).toContainEqual(
      expect.objectContaining({
        batchKey: mismatched.key,
        phase: "failed",
        reason: expect.stringContaining("source filename mismatch"),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ batchKey: healthy.key, phraseLocale: "fr", phase: "pr-created" }),
    );
    expect(repository.commitCount(mismatchedBranch!)).toBe(mismatchedCommitsBefore);
    expect(repository.commitCount(healthyBranch!)).toBe(healthyCommitsBefore + 1);
    expect(phrase.targetDownloadJobUids.slice(downloadsBefore)).toEqual(["job-fr"]);
    expect(state.records.get(mismatched.key)?.record).toEqual(mismatchedRecord);
    expect(state.records.get(mismatched.key)?.revision).toBe(mismatchedRevision);
    expect(repository.pullRequests).toHaveLength(2);
  });

  it("does not commit state on every run while Phrase jobs are unchanged", async () => {
    const state = new MemoryStateStore();
    const workflow = new PhraseWorkflow({
      phrase: new FakePhrase(),
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    await workflow.reconcile();
    const writes = state.writes;

    expect((await workflow.reconcile()).map((result) => result.phase)).toEqual(["pending"]);
    expect(state.writes).toBe(writes);
  });

  it("revives a superseded batch when the same source returns instead of creating a new job", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    await workflow.submit(input);
    repository.baseSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Welcome {name}"}}',
    );
    expect((await workflow.reconcile())[0]?.phase).toBe("superseded");
    repository.baseSourceBytes = sourceBytes;

    const revived = await workflow.submit(input);
    phrase.jobStatus = "COMPLETED";

    expect(revived.phase).toBe("ready");
    expect(phrase.createJobCalls).toBe(1);
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
  });

  it("resumes imports when reviving a superseded batch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    };
    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 503", 503));

    const submitted = await workflow.submit(input);
    expect(submitted.phase).toBe("importing");

    repository.baseSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Welcome {name}"}}',
    );
    expect((await workflow.reconcile())[0]?.phase).toBe("superseded");
    expect((await state.readBatch(submitted.key))?.record.phase).toBe("superseded");

    repository.baseSourceBytes = sourceBytes;
    const revived = await workflow.submit(input);

    expect(revived.phase).toBe("importing");
    expect(revived.locales.fr).toEqual({ phase: "pending" });

    phrase.getJobErrors.set("job-fr", new PhraseApiError("Phrase API returned HTTP 404", 404));
    const results = await workflow.reconcile();
    const failed = await state.readBatch(submitted.key);

    expect(results).toContainEqual({
      batchKey: submitted.key,
      phraseLocale: "fr",
      phase: "retrying",
      reason: "Phrase has not yet exposed the new jobs; the next run continues this batch",
    });
    expect(failed?.record.locales.fr).toMatchObject({
      phase: "pending",
    });
    expect(failed?.record.phase).toBe("importing");
    expect(phrase.createJobCalls).toBe(1);
  });

  it("starts a fresh target export after an interrupted download attempt", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    phrase.exportError = new Error("temporary export failure");

    const interrupted = await workflow.reconcile();
    expect(interrupted[0]?.phase).toBe("retrying");
    phrase.exportError = undefined;

    const retried = await workflow.reconcile();

    expect(retried[0]?.phase).toBe("pr-created");
    expect(phrase.targetDownloadCalls).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);
  });

  it("retries PR handoff after a repository failure without persisting an export request ID", async () => {
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.pullRequestError = new Error("temporary GitHub failure");
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const failedHandoff = await workflow.reconcile();
    expect(failedHandoff[0]?.phase).toBe("retrying");
    repository.pullRequestError = undefined;

    const retried = await workflow.reconcile();

    expect(retried[0]?.phase).toBe("pr-created");
    expect(phrase.targetDownloadCalls).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);
  });

  it("waits for the final Phrase workflow step even when an earlier step is complete", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-step-1", targetLang: "fr", workflowLevel: 1, lastWorkflowLevel: 2 },
      { uid: "job-step-2", targetLang: "fr", workflowLevel: 2, lastWorkflowLevel: 2 },
    ];
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });

    phrase.jobStatuses.set("job-step-1", "COMPLETED");
    phrase.jobStatuses.set("job-step-2", "NEW");
    const waiting = await workflow.reconcile();

    expect(waiting[0]?.phase).toBe("pending");
    expect(phrase.targetDownloadCalls).toBe(0);
    phrase.jobStatuses.set("job-step-2", "COMPLETED");

    const completed = await workflow.reconcile();

    expect(completed[0]?.phase).toBe("pr-created");
    expect(phrase.events).toContain("phrase:export:job-step-2");
  });

  it("rejects a Phrase translation that replaces an exact plural with a number", async () => {
    const exactSourceBytes = new TextEncoder().encode(
      JSON.stringify({
        items: { defaultMessage: "{count, plural, =1 {one item} other {# items}}" },
      }),
    );
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({ items: "{count, number} articles" }),
    );
    const repository = new FakeRepository();
    repository.baseSourceBytes = exactSourceBytes;
    repository.pinnedSourceBytes = exactSourceBytes;
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: exactSourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const [result] = await workflow.reconcile();

    expect(result?.phase).toBe("failed");
    expect(result?.reason).toContain('"items": plural {count} lost exact branch =1');
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.draft).toBe(true);
    expect(repository.pullRequestComments[0]?.body).toContain(
      "Plural {count} lost exact branch =1.",
    );
  });

  it("requires drafts for adoption only when validation fails", async () => {
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    await workflow.reconcile();
    expect(repository.createDraftRequirements).toEqual([false]);
    expect(repository.pullRequests[0]?.draft).toBe(true);
  });

  it.each(["open", "closed", "merged"] as const)(
    "allows fresh-job retry only for a closed unmerged invalid PR (state: %s)",
    async (prState) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const input = {
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      };
      const batch = await workflow.submit(input);
      phrase.jobStatus = "COMPLETED";
      phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour"}');
      const [invalid] = await workflow.reconcile();
      repository.pullRequestStates.set(invalid!.pullRequestUrl!, prState);
      await workflow.reconcile();
      phrase.jobParts = [{ uid: "job-fr-retry", targetLang: "fr", workflowLevel: 1 }];
      phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
      const retried = await workflow.submit({ ...input, retryFailed: true });
      expect(phrase.createJobCalls).toBe(prState === "closed" ? 2 : 1);
      if (prState === "closed") {
        expect(retried.key).not.toBe(batch.key);
        expect(retried.jobs.map((job) => job.uid)).toEqual(["job-fr-retry"]);
        expect(
          (await state.readBatch(batch.key))?.record.locales.fr?.pullRequestReexportDelegated,
        ).toBe(true);
        expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
        expect(repository.pullRequests).toHaveLength(2);
        expect(repository.pullRequests[1]?.branch).not.toBe(repository.pullRequests[0]?.branch);
        expect((await workflow.submit({ ...input, retryFailed: true })).key).toBe(retried.key);
        expect(phrase.createJobCalls).toBe(2);
      } else {
        expect(retried.key).toBe(batch.key);
      }
    },
  );

  it("does not resume the replaced closed-invalid PR when it reopens in an active parent batch", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.targetBytesByJob.set("job-fr", new TextEncoder().encode('{"greeting":"Bonjour"}'));
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
      },
    };
    const batch = await workflow.submit(input);
    phrase.jobStatus = "COMPLETED";
    const [invalid] = await workflow.reconcile();
    const oldBranch = repository.pullRequests[0]!.branch;
    repository.pullRequestStates.set(invalid!.pullRequestUrl!, "closed");
    await workflow.reconcile();
    expect((await state.readBatch(batch.key))?.record.phase).toBe("ready");
    phrase.expectedTargetLangs = ["fr"];
    phrase.jobParts = [{ uid: "job-fr-retry", targetLang: "fr", workflowLevel: 1 }];
    await workflow.submit({ ...input, retryFailed: true });
    repository.pullRequestStates.set(invalid!.pullRequestUrl!, "open");
    phrase.targetDownloadJobUids.length = 0;
    await workflow.reconcile();
    expect(phrase.targetDownloadJobUids).not.toContain("job-fr");
    expect(phrase.targetDownloadJobUids).toContain("job-fr-retry");
    expect(repository.commitCount(oldBranch)).toBe(1);
    expect(repository.pullRequests).toHaveLength(3);
  });

  it.each([
    ['{"greeting":"Bonjour {name"}', "invalid ICU syntax"],
    ["{", "Downloaded fr catalog failed validation"],
  ])(
    "opens a draft with invalid bytes (%s) and repairs the same PR without changing job status",
    async (content, diagnostic) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      const batch = await workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      });
      phrase.jobStatus = "COMPLETED";
      phrase.targetBytes = new TextEncoder().encode(content);

      const [invalid] = await workflow.reconcile();
      const pr = repository.pullRequests[0]!;
      expect(pr).toBeDefined();
      expect(pr.draft).toBe(true);
      expect(pr.content).toEqual(phrase.targetBytes);
      expect(pr.body).toContain("❌ 1 error — see the latest 🌐 Translation check comment.");
      expect(repository.pullRequestComments.at(-1)?.body).toContain(diagnostic);
      expect(invalid?.phase).toBe("failed");
      expect(invalid?.pullRequestUrl).toBe("https://github.com/example/app/pull/42");
      expect((await state.readBatch(batch.key))?.record.locales.fr?.phase).toBe("pr-created");

      const commits = repository.branchCommits.get(pr.branch)!.length;
      expect((await workflow.reconcile())[0]?.phase).toBe("failed");
      expect(repository.branchCommits.get(pr.branch)).toHaveLength(commits);
      phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
      const [fixed] = await workflow.reconcile();
      expect(fixed?.phase).toBe("pr-created");
      expect(fixed?.pullRequestUrl).toBe(invalid?.pullRequestUrl);
      expect(repository.pullRequests).toHaveLength(1);
      expect(repository.pullRequestBodies.get(fixed!.pullRequestUrl!)).not.toContain(
        "Translation errors",
      );
      expect(phrase.jobStatus).toBe("COMPLETED");
      expect(phrase.createJobCalls).toBe(1);
    },
  );

  it("refreshes legacy PR descriptions even when findings and catalog bytes are unchanged", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const batch = await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour"}');
    const [invalid] = await workflow.reconcile();
    const stored = await state.readBatch(batch.key);
    delete stored!.record.locales.fr!.pullRequestBodyDigest;
    await state.updateBatch(stored!.record, stored!.revision);
    const expectedBody = repository.pullRequestBodies.get(invalid!.pullRequestUrl!);
    repository.pullRequestBodies.set(
      invalid!.pullRequestUrl!,
      "old description without current safety notes",
    );
    const branch = repository.pullRequests[0]!.branch;
    const commits = repository.commitCount(branch);
    expect((await workflow.reconcile())[0]?.phase).toBe("failed");
    expect(repository.pullRequestBodies.get(invalid!.pullRequestUrl!) === expectedBody).toBe(true);
    expect(repository.commitCount(branch)).toBe(commits);
  });

  it("shows both errors and warnings and truncates Unicode without replacement characters", async () => {
    const source = new TextEncoder().encode(
      JSON.stringify({
        ...Object.fromEntries([["é".repeat(30_000), { defaultMessage: "Message" }]]),
        requests: { defaultMessage: "{count, plural, one {# request} other {# requests}}" },
      }),
    );
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({ requests: "{count, plural, one {élément} other {# éléments}}" }),
    );
    const repository = new FakeRepository();
    repository.baseSourceBytes = source;
    repository.pinnedSourceBytes = source;
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    expect((await workflow.reconcile())[0]?.phase).toBe("failed");
    const pr = repository.pullRequests[0]!;
    expect(pr.draft).toBe(true);
    expect(pr.body).toContain(
      "❌ 1 error · ⚠️ 1 warning — see the latest 🌐 Translation check comment.",
    );
    expect(pr.body).not.toContain("missing IDs");
    expect(repository.pullRequestComments[0]?.body).toContain("…and 1 more");
    expect(repository.pullRequestComments[0]?.body.includes("\uFFFD")).toBe(false);
    expect(new TextEncoder().encode(repository.pullRequestComments[0]?.body).length).toBeLessThan(
      65_536,
    );
  });

  it("repairs a draft with ICU argument mismatches from the same completed Phrase job", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        greeting: {
          defaultMessage: "Bonjour {count}",
          description: "Greeting",
        },
      }),
    );
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const first = await workflow.reconcile();
    const [failed] = await state.listBatches();

    expect(first[0]?.phase).toBe("failed");
    expect(first[0]?.reason).toContain("ICU argument mismatches");
    expect(first[0]?.reason).toContain('"greeting": source [name], target [count]');
    expect(failed?.record.phase).toBe("ready");
    expect(failed?.record.locales.fr?.phase).toBe("pr-created");
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.draft).toBe(true);
    expect(repository.pullRequestComments[0]?.body).toContain(
      "Argument {name} is missing from the translation.",
    );

    phrase.targetBytes = new TextEncoder().encode(
      JSON.stringify({
        greeting: {
          defaultMessage: "Bonjour {name}",
          description: "Greeting",
        },
      }),
    );
    const retried = await workflow.reconcile();
    const [completed] = await state.listBatches();

    expect(retried[0]?.phase).toBe("pr-created");
    expect(phrase.createJobCalls).toBe(1);
    expect(phrase.targetDownloadCalls).toBe(2);
    expect(repository.pullRequests).toHaveLength(1);
    expect(completed?.record.locales.fr?.phase).toBe("pr-created");
    expect((await workflow.reconcile())[0]?.phase).toBe("pr-created");
    expect(phrase.targetDownloadCalls).toBe(3);
  });

  it.each([
    ["cancelled", "CANCELLED", "OK"],
    ["declined", "DECLINED", "OK"],
    ["rejected", "REJECTED", "OK"],
    ["import error", "COMPLETED", "ERROR"],
  ] as Array<[string, string, "OK" | "ERROR"]>)(
    "does not export a final job with %s status",
    async (_label, status, importStatus) => {
      const state = new MemoryStateStore();
      const phrase = new FakePhrase();
      const repository = new FakeRepository();
      const workflow = new PhraseWorkflow({
        phrase,
        state,
        repository,
        catalogAdapters: new CatalogAdapterRegistry(),
      });
      await workflow.submit({
        repository: "example/app",
        baseRef: "phrase-pilot",
        sourceCommit: "abc123",
        sourceBytes,
        config,
      });
      phrase.jobStatus = status;
      phrase.importStatus = importStatus;

      const results = await workflow.reconcile();

      expect(results[0]?.phase).toBe("failed");
      expect(phrase.targetDownloadCalls).toBe(0);
      expect(repository.pullRequests).toHaveLength(0);
    },
  );

  it("fails safely when Phrase omits a requested target locale job", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [{ uid: "job-ja", targetLang: "ja", workflowLevel: 1 }];
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("failed");
    expect(results[0]?.reason).toMatch(/no job part for this target locale/);
    expect(phrase.targetDownloadCalls).toBe(0);
  });

  it("fails safely when Phrase returns multiple job parts at the final workflow step", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr-1", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-fr-2", targetLang: "fr", workflowLevel: 1 },
    ];
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("failed");
    expect(results[0]?.reason).toMatch(/multiple final-step job parts/i);
    expect(phrase.targetDownloadCalls).toBe(0);
  });

  it("names the missing final workflow level when no job part exists for it", async () => {
    const phrase = new FakePhrase();
    phrase.jobParts = [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1, lastWorkflowLevel: 2 }];
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("failed");
    expect(results[0]?.reason).toBe("Phrase returned no job part for final workflow level 2");
  });

  it("holds all locales until every target reaches its final step when configured", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const allLocalesConfig: PhraseWorkflowConfig = {
      ...config,
      targetLocales: [
        ...config.targetLocales,
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
      ],
      completionPolicy: { default: "all-locales" },
    };
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: allLocalesConfig,
    });
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.jobStatuses.set("job-ja", "NEW");

    const waiting = await workflow.reconcile();

    expect(waiting.map((result) => result.phase)).toEqual(["pending", "pending"]);
    expect(phrase.targetDownloadCalls).toBe(0);
    phrase.jobStatuses.set("job-ja", "COMPLETED");

    const completed = await workflow.reconcile();

    expect(completed.map((result) => result.phase)).toEqual(["pr-created", "pr-created"]);
    expect(repository.pullRequests).toHaveLength(2);
  });

  it("keeps all-locales siblings pending while a delivered draft has validation errors", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.jobParts = [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
    ];
    phrase.expectedTargetLangs = ["fr", "ja"];
    phrase.jobStatuses.set("job-fr", "COMPLETED");
    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {count}"}');
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository: new FakeRepository(),
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    const input = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config: {
        ...config,
        targetLocales: [
          ...config.targetLocales,
          { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        ],
        completionPolicy: {
          default: "per-locale" as const,
          byLocale: { ja: "all-locales" as const },
        },
      },
    };
    await workflow.submit(input);

    const first = await workflow.reconcile();
    expect(first.map((result) => result.phase)).toEqual(["failed", "pending"]);
    expect((await state.listBatches())[0]?.record.phase).toBe("ready");
    expect((await state.listBatches())[0]?.record.locales.ja?.phase).toBe("pending");

    phrase.jobStatuses.set("job-ja", "COMPLETED");
    const stillInvalid = await workflow.reconcile();
    expect(stillInvalid.map((result) => result.phase)).toEqual(["failed", "pending"]);
    expect((await state.listBatches())[0]?.record.locales.ja?.phase).toBe("pending");
    expect(phrase.targetDownloadCalls).toBe(2);

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
    const retried = await workflow.reconcile();

    expect(retried.map((result) => result.phase)).toEqual(["pr-created", "pr-created"]);
    expect(phrase.targetDownloadCalls).toBe(4);
  });

  it("fails the batch if the pinned source revision can no longer be reproduced", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    repository.pinnedSourceBytes = new TextEncoder().encode("{}");

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("failed");
    expect(stored?.record.phase).toBe("failed");
    expect(phrase.targetDownloadCalls).toBe(0);
  });

  it("rechecks the source immediately before creating the locale PR", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const changedSource = new TextEncoder().encode('{"greeting":{"defaultMessage":"Updated"}}');
    repository.onReadFile = (_path, ref, call) => {
      if (ref === "abc123") return sourceBytes;
      return call >= 4 ? changedSource : sourceBytes;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("superseded");
    expect(stored?.record.phase).toBe("superseded");
    expect(phrase.targetDownloadCalls).toBe(1);
    expect(repository.pullRequests).toHaveLength(0);
  });

  it("supersedes a translation when the base branch moves to a commit with changed English", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const oldBaseCommit = "base-before-download";
    const newBaseCommit = "base-after-download";
    const changedSource = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Good morning","description":"Greeting"}}',
    );
    repository.baseCommit = oldBaseCommit;
    repository.onReadFile = (_path, ref) => {
      if (ref === "abc123" || ref === oldBaseCommit) return sourceBytes;
      if (ref === newBaseCommit) return changedSource;
      return null;
    };
    phrase.onDownloadTargetFile = () => {
      repository.baseCommit = newBaseCommit;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("superseded");
    expect(stored?.record.phase).toBe("superseded");
    expect(repository.resolvedRefs).toEqual(["phrase-pilot", "phrase-pilot"]);
    expect(phrase.targetDownloadCalls).toBe(1);
    expect(repository.pullRequests).toHaveLength(0);
  });

  it("keeps the locale commit on its original base when the branch moves with unrelated changes", async () => {
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const oldBaseCommit = "base-before-download";
    const newBaseCommit = "base-after-download";
    repository.baseCommit = oldBaseCommit;
    repository.onReadFile = (_path, ref) =>
      ref === "abc123" || ref === oldBaseCommit || ref === newBaseCommit ? sourceBytes : null;
    phrase.onDownloadTargetFile = () => {
      repository.baseCommit = newBaseCommit;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryStateStore(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("pr-created");
    expect(repository.resolvedRefs).toEqual(["phrase-pilot", "phrase-pilot"]);
    expect(repository.pullRequests).toHaveLength(1);
    expect(repository.pullRequests[0]?.baseCommit).toBe(oldBaseCommit);
  });

  it.each([
    '{"searchEntries.roles.title":"角色"}',
    '{"searchEntries.roles.title":"角色 {missing}"}',
  ])("supersedes a late FEO template English change even with target %s", async (target) => {
    const source = new TextEncoder().encode(
      '{"searchEntries.roles.title":{"defaultMessage":"Roles","description":"Role title"}}',
    );
    const template =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles\n";
    const changedTemplate = template.replace("title: Roles", "title: Users");
    const oldBaseCommit = "base-before-download";
    const newBaseCommit = "base-after-download";
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    phrase.expectedTargetLangs = ["zh_cn"];
    phrase.jobParts = [{ uid: "job-zh_cn", targetLang: "zh_cn", workflowLevel: 1 }];
    phrase.targetBytes = new TextEncoder().encode(target);
    const repository = new FakeRepository();
    repository.baseCommit = oldBaseCommit;
    repository.onReadFile = (path, ref) => {
      if (path === "deploy/frontend.yaml") {
        return new TextEncoder().encode(ref === newBaseCommit ? changedTemplate : template);
      }
      return source;
    };
    phrase.onDownloadTargetFile = () => {
      repository.baseCommit = newBaseCommit;
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes: source,
      config: {
        ...config,
        frontendTemplate: { path: "deploy/frontend.yaml" },
        targetLocales: [
          {
            phraseLocale: "zh_cn",
            repositoryLocale: "zh-CN",
            outputPath: "deploy/locales/zh-CN.json",
          },
        ],
      },
    });
    phrase.jobStatus = "COMPLETED";

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("superseded");
    expect(stored?.record.phase).toBe("superseded");
    expect(repository.resolvedRefs).toEqual(["phrase-pilot", "phrase-pilot"]);
    expect(repository.pullRequests).toHaveLength(0);
  });

  it("marks a batch superseded when its source catalog changed before reconciliation", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    const workflow = new PhraseWorkflow({
      phrase,
      state,
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });
    await workflow.submit({
      repository: "example/app",
      baseRef: "phrase-pilot",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    phrase.jobStatus = "COMPLETED";
    repository.baseSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Welcome {name}","description":"Greeting"}}',
    );

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("superseded");
    expect(stored?.record.phase).toBe("superseded");
    expect(phrase.targetDownloadCalls).toBe(0);
    expect(repository.pullRequests).toHaveLength(0);
  });
});

describe("new locale PR assignees", () => {
  const sourceMessages = {
    greeting: { defaultMessage: "Hello {name}", description: "Greeting" },
  };
  const translatedMessages = { greeting: "Bonjour {name}" };

  it("resolves source-change authors once per batch for all new locale PRs", async () => {
    const scenario = makeJapaneseWorkflowScenario();
    await scenario.workflow.submit(scenario.input);
    scenario.repository.sourceChangeAuthors = ["source-author"];

    const results = await scenario.workflow.reconcile();

    expect(results.map((result) => result.phase)).toEqual(["pr-created", "pr-created"]);
    expect(scenario.repository.sourceAuthorRequests).toHaveLength(1);
    expect(scenario.repository.assigneeRequests.map((request) => request.logins)).toEqual([
      ["source-author"],
      ["source-author"],
    ]);
  });

  it("assigns the source-change authors when it creates a locale PR", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    scenario.repository.sourceChangeAuthors = ["source-author", "second-author"];

    const [result] = await scenario.workflow.reconcile({
      fallbackAssignees: ["hub-fallback"],
    });
    const stored = await scenario.state.readBatch(scenario.batch.key);

    expect(result?.phase).toBe("pr-created");
    expect(scenario.repository.sourceAuthorRequests).toEqual([
      { path: "locales/translation-template.json", headCommit: "abc123" },
    ]);
    expect(scenario.repository.assigneeRequests).toEqual([
      {
        pullRequestUrl: result?.pullRequestUrl,
        logins: ["source-author", "second-author"],
      },
    ]);
    expect(stored?.record.locales.fr?.phase).toBe("pr-created");
    expect(stored?.record.locales.fr?.pullRequestAssigneesPending).toBeUndefined();
  });

  it("uses the fallback list when no source-change authors are found", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);

    await scenario.workflow.reconcile({ fallbackAssignees: ["hub-fallback", "team-owner"] });

    expect(scenario.repository.assigneeRequests).toEqual([
      {
        pullRequestUrl: "https://github.com/example/app/pull/42",
        logins: ["hub-fallback", "team-owner"],
      },
    ]);
  });

  it("uses the fallback list when GitHub assigns none of the source authors", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    scenario.repository.sourceChangeAuthors = ["source-author"];
    scenario.repository.assigneeResponses.push([], ["hub-fallback"]);

    await scenario.workflow.reconcile({ fallbackAssignees: ["hub-fallback"] });

    expect(scenario.repository.assigneeRequests).toEqual([
      {
        pullRequestUrl: "https://github.com/example/app/pull/42",
        logins: ["source-author"],
      },
      {
        pullRequestUrl: "https://github.com/example/app/pull/42",
        logins: ["hub-fallback"],
      },
    ]);
  });

  it("does not assign again while updating an existing open PR", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    scenario.repository.sourceChangeAuthors = ["source-author"];
    const [created] = await scenario.workflow.reconcile();
    scenario.repository.assignedLogins.set(created!.pullRequestUrl!, []);

    const [updated] = await scenario.workflow.reconcile();

    expect(updated?.phase).toBe("pr-created");
    expect(scenario.repository.assignedLogins.get(created!.pullRequestUrl!)).toEqual([]);
    expect(scenario.repository.assigneeRequests).toHaveLength(1);
    expect(scenario.repository.sourceAuthorRequests).toHaveLength(1);
  });

  it("keeps a transient assignment pending and retries it on the next reconcile", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    scenario.repository.sourceChangeAuthors = ["source-author"];
    scenario.repository.sourceAuthorErrors.push(
      new PhraseRepositoryError("GitHub API returned HTTP 503", 503),
    );

    const [first] = await scenario.workflow.reconcile();
    const afterFailure = await scenario.state.readBatch(scenario.batch.key);

    expect(first?.phase).toBe("pr-created");
    expect(first?.reason).toContain("503");
    expect(afterFailure?.record.locales.fr?.phase).toBe("pr-created");
    expect(afterFailure?.record.locales.fr?.pullRequestAssigneesPending).toBe(true);

    const [retry] = await scenario.workflow.reconcile();
    const afterRetry = await scenario.state.readBatch(scenario.batch.key);
    await scenario.workflow.reconcile();

    expect(retry?.phase).toBe("pr-created");
    expect(afterRetry?.record.locales.fr?.phase).toBe("pr-created");
    expect(afterRetry?.record.locales.fr?.pullRequestAssigneesPending).toBeUndefined();
    expect(scenario.repository.assigneeRequests).toHaveLength(1);
    expect(scenario.repository.sourceAuthorRequests).toHaveLength(2);
  });

  it("clears a final 4xx assignment failure without retrying or changing the result phase", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    scenario.repository.sourceAuthorErrors.push(
      new PhraseRepositoryError("GitHub API returned HTTP 403", 403),
    );

    const [first] = await scenario.workflow.reconcile();
    const afterFailure = await scenario.state.readBatch(scenario.batch.key);
    await scenario.workflow.reconcile();

    expect(first?.phase).toBe("pr-created");
    expect(first?.reason).toContain("403");
    expect(afterFailure?.record.locales.fr?.phase).toBe("pr-created");
    expect(afterFailure?.record.locales.fr?.pullRequestAssigneesPending).toBeUndefined();
    expect(scenario.repository.sourceAuthorRequests).toHaveLength(1);
    expect(scenario.repository.assigneeRequests).toHaveLength(0);
  });

  it("chooses the latest earlier batch for the same repository, ref, project, and filename", async () => {
    const scenario = await makeFindingsScenario(sourceMessages, translatedMessages);
    const current = await scenario.state.readBatch(scenario.batch.key);
    if (!current) throw new Error("Expected the current Phrase batch");
    const currentRecord = {
      ...current.record,
      sourceCommit: "current-source",
      createdAt: "2026-10-20T00:00:00.000Z",
    };
    scenario.state.records.set(currentRecord.key, {
      record: currentRecord,
      revision: current.revision,
    });
    const previousRecord = (
      key: string,
      sourceCommit: string,
      createdAt: string,
      overrides: Partial<PhraseBatchRecord> = {},
    ): PhraseBatchRecord => ({
      ...currentRecord,
      key,
      phase: "completed",
      sourceCommit,
      createdAt,
      jobs: [],
      locales: {},
      ...overrides,
    });
    const unrelatedProject = previousRecord(
      "wrong-project",
      "wrong-project",
      "2026-10-19T23:00:00Z",
      {
        config: { ...currentRecord.config, projectUid: "other-project" },
      },
    );
    const unrelatedFilename = previousRecord(
      "wrong-filename",
      "wrong-filename",
      "2026-10-19T22:00:00Z",
      {
        config: {
          ...currentRecord.config,
          sourceCatalog: { ...currentRecord.config.sourceCatalog, filename: "other.json" },
        },
      },
    );
    const candidates = [
      previousRecord("older-match", "older-source", "2026-10-17T00:00:00Z"),
      previousRecord("latest-match", "latest-source", "2026-10-18T00:00:00Z"),
      previousRecord("same-source", "current-source", "2026-10-19T23:00:00Z"),
      previousRecord("wrong-repository", "wrong-repository", "2026-10-19T22:00:00Z", {
        repository: "other/app",
      }),
      previousRecord("wrong-ref", "wrong-ref", "2026-10-19T21:00:00Z", { baseRef: "main" }),
      unrelatedProject,
      unrelatedFilename,
      previousRecord("future", "future-source", "2026-10-21T00:00:00Z"),
    ];
    for (const candidate of candidates) await scenario.state.createBatch(candidate);

    await scenario.workflow.reconcile();

    expect(scenario.repository.sourceAuthorRequests[0]).toEqual({
      path: "locales/translation-template.json",
      headCommit: "current-source",
      baseCommit: "latest-source",
    });
  });
});
