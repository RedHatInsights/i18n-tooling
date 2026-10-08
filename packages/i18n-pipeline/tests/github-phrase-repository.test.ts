import { describe, expect, it } from "vitest";
import { GitHubPhraseRepository, GitHubRepositoryError } from "../src/github-phrase-repository.js";
import {
  PhraseBatchStateConflictError,
  type PhraseBatchRecord,
  type PhraseLocalePullRequest,
} from "../src/phrase-workflow.js";

const pullRequest: PhraseLocalePullRequest = {
  repository: "example/app",
  baseRef: "phrase-pilot",
  branch: "i18n/phrase-batch-fr",
  title: "i18n(fr): Phrase translation update",
  body: "Phrase batch test",
  path: "locales/fr.json",
  content: new TextEncoder().encode('{"hello":"Bonjour"}\n'),
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
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

describe("GitHubPhraseRepository", () => {
  it("creates a deterministic locale branch and pull request with the run token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr")) return response({}, 404);
      if (url.endsWith("/git/ref/heads/phrase-pilot")) {
        return response({ object: { sha: "base-commit" } });
      }
      if (url.endsWith("/git/refs"))
        return response({ ref: "refs/heads/i18n/phrase-batch-fr" }, 201);
      if (url.includes("/contents/locales/fr.json?ref=")) return response({}, 404);
      if (url.endsWith("/contents/locales/fr.json")) {
        return response({ content: { sha: "translation-blob" } }, 201);
      }
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
      sha: "base-commit",
    });
    const fileWrite = calls.find((call) => call.url.endsWith("/contents/locales/fr.json"));
    expect(JSON.parse(String(fileWrite?.init?.body))).toMatchObject({
      branch: "i18n/phrase-batch-fr",
      message: "i18n: update locales/fr.json from Phrase",
      content: Buffer.from(pullRequest.content).toString("base64"),
    });
    expect(new Headers(fileWrite?.init?.headers).get("Authorization")).toBe(
      "Bearer github-run-token",
    );
  });

  it("writes both JSON and Frontend YAML before opening the locale PR", async () => {
    const writes: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/pulls?")) return response([]);
      if (url.endsWith("/git/ref/heads/i18n/phrase-batch-fr"))
        return response({ object: { sha: "branch" } });
      if (url.includes("/contents/") && init?.method === "GET") return response({}, 404);
      if (url.includes("/contents/") && init?.method === "PUT") {
        writes.push(url);
        return response({ content: { sha: "blob" } });
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        expect(writes).toHaveLength(2);
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
    expect(writes.map((url) => url.slice(url.indexOf("/contents/")))).toEqual([
      "/contents/locales/fr.json",
      "/contents/deploy/frontend.yaml",
    ]);
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

  it("reuses open or merged PRs and refuses closed unmerged PRs", async () => {
    const openFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/pulls?")) {
        return response([{ state: "open", html_url: "https://github.com/example/app/pull/7" }]);
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

    let calls = 0;
    const mergedRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () => {
        calls += 1;
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

    const closedRepository = new GitHubPhraseRepository({
      repository: "example/app",
      token: "github-run-token",
      stateBranch: "i18n-state",
      fetch: async () => response([{ state: "closed", merged_at: null }]),
    });
    await expect(closedRepository.createOrUpdatePullRequest(pullRequest)).rejects.toMatchObject({
      status: 409,
      permanent: true,
    });
  });
});
