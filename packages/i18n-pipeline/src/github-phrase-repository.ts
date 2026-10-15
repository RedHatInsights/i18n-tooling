import { PhraseBatchStateConflictError, PhraseRepositoryError } from "./phrase-workflow.js";
import type {
  PhraseBatchRecord,
  PhraseBatchStateStore,
  PhraseLocalePullRequest,
  PhraseWorkflowRepository,
  StoredPhraseBatch,
} from "./phrase-workflow.js";

export interface GitHubPhraseRepositoryOptions {
  repository: string;
  token: string;
  stateBranch: string;
  stateDirectory?: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

/** State writes retried when GitHub rejects them only because the branch head moved. */
const STATE_WRITE_ATTEMPTS = 3;

interface GitHubFile {
  sha: string;
  bytes: Uint8Array;
}

interface GitHubPullRequestResponse {
  html_url?: string;
  state?: string;
  merged_at?: string | null;
}

export class GitHubRepositoryError extends PhraseRepositoryError {
  constructor(message: string, status: number, permanent = false) {
    super(message, status, permanent);
    this.name = "GitHubRepositoryError";
  }
}

// Both are fixed outside the run (workflow permissions, token rotation), then a rerun succeeds.
const TOKEN_HINTS: ReadonlyMap<number, string> = new Map([
  [401, ": the token is missing, expired or revoked"],
  [
    403,
    ": the token may not make this request; state and locale branches need contents: write, pull requests need pull-requests: write",
  ],
]);

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function fileBytes(value: unknown): GitHubFile | null {
  if (!isRecord(value) || value.type !== "file" || !nonEmptyString(value.sha)) return null;
  if (typeof value.content !== "string" || value.encoding !== "base64") {
    throw new Error("GitHub returned an unsupported file representation");
  }
  return {
    sha: value.sha,
    bytes: new Uint8Array(Buffer.from(value.content.replace(/\s/g, ""), "base64")),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRepositoryPath(path: string): void {
  if (
    !nonEmptyString(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new TypeError(
      "GitHub content paths must be repository-relative and cannot traverse parents",
    );
  }
}

function assertGitRef(ref: string): void {
  if (
    !nonEmptyString(ref) ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.includes("..") ||
    ref.includes("\\") ||
    [" ", "~", "^", ":", "?", "*", "["].some((character) => ref.includes(character)) ||
    ref.includes("@{")
  ) {
    throw new TypeError("Invalid Git ref name");
  }
}

export class GitHubPhraseRepository implements PhraseBatchStateStore, PhraseWorkflowRepository {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly apiUrl: string;
  private readonly stateDirectory: string;
  private readonly repositoryPath: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(private readonly options: GitHubPhraseRepositoryOptions) {
    const [owner, name, ...extra] = options.repository.split("/");
    if (!owner || !name || extra.length)
      throw new TypeError("GitHub repository must be owner/name");
    if (!nonEmptyString(options.token)) throw new TypeError("GitHub token is required");
    if (!nonEmptyString(options.stateBranch))
      throw new TypeError("GitHub state branch is required");
    this.owner = owner;
    this.name = name;
    this.repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const stateDirectory = options.stateDirectory ?? ".github/i18n-state/batches";
    assertGitRef(options.stateBranch);
    assertRepositoryPath(stateDirectory);
    this.stateDirectory = stateDirectory.replace(/\/+$/g, "");
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async readFile(path: string, ref: string): Promise<Uint8Array | null> {
    const file = await this.getFile(path, ref);
    return file?.bytes ?? null;
  }

  async resolveCommit(ref: string): Promise<string> {
    assertGitRef(ref);
    const sha = await this.getReference(ref);
    if (!sha) throw new GitHubRepositoryError(`GitHub base branch does not exist: ${ref}`, 404);
    return sha;
  }

  async readBatch(key: string): Promise<StoredPhraseBatch | undefined> {
    const file = await this.getFile(this.batchPath(key), this.options.stateBranch);
    if (!file) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(file.bytes)) as unknown;
    } catch {
      throw new GitHubRepositoryError("Phrase state file is not valid JSON", 500);
    }
    if (!isRecord(value) || value.schema !== 1 || value.key !== key) {
      throw new GitHubRepositoryError("Phrase state file has an invalid schema or key", 500);
    }
    return { record: value as unknown as PhraseBatchRecord, revision: file.sha };
  }

  /**
   * Lists batch keys without reading them, so the workflow can isolate a corrupt record to its
   * own batch. The contents API lists at most 1,000 entries per directory.
   */
  async listBatchKeys(): Promise<string[]> {
    const response = await this.request(
      `${this.repositoryPath}/contents/${encodePath(this.stateDirectory)}?ref=${encodeURIComponent(this.options.stateBranch)}`,
      { method: "GET" },
      true,
    );
    if (response.status === 404) return [];
    const entries: unknown = await response.json();
    if (!Array.isArray(entries))
      throw new GitHubRepositoryError("GitHub returned an invalid state directory", 500);
    return entries
      .filter(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) &&
          entry.type === "file" &&
          typeof entry.name === "string" &&
          /^[a-f0-9]{64}\.json$/.test(entry.name),
      )
      .map((entry) => (entry.name as string).slice(0, -5))
      .sort();
  }

  async createBatch(record: PhraseBatchRecord): Promise<string> {
    await this.ensureBranch(this.options.stateBranch, record.baseRef);
    return this.writeState(
      record,
      undefined,
      `i18n: record Phrase batch ${record.key.slice(0, 12)}`,
    );
  }

  async updateBatch(record: PhraseBatchRecord, expectedRevision: string): Promise<string> {
    return this.writeState(
      record,
      expectedRevision,
      `i18n: update Phrase batch ${record.key.slice(0, 12)}`,
    );
  }

  /**
   * Compare-and-swap on the state file's blob SHA. Concurrent submit and reconcile runs commit
   * different files to the same branch, and GitHub then answers 409 because the branch head
   * moved; retry only while the file itself still has the expected revision.
   */
  private async writeState(
    record: PhraseBatchRecord,
    expectedRevision: string | undefined,
    message: string,
  ): Promise<string> {
    const path = this.batchPath(record.key);
    const content = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.getFile(path, this.options.stateBranch);
      if ((current?.sha ?? undefined) !== expectedRevision)
        throw new PhraseBatchStateConflictError();
      try {
        const result = await this.putFile(
          path,
          content,
          this.options.stateBranch,
          message,
          expectedRevision,
        );
        return result.sha;
      } catch (error) {
        const conflict =
          error instanceof GitHubRepositoryError && (error.status === 409 || error.status === 422);
        if (!conflict) throw error;
        if (attempt >= STATE_WRITE_ATTEMPTS) throw new PhraseBatchStateConflictError();
      }
    }
  }

  async createOrUpdatePullRequest(input: PhraseLocalePullRequest): Promise<string> {
    if (input.repository !== `${this.owner}/${this.name}`) {
      throw new TypeError("Phrase PR repository does not match the GitHub token repository");
    }
    assertGitRef(input.baseRef);
    assertGitRef(input.branch);
    if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) {
      throw new TypeError("Phrase PR base commit must be a full commit SHA");
    }
    const existing = await this.findPullRequests(input.branch, input.baseRef);
    const merged = existing.find((pullRequest) => pullRequest.merged_at && pullRequest.html_url);
    if (merged?.html_url) return merged.html_url;
    if (existing.some((pullRequest) => pullRequest.state === "closed")) {
      throw new GitHubRepositoryError(
        `A previous Phrase pull request for ${input.branch} was closed without merging; reopen it or delete the branch`,
        409,
        true,
      );
    }

    const files = [{ path: input.path, content: input.content }, ...(input.additionalFiles ?? [])];
    const branchHead = await this.getReference(input.branch);
    const changedFiles: { path: string; content: Uint8Array }[] = [];
    if (branchHead) {
      for (const file of files) {
        const current = await this.getFile(file.path, branchHead);
        if (!current || !Buffer.from(current.bytes).equals(Buffer.from(file.content))) {
          changedFiles.push(file);
        }
      }
    } else {
      changedFiles.push(...files);
    }
    if (changedFiles.length) {
      // On retry, branchHead can include intervening base edits; the inlined YAML is rebuilt from
      // baseCommit, so the identical template hunks merge cleanly with that parent.
      await this.writeLocaleCommit(
        input.branch,
        branchHead ?? input.baseCommit,
        changedFiles,
        branchHead === null,
      );
    }
    const open = existing.find(
      (pullRequest) => pullRequest.state === "open" && pullRequest.html_url,
    );
    if (open?.html_url) return open.html_url;

    try {
      const response = await this.request(`${this.repositoryPath}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.branch,
          base: input.baseRef,
        }),
      });
      const value: unknown = await response.json();
      if (!isRecord(value) || !nonEmptyString(value.html_url)) {
        throw new GitHubRepositoryError(
          "GitHub returned an invalid pull request response",
          response.status,
        );
      }
      return value.html_url;
    } catch (error) {
      if (error instanceof GitHubRepositoryError && error.status === 422) {
        const raced = await this.findPullRequests(input.branch, input.baseRef);
        const open = raced.find(
          (pullRequest) => pullRequest.state === "open" && pullRequest.html_url,
        );
        if (open?.html_url) return open.html_url;
      }
      throw error;
    }
  }

  private batchPath(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new TypeError("Phrase batch key must be a SHA-256 digest");
    return `${this.stateDirectory}/${key}.json`;
  }

  private async getFile(path: string, ref: string): Promise<GitHubFile | null> {
    assertRepositoryPath(path);
    assertGitRef(ref);
    const response = await this.request(
      `${this.repositoryPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      { method: "GET" },
      true,
    );
    if (response.status === 404) return null;
    const value: unknown = await response.json();
    return fileBytes(value);
  }

  private async putFile(
    path: string,
    bytes: Uint8Array,
    branch: string,
    message: string,
    sha?: string,
  ): Promise<{ sha: string }> {
    assertRepositoryPath(path);
    assertGitRef(branch);
    const response = await this.request(`${this.repositoryPath}/contents/${encodePath(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(bytes).toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.content) || !nonEmptyString(value.content.sha)) {
      throw new GitHubRepositoryError(
        "GitHub returned an invalid contents response",
        response.status,
      );
    }
    return { sha: value.content.sha };
  }

  private async writeLocaleCommit(
    branch: string,
    parent: string,
    files: { path: string; content: Uint8Array }[],
    createRef: boolean,
  ): Promise<void> {
    const baseTree = await this.getCommitTree(parent);
    const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const file of files) {
      assertRepositoryPath(file.path);
      const response = await this.request(`${this.repositoryPath}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        }),
      });
      const value: unknown = await response.json();
      if (!isRecord(value) || !nonEmptyString(value.sha)) {
        throw new GitHubRepositoryError(
          "GitHub returned an invalid git blob response",
          response.status,
        );
      }
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: value.sha });
    }

    const treeResponse = await this.request(`${this.repositoryPath}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTree, tree: entries }),
    });
    const treeValue: unknown = await treeResponse.json();
    if (!isRecord(treeValue) || !nonEmptyString(treeValue.sha)) {
      throw new GitHubRepositoryError(
        "GitHub returned an invalid git tree response",
        treeResponse.status,
      );
    }

    const commitResponse = await this.request(`${this.repositoryPath}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `i18n: update Phrase translations for ${branch}`,
        tree: treeValue.sha,
        parents: [parent],
      }),
    });
    const commitValue: unknown = await commitResponse.json();
    if (!isRecord(commitValue) || !nonEmptyString(commitValue.sha)) {
      throw new GitHubRepositoryError(
        "GitHub returned an invalid git commit response",
        commitResponse.status,
      );
    }

    const refPath = createRef
      ? `${this.repositoryPath}/git/refs`
      : `${this.repositoryPath}/git/refs/heads/${encodeRefPath(branch)}`;
    const refInit: RequestInit = createRef
      ? {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitValue.sha }),
        }
      : {
          method: "PATCH",
          body: JSON.stringify({ sha: commitValue.sha, force: false }),
        };
    try {
      await this.request(refPath, refInit);
    } catch (error) {
      if (
        error instanceof GitHubRepositoryError &&
        (error.status === 409 || error.status === 422)
      ) {
        throw new PhraseBatchStateConflictError("Phrase locale branch changed concurrently");
      }
      throw error;
    }
  }

  private async getCommitTree(commit: string): Promise<string> {
    const response = await this.request(
      `${this.repositoryPath}/git/commits/${encodeURIComponent(commit)}`,
      { method: "GET" },
    );
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.tree) || !nonEmptyString(value.tree.sha)) {
      throw new GitHubRepositoryError(
        "GitHub returned an invalid git commit tree",
        response.status,
      );
    }
    return value.tree.sha;
  }

  private async ensureBranch(branch: string, baseRef: string): Promise<void> {
    assertGitRef(branch);
    assertGitRef(baseRef);
    const existing = await this.getReference(branch);
    if (existing) return;
    const base = await this.getReference(baseRef);
    if (!base)
      throw new GitHubRepositoryError(`GitHub base branch does not exist: ${baseRef}`, 404);
    try {
      await this.request(`${this.repositoryPath}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }),
      });
    } catch (error) {
      if (!(error instanceof GitHubRepositoryError && error.status === 422)) throw error;
      if (!(await this.getReference(branch))) throw error;
    }
  }

  private async getReference(branch: string): Promise<string | null> {
    assertGitRef(branch);
    const response = await this.request(
      `${this.repositoryPath}/git/ref/heads/${encodeRefPath(branch)}`,
      { method: "GET" },
      true,
    );
    if (response.status === 404) return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.object) || !nonEmptyString(value.object.sha)) {
      throw new GitHubRepositoryError("GitHub returned an invalid git reference", response.status);
    }
    return value.object.sha;
  }

  private async findPullRequests(
    branch: string,
    base: string,
  ): Promise<GitHubPullRequestResponse[]> {
    const head = `${this.owner}:${branch}`;
    const query = new URLSearchParams({ head, base, state: "all", per_page: "100" });
    const response = await this.request(`${this.repositoryPath}/pulls?${query.toString()}`, {
      method: "GET",
    });
    const value: unknown = await response.json();
    if (!Array.isArray(value))
      throw new GitHubRepositoryError("GitHub returned an invalid pull request list", 500);
    return value.filter(isRecord) as GitHubPullRequestResponse[];
  }

  private async request(path: string, init: RequestInit, allowNotFound = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    } catch {
      throw new GitHubRepositoryError("Could not reach GitHub API", 0);
    }
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new GitHubRepositoryError(
        `GitHub API returned HTTP ${response.status}${TOKEN_HINTS.get(response.status) ?? ""}`,
        response.status,
      );
    }
    return response;
  }
}
