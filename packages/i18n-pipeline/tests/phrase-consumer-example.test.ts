import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogAdapterRegistry, checkCatalogs } from "../src/index.js";
import {
  PhraseWorkflow,
  type PhraseBatchRecord,
  type PhraseBatchStateStore,
  type PhraseLocalePullRequest,
  type PhraseWorkflowConfig,
  type PhraseWorkflowDependencies,
  type PhraseWorkflowRepository,
} from "../src/phrase-workflow.js";

const sourceBytes = new TextEncoder().encode(
  JSON.stringify({
    greeting: { defaultMessage: "Hello {name}", description: "Greeting" },
    ready: {
      defaultMessage: "Ready",
      description: { context: "Button", text: "Status label" },
    },
  }),
);
const phraseExportBytes = new TextEncoder().encode(
  JSON.stringify({
    greeting: { defaultMessage: "Bonjour {name}", description: "Greeting" },
    ready: {
      defaultMessage: "Prêt",
      description: { context: "Button", text: "Status label" },
    },
  }),
);
const config: PhraseWorkflowConfig = {
  projectUid: "example-project",
  region: "eu",
  sourceCatalog: {
    path: "locales/translation-template.json",
    filename: "translation-template.json",
    adapter: "formatjs-json",
    locale: "en",
    useProjectFileImportSettings: true,
  },
  targetAdapter: "formatjs-json",
  targetLocales: [
    { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "src/locales/fr.json" },
  ],
  completionPolicy: { default: "per-locale" },
};
const assembleLocalesScript = fileURLToPath(
  new URL("../../../examples/phrase-consumer/scripts/assemble-locales.mjs", import.meta.url),
);

class MemoryState implements PhraseBatchStateStore {
  private readonly batches = new Map<string, { record: PhraseBatchRecord; revision: string }>();

  async readBatch(key: string) {
    return this.batches.get(key);
  }

  async listBatchKeys() {
    return [...this.batches.keys()];
  }

  async listBatches() {
    return [...this.batches.values()];
  }

  async createBatch(record: PhraseBatchRecord): Promise<string> {
    const revision = "1";
    this.batches.set(record.key, { record, revision });
    return revision;
  }

  async updateBatch(record: PhraseBatchRecord, expectedRevision: string): Promise<string> {
    const current = this.batches.get(record.key);
    if (!current || current.revision !== expectedRevision) throw new Error("state conflict");
    const revision = String(Number(expectedRevision) + 1);
    this.batches.set(record.key, { record, revision });
    return revision;
  }
}

describe("Phrase consumer example", () => {
  it("assembles a reconciled locale PR into runtime locale data without replacing English", async () => {
    const pullRequests: PhraseLocalePullRequest[] = [];
    const phrase: PhraseWorkflowDependencies["phrase"] = {
      async createJob() {
        return {
          asyncRequest: { id: "import-1", action: "IMPORT_JOB" },
          jobs: [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1, lastWorkflowLevel: 1 }],
          unsupportedFiles: [],
          warnings: [],
        };
      },
      async waitForAsyncRequest() {},
      async getJob() {
        return {
          uid: "job-fr",
          targetLang: "fr",
          workflowLevel: 1,
          lastWorkflowLevel: 1,
          status: "COMPLETED",
          imported: true,
          importStatus: { status: "OK", errorMessage: null },
        };
      },
      async startTargetDownload() {
        return "export-1";
      },
      async downloadTargetFile() {
        return phraseExportBytes;
      },
    };
    const repository: PhraseWorkflowRepository = {
      async readFile() {
        return sourceBytes;
      },
      async createOrUpdatePullRequest(input) {
        pullRequests.push(input);
        return "https://github.com/example/consumer/pull/1";
      },
    };
    const workflow = new PhraseWorkflow({
      phrase,
      state: new MemoryState(),
      repository,
      catalogAdapters: new CatalogAdapterRegistry(),
    });

    await workflow.submit({
      repository: "example/consumer",
      baseRef: "main",
      sourceCommit: "abc123",
      sourceBytes,
      config,
    });
    const results = await workflow.reconcile();

    expect(results[0]?.phase).toBe("pr-created");
    expect(pullRequests).toHaveLength(1);
    const localePullRequest = pullRequests[0];
    expect(localePullRequest?.path).toBe("src/locales/fr.json");
    const targetCatalogDocument = JSON.parse(
      new TextDecoder().decode(localePullRequest?.content),
    ) as Record<string, string>;

    const adapters = new CatalogAdapterRegistry();
    const adapter = adapters.get("formatjs-json");
    const sourceCatalog = adapter.read(JSON.parse(new TextDecoder().decode(sourceBytes)), {
      locale: "en",
      role: "source",
      options: {},
    });
    const targetCatalog = adapter.read(targetCatalogDocument, {
      locale: "fr",
      role: "target",
      options: {},
    });
    expect(checkCatalogs(sourceCatalog, targetCatalog)).toEqual({
      missingIds: [],
      extraIds: [],
      argumentMismatches: [],
    });

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "phrase-consumer-example-"));
    const localeDirectory = join(temporaryDirectory, "src/locales");
    try {
      await mkdir(localeDirectory, { recursive: true });
      const englishCatalog = adapter.write(sourceCatalog, {
        locale: "en",
        role: "target",
        options: {},
      });
      await writeFile(
        join(localeDirectory, "translations.json"),
        `${JSON.stringify(englishCatalog)}\n`,
      );
      await writeFile(
        join(localeDirectory, "fr.json"),
        localePullRequest?.content ?? new Uint8Array(),
      );
      execFileSync(process.execPath, [assembleLocalesScript, localeDirectory], {
        stdio: "pipe",
        timeout: 10_000,
      });

      const runtimeData = JSON.parse(
        await readFile(join(localeDirectory, "data.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeData).toEqual({ en: englishCatalog, fr: targetCatalogDocument });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
