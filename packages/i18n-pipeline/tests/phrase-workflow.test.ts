import { describe, expect, it } from "vitest";
import { CatalogAdapterRegistry } from "../src/index.js";
import { PhraseApiError } from "../src/phrase-client.js";
import {
  PhraseBatchStateConflictError,
  PhraseRepositoryError,
  PhraseWorkflow,
  type PhraseBatchRecord,
  type PhraseBatchStateStore,
  type PhraseLocalePullRequest,
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
    const current = this.records.get(record.key);
    if (!current || current.revision !== expectedRevision) throw new Error("state conflict");
    if (record.phase === this.conflictOnPhase) throw new PhraseBatchStateConflictError();
    this.events.push(`state:${record.phase}`);
    this.writes += 1;
    const revision = String(Number(expectedRevision) + 1);
    this.records.set(record.key, { record: structuredClone(record), revision });
    return revision;
  }
}

class FakePhrase {
  readonly events: string[];
  createJobCalls = 0;
  targetDownloadCalls = 0;
  createError?: Error & { mayHaveExecuted?: boolean };
  waitError?: Error;
  exportError?: Error;
  getJobError?: Error;
  jobStatus = "NEW";
  importStatus: "RUNNING" | "ERROR" | "OK" = "OK";
  expectedTargetLangs = ["fr"];
  unsupportedFiles: string[] = [];
  warnings: unknown[] = [];
  readonly jobStatuses = new Map<string, string>();
  jobParts: Array<{
    uid: string;
    targetLang: string;
    workflowLevel: number;
    lastWorkflowLevel?: number;
  }> = [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1 }];
  targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');

  constructor(events: string[] = []) {
    this.events = events;
  }

  async createJob(input: { targetLangs: string[]; filename: string }) {
    this.createJobCalls += 1;
    this.events.push("phrase:create");
    if (this.createError) throw this.createError;
    expect(input.filename).toBe("translation-template.json");
    expect(input.targetLangs).toEqual(this.expectedTargetLangs);
    return {
      asyncRequest: { id: "import-1", action: "IMPORT_JOB" },
      jobs: this.jobParts,
      unsupportedFiles: this.unsupportedFiles,
      warnings: this.warnings,
    };
  }

  async waitForAsyncRequest(id: string) {
    this.events.push(`phrase:wait:${id}`);
    if (this.waitError) {
      const error = this.waitError;
      this.waitError = undefined;
      throw error;
    }
  }

  async getJob(_projectUid: string, uid: string) {
    if (this.getJobError) throw this.getJobError;
    const job = this.jobParts.find((part) => part.uid === uid);
    if (!job) throw new Error(`Unexpected job ${uid}`);
    return {
      ...job,
      lastWorkflowLevel: job.lastWorkflowLevel ?? job.workflowLevel,
      status: this.jobStatuses.get(uid) ?? this.jobStatus,
      importStatus: { status: this.importStatus },
    };
  }

  async startTargetDownload(_projectUid: string, jobUid: string) {
    this.targetDownloadCalls += 1;
    this.events.push(`phrase:export:${jobUid}`);
    if (this.exportError) throw this.exportError;
    return `export-${jobUid}`;
  }

  async downloadTargetFile(_projectUid: string, _jobUid: string) {
    this.events.push("phrase:download");
    return this.targetBytes;
  }
}

class FakeRepository implements PhraseWorkflowRepository {
  readonly pullRequests: PhraseLocalePullRequest[] = [];
  baseSourceBytes = sourceBytes;
  pinnedSourceBytes = sourceBytes;
  pullRequestError?: Error;
  readFileCalls = 0;
  onReadFile?: (path: string, ref: string, call: number) => Uint8Array | null;

  async readFile(path: string, ref: string) {
    this.readFileCalls += 1;
    if (this.onReadFile) return this.onReadFile(path, ref, this.readFileCalls);
    return ref === "abc123" ? this.pinnedSourceBytes : this.baseSourceBytes;
  }

  async createOrUpdatePullRequest(input: PhraseLocalePullRequest) {
    if (this.pullRequestError) throw this.pullRequestError;
    this.pullRequests.push(input);
    return "https://github.com/example/app/pull/42";
  }
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

  it("does not resubmit a job after Phrase reports an import failure", async () => {
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

    await expect(workflow.submit(input)).rejects.toThrow("Phrase failed to import job job-fr");
    const [stored] = await state.listBatches();
    expect(stored?.record.phase).toBe("failed");
    await expect(workflow.submit(input)).rejects.toThrow(
      /cannot be submitted again from phase failed/i,
    );
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
    await expect(workflow.submit(input)).rejects.toThrow(/unknown Phrase submission outcome/i);
    expect(phrase.createJobCalls).toBe(1);
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

    expect((await state.listBatches())[0]?.record.phase).toBe("completed");

    repository.baseSourceBytes = new TextEncoder().encode(
      '{"greeting":{"defaultMessage":"Welcome {name}","description":"Greeting"}}',
    );
    const repeated = await workflow.reconcile();
    expect(repeated).toEqual([]);
    expect((await state.listBatches())[0]?.record.phase).toBe("completed");
    expect(phrase.targetDownloadCalls).toBe(1);
    expect(repository.pullRequests).toHaveLength(1);
  });

  it("fails a locale permanently when its previous PR was closed without merging", async () => {
    const state = new MemoryStateStore();
    const phrase = new FakePhrase();
    const repository = new FakeRepository();
    repository.pullRequestError = new PhraseRepositoryError(
      "A previous Phrase pull request was closed without merging",
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
        reason: "A previous Phrase pull request was closed without merging",
      }),
    ]);
    expect((await state.listBatches())[0]?.record.phase).toBe("completed");
    expect(await workflow.reconcile()).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(1);
  });

  it("reports a Phrase failure for one batch without blocking the others", async () => {
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
    phrase.getJobError = new PhraseApiError("Phrase API returned HTTP 404", 404);
    expect(await workflow.reconcile()).toEqual([
      { batchKey: corrupt.key, phase: "retrying", reason: "Phrase API returned HTTP 404" },
    ]);
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

  it("does not open a PR when downloaded catalog fails ICU validation", async () => {
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

    const results = await workflow.reconcile();
    const [stored] = await state.listBatches();

    expect(results[0]?.phase).toBe("failed");
    expect(results[0]?.reason).toContain("ICU argument mismatches");
    expect(stored?.record.locales.fr?.phase).toBe("failed");
    expect(repository.pullRequests).toHaveLength(0);
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

  it("fails all-locales targets once another locale fails validation", async () => {
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
    expect(first.map((result) => result.phase)).toEqual(["failed", "failed"]);
    expect(first[1]?.reason).toBe("Blocked: locale fr failed in this all-locales batch");
    expect((await state.listBatches())[0]?.record.phase).toBe("completed");

    phrase.targetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
    phrase.jobStatuses.set("job-ja", "COMPLETED");
    const retried = await workflow.reconcile();

    expect(retried).toEqual([]);
    expect(phrase.targetDownloadCalls).toBe(1);
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
