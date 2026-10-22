import { describe, expect, it } from "vitest";
import { GitHubPhraseRepository, GitHubRepositoryError } from "../src/github-phrase-repository.js";
import {
  PhraseBatchStateConflictError,
  type PhraseBatchRecord,
  type PhraseLocalePullRequest,
  type PhraseLocalePullRequestUpdate,
} from "../src/phrase-workflow.js";

const baseCommitSha = "a".repeat(40);
const noToolingCommitWrite = async (_pendingSha: string, _previousHeadSha: string | null) => {};
const pullRequest: PhraseLocalePullRequest & { baseCommit: string } = {
  repository: "example/app",
  baseRef: "phrase-pilot",
  baseCommit: baseCommitSha,
  branch: "i18n/phrase-batch-fr",
  recordToolingCommitSha: noToolingCommitWrite,
  title: "i18n(fr): Phrase translation update for locales/en.json",
  body: "Phrase batch test",
  path: "locales/fr.json",
  content: new TextEncoder().encode('{"hello":"Bonjour"}\n'),
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function commitDetails(sha: string, options: { paths?: string[] } = {}) {
  return {
    sha,
    files: (options.paths ?? ["locales/fr.json"]).map((filename) => ({ filename })),
  };
}

function batchRecord(key = "a".repeat(64)): PhraseBatchRecord {
  return {
    schema: 1,
    key,
    phase: "creating",
    repository: "example/app",
    baseRef: "phrase-pilot",
    sourceCommit: "abc123",
    sourceDigest: "b".repeat(64),
    config: {
      projectUid: "project-uid",
      region: "us",
      sourceCatalog: {
        path: "locales/en.json",
        filename: "en.json",
        adapter: "formatjs-json",
        locale: "en",
      },
      targetLocales: [
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
      ],
      completionPolicy: { default: "per-locale" },
    },
    createdAt: "2026-09-29T00:00:00.000Z",
    jobs: [],
    warningCount: 0,
    locales: { fr: { phase: "pending" } },
  };
}

function openPullRequestHarness(
  initialHead: string,
  options: {
    currentContent?: string;
    compare?: (headSha: string) => unknown;
    refUpdateStatuses?: number[];
    draft?: boolean;
    draftResult?: unknown;
    apiUrl?: string;
    discovery?: "open" | "race" | "create" | "unsupported";
  } = {},
) {
  const calls: Array<{ url: string; method: string }> = [];
  const events: string[] = [];
  const refUpdateStatuses = [...(options.refUpdateStatuses ?? [])];
  let branchHead = initialHead;
  let currentContent = options.currentContent ?? "old";
  let pendingContent: string | undefined;
  let commitNumber = 0;
  let draft = options.draft ?? false;
  let discoveryCalls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url.includes("/pulls?")) {
      discoveryCalls += 1;
      if (
        options.discovery === "unsupported" ||
        ((options.discovery === "race" || options.discovery === "create") && discoveryCalls === 1)
      )
        return response([]);
      return response([
        {
          state: "open",
          html_url: "https://github.com/example/app/pull/7",
          head: { sha: branchHead },
        },
      ]);
    }
    if (url.endsWith("/pulls") && method === "POST") {
      expect(JSON.parse(String(init?.body)).draft).toBe(true);
      if (options.discovery === "create") {
        draft = true;
        return response({ html_url: "https://github.com/example/app/pull/7" }, 201);
      }
      return response({ message: "Validation Failed" }, 422);
    }
    if (url.endsWith("/pulls/7") && method === "GET") {
      return response({ state: "open", head: { sha: branchHead }, draft, node_id: "PR_7" });
    }
    if (url.endsWith("/graphql") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({ id: "PR_7" });
      expect(body.query).toContain("convertPullRequestToDraft");
      draft = true;
      return response(
        options.draftResult ?? {
          data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } },
        },
      );
    }
    if (url.endsWith("/pulls/7") && method === "PATCH") return response({});
    if (url.includes("/contents/locales/fr.json?ref=")) {
      return response({
        type: "file",
        sha: "translation-blob",
        encoding: "base64",
        content: Buffer.from(currentContent).toString("base64"),
      });
    }
    if (url.includes("/compare/")) {
      return response(
        options.compare?.(branchHead) ?? {
          ahead_by: 1,
          commits: [{ sha: branchHead }],
          files: [{ filename: "locales/fr.json" }],
        },
      );
    }
    if (url.endsWith(`/git/commits/${branchHead}`) && method === "GET") {
      return response({
        sha: branchHead,
        tree: { sha: "branch-tree" },
        author: { name: "integration-bot", email: "bot@example.invalid" },
        committer: { name: "web-flow", email: "noreply@github.com" },
        verification: { verified: false, reason: "unsigned" },
      });
    }
    if (url.endsWith("/git/blobs") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { content: string };
      pendingContent = Buffer.from(body.content, "base64").toString();
      return response({ sha: "blob-new" }, 201);
    }
    if (url.endsWith("/git/trees") && method === "POST") {
      return response({ sha: "tree-new" }, 201);
    }
    if (url.endsWith("/git/commits") && method === "POST") {
      commitNumber += 1;
      return response({ sha: `${String(commitNumber).padStart(40, "0")}` }, 201);
    }
    if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr") && method === "GET") {
      return response({ object: { sha: branchHead } });
    }
    if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && method === "PATCH") {
      const failedStatus = refUpdateStatuses.shift();
      if (failedStatus) return response({ message: "ref update failed" }, failedStatus);
      const body = JSON.parse(String(init?.body)) as { sha: string };
      branchHead = body.sha;
      currentContent = pendingContent ?? currentContent;
      return response({ ref: "refs/heads/i18n/phrase-batch-fr" });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  };
  const repository = new GitHubPhraseRepository({
    repository: "example/app",
    token: "token",
    stateBranch: "i18n-state",
    apiUrl: options.apiUrl,
    fetch,
  });
  const makeUpdate = (
    recordToolingCommitSha = noToolingCommitWrite,
    overrides: Partial<PhraseLocalePullRequestUpdate> = {},
  ): PhraseLocalePullRequestUpdate => ({
    repository: "example/app",
    baseRef: "phrase-pilot",
    branch: pullRequest.branch,
    pullRequestUrl: "https://github.com/example/app/pull/7",
    headSha: branchHead,
    recordToolingCommitSha,
    title: pullRequest.title,
    path: pullRequest.path,
    content: new TextEncoder().encode("updated"),
    body: "updated warning list",
    ...overrides,
  });
  return {
    repository,
    calls,
    events,
    makeUpdate,
    queueRefUpdateStatus(status: number) {
      refUpdateStatuses.push(status);
    },
    get branchHead() {
      return branchHead;
    },
    get currentContent() {
      return currentContent;
    },
  };
}

describe("GitHubPhraseRepository", () => {
  it.each(["open", "race"] as const)(
    "adopts a ready PR (%s) without converting a valid update",
    async (discovery) => {
      const harness = openPullRequestHarness("b".repeat(40), { discovery });
      const created = await harness.repository.createOrUpdatePullRequestWithCommit({
        ...pullRequest,
        draft: false,
      });
      expect(created.pullRequestCreated).toBeUndefined();
      expect(harness.calls.some(({ url }) => url.endsWith("/graphql"))).toBe(false);
      expect(harness.currentContent).toBe(new TextDecoder().decode(pullRequest.content));
    },
  );

  it("creates a draft for an existing branch before writing invalid content", async () => {
    const harness = openPullRequestHarness("b".repeat(40), { discovery: "create" });
    const created = await harness.repository.createOrUpdatePullRequestWithCommit({
      ...pullRequest,
      draft: true,
    });
    expect(created.pullRequestCreated).toBe(true);
    const creation = harness.calls.findIndex(
      ({ url, method }) => url.endsWith("/pulls") && method === "POST",
    );
    const write = harness.calls.findIndex(
      ({ url, method }) => url.endsWith("/git/blobs") && method === "POST",
    );
    expect(creation).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(creation);
  });

  it("rechecks delivery eligibility before creating a draft for an existing branch", async () => {
    const harness = openPullRequestHarness("b".repeat(40), { discovery: "create" });
    await expect(
      harness.repository.createOrUpdatePullRequestWithCommit({
        ...pullRequest,
        draft: true,
        recheckOwnedCommitEligibility: async () => {
          throw new Error("batch superseded");
        },
      }),
    ).rejects.toThrow("batch superseded");
    expect(
      harness.calls.some(({ url, method }) => url.endsWith("/pulls") && method === "POST"),
    ).toBe(false);
    expect(harness.currentContent).toBe("old");
  });

  it("handles the 422 adoption race before writing invalid content", async () => {
    const harness = openPullRequestHarness("b".repeat(40), { discovery: "race" });
    await harness.repository.createOrUpdatePullRequestWithCommit({ ...pullRequest, draft: true });
    const creation = harness.calls.findIndex(
      ({ url, method }) => url.endsWith("/pulls") && method === "POST",
    );
    const conversion = harness.calls.findIndex(({ url }) => url.endsWith("/graphql"));
    const write = harness.calls.findIndex(
      ({ url, method }) => url.endsWith("/git/blobs") && method === "POST",
    );
    expect(creation).toBeGreaterThan(-1);
    expect(conversion).toBeGreaterThan(creation);
    expect(write).toBeGreaterThan(conversion);
  });

  it("does not write invalid content or swallow failed draft conversion in a 422 race", async () => {
    const harness = openPullRequestHarness("b".repeat(40), {
      discovery: "race",
      draftResult: { errors: [{ message: "Not permitted" }] },
    });
    await expect(
      harness.repository.createOrUpdatePullRequestWithCommit({ ...pullRequest, draft: true }),
    ).rejects.toThrow("GitHub did not confirm draft conversion");
    expect(harness.currentContent).toBe("old");
    expect(
      harness.calls.some(({ url, method }) => url.endsWith("/git/blobs") && method === "POST"),
    ).toBe(false);
  });

  it("fails closed with an actionable draft-creation error instead of a ready-PR fallback", async () => {
    const harness = openPullRequestHarness("b".repeat(40), { discovery: "unsupported" });
    await expect(
      harness.repository.createOrUpdatePullRequestWithCommit({ ...pullRequest, draft: true }),
    ).rejects.toThrow("requires draft pull request support");
    expect(harness.currentContent).toBe("old");
    expect(
      harness.calls.filter(({ url, method }) => url.endsWith("/pulls") && method === "POST"),
    ).toHaveLength(1);
  });

  it("converts a ready PR to draft before writing invalid content", async () => {
    const harness = openPullRequestHarness("b".repeat(40));
    await harness.repository.updateOpenPullRequest(harness.makeUpdate(undefined, { draft: true }));
    const conversion = harness.calls.findIndex(({ url }) => url.endsWith("/graphql"));
    const write = harness.calls.findIndex(
      ({ url, method }) => url.endsWith("/git/blobs") && method === "POST",
    );
    expect(conversion).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(conversion);
  });

  it.each(["https://github.example/api/v3", "https://github.example/api/v3/"])(
    "uses the Enterprise GraphQL endpoint for %s",
    async (apiUrl) => {
      const harness = openPullRequestHarness("b".repeat(40), { apiUrl });
      await harness.repository.updateOpenPullRequest(
        harness.makeUpdate(undefined, { draft: true }),
      );
      expect(harness.calls.some(({ url }) => url === "https://github.example/api/graphql")).toBe(
        true,
      );
    },
  );

  it("does not repeat draft conversion on an already draft PR", async () => {
    const harness = openPullRequestHarness("b".repeat(40), { draft: true });
    await harness.repository.updateOpenPullRequest(harness.makeUpdate(undefined, { draft: true }));
    expect(harness.calls.some(({ url }) => url.endsWith("/graphql"))).toBe(false);
  });

  it.each([
    { errors: [{ message: "Not permitted" }] },
    { data: { convertPullRequestToDraft: { pullRequest: { isDraft: false } } } },
    {},
  ])(
    "does not write invalid content when draft conversion is unconfirmed: %j",
    async (draftResult) => {
      const harness = openPullRequestHarness("b".repeat(40), { draftResult });
      await expect(
        harness.repository.updateOpenPullRequest(harness.makeUpdate(undefined, { draft: true })),
      ).rejects.toThrow("GitHub did not confirm draft conversion");
      expect(
        harness.calls.some(({ url, method }) => url.endsWith("/git/blobs") && method === "POST"),
      ).toBe(false);
    },
  );

  it("rejects a locale PR base commit that is not a full commit SHA", async () => {
    let requests = 0;
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () => {
        requests += 1;
        return response([]);
      },
    });

    const error = await repository
      .createOrUpdatePullRequest({ ...pullRequest, baseCommit: "base-commit" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: "Phrase PR base commit must be a full commit SHA",
    });
    expect(requests).toBe(0);
  });

  it("writes all locale PR files in one Git Data commit from the resolved base SHA", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const blobs: Record<string, unknown>[] = [];
    let treeBody: Record<string, unknown> | undefined;
    let commitBody: Record<string, unknown> | undefined;
    let refBody: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.includes("/pulls?")) return response([]);
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) return response({}, 404);
      if (url.endsWith(`/git/commits/${baseCommitSha}`)) {
        return response({ sha: baseCommitSha, tree: { sha: "base-tree" } });
      }
      if (url.endsWith("/git/blobs") && init?.method === "POST") {
        blobs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response({ sha: `blob-${blobs.length}` }, 201);
      }
      if (url.endsWith("/git/trees") && init?.method === "POST") {
        treeBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ sha: "tree-new" }, 201);
      }
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        commitBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/refs") && init?.method === "POST") {
        refBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" }, 201);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return response({ html_url: "https://github.com/example/app/pull/7" }, 201);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });
    const frontend = new TextEncoder().encode("kind: Template\n");

    await expect(
      repository.createOrUpdatePullRequest({
        ...pullRequest,
        draft: true,
        additionalFiles: [{ path: "deploy/frontend.yaml", content: frontend }],
      }),
    ).resolves.toBe("https://github.com/example/app/pull/7");

    const createPr = calls.find(
      ({ url, init }) => url.endsWith("/pulls") && init?.method === "POST",
    );
    expect(JSON.parse(String(createPr?.init?.body))).toMatchObject({ draft: true });
    expect(blobs).toHaveLength(2);
    expect(treeBody).toMatchObject({
      base_tree: "base-tree",
      tree: [
        { path: "locales/fr.json", mode: "100644", type: "blob" },
        { path: "deploy/frontend.yaml", mode: "100644", type: "blob" },
      ],
    });
    expect(commitBody).toMatchObject({
      message: expect.any(String),
      tree: "tree-new",
      parents: [baseCommitSha],
    });
    expect(Object.keys(commitBody ?? {}).sort()).toEqual(["message", "parents", "tree"]);
    expect(refBody).toEqual({ ref: "refs/heads/i18n/phrase-batch-fr", sha: "commit-new" });
    expect(calls.some((call) => call.url.endsWith("/git/ref/heads/phrase-pilot"))).toBe(false);
    expect(
      calls.filter(({ url, init }) => url.includes("/contents/") && init?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("resolves a base branch to one commit SHA", async () => {
    const calls: string[] = [];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        expect(init?.method).toBe("GET");
        return response({ object: { sha: "base-commit" } });
      },
    });

    await expect(repository.resolveCommit("phrase-pilot")).resolves.toBe("base-commit");
    expect(calls).toEqual(["https://api.github.com/repos/example/app/git/ref/heads/phrase-pilot"]);
  });

  it("reports a rejected non-force locale ref update as a retryable conflict", async () => {
    let refUpdate: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/pulls?")) return response([]);
      if (
        url.endsWith("/git/ref/heads/i18n/phrase-batch-fr") &&
        (init?.method ?? "GET") === "GET"
      ) {
        return response({ object: { sha: "branch-head" } });
      }
      if (url.includes("/compare/")) {
        return response({
          ahead_by: 1,
          commits: [commitDetails("branch-head")],
          files: [{ filename: "locales/fr.json" }],
        });
      }
      if (url.endsWith("/git/commits/branch-head")) {
        return response({
          sha: "branch-head",
          tree: { sha: "branch-tree" },
          files: [{ filename: "locales/fr.json" }],
        });
      }
      if (url.includes("/contents/locales/fr.json?ref=branch-head")) {
        return response({
          type: "file",
          sha: "translation-blob",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      if (url.endsWith("/git/blobs")) return response({ sha: "blob-new" }, 201);
      if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && init?.method === "PATCH") {
        refUpdate = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ message: "Reference update failed" }, 422);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch,
    });

    await expect(repository.createOrUpdatePullRequest(pullRequest)).rejects.toMatchObject({
      name: "GitHubRepositoryError",
      status: 422,
      permanent: false,
      message: expect.stringContaining("refusing to overwrite reviewer changes"),
    });
    expect(refUpdate).toEqual({ sha: "commit-new", force: false });
  });

  it("creates a deterministic locale branch and pull request with the run token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) return response({}, 404);
      if (url.endsWith(`/git/commits/${baseCommitSha}`))
        return response({ tree: { sha: "base-tree" } });
      if (url.endsWith("/git/blobs")) return response({ sha: "translation-blob" }, 201);
      if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
      if (url.endsWith("/git/commits") && init?.method === "POST")
        return response({ sha: "locale-commit" }, 201);
      if (url.endsWith("/git/refs") && init?.method === "POST")
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" }, 201);
      if (url.includes("/pulls?")) return response([]);
      if (url.endsWith("/pulls")) {
        return response({ html_url: "https://github.com/example/app/pull/7" }, 201);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });

    const pullRequestUrl = await repository.createOrUpdatePullRequest(pullRequest);

    expect(pullRequestUrl).toBe("https://github.com/example/app/pull/7");
    const refCreate = calls.find((call) => call.url.endsWith("/git/refs"));
    expect(JSON.parse(String(refCreate?.init?.body))).toEqual({
      ref: "refs/heads/i18n/phrase-batch-fr",
      sha: "locale-commit",
    });
    const fileBlob = calls.find((call) => call.url.endsWith("/git/blobs"));
    expect(JSON.parse(String(fileBlob?.init?.body))).toEqual({
      content: Buffer.from(pullRequest.content).toString("base64"),
      encoding: "base64",
    });
    const commit = calls.find(
      (call) => call.url.endsWith("/git/commits") && call.init?.method === "POST",
    );
    expect(new Headers(commit?.init?.headers).get("Authorization")).toBe("Bearer github-run-token");
  });

  it("writes both JSON and Frontend YAML before opening the locale PR", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let treeBody: Record<string, unknown> | undefined;
    let commitCount = 0;
    let refUpdate: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.includes("/pulls?")) return response([]);
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) {
        return response({ object: { sha: "branch-head" } });
      }
      if (url.includes("/compare/")) {
        return response({
          ahead_by: 1,
          commits: [
            commitDetails("branch-head", {
              paths: ["locales/fr.json", "deploy/frontend.yaml"],
            }),
          ],
          files: [{ filename: "locales/fr.json" }, { filename: "deploy/frontend.yaml" }],
        });
      }
      if (url.endsWith("/git/commits/branch-head")) {
        return response({
          sha: "branch-head",
          tree: { sha: "branch-tree" },
          files: [{ filename: "locales/fr.json" }, { filename: "deploy/frontend.yaml" }],
        });
      }
      if (url.includes("/contents/")) return response({}, 404);
      if (url.endsWith("/git/blobs")) return response({ sha: "blob" }, 201);
      if (url.endsWith("/git/trees")) {
        treeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ sha: "tree-new" }, 201);
      }
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        commitCount += 1;
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && init?.method === "PATCH") {
        refUpdate = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" });
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        expect(commitCount).toBe(1);
        return response({ html_url: "https://github.com/example/app/pull/7" }, 201);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch,
    });
    await repository.createOrUpdatePullRequest({
      ...pullRequest,
      additionalFiles: [
        { path: "deploy/frontend.yaml", content: new TextEncoder().encode("kind: Template\n") },
      ],
    });
    const tree = treeBody?.tree as Array<{ path: string }>;
    expect(tree.map(({ path }) => path)).toEqual(["locales/fr.json", "deploy/frontend.yaml"]);
    expect(refUpdate).toEqual({ sha: "commit-new", force: false });
    expect(
      calls.filter(({ url, init }) => url.includes("/contents/") && init?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("uses state-file SHA as compare-and-swap revision", async () => {
    const record = batchRecord();
    record.phase = "ready";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.includes("/contents/.github/i18n-state/batches/")) {
        if (init?.method === "PUT") return response({ content: { sha: "blob-new" } });
        return response({
          type: "file",
          sha: "blob-old",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(record)).toString("base64"),
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });

    const saved = await repository.updateBatch(record, "blob-old");

    expect(saved).toBe("blob-new");
    const body = JSON.parse(String(calls.at(-1)?.init?.body));
    expect(body.sha).toBe("blob-old");
    expect(body.branch).toBe("i18n-state");
  });

  it("creates the durable state branch from the requested base and stores the batch", async () => {
    const record = batchRecord();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/git/ref/heads/i18n-state")) return response({}, 404);
      if (url.endsWith("/git/ref/heads/phrase-pilot")) {
        return response({ object: { sha: "base-commit" } });
      }
      if (url.endsWith("/git/refs")) return response({}, 201);
      if (url.includes("/contents/.github/i18n-state/batches/") && init?.method === "GET") {
        return response({}, 404);
      }
      if (url.includes("/contents/.github/i18n-state/batches/") && init?.method === "PUT") {
        return response({ content: { sha: "state-blob" } }, 201);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });

    const revision = await repository.createBatch(record);

    expect(revision).toBe("state-blob");
    expect(
      JSON.parse(String(calls.find((call) => call.url.includes("/git/refs"))?.init?.body)),
    ).toEqual({
      ref: "refs/heads/i18n-state",
      sha: "base-commit",
    });
    const write = calls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse(String(write?.init?.body)).message).toBe(
      `i18n: record Phrase batch ${record.key.slice(0, 12)}`,
    );
  });

  it("lists batch keys without reading records and ignores unrelated directory entries", async () => {
    const key = "a".repeat(64);
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return response([
        { type: "file", name: `${key}.json` },
        { type: "file", name: "README.md" },
        { type: "file", name: "not-a-batch.json" },
        { type: "dir", name: "archive" },
      ]);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });

    expect(await repository.listBatchKeys()).toEqual([key]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/contents/.github/i18n-state/batches?ref=i18n-state");
  });

  it("reads a valid state record with its blob SHA as revision", async () => {
    const record = batchRecord();
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () =>
        response({
          type: "file",
          sha: "state-blob",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(record)).toString("base64"),
        }),
    });

    const batch = await repository.readBatch(record.key);

    expect(batch?.record).toEqual(record);
    expect(batch?.revision).toBe("state-blob");
  });

  it("retries a state write rejected only because the branch head moved", async () => {
    const record = batchRecord();
    let puts = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.method === "PUT") {
        puts += 1;
        return puts === 1
          ? response({ message: "is at abc but expected def" }, 409)
          : response({ content: { sha: "blob-new" } });
      }
      return response({ type: "file", sha: "blob-old", encoding: "base64", content: "e30=" });
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch,
    });

    await expect(repository.updateBatch(record, "blob-old")).resolves.toBe("blob-new");
    expect(puts).toBe(2);
  });

  it("explains rejected and under-scoped tokens as retryable failures without exposing the token", async () => {
    const expired = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () => new Response("Bad credentials github-run-token", { status: 401 }),
    });

    const expiredError = await expired.listBatchKeys().catch((error: unknown) => error);
    expect(expiredError).toMatchObject({
      name: "GitHubRepositoryError",
      status: 401,
      permanent: false,
      message: "GitHub API returned HTTP 401: the token is missing, expired or revoked",
    });

    const writes: string[] = [];
    const denied = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (init?.method && init.method !== "GET") writes.push(url);
        if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) return response({}, 404);
        if (url.endsWith(`/git/commits/${baseCommitSha}`))
          return response({ tree: { sha: "base-tree" } });
        if (url.endsWith("/git/blobs")) return response({ sha: "translation-blob" }, 201);
        if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
        if (url.endsWith("/git/commits") && init?.method === "POST")
          return response({ sha: "locale-commit" }, 201);
        if (url.endsWith("/git/refs") && init?.method === "POST") return response({}, 201);
        if (url.includes("/pulls?")) return response([]);
        if (url.endsWith("/pulls")) {
          return response({ message: "Resource not accessible by integration" }, 403);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    const deniedError = await denied
      .createOrUpdatePullRequest(pullRequest)
      .catch((error: unknown) => error);
    expect(deniedError).toMatchObject({
      name: "GitHubRepositoryError",
      status: 403,
      permanent: false,
      message:
        "GitHub API returned HTTP 403: the token may not make this request; state and locale branches need contents: write, pull requests need pull-requests: write",
    });
    expect(writes.at(-1)).toMatch(/\/pulls$/);
  });

  it("wraps transport failures and applies a request timeout", async () => {
    let signal: AbortSignal | null | undefined;
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (_input, init) => {
        signal = init?.signal;
        throw new TypeError("fetch failed");
      },
    });

    await expect(repository.readFile("locales/en.json", "main")).rejects.toMatchObject({
      name: "GitHubRepositoryError",
      status: 0,
      message: "Could not reach GitHub API",
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed on stale state revisions and malformed state files", async () => {
    const record = batchRecord();
    const fetchStale: typeof globalThis.fetch = async () =>
      response({ type: "file", sha: "newer-blob", encoding: "base64", content: "e30=" });
    const staleRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: fetchStale,
    });
    await expect(staleRepository.updateBatch(record, "old-blob")).rejects.toBeInstanceOf(
      PhraseBatchStateConflictError,
    );

    const malformedRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () =>
        response({
          type: "file",
          sha: "state-blob",
          encoding: "base64",
          content: Buffer.from("{").toString("base64"),
        }),
    });
    await expect(malformedRepository.readBatch(record.key)).rejects.toBeInstanceOf(
      GitHubRepositoryError,
    );
  });

  it("checks one PR by number and updates changed locale files with a non-force Git Data commit", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/pulls/7") && init?.method === "GET") {
        return response({ state: "open", head: { sha: "branch-head" } });
      }
      if (url.includes("/contents/locales/fr.json?ref=branch-head")) {
        return response({
          type: "file",
          sha: "translation-blob",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      if (url.endsWith("/git/commits/branch-head"))
        return response({ tree: { sha: "branch-tree" } });
      if (url.endsWith("/git/blobs")) return response({ sha: "blob-new" }, 201);
      if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          message: expect.any(String),
          tree: "tree-new",
          parents: ["branch-head"],
        });
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr") && init?.method === "GET") {
        return response({ object: { sha: "branch-head" } });
      }
      if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ sha: "commit-new", force: false });
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" });
      }
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          title: update.title,
          body: "updated warning list",
        });
        return response({});
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch,
    });
    const update: PhraseLocalePullRequestUpdate = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      branch: pullRequest.branch,
      pullRequestUrl: "https://github.com/example/app/pull/7",
      headSha: "branch-head",
      expectedToolingCommitSha: "branch-head",
      recordToolingCommitSha: noToolingCommitWrite,
      title: "i18n(fr): Phrase translation update for locales/en.json",
      path: pullRequest.path,
      content: new TextEncoder().encode("updated"),
      body: "updated warning list",
    };

    await expect(repository.getPullRequestState(update.pullRequestUrl)).resolves.toEqual({
      state: "open",
      headSha: "branch-head",
    });
    await expect(repository.updateOpenPullRequest(update)).resolves.toEqual({
      changed: true,
      toolingCommitSha: "commit-new",
      bodyUpdated: true,
    });
    expect(calls.filter(({ url }) => url.endsWith("/pulls/7"))).toHaveLength(5);
    expect(calls.some(({ url }) => url.includes("/compare/"))).toBe(false);
    expect(
      calls.some(({ url, init }) => url.includes("/contents/") && init?.method === "PUT"),
    ).toBe(false);
  });

  it("retries when a recorded PR URL returns 404 instead of treating it as closed", async () => {
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch: async () => response({}, 404),
    });

    await expect(
      repository.getPullRequestState("https://github.com/example/app/pull/7"),
    ).rejects.toMatchObject({ status: 404, permanent: false });
  });

  it("treats a reviewer commit on top of a recorded commit as a retryable conflict", async () => {
    const harness = openPullRequestHarness("reviewer-head");

    await expect(
      harness.repository.updateOpenPullRequest(
        harness.makeUpdate(noToolingCommitWrite, {
          expectedToolingCommitShas: ["tooling-head"],
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("refusing to overwrite reviewer changes"),
    });
    expect(harness.calls.some(({ url }) => url.includes("/contents/"))).toBe(false);
    expect(
      harness.calls.some(({ url, method }) => url.endsWith("/git/blobs") && method === "POST"),
    ).toBe(false);
  });

  it("adopts a legacy single commit that changes only the expected output path", async () => {
    const harness = openPullRequestHarness("legacy-head", {
      compare: (headSha) => ({
        ahead_by: 1,
        commits: [{ sha: headSha }],
        files: [{ filename: "locales/fr.json" }],
      }),
    });
    const state: { toolingCommitShas: string[] } = { toolingCommitShas: [] };
    const persistOwnership = async (toolingSha: string, previousHeadSha: string | null) => {
      expect(previousHeadSha).toBe("legacy-head");
      state.toolingCommitShas = [
        ...new Set([
          ...state.toolingCommitShas,
          ...(previousHeadSha ? [previousHeadSha] : []),
          toolingSha,
        ]),
      ].slice(-20);
    };

    const result = await harness.repository.updateOpenPullRequest(
      harness.makeUpdate(persistOwnership),
    );

    expect(result).toMatchObject({ changed: true, bodyUpdated: true });
    expect(state.toolingCommitShas).toContain("legacy-head");
    expect(state.toolingCommitShas).toContain(result.toolingCommitSha);
    expect(harness.calls.some(({ url }) => url.includes("/app/commits/"))).toBe(false);
  });

  it("rejects a legacy branch with two commits even when both touch expected paths", async () => {
    const harness = openPullRequestHarness("legacy-head", {
      compare: (headSha) => ({
        ahead_by: 2,
        commits: [{ sha: "legacy-parent" }, { sha: headSha }],
        files: [{ filename: "locales/fr.json" }],
      }),
    });

    await expect(
      harness.repository.updateOpenPullRequest(harness.makeUpdate()),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("refusing to overwrite reviewer changes"),
    });
    expect(
      harness.calls.some(({ url, method }) => url.endsWith("/git/blobs") && method === "POST"),
    ).toBe(false);
  });

  it("owns a recorded tooling SHA without checking author, signature, or committer", async () => {
    const recordedSha = "a".repeat(40);
    const harness = openPullRequestHarness(recordedSha);

    await expect(
      harness.repository.updateOpenPullRequest(
        harness.makeUpdate(noToolingCommitWrite, {
          expectedToolingCommitSha: recordedSha,
        }),
      ),
    ).resolves.toMatchObject({ changed: true, bodyUpdated: true });
    expect(harness.calls.some(({ url }) => url.includes("/compare/"))).toBe(false);
    expect(harness.calls.some(({ url }) => url.includes("/app/commits/"))).toBe(false);
  });

  it("accepts ownership from the SHA history and from the legacy pending field", async () => {
    const recordedSha = "e".repeat(40);
    const harness = openPullRequestHarness(recordedSha);

    await expect(
      harness.repository.updateOpenPullRequest(
        harness.makeUpdate(noToolingCommitWrite, {
          expectedToolingCommitShas: ["older-tooling-sha", recordedSha],
        }),
      ),
    ).resolves.toMatchObject({ changed: true, bodyUpdated: true });

    const legacyPendingHarness = openPullRequestHarness(recordedSha);
    await expect(
      legacyPendingHarness.repository.updateOpenPullRequest(
        legacyPendingHarness.makeUpdate(noToolingCommitWrite, {
          expectedPendingToolingCommitSha: recordedSha,
        }),
      ),
    ).resolves.toMatchObject({ changed: true, bodyUpdated: true });
  });

  it("blocks ref movement until ownership is saved", async () => {
    const oldHead = "b".repeat(40);
    const harness = openPullRequestHarness(oldHead);
    let failSave = true;
    let toolingCommitShas = [oldHead];
    const persistOwnership = async (toolingSha: string, previousHeadSha: string | null) => {
      expect(
        harness.calls.some(
          ({ url, method }) =>
            url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && method === "PATCH",
        ),
      ).toBe(false);
      if (failSave) {
        failSave = false;
        throw new Error("state save failed");
      }
      toolingCommitShas = [
        ...new Set([
          ...toolingCommitShas,
          ...(previousHeadSha ? [previousHeadSha] : []),
          toolingSha,
        ]),
      ].slice(-20);
    };
    const update = () =>
      harness.makeUpdate(persistOwnership, { expectedToolingCommitShas: toolingCommitShas });

    await expect(harness.repository.updateOpenPullRequest(update())).rejects.toThrow(
      "state save failed",
    );
    expect(harness.branchHead).toBe(oldHead);
    expect(
      harness.calls.some(
        ({ url, method }) =>
          url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && method === "PATCH",
      ),
    ).toBe(false);

    await expect(harness.repository.updateOpenPullRequest(update())).resolves.toMatchObject({
      changed: true,
      bodyUpdated: true,
    });
    expect(toolingCommitShas).toContain(harness.branchHead);
    expect(harness.branchHead).not.toBe(oldHead);
  });

  it("recovers an owned head after ref update failure", async () => {
    const oldHead = "c".repeat(40);
    const harness = openPullRequestHarness(oldHead, { refUpdateStatuses: [503] });
    let toolingCommitShas = [oldHead];
    const persistOwnership = async (toolingSha: string, previousHeadSha: string | null) => {
      toolingCommitShas = [
        ...new Set([
          ...toolingCommitShas,
          ...(previousHeadSha ? [previousHeadSha] : []),
          toolingSha,
        ]),
      ].slice(-20);
    };
    const update = () =>
      harness.makeUpdate(persistOwnership, {
        expectedToolingCommitShas: toolingCommitShas,
      });

    await expect(harness.repository.updateOpenPullRequest(update())).rejects.toMatchObject({
      status: 503,
    });
    expect(toolingCommitShas).toHaveLength(2);
    expect(harness.branchHead).toBe(oldHead);

    await expect(harness.repository.updateOpenPullRequest(update())).resolves.toMatchObject({
      changed: true,
      bodyUpdated: true,
    });
    expect(toolingCommitShas).toContain(harness.branchHead);
    expect(harness.branchHead).not.toBe(oldHead);
  });

  it("keeps ownership through a failed final save and a later failed ref update", async () => {
    const oldHead = "d".repeat(40);
    const harness = openPullRequestHarness(oldHead);
    const state: { toolingCommitSha: string; toolingCommitShas: string[] } = {
      toolingCommitSha: oldHead,
      toolingCommitShas: [oldHead],
    };
    const persistOwnership = async (toolingSha: string, previousHeadSha: string | null) => {
      state.toolingCommitShas = [
        ...new Set([
          ...state.toolingCommitShas,
          ...(previousHeadSha ? [previousHeadSha] : []),
          toolingSha,
        ]),
      ].slice(-20);
    };
    const reconcile = async (content: string, failFinalStateSave = false) => {
      const result = await harness.repository.updateOpenPullRequest(
        harness.makeUpdate(persistOwnership, {
          expectedToolingCommitShas: state.toolingCommitShas,
          content: new TextEncoder().encode(content),
        }),
      );
      if (failFinalStateSave) {
        throw new Error("final state save failed");
      }
      state.toolingCommitSha = result.toolingCommitSha;
      return result;
    };

    await expect(reconcile("first export", true)).rejects.toThrow("final state save failed");
    const firstPushedHead = harness.branchHead;
    expect(state.toolingCommitSha).toBe(oldHead);
    expect(state.toolingCommitShas).toContain(firstPushedHead);

    harness.queueRefUpdateStatus(503);
    await expect(reconcile("changed export after interruption")).rejects.toMatchObject({
      status: 503,
    });
    expect(harness.branchHead).toBe(firstPushedHead);
    expect(state.toolingCommitSha).toBe(oldHead);
    expect(state.toolingCommitShas).toHaveLength(3);

    const recovered = await reconcile("changed export after interruption");
    expect(recovered).toMatchObject({
      changed: true,
      bodyUpdated: true,
    });
    expect(state.toolingCommitSha).toBe(harness.branchHead);
    expect(state.toolingCommitShas).toContain(firstPushedHead);
    expect(state.toolingCommitShas).toContain(harness.branchHead);
  });

  it("skips branch and metadata writes when an open PR closes before the branch update", async () => {
    const writes: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method && init.method !== "GET") writes.push(url);
      if (url.endsWith("/pulls/7") && init?.method === "GET") {
        return response({ state: "closed", merged_at: null });
      }
      if (url.includes("/contents/locales/fr.json?ref=branch-head")) {
        return response({
          type: "file",
          sha: "translation-blob",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      if (url.endsWith("/git/commits/branch-head")) {
        return response({ tree: { sha: "branch-tree" } });
      }
      if (url.endsWith("/git/blobs")) return response({ sha: "blob-new" }, 201);
      if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) {
        return response({ object: { sha: "branch-head" } });
      }
      if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr")) return response({});
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") return response({});
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch,
    });
    const update: PhraseLocalePullRequestUpdate = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      branch: pullRequest.branch,
      pullRequestUrl: "https://github.com/example/app/pull/7",
      headSha: "branch-head",
      expectedToolingCommitSha: "branch-head",
      recordToolingCommitSha: noToolingCommitWrite,
      title: pullRequest.title,
      path: pullRequest.path,
      content: new TextEncoder().encode("updated"),
      body: "updated warning list",
    };

    await expect(repository.updateOpenPullRequest(update)).resolves.toMatchObject({
      changed: false,
      pullRequestFinalized: true,
    });
    expect(writes).toEqual([]);
  });

  it("skips the PR metadata write when it closes after the branch update", async () => {
    const branchHead = "branch-head";
    let pullRequestChecks = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/pulls/7") && init?.method === "GET") {
        pullRequestChecks += 1;
        return pullRequestChecks < 3
          ? response({ state: "open", head: { sha: branchHead } })
          : response({ state: "closed", merged_at: null });
      }
      if (url.includes(`/contents/locales/fr.json?ref=${branchHead}`)) {
        return response({
          type: "file",
          sha: "translation-blob",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      if (url.endsWith(`/git/commits/${branchHead}`)) {
        return response({ tree: { sha: "branch-tree" } });
      }
      if (url.endsWith("/git/blobs")) return response({ sha: "blob-new" }, 201);
      if (url.endsWith("/git/trees")) return response({ sha: "tree-new" }, 201);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        return response({ sha: "commit-new" }, 201);
      }
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) {
        return response({ object: { sha: branchHead } });
      }
      if (url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && init?.method === "PATCH") {
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" });
      }
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") return response({});
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "token",
      stateBranch: "i18n-state",
      fetch,
    });
    const update: PhraseLocalePullRequestUpdate = {
      repository: "example/app",
      baseRef: "phrase-pilot",
      branch: pullRequest.branch,
      pullRequestUrl: "https://github.com/example/app/pull/7",
      headSha: branchHead,
      expectedToolingCommitSha: branchHead,
      recordToolingCommitSha: noToolingCommitWrite,
      title: pullRequest.title,
      path: pullRequest.path,
      content: new TextEncoder().encode("updated"),
      body: "updated warning list",
    };

    await expect(repository.updateOpenPullRequest(update)).resolves.toMatchObject({
      changed: true,
      bodyUpdated: false,
      pullRequestFinalized: true,
    });
    expect(pullRequestChecks).toBe(3);
    expect(
      calls.filter(
        ({ url, init }) =>
          url.endsWith("/git/refs/heads/i18n/phrase-batch-fr") && init?.method === "PATCH",
      ),
    ).toHaveLength(1);
    expect(
      calls.some(({ url, init }) => url.endsWith("/pulls/7") && init?.method === "PATCH"),
    ).toBe(false);
  });

  it("reuses open, merged, or closed PRs without changing their branches", async () => {
    const openMetadataUpdates: Record<string, unknown>[] = [];
    const openFetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/pulls/7") && init?.method === "GET") {
        return response({ state: "open", head: { sha: "branch-head" } });
      }
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") {
        openMetadataUpdates.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response({});
      }
      if (url.includes("/pulls?")) {
        return response([{ state: "open", html_url: "https://github.com/example/app/pull/7" }]);
      }
      if (url.includes("/compare/")) {
        return response({
          ahead_by: 1,
          commits: [commitDetails("branch-head")],
          files: [{ filename: "locales/fr.json" }],
        });
      }
      if (url.endsWith("/git/commits/branch-head")) {
        return response({
          sha: "branch-head",
          tree: { sha: "branch-tree" },
        });
      }
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) {
        return response({ object: { sha: "branch-head" } });
      }
      if (url.includes("/contents/locales/fr.json?")) {
        return response({
          type: "file",
          sha: "translation-blob",
          encoding: "base64",
          content: Buffer.from(pullRequest.content).toString("base64"),
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    };
    const openRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: openFetch,
    });
    await expect(openRepository.createOrUpdatePullRequest(pullRequest)).resolves.toBe(
      "https://github.com/example/app/pull/7",
    );
    expect(openMetadataUpdates).toEqual([{ title: pullRequest.title, body: pullRequest.body }]);

    let calls = 0;
    let mergedPatches = 0;
    const mergedRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (_input, init) => {
        calls += 1;
        if (init?.method === "PATCH") mergedPatches += 1;
        return response([
          {
            state: "closed",
            merged_at: "2026-09-29T00:00:00Z",
            html_url: "https://github.com/example/app/pull/7",
          },
        ]);
      },
    });
    await expect(mergedRepository.createOrUpdatePullRequest(pullRequest)).resolves.toBe(
      "https://github.com/example/app/pull/7",
    );
    expect(calls).toBe(1);
    expect(mergedPatches).toBe(0);

    let closedCalls = 0;
    let closedPatches = 0;
    const closedRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        closedCalls += 1;
        if (init?.method === "PATCH") closedPatches += 1;
        const url = input instanceof Request ? input.url : String(input);
        return url.includes("/pulls?")
          ? response([
              {
                state: "closed",
                merged_at: null,
                html_url: "https://github.com/example/app/pull/7",
              },
            ])
          : response({ state: "closed", merged_at: null });
      },
    });
    await expect(
      closedRepository.createOrUpdatePullRequestWithCommit(pullRequest),
    ).resolves.toEqual({
      pullRequestUrl: "https://github.com/example/app/pull/7",
      pullRequestFinalized: true,
    });
    expect(closedCalls).toBe(1);
    expect(closedPatches).toBe(0);
    expect(
      await closedRepository.getPullRequestState("https://github.com/example/app/pull/7"),
    ).toEqual({
      state: "closed",
    });
    expect(closedCalls).toBe(2);
    expect(closedPatches).toBe(0);
  });

  it("reports the head and merge commit of a merged or closed pull request", async () => {
    const pullRequests: Record<string, unknown> = {
      "/pulls/7": {
        state: "closed",
        merged_at: "2026-10-22T00:00:00Z",
        merge_commit_sha: "m".repeat(40),
        head: { sha: "h".repeat(40) },
      },
      "/pulls/8": { state: "closed", merged_at: null, head: { sha: "c".repeat(40) } },
      "/pulls/9": { state: "closed", merged_at: "2026-10-22T00:00:00Z", head: {} },
    };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        const key = Object.keys(pullRequests).find((path) => url.endsWith(path));
        return response(key ? pullRequests[key] : {});
      },
    });

    await expect(
      repository.getPullRequestState("https://github.com/example/app/pull/7"),
    ).resolves.toEqual({
      state: "merged",
      headSha: "h".repeat(40),
      mergeCommitSha: "m".repeat(40),
    });
    await expect(
      repository.getPullRequestState("https://github.com/example/app/pull/8"),
    ).resolves.toEqual({ state: "closed", headSha: "c".repeat(40) });
    await expect(
      repository.getPullRequestState("https://github.com/example/app/pull/9"),
    ).resolves.toEqual({ state: "merged" });
  });

  it("paginates issue comments and returns the latest marked Bot comment", async () => {
    const marker = "<!-- i18n-pipeline:translation-findings";
    const commentRequests: string[] = [];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        commentRequests.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        if (page === 1) {
          return response([
            { body: `${marker} digest=user`, user: { login: "reviewer", type: "User" } },
            ...Array.from({ length: 99 }, (_, index) => ({
              body: `unrelated ${index}`,
              user: { login: "ci[bot]", type: "Bot" },
            })),
          ]);
        }
        if (page === 2) {
          return response([
            { body: `${marker} digest=older`, user: { login: "ci[bot]", type: "Bot" } },
            { body: `${marker} digest=newest`, user: { login: "ci[bot]", type: "Bot" } },
          ]);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    await expect(
      repository.findLatestBotPullRequestComment("https://github.com/example/app/pull/7", marker),
    ).resolves.toBe(`${marker} digest=newest`);
    expect(commentRequests).toHaveLength(2);
    expect(commentRequests.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(commentRequests[0]).toContain("/repos/example/app/issues/7/comments?");
    expect(new URL(commentRequests[0]!).searchParams.has("direction")).toBe(false);
  });

  it("creates issue comments only while the pull request is open", async () => {
    let postedBody: unknown;
    const calls: Array<{ url: string; method: string }> = [];
    let pullRequestState: "open" | "closed" = "open";
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method });
        if (url.endsWith("/pulls/7")) {
          return response({
            state: pullRequestState,
            head: { sha: baseCommitSha },
          });
        }
        if (url.endsWith("/issues/7/comments") && method === "POST") {
          postedBody = JSON.parse(String(init?.body));
          return response({ id: 99 }, 201);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });
    const pullRequestUrl = "https://github.com/example/app/pull/7";

    await expect(repository.createPullRequestComment(pullRequestUrl, "report body")).resolves.toBe(
      true,
    );
    expect(postedBody).toEqual({ body: "report body" });
    expect(calls.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/repos/example/app/pulls/7"],
      ["POST", "/repos/example/app/issues/7/comments"],
    ]);

    pullRequestState = "closed";
    await expect(repository.createPullRequestComment(pullRequestUrl, "ignored")).resolves.toBe(
      false,
    );
    expect(calls).toHaveLength(3);
  });

  it("closes a pull request through the REST endpoint and maps API errors", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({
          url,
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return response({ state: "closed" });
      },
    });

    await repository.closePullRequest("https://github.com/example/app/pull/7");

    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/example/app/pulls/7",
        method: "PATCH",
        body: { state: "closed" },
      },
    ]);

    const forbidden = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () => response({ message: "Resource not accessible by integration" }, 403),
    });
    await expect(
      forbidden.closePullRequest("https://github.com/example/app/pull/7"),
    ).rejects.toMatchObject({
      name: "GitHubRepositoryError",
      status: 403,
      permanent: false,
      message: expect.stringContaining("pull-requests: write"),
    });
  });

  it("intersects paginated path history with the compare range in newest-first order", async () => {
    const baseCommit = "e".repeat(40);
    const headCommit = "f".repeat(40);
    const calls: string[] = [];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page"));
        if (parsed.pathname.includes("/compare/")) {
          return response({
            commits:
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({ sha: `range-${index}` }))
                : [{ sha: "range-old" }],
          });
        }
        if (parsed.pathname.endsWith("/commits")) {
          if (page === 1) {
            return response([
              { sha: "range-0", author: { login: "newest" } },
              { sha: "outside-a", author: { login: "outside" } },
              { sha: "range-1", author: { login: "middle" } },
              ...Array.from({ length: 97 }, (_, index) => ({
                sha: `outside-${index}`,
                author: { login: `outside-${index}` },
              })),
            ]);
          }
          return response([{ sha: "range-old", author: { login: "oldest" } }]);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    await expect(
      repository.listSourceChangeAuthors({
        path: "locales/en.json",
        headCommit,
        baseCommit,
      }),
    ).resolves.toEqual(["newest", "middle", "oldest"]);
    const compareCalls = calls.filter((url) => new URL(url).pathname.includes("/compare/"));
    const pathCalls = calls.filter((url) => new URL(url).pathname.endsWith("/commits"));
    expect(compareCalls).toHaveLength(2);
    expect(pathCalls).toHaveLength(2);
    expect(new URL(pathCalls[0]!).searchParams.get("path")).toBe("locales/en.json");
    expect(pathCalls.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("skips unlinked authors and bots, deduplicates logins, and caps results at ten", async () => {
    const commits = Array.from({ length: 20 }, (_, index) => ({ sha: `range-${index}` }));
    const history = [
      { sha: "range-0", author: null },
      { sha: "range-1", author: { login: "ci", type: "Bot" } },
      { sha: "range-2", author: { login: "renovate[bot]", type: "User" } },
      ...Array.from({ length: 8 }, (_, index) => ({
        sha: `range-${index + 3}`,
        author: { login: `user-${index}`, type: "User" },
      })),
      { sha: "range-11", author: { login: "USER-0", type: "User" } },
      { sha: "range-12", author: { login: "user-8", type: "User" } },
      { sha: "range-13", author: { login: "user-9", type: "User" } },
      { sha: "range-14", author: { login: "user-10", type: "User" } },
    ];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsed = new URL(url);
        if (parsed.pathname.includes("/compare/")) return response({ commits });
        if (parsed.pathname.endsWith("/commits")) return response(history);
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    await expect(
      repository.listSourceChangeAuthors({
        path: "locales/en.json",
        headCommit: "f".repeat(40),
        baseCommit: "e".repeat(40),
      }),
    ).resolves.toEqual(Array.from({ length: 10 }, (_, index) => `user-${index}`));
  });

  it("bounds compare and path-history pagination to five pages each", async () => {
    const calls: string[] = [];
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page"));
        if (parsed.pathname.includes("/compare/")) {
          return response({
            commits: [
              { sha: `range-${page}` },
              ...Array.from({ length: 99 }, (_, index) => ({ sha: `compare-${page}-${index}` })),
            ],
          });
        }
        if (parsed.pathname.endsWith("/commits")) {
          return response([
            { sha: `range-${page}`, author: null },
            ...Array.from({ length: 99 }, (_, index) => ({
              sha: `outside-${page}-${index}`,
              author: null,
            })),
          ]);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    await expect(
      repository.listSourceChangeAuthors({
        path: "locales/en.json",
        headCommit: "f".repeat(40),
        baseCommit: "e".repeat(40),
      }),
    ).resolves.toEqual([]);
    expect(calls.filter((url) => new URL(url).pathname.includes("/compare/"))).toHaveLength(5);
    expect(calls.filter((url) => new URL(url).pathname.endsWith("/commits"))).toHaveLength(5);
  });

  it("uses only the newest path commit when no base commit exists", async () => {
    const calls: string[] = [];
    let author: unknown = { login: "source-author", type: "User" };
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/commits")) {
          return response([{ sha: "newest", author }]);
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      },
    });

    await expect(
      repository.listSourceChangeAuthors({ path: "locales/en.json", headCommit: "f".repeat(40) }),
    ).resolves.toEqual(["source-author"]);
    author = { login: "ci[bot]", type: "User" };
    await expect(
      repository.listSourceChangeAuthors({ path: "locales/en.json", headCommit: "f".repeat(40) }),
    ).resolves.toEqual([]);
    expect(calls.map((url) => new URL(url).searchParams.get("per_page"))).toEqual(["1", "1"]);
    expect(calls.every((url) => !new URL(url).searchParams.has("page"))).toBe(true);
  });

  it("posts assignees and returns the logins GitHub actually assigned", async () => {
    let request: { url: string; method: string; body: unknown } | undefined;
    const repository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        request = {
          url,
          method: (init?.method ?? "GET").toUpperCase(),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        return response(
          { assignees: [{ login: "existing-maintainer" }, { login: "alice" }, { login: "bob" }] },
          201,
        );
      },
    });

    await expect(
      repository.addPullRequestAssignees("https://github.com/example/app/pull/7", [
        "alice",
        "ALICE",
        "bob",
      ]),
    ).resolves.toEqual(["alice", "bob"]);
    expect(request).toEqual({
      url: expect.stringContaining("/repos/example/app/issues/7/assignees"),
      method: "POST",
      body: { assignees: ["alice", "bob"] },
    });
  });
});
