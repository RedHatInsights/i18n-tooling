import { PhraseBatchStateConflictError, PhraseRepositoryError } from "./phrase-workflow.js";
import type {
  PhraseBatchRecord,
  PhraseBatchStateStore,
  PhraseLocalePullRequestCreated,
  PhraseLocalePullRequestUpdate,
  PhraseLocalePullRequestUpdateResult,
  PhraseLocalePullRequest,
  PhrasePullRequestState,
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
const API_PAGE_SIZE = 100;
const AUTHOR_HISTORY_PAGE_LIMIT = 5;
const MAX_ASSIGNEES = 10;

interface GitHubFile {
  sha: string;
  bytes: Uint8Array;
}

interface GitHubPullRequestResponse {
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  number?: number;
  head?: { sha?: string; ref?: string };
}

interface GitHubCompareResponse {
  ahead_by?: number;
  commits?: { sha?: string }[];
  files?: { filename?: string; previous_filename?: string }[];
}

type LocaleCommitWriteResult = { sha: string } | { finalized: "merged" | "closed" };

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

function commitAuthorLogin(commit: unknown): string | undefined {
  if (!isRecord(commit) || !isRecord(commit.author) || !nonEmptyString(commit.author.login)) {
    return undefined;
  }
  const login = commit.author.login.trim();
  if (commit.author.type === "Bot" || /\[bot\]$/i.test(login)) return undefined;
  return login;
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
  private readonly graphqlUrl: string;
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
    this.graphqlUrl = `${this.apiUrl.replace(/\/api\/v3$/, "/api")}/graphql`;
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

  async listSourceChangeAuthors(input: {
    path: string;
    headCommit: string;
    baseCommit?: string;
  }): Promise<string[]> {
    assertRepositoryPath(input.path);
    assertGitRef(input.headCommit);

    if (!input.baseCommit) {
      const commits = await this.listCommitsForPath(input.path, input.headCommit, 1);
      const login = commitAuthorLogin(commits[0]);
      return login ? [login] : [];
    }

    assertGitRef(input.baseCommit);
    const compareShas = new Set<string>();
    for (let page = 1; page <= AUTHOR_HISTORY_PAGE_LIMIT; page += 1) {
      const compareRef = encodeURIComponent(`${input.baseCommit}...${input.headCommit}`);
      const query = new URLSearchParams({ per_page: String(API_PAGE_SIZE), page: String(page) });
      const response = await this.request(
        `${this.repositoryPath}/compare/${compareRef}?${query.toString()}`,
        { method: "GET" },
      );
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.commits)) {
        throw new GitHubRepositoryError("GitHub returned an invalid commit comparison", 500);
      }
      for (const commit of value.commits) {
        if (isRecord(commit) && nonEmptyString(commit.sha)) compareShas.add(commit.sha);
      }
      if (value.commits.length < API_PAGE_SIZE) break;
    }
    if (!compareShas.size) return [];

    const logins: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= AUTHOR_HISTORY_PAGE_LIMIT; page += 1) {
      const commits = await this.listCommitsForPath(
        input.path,
        input.headCommit,
        API_PAGE_SIZE,
        page,
      );
      const matching = commits.filter(
        (commit) => isRecord(commit) && nonEmptyString(commit.sha) && compareShas.has(commit.sha),
      );
      if (!matching.length) break;
      for (const commit of matching) {
        const login = commitAuthorLogin(commit);
        if (!login || seen.has(login.toLowerCase())) continue;
        seen.add(login.toLowerCase());
        logins.push(login);
        if (logins.length === MAX_ASSIGNEES) return logins;
      }
      if (commits.length < API_PAGE_SIZE) break;
    }
    return logins;
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
    return (await this.createOrUpdatePullRequestWithCommit(input)).pullRequestUrl;
  }

  async addPullRequestAssignees(pullRequestUrl: string, logins: string[]): Promise<string[]> {
    const number = this.pullRequestNumber(pullRequestUrl);
    const uniqueLogins: string[] = [];
    const seen = new Set<string>();
    for (const candidate of logins) {
      const login = candidate.trim();
      const normalized = login.toLowerCase();
      if (!login || seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueLogins.push(login);
      if (uniqueLogins.length === MAX_ASSIGNEES) break;
    }
    if (!uniqueLogins.length) return [];
    const requestedLogins = new Set(uniqueLogins.map((login) => login.toLowerCase()));

    const response = await this.request(`${this.repositoryPath}/issues/${number}/assignees`, {
      method: "POST",
      body: JSON.stringify({ assignees: uniqueLogins }),
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.assignees)) {
      throw new GitHubRepositoryError("GitHub returned an invalid pull request assignee list", 500);
    }
    const assigned: string[] = [];
    const assignedLogins = new Set<string>();
    for (const assignee of value.assignees) {
      if (!isRecord(assignee) || !nonEmptyString(assignee.login)) continue;
      const login = assignee.login.trim();
      const normalizedLogin = login.toLowerCase();
      if (!requestedLogins.has(normalizedLogin) || assignedLogins.has(normalizedLogin)) continue;
      assignedLogins.add(normalizedLogin);
      assigned.push(login);
    }
    return assigned;
  }

  async getPullRequestState(pullRequestUrl: string): Promise<PhrasePullRequestState> {
    const number = this.pullRequestNumber(pullRequestUrl);
    const response = await this.request(`${this.repositoryPath}/pulls/${number}`, {
      method: "GET",
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.state !== "string") {
      throw new GitHubRepositoryError("GitHub returned an invalid pull request response", 500);
    }
    if (value.merged_at) return { state: "merged" };
    if (value.state === "closed") return { state: "closed" };
    if (value.state !== "open" || !isRecord(value.head) || !nonEmptyString(value.head.sha)) {
      throw new GitHubRepositoryError("GitHub returned an invalid open pull request head", 500);
    }
    return { state: "open", headSha: value.head.sha };
  }

  async closePullRequest(pullRequestUrl: string): Promise<void> {
    const number = this.pullRequestNumber(pullRequestUrl);
    await this.request(this.repositoryPath + "/pulls/" + number, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  async createOrUpdatePullRequestWithCommit(
    input: PhraseLocalePullRequest,
  ): Promise<PhraseLocalePullRequestCreated> {
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
    if (merged?.html_url)
      return {
        pullRequestUrl: merged.html_url,
        ...(nonEmptyString(merged.head?.sha) ? { toolingCommitSha: merged.head.sha } : {}),
        pullRequestFinalized: true,
        pullRequestMerged: true,
      };
    const closed = existing.find(
      (pullRequest) =>
        pullRequest.state === "closed" && !pullRequest.merged_at && pullRequest.html_url,
    );
    if (closed?.html_url) {
      return {
        pullRequestUrl: closed.html_url,
        ...(nonEmptyString(closed.head?.sha) ? { toolingCommitSha: closed.head.sha } : {}),
        pullRequestFinalized: true,
      };
    }
    if (existing.some((pullRequest) => pullRequest.state === "closed")) {
      throw new GitHubRepositoryError(
        `A previous Phrase pull request for ${input.branch} was closed without merging; reopen it or delete the branch`,
        409,
        true,
      );
    }

    const files = [{ path: input.path, content: input.content }, ...(input.additionalFiles ?? [])];
    const branchHead = await this.getReference(input.branch);
    let open = existing.find((pullRequest) => pullRequest.state === "open" && pullRequest.html_url);
    if (open && !branchHead) {
      throw new GitHubRepositoryError("Open Phrase pull request has no locale branch head", 409);
    }
    if (
      branchHead &&
      !(await this.isToolingOwned(
        input.baseRef,
        input.branch,
        branchHead,
        files,
        input.expectedToolingCommitShas,
        input.expectedToolingCommitSha,
        input.expectedPendingToolingCommitSha,
      ))
    ) {
      throw new GitHubRepositoryError(
        `Phrase locale branch ${input.branch} is not tooling-owned; refusing to overwrite reviewer changes`,
        409,
      );
    }
    let pullRequestCreated = false;
    // An existing branch may acquire a ready PR after discovery. Establish or adopt
    // its draft PR before changing invalid content, including the POST/422 race.
    if (!open && branchHead && input.draft) {
      await input.recheckOwnedCommitEligibility?.(branchHead);
      const created = await this.createDraftPullRequest(input);
      pullRequestCreated = !created.adopted;
      open = { html_url: created.pullRequestUrl, state: "open" };
    }
    if (input.draft && open?.html_url) await this.ensurePullRequestDraft(open.html_url);
    const openPullRequestUrl = open?.html_url;
    const changedFiles = await this.changedFiles(files, branchHead);
    let toolingCommitSha = branchHead ?? input.baseCommit;
    if (changedFiles.length) {
      const commitResult = await this.writeLocaleCommit(
        input.branch,
        toolingCommitSha,
        changedFiles,
        branchHead === null,
        input.recordToolingCommitSha,
        input.recheckOwnedCommitEligibility,
        openPullRequestUrl
          ? () => this.pullRequestIsOpenAtHead(openPullRequestUrl, toolingCommitSha)
          : undefined,
      );
      if ("finalized" in commitResult) {
        return {
          pullRequestUrl: open!.html_url!,
          ...(pullRequestCreated ? { pullRequestCreated: true } : {}),
          toolingCommitSha,
          pullRequestFinalized: true,
          ...(commitResult.finalized === "merged" ? { pullRequestMerged: true } : {}),
        };
      }
      toolingCommitSha = commitResult.sha;
    }
    if (!open?.html_url) {
      const created = await this.createDraftPullRequest(input);
      pullRequestCreated = !created.adopted;
      if (!created.adopted) {
        return {
          pullRequestUrl: created.pullRequestUrl,
          pullRequestCreated: true,
          toolingCommitSha,
        };
      }
      open = { html_url: created.pullRequestUrl, state: "open" };
    }
    const pullRequestUrl = open.html_url!;
    try {
      const bodyUpdated = await this.updatePullRequestBody(pullRequestUrl, input.body, input.title);
      return {
        pullRequestUrl,
        ...(pullRequestCreated ? { pullRequestCreated: true } : {}),
        toolingCommitSha,
        ...(!bodyUpdated ? { pullRequestFinalized: true } : {}),
      };
    } catch (bodyError) {
      return {
        pullRequestUrl,
        ...(pullRequestCreated ? { pullRequestCreated: true } : {}),
        toolingCommitSha,
        bodyError,
      };
    }
  }

  private async createDraftPullRequest(
    input: PhraseLocalePullRequest,
  ): Promise<{ pullRequestUrl: string; adopted: boolean }> {
    try {
      const response = await this.request(`${this.repositoryPath}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.branch,
          base: input.baseRef,
          draft: true,
        }),
      });
      const value: unknown = await response.json();
      if (!isRecord(value) || !nonEmptyString(value.html_url)) {
        throw new GitHubRepositoryError(
          "GitHub returned an invalid pull request response",
          response.status,
        );
      }
      return { pullRequestUrl: value.html_url, adopted: false };
    } catch (error) {
      if (!(error instanceof GitHubRepositoryError) || error.status !== 422) throw error;
      const raced = await this.findPullRequests(input.branch, input.baseRef);
      const open = raced.find(
        (pullRequest) => pullRequest.state === "open" && pullRequest.html_url,
      );
      if (!open?.html_url) {
        throw new GitHubRepositoryError(
          "GitHub rejected draft PR creation (HTTP 422). Delivery requires draft pull request support; check the repository plan and branch diff. No ready-PR fallback is allowed.",
          422,
        );
      }
      // A conversion failure is a delivery failure, not a description-only error.
      if (input.draft) await this.ensurePullRequestDraft(open.html_url);
      return { pullRequestUrl: open.html_url, adopted: true };
    }
  }

  async updateOpenPullRequest(
    input: PhraseLocalePullRequestUpdate,
  ): Promise<PhraseLocalePullRequestUpdateResult> {
    if (input.repository !== `${this.owner}/${this.name}`) {
      throw new TypeError("Phrase PR repository does not match the GitHub token repository");
    }
    assertGitRef(input.baseRef);
    assertGitRef(input.branch);
    this.pullRequestNumber(input.pullRequestUrl);
    if (!nonEmptyString(input.headSha)) {
      throw new GitHubRepositoryError("GitHub returned an invalid open pull request head", 500);
    }
    const pullRequestState = await this.getPullRequestState(input.pullRequestUrl);
    if (pullRequestState.state !== "open") {
      return {
        changed: false,
        toolingCommitSha: input.expectedToolingCommitSha ?? input.headSha,
        bodyUpdated: false,
        pullRequestFinalized: true,
        ...(pullRequestState.state === "merged" ? { pullRequestMerged: true } : {}),
      };
    }
    if (pullRequestState.headSha !== input.headSha) {
      throw new GitHubRepositoryError(
        `Phrase locale branch ${input.branch} moved during re-export; retrying from its current head`,
        409,
      );
    }
    const headSha = pullRequestState.headSha;
    const files = [{ path: input.path, content: input.content }, ...(input.additionalFiles ?? [])];
    if (
      !(await this.isToolingOwned(
        input.baseRef,
        input.branch,
        headSha,
        files,
        input.expectedToolingCommitShas,
        input.expectedToolingCommitSha,
        input.expectedPendingToolingCommitSha,
      ))
    ) {
      throw new GitHubRepositoryError(
        `Phrase locale branch ${input.branch} is not tooling-owned; refusing to overwrite reviewer changes`,
        409,
      );
    }

    if (input.draft) await this.ensurePullRequestDraft(input.pullRequestUrl);
    const changedFiles = await this.changedFiles(files, headSha);
    if (!changedFiles.length) {
      return {
        changed: false,
        toolingCommitSha: headSha,
        bodyUpdated: false,
      };
    }

    const commitResult = await this.writeLocaleCommit(
      input.branch,
      headSha,
      changedFiles,
      false,
      input.recordToolingCommitSha,
      input.recheckOwnedCommitEligibility,
      () => this.pullRequestIsOpenAtHead(input.pullRequestUrl, headSha),
    );
    if ("finalized" in commitResult) {
      return {
        changed: false,
        toolingCommitSha: headSha,
        bodyUpdated: false,
        pullRequestFinalized: true,
        ...(commitResult.finalized === "merged" ? { pullRequestMerged: true } : {}),
      };
    }
    const toolingCommitSha = commitResult.sha;
    try {
      const bodyUpdated = await this.updatePullRequestBody(
        input.pullRequestUrl,
        input.body,
        input.title,
      );
      return {
        changed: true,
        toolingCommitSha,
        bodyUpdated,
        ...(!bodyUpdated ? { pullRequestFinalized: true } : {}),
      };
    } catch (bodyError) {
      return { changed: true, toolingCommitSha, bodyUpdated: false, bodyError };
    }
  }

  /** Draft conversion must succeed before invalid content reaches an existing PR. */
  private async ensurePullRequestDraft(pullRequestUrl: string): Promise<void> {
    const number = this.pullRequestNumber(pullRequestUrl);
    const response = await this.request(`${this.repositoryPath}/pulls/${number}`, {
      method: "GET",
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || value.state !== "open" || value.merged_at) {
      throw new GitHubRepositoryError(
        "Phrase pull request is no longer open; retry reconciliation",
        409,
      );
    }
    if (value.draft === true) return;
    if (!nonEmptyString(value.node_id)) {
      throw new GitHubRepositoryError(
        "GitHub returned no pull request node ID for draft conversion",
        500,
      );
    }
    const converted = await this.request("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: value.node_id },
      }),
    });
    const result: unknown = await converted.json();
    if (
      !isRecord(result) ||
      result.errors ||
      !isRecord(result.data) ||
      !isRecord(result.data.convertPullRequestToDraft) ||
      !isRecord(result.data.convertPullRequestToDraft.pullRequest) ||
      result.data.convertPullRequestToDraft.pullRequest.isDraft !== true
    ) {
      throw new GitHubRepositoryError(
        "GitHub did not confirm draft conversion; invalid content was not written",
        500,
      );
    }
  }

  async updatePullRequestBody(
    pullRequestUrl: string,
    body: string,
    title?: string,
  ): Promise<boolean> {
    const number = this.pullRequestNumber(pullRequestUrl);
    const state = await this.getPullRequestState(pullRequestUrl);
    if (state.state !== "open") return false;
    await this.request(`${this.repositoryPath}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ ...(title === undefined ? {} : { title }), body }),
    });
    return true;
  }

  async findLatestBotPullRequestComment(
    pullRequestUrl: string,
    bodyPrefix: string,
  ): Promise<string | undefined> {
    const number = this.pullRequestNumber(pullRequestUrl);
    // This endpoint ignores sort parameters and lists oldest first, so the last match wins.
    let latest: string | undefined;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      const response = await this.request(
        `${this.repositoryPath}/issues/${number}/comments?${query.toString()}`,
        { method: "GET" },
      );
      const value: unknown = await response.json();
      if (!Array.isArray(value)) {
        throw new GitHubRepositoryError(
          "GitHub returned an invalid pull request comment list",
          500,
        );
      }
      // Actor lookup needs a separate API call, so report ownership uses GitHub's Bot author type.
      for (const comment of value) {
        if (
          isRecord(comment) &&
          typeof comment.body === "string" &&
          comment.body.startsWith(bodyPrefix) &&
          isRecord(comment.user) &&
          comment.user.type === "Bot"
        ) {
          latest = comment.body;
        }
      }
      if (value.length < 100) return latest;
    }
  }

  async createPullRequestComment(pullRequestUrl: string, body: string): Promise<boolean> {
    const number = this.pullRequestNumber(pullRequestUrl);
    const state = await this.getPullRequestState(pullRequestUrl);
    if (state.state !== "open") return false;
    await this.request(`${this.repositoryPath}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return true;
  }

  private async pullRequestIsOpenAtHead(
    pullRequestUrl: string,
    expectedHeadSha: string,
  ): Promise<PhrasePullRequestState> {
    const state = await this.getPullRequestState(pullRequestUrl);
    if (state.state !== "open") return state;
    if (state.headSha !== expectedHeadSha) {
      throw new GitHubRepositoryError(
        "Phrase locale branch moved while applying the update; refusing to overwrite reviewer changes",
        409,
      );
    }
    return state;
  }

  private pullRequestNumber(pullRequestUrl: string): number {
    let url: URL;
    try {
      url = new URL(pullRequestUrl);
    } catch {
      throw new TypeError("Phrase pull request URL is invalid");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const [owner, repository, resource, number] = segments;
    if (
      owner?.toLowerCase() !== this.owner.toLowerCase() ||
      repository?.toLowerCase() !== this.name.toLowerCase() ||
      resource !== "pull" ||
      !number ||
      !/^\d+$/.test(number)
    ) {
      throw new TypeError("Phrase pull request URL does not match the GitHub repository");
    }
    return Number(number);
  }

  private async changedFiles(
    files: { path: string; content: Uint8Array }[],
    branchHead: string | null,
  ): Promise<{ path: string; content: Uint8Array }[]> {
    if (!branchHead) return files;
    const changed: { path: string; content: Uint8Array }[] = [];
    for (const file of files) {
      const current = await this.getFile(file.path, branchHead);
      if (!current || !Buffer.from(current.bytes).equals(Buffer.from(file.content))) {
        changed.push(file);
      }
    }
    return changed;
  }

  private async isToolingOwned(
    baseRef: string,
    branch: string,
    headSha: string,
    files: { path: string; content: Uint8Array }[],
    expectedToolingCommitShas?: string[],
    expectedToolingCommitSha?: string,
    expectedPendingToolingCommitSha?: string,
  ): Promise<boolean> {
    const ownedShas = new Set(
      [
        ...(Array.isArray(expectedToolingCommitShas) ? expectedToolingCommitShas : []),
        expectedToolingCommitSha,
        expectedPendingToolingCommitSha,
      ].filter(nonEmptyString),
    );
    if (ownedShas.size) {
      return ownedShas.has(headSha);
    }

    return this.isSingleToolingCommit(
      baseRef,
      branch,
      headSha,
      new Set(files.map(({ path }) => path)),
    );
  }

  private async isSingleToolingCommit(
    baseRef: string,
    branch: string,
    headSha: string,
    expectedPaths: Set<string>,
  ): Promise<boolean> {
    const compare = await this.compareCommits(baseRef, branch);
    const changedFiles = compare.files;
    return (
      compare.ahead_by === 1 &&
      compare.commits?.length === 1 &&
      compare.commits[0]?.sha === headSha &&
      changedFiles !== undefined &&
      changedFiles.length > 0 &&
      changedFiles.every((file) => this.isExpectedFileChange(file, expectedPaths))
    );
  }

  private async listCommitsForPath(
    path: string,
    headCommit: string,
    perPage: number,
    page?: number,
  ): Promise<unknown[]> {
    const query = new URLSearchParams({
      sha: headCommit,
      path,
      per_page: String(perPage),
      ...(page === undefined ? {} : { page: String(page) }),
    });
    const response = await this.request(`${this.repositoryPath}/commits?${query.toString()}`, {
      method: "GET",
    });
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new GitHubRepositoryError("GitHub returned an invalid path commit list", 500);
    }
    return value;
  }

  private async compareCommits(base: string, head: string): Promise<GitHubCompareResponse> {
    const compareRef = encodeURIComponent(`${base}...${head}`);
    const response = await this.request(`${this.repositoryPath}/compare/${compareRef}`, {
      method: "GET",
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.commits) || !Array.isArray(value.files)) {
      throw new GitHubRepositoryError("GitHub returned an invalid commit comparison", 500);
    }
    return value as GitHubCompareResponse;
  }

  private isExpectedFileChange(
    file: { filename?: string; previous_filename?: string },
    expectedPaths: Set<string>,
  ): boolean {
    return (
      nonEmptyString(file.filename) &&
      expectedPaths.has(file.filename) &&
      (!file.previous_filename || expectedPaths.has(file.previous_filename))
    );
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
    recordToolingCommitSha: (toolingSha: string, previousHeadSha: string | null) => Promise<void>,
    recheckOwnedCommitEligibility?: (previousHeadSha: string | null) => Promise<void>,
    beforeRefUpdate?: () => Promise<PhrasePullRequestState>,
  ): Promise<LocaleCommitWriteResult> {
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
    if (!createRef) {
      const currentHead = await this.getReference(branch);
      if (currentHead !== parent) {
        throw new GitHubRepositoryError(
          `Phrase locale branch ${branch} moved before the update; refusing to overwrite reviewer changes`,
          409,
        );
      }
      if (beforeRefUpdate) {
        const pullRequestState = await beforeRefUpdate();
        if (pullRequestState.state !== "open") return { finalized: pullRequestState.state };
      }
    }
    await recordToolingCommitSha(commitValue.sha, createRef ? null : parent);
    const refInit: RequestInit = createRef
      ? {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitValue.sha }),
        }
      : {
          method: "PATCH",
          body: JSON.stringify({ sha: commitValue.sha, force: false }),
        };
    if (!createRef) await recheckOwnedCommitEligibility?.(parent);
    try {
      await this.request(refPath, refInit);
    } catch (error) {
      if (
        error instanceof GitHubRepositoryError &&
        (error.status === 409 || error.status === 422)
      ) {
        throw new GitHubRepositoryError(
          `Phrase locale branch ${branch} changed while applying the update; refusing to overwrite reviewer changes`,
          error.status,
        );
      }
      throw error;
    }
    return { sha: commitValue.sha };
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
      // GitHub Enterprise serves REST at /api/v3 but GraphQL at /api/graphql.
      const url = path === "/graphql" ? this.graphqlUrl : `${this.apiUrl}${path}`;
      response = await this.fetcher(url, {
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
