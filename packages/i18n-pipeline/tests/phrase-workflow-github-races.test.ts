import { describe, expect, it } from "vitest";
import { CatalogAdapterRegistry } from "../src/index.js";
import { GitHubPhraseRepository } from "../src/github-phrase-repository.js";
import {
  PhraseBatchStateConflictError,
  PhraseWorkflow,
  type PhraseBatchRecord,
  type PhraseBatchStateStore,
  type PhraseWorkflowConfig,
  type PhraseWorkflowDependencies,
  type PhraseSubmitInput,
} from "../src/phrase-workflow.js";

const sourceBytes = new TextEncoder().encode(
  '{"greeting":{"defaultMessage":"Hello {name}","description":"Greeting"}}',
);
const initialTargetBytes = new TextEncoder().encode('{"greeting":"Bonjour {name}"}');
const updatedTargetBytes = new TextEncoder().encode('{"greeting":"Salut {name}"}');
const config: PhraseWorkflowConfig = {
  projectUid: "project-uid",
  region: "us",
  sourceCatalog: {
    path: "locales/translation-template.json",
    filename: "translation-template.json",
    adapter: "formatjs-json",
    locale: "en",
  },
  targetAdapter: "formatjs-json",
  targetLocales: [
    { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
    { phraseLocale: "de", repositoryLocale: "de", outputPath: "locales/de.json" },
  ],
  completionPolicy: { default: "per-locale" },
};

type StateBeforeUpdate = (
  store: RevisionedStateStore,
  record: PhraseBatchRecord,
  expectedRevision: string,
) => Promise<void> | void;
type PhraseClient = PhraseWorkflowDependencies["phrase"];

class RevisionedStateStore implements PhraseBatchStateStore {
  private readonly records = new Map<string, { record: PhraseBatchRecord; revision: string }>();
  beforeUpdate?: StateBeforeUpdate;
  beforeOwnedCommitWrite?: (
    store: RevisionedStateStore,
    record: PhraseBatchRecord,
  ) => Promise<void>;
  afterOwnedCommitWrite?: (
    store: RevisionedStateStore,
    record: PhraseBatchRecord,
  ) => Promise<void> | void;

  async readBatch(key: string) {
    const stored = this.records.get(key);
    return stored && { record: structuredClone(stored.record), revision: stored.revision };
  }

  async listBatchKeys() {
    return [...this.records.keys()];
  }

  async createBatch(record: PhraseBatchRecord): Promise<string> {
    if (this.records.has(record.key)) throw new Error("batch already exists");
    this.records.set(record.key, { record: structuredClone(record), revision: "1" });
    return "1";
  }

  async updateBatch(record: PhraseBatchRecord, expectedRevision: string): Promise<string> {
    await this.beforeUpdate?.(this, record, expectedRevision);
    const current = this.records.get(record.key);
    const writesOwnedSha = current && this.addedOwnedSha(record, current.record);
    if (this.beforeOwnedCommitWrite && writesOwnedSha) {
      const intercept = this.beforeOwnedCommitWrite;
      this.beforeOwnedCommitWrite = undefined;
      await intercept(this, record);
    }
    const latest = this.records.get(record.key);
    if (!latest || latest.revision !== expectedRevision) {
      throw new PhraseBatchStateConflictError();
    }
    const revision = String(Number(expectedRevision) + 1);
    this.records.set(record.key, { record: structuredClone(record), revision });
    if (writesOwnedSha) await this.afterOwnedCommitWrite?.(this, record);
    return revision;
  }

  forceUpdate(key: string, mutate: (record: PhraseBatchRecord) => void): void {
    const current = this.records.get(key);
    if (!current) throw new Error(`Unknown batch ${key}`);
    const record = structuredClone(current.record);
    mutate(record);
    this.records.set(key, {
      record,
      revision: String(Number(current.revision) + 1),
    });
  }

  private addedOwnedSha(candidate: PhraseBatchRecord, current: PhraseBatchRecord): boolean {
    return Object.entries(candidate.locales).some(([locale, candidateRecord]) => {
      const currentShas = new Set(current.locales[locale]?.toolingCommitShas ?? []);
      return (candidateRecord.toolingCommitShas ?? []).some((sha) => !currentShas.has(sha));
    });
  }
}

class FakePhrase implements PhraseClient {
  createJobCalls = 0;
  targetBytes = initialTargetBytes;

  async createJob(input: { targetLangs: string[] }) {
    this.createJobCalls += 1;
    const jobs = input.targetLangs.map((targetLang) => ({
      uid: `job-${targetLang}-${this.createJobCalls}`,
      targetLang,
      workflowLevel: 1,
    }));
    return {
      asyncRequest: { id: `import-${this.createJobCalls}`, action: "IMPORT_JOB" as const },
      jobs,
      unsupportedFiles: [],
      warnings: [],
    };
  }

  async waitForAsyncRequest() {}

  async getJob(_projectUid: string, uid: string) {
    const targetLang = uid.split("-")[1]!;
    return {
      uid,
      targetLang,
      workflowLevel: 1,
      lastWorkflowLevel: 1,
      status: targetLang === "fr" ? "COMPLETED" : "REJECTED",
      importStatus: { status: "OK" as const },
    };
  }

  async listJobs() {
    return [];
  }

  async startTargetDownload(_projectUid: string, jobUid: string) {
    return `export-${jobUid}`;
  }

  async downloadTargetFile() {
    return this.targetBytes;
  }
}

class FakeGitHub {
  readonly baseCommit = "f".repeat(40);
  readonly refUpdates: { branch: string; sha: string }[] = [];
  readonly pullRequests = new Map<
    number,
    { branch: string; state: "open" | "closed"; merged: boolean }
  >();
  private readonly refs = new Map<string, string>();
  private readonly filesByCommit = new Map<string, Map<string, Uint8Array>>();
  private readonly commitTrees = new Map<string, string>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly treeEntries = new Map<string, { path: string; sha: string }[]>();
  private nextBlob = 0;
  private nextTree = 0;
  private nextCommit = 0;
  private nextPullRequest = 42;

  constructor() {
    this.refs.set("phrase-pilot", this.baseCommit);
    this.filesByCommit.set(this.baseCommit, new Map());
    this.commitTrees.set(this.baseCommit, "tree-base");
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const root = "/repos/example/app";

    if (path.startsWith(`${root}/git/ref/heads/`) && method === "GET") {
      const ref = path.slice(`${root}/git/ref/heads/`.length);
      const sha = this.refs.get(ref);
      return sha ? jsonResponse({ object: { sha } }) : jsonResponse({}, 404);
    }
    if (path === `${root}/git/refs` && method === "POST") {
      const body = readBody<{ ref: string; sha: string }>(init);
      const branch = body.ref.slice("refs/heads/".length);
      this.refs.set(branch, body.sha);
      return jsonResponse({ ref: body.ref }, 201);
    }
    if (path.startsWith(`${root}/git/refs/heads/`) && method === "PATCH") {
      const branch = path.slice(`${root}/git/refs/heads/`.length);
      const body = readBody<{ sha: string }>(init);
      this.refs.set(branch, body.sha);
      this.refUpdates.push({ branch, sha: body.sha });
      return jsonResponse({ ref: `refs/heads/${branch}` });
    }
    if (path.startsWith(`${root}/git/commits/`) && method === "GET") {
      const sha = path.slice(`${root}/git/commits/`.length);
      return jsonResponse({ sha, tree: { sha: this.commitTrees.get(sha) ?? "tree-unknown" } });
    }
    if (path === `${root}/git/blobs` && method === "POST") {
      const body = readBody<{ content: string }>(init);
      const sha = `blob-${++this.nextBlob}`;
      this.blobs.set(sha, new Uint8Array(Buffer.from(body.content, "base64")));
      return jsonResponse({ sha }, 201);
    }
    if (path === `${root}/git/trees` && method === "POST") {
      const body = readBody<{ tree: { path: string; sha: string }[] }>(init);
      const sha = `tree-${++this.nextTree}`;
      this.treeEntries.set(sha, body.tree);
      return jsonResponse({ sha }, 201);
    }
    if (path === `${root}/git/commits` && method === "POST") {
      const body = readBody<{ tree: string; parents: string[] }>(init);
      const parent = body.parents[0]!;
      const files = new Map(this.filesByCommit.get(parent) ?? []);
      for (const entry of this.treeEntries.get(body.tree) ?? []) {
        const content = this.blobs.get(entry.sha);
        if (content) files.set(entry.path, content);
      }
      const sha = (++this.nextCommit).toString(16).padStart(40, "0");
      this.filesByCommit.set(sha, files);
      this.commitTrees.set(sha, body.tree);
      return jsonResponse({ sha }, 201);
    }
    if (path.startsWith(`${root}/contents/`) && method === "GET") {
      const filePath = decodeURIComponent(path.slice(`${root}/contents/`.length));
      if (filePath === config.sourceCatalog.path) return fileResponse(sourceBytes);
      const ref = url.searchParams.get("ref") ?? "";
      const content = this.filesByCommit.get(ref)?.get(filePath);
      return content ? fileResponse(content) : jsonResponse({}, 404);
    }
    if (path === `${root}/pulls` && method === "GET") {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.startsWith("example:") ? head.slice("example:".length) : head;
      return jsonResponse(
        [...this.pullRequests.entries()]
          .filter(([, pullRequest]) => pullRequest.branch === branch)
          .map(([number, pullRequest]) => this.pullRequestResponse(number, pullRequest)),
      );
    }
    if (path === `${root}/pulls` && method === "POST") {
      const body = readBody<{ head: string }>(init);
      const number = this.nextPullRequest++;
      const pullRequest = { branch: body.head, state: "open" as const, merged: false };
      this.pullRequests.set(number, pullRequest);
      return jsonResponse(this.pullRequestResponse(number, pullRequest), 201);
    }
    if (path.startsWith(`${root}/pulls/`)) {
      const number = Number(path.slice(`${root}/pulls/`.length));
      const pullRequest = this.pullRequests.get(number);
      if (!pullRequest) return jsonResponse({}, 404);
      if (method === "PATCH") return jsonResponse({});
      if (method === "GET") return jsonResponse(this.pullRequestResponse(number, pullRequest));
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${url}`);
  };

  branchHead(branch: string): string | undefined {
    return this.refs.get(branch);
  }

  branchFile(branch: string, path: string): Uint8Array | undefined {
    const head = this.refs.get(branch);
    return head ? this.filesByCommit.get(head)?.get(path) : undefined;
  }

  closePullRequest(number: number): void {
    const pullRequest = this.pullRequests.get(number);
    if (pullRequest) pullRequest.state = "closed";
  }

  private pullRequestResponse(
    number: number,
    pullRequest: { branch: string; state: "open" | "closed"; merged: boolean },
  ) {
    const headSha = this.refs.get(pullRequest.branch);
    return {
      number,
      state: pullRequest.state,
      merged_at: pullRequest.merged ? "2026-10-15T00:00:00Z" : null,
      html_url: `https://github.com/example/app/pull/${number}`,
      head: headSha ? { sha: headSha, ref: pullRequest.branch } : undefined,
    };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileResponse(content: Uint8Array): Response {
  return jsonResponse({
    type: "file",
    sha: "file-blob",
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
  });
}

function readBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body ?? "{}")) as T;
}

async function createHarness() {
  const state = new RevisionedStateStore();
  const phrase = new FakePhrase();
  const github = new FakeGitHub();
  const repository = new GitHubPhraseRepository({
    repository: "example/app",
    token: "fake-token",
    stateBranch: "phrase-state",
    apiUrl: "https://api.github.test",
    fetch: github.fetch,
  });
  const workflow = new PhraseWorkflow({
    phrase,
    state,
    repository,
    catalogAdapters: new CatalogAdapterRegistry(),
  });
  const input: PhraseSubmitInput = {
    repository: "example/app",
    baseRef: "phrase-pilot",
    sourceCommit: "abc123",
    sourceBytes,
    config,
  };

  await workflow.submit(input);
  const initialResults = await workflow.reconcile();
  const [batchKey] = await state.listBatchKeys();
  const stored = batchKey ? await state.readBatch(batchKey) : undefined;
  const branch = stored?.record.locales.fr?.pullRequestBranch;
  const initialHead = branch ? github.branchHead(branch) : undefined;
  expect(initialResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phraseLocale: "fr", phase: "pr-created" }),
      expect.objectContaining({ phraseLocale: "de", phase: "failed" }),
    ]),
  );
  expect(stored?.record.phase).toBe("ready");
  expect(stored?.record.locales.fr?.toolingCommitSha).toBe(initialHead);
  expect(initialHead).toBeDefined();
  expect(github.pullRequests.size).toBe(1);

  return { state, phrase, github, workflow, input, batchKey: batchKey!, branch: branch! };
}

describe("PhraseWorkflow owned-SHA revision races", () => {
  it("aborts a parent write after a retry batch takes ownership, then lets the retry update the branch", async () => {
    const harness = await createHarness();
    const initialHead = harness.github.branchHead(harness.branch)!;
    harness.phrase.targetBytes = updatedTargetBytes;
    let retryBatch: PhraseBatchRecord | undefined;
    harness.state.beforeOwnedCommitWrite = async () => {
      retryBatch = await harness.workflow.submit({ ...harness.input, retryFailed: true });
    };

    const parentResults = await harness.workflow.reconcile();
    const parentAfterConflict = await harness.state.readBatch(harness.batchKey);

    expect(parentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchKey: harness.batchKey,
          phraseLocale: "fr",
          phase: "retrying",
          reason: expect.stringMatching(/delegat|handed off/i),
        }),
      ]),
    );
    expect(retryBatch).toBeDefined();
    expect(parentAfterConflict?.record.locales.fr?.pullRequestReexportDelegated).toBe(true);
    expect(retryBatch?.locales.fr?.toolingCommitShas).toEqual([initialHead]);
    expect(harness.github.branchHead(harness.branch)).toBe(initialHead);
    expect(harness.github.refUpdates).toHaveLength(0);

    const retryResults = await harness.workflow.reconcile();
    const retryStored = await harness.state.readBatch(retryBatch!.key);

    expect(retryResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchKey: retryBatch!.key,
          phraseLocale: "fr",
          phase: "pr-created",
        }),
      ]),
    );
    expect(harness.github.branchHead(harness.branch)).not.toBe(initialHead);
    expect(harness.github.refUpdates).toHaveLength(1);
    expect(
      new TextDecoder().decode(harness.github.branchFile(harness.branch, "locales/fr.json")),
    ).toContain("Salut {name}");
    expect(retryStored?.record.locales.fr?.toolingCommitSha).toBe(
      harness.github.branchHead(harness.branch),
    );
  });

  it("does not save or push a locale commit after a concurrent supersede", async () => {
    const harness = await createHarness();
    const initialHead = harness.github.branchHead(harness.branch)!;
    harness.phrase.targetBytes = updatedTargetBytes;
    harness.state.beforeOwnedCommitWrite = async (store) => {
      store.forceUpdate(harness.batchKey, (record) => {
        record.phase = "superseded";
        record.failureReason = "Source catalog changed concurrently";
      });
    };

    const results = await harness.workflow.reconcile();
    const stored = await harness.state.readBatch(harness.batchKey);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchKey: harness.batchKey,
          phraseLocale: "fr",
          phase: "retrying",
          reason: expect.stringMatching(/supersed/i),
        }),
      ]),
    );
    expect(stored?.record.phase).toBe("superseded");
    expect(stored?.record.locales.fr?.toolingCommitShas).toEqual([initialHead]);
    expect(harness.github.branchHead(harness.branch)).toBe(initialHead);
    expect(harness.github.refUpdates).toHaveLength(0);
  });

  it("rechecks eligibility after saving ownership and before updating the locale ref", async () => {
    const harness = await createHarness();
    const initialHead = harness.github.branchHead(harness.branch)!;
    harness.phrase.targetBytes = updatedTargetBytes;
    harness.state.afterOwnedCommitWrite = (store) => {
      store.afterOwnedCommitWrite = undefined;
      store.forceUpdate(harness.batchKey, (record) => {
        record.phase = "superseded";
        record.failureReason = "Source catalog changed after ownership was saved";
      });
    };

    const results = await harness.workflow.reconcile();
    const stored = await harness.state.readBatch(harness.batchKey);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchKey: harness.batchKey,
          phraseLocale: "fr",
          phase: "retrying",
          reason: expect.stringMatching(/supersed/i),
        }),
      ]),
    );
    expect(stored?.record.phase).toBe("superseded");
    expect(stored?.record.locales.fr?.toolingCommitSha).toBe(initialHead);
    expect(stored?.record.locales.fr?.toolingCommitShas).toHaveLength(2);
    expect(harness.github.branchHead(harness.branch)).toBe(initialHead);
    expect(harness.github.refUpdates).toHaveLength(0);
  });

  it("retries an owned-SHA save after an unrelated locale update", async () => {
    const harness = await createHarness();
    const initialHead = harness.github.branchHead(harness.branch)!;
    harness.phrase.targetBytes = updatedTargetBytes;
    harness.state.beforeOwnedCommitWrite = async (store) => {
      store.forceUpdate(harness.batchKey, (record) => {
        record.locales.de!.failureReason = "Independent locale update";
      });
    };

    const results = await harness.workflow.reconcile();
    const stored = await harness.state.readBatch(harness.batchKey);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchKey: harness.batchKey,
          phraseLocale: "fr",
          phase: "pr-created",
        }),
      ]),
    );
    expect(stored?.record.phase).toBe("ready");
    expect(stored?.record.locales.de?.failureReason).toBe("Independent locale update");
    expect(stored?.record.locales.fr?.toolingCommitSha).not.toBe(initialHead);
    expect(harness.github.branchHead(harness.branch)).toBe(
      stored?.record.locales.fr?.toolingCommitSha,
    );
    expect(harness.github.refUpdates).toHaveLength(1);
  });

  it("conditions a repeated retry handoff on the parent revision whose owned set it copied", async () => {
    const harness = await createHarness();
    const retry = await harness.workflow.submit({ ...harness.input, retryFailed: true });
    const concurrentHead = "e".repeat(40);
    harness.state.forceUpdate(retry.key, (record) => {
      record.retryParentDelegated = false;
    });
    harness.github.closePullRequest(42);
    harness.state.beforeUpdate = (store, candidate) => {
      const parent = store.readBatch(harness.batchKey);
      return parent.then((stored) => {
        const isParentCompareAndSwap =
          candidate.key === harness.batchKey &&
          JSON.stringify(candidate) === JSON.stringify(stored?.record);
        const isChildHandoffSave =
          candidate.key === retry.key && candidate.retryParentDelegated === true;
        if (!isParentCompareAndSwap && !isChildHandoffSave) return;
        store.beforeUpdate = undefined;
        store.forceUpdate(harness.batchKey, (record) => {
          record.locales.fr!.toolingCommitShas = [
            ...(record.locales.fr!.toolingCommitShas ?? []),
            concurrentHead,
          ];
        });
      });
    };

    await harness.workflow.reconcile();
    const retryAfterRace = await harness.state.readBatch(retry.key);

    if (retryAfterRace?.record.retryParentDelegated !== true) {
      await harness.workflow.reconcile();
    }
    const recoveredRetry = await harness.state.readBatch(retry.key);

    expect(recoveredRetry?.record.retryParentDelegated).toBe(true);
    expect(recoveredRetry?.record.locales.fr?.toolingCommitShas).toContain(concurrentHead);
  });
});
