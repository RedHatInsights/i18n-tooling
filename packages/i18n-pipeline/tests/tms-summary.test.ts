import { describe, expect, it } from "vitest";
import {
  formatTmsNextStep,
  formatTmsResultLine,
  formatTmsRunSummary,
  formatTmsSubmitSummary,
  type TmsSummaryContext,
} from "../src/tms-summary.js";
import type { PhraseBatchRecord, PhraseReconcileResult } from "../src/phrase-workflow.js";

const batchKey = "6c9099ac7718" + "a".repeat(52);
const sourceCommit = "cb54f58" + "b".repeat(33);
const context: TmsSummaryContext = {
  repository: "example/i18n-hub-test-consumer",
  sourcePath: "locales/translation-template.json",
};

function result(overrides: Partial<PhraseReconcileResult> = {}): PhraseReconcileResult {
  return {
    batchKey,
    phraseLocale: "fr",
    phase: "pending",
    ...overrides,
  };
}

function batchLevelResult(overrides: Partial<PhraseReconcileResult> = {}): PhraseReconcileResult {
  const value = result(overrides);
  delete value.phraseLocale;
  return value;
}

function phraseBatch(overrides: Partial<PhraseBatchRecord> = {}): PhraseBatchRecord {
  return {
    schema: 1,
    key: batchKey,
    phase: "ready",
    repository: "example/i18n-hub-test-consumer",
    baseRef: "main",
    sourceCommit,
    sourceDigest: "digest",
    config: {
      projectUid: "project-uid",
      region: "us",
      sourceCatalog: {
        path: "locales/translation-template.json",
        filename: "translation-template.json",
        adapter: "formatjs-json",
        locale: "en",
      },
      targetLocales: [
        { phraseLocale: "fr", repositoryLocale: "fr", outputPath: "locales/fr.json" },
        { phraseLocale: "ja", repositoryLocale: "ja", outputPath: "locales/ja.json" },
        { phraseLocale: "ko", repositoryLocale: "ko", outputPath: "locales/ko.json" },
        { phraseLocale: "zh-CN", repositoryLocale: "zh-CN", outputPath: "locales/zh-CN.json" },
      ],
      completionPolicy: { default: "per-locale" },
    },
    createdAt: "2026-10-20T14:20:00.000Z",
    jobs: [
      { uid: "job-fr", targetLang: "fr", workflowLevel: 1 },
      { uid: "job-ja", targetLang: "ja", workflowLevel: 1 },
      { uid: "job-ko", targetLang: "ko", workflowLevel: 1 },
      { uid: "job-zh", targetLang: "zh-CN", workflowLevel: 1 },
    ],
    warningCount: 0,
    locales: {},
    ...overrides,
  };
}

describe("TMS result lines", () => {
  it("prints the invalid translation next step and known links", () => {
    expect(
      formatTmsResultLine(
        result({
          phase: "invalid-translation",
          jobUid: "job-fr",
          jobStatus: "COMPLETED",
          region: "us",
          pullRequestUrl: "https://github.com/example/app/pull/32",
          reason: "The detailed error stays in the pull request comment",
        }),
      ),
    ).toBe(
      "6c9099ac7718 fr: invalid-translation — fix the translation in Phrase; the next sync updates the PR — Phrase job (Completed): https://us.cloud.memsource.com/web/job/job-fr/translate — PR (draft with errors): https://github.com/example/app/pull/32",
    );
  });

  it("keeps the failed next step actionable", () => {
    expect(
      formatTmsNextStep(result({ phase: "failed", reason: "Phrase API returned HTTP 503" })),
    ).toBe("Phrase API returned HTTP 503; fix the Phrase job or configuration before retrying");
  });
});

describe("TMS reconcile summary", () => {
  it("renders a mixed invalid, created, and pending batch as one exact block", () => {
    expect(
      formatTmsRunSummary(context, [
        result({
          repositoryLocale: "fr",
          phase: "invalid-translation",
          jobUid: "job-fr",
          jobStatus: "COMPLETED",
          projectUid: "project-uid",
          region: "us",
          sourceCommit,
          createdAt: "2026-10-20T14:20:00.000Z",
          validationErrorCount: 1,
          validationWarningCount: 2,
          pullRequestAssignees: ["petrsimon"],
          pullRequestUrl: "https://github.com/RedHatInsights/i18n-hub-test-consumer/pull/32",
        }),
        result({
          phraseLocale: "ja",
          repositoryLocale: "ja",
          phase: "pr-created",
          jobUid: "job-ja",
          jobStatus: "COMPLETED",
          projectUid: "project-uid",
          region: "us",
          sourceCommit,
          createdAt: "2026-10-20T14:20:00.000Z",
          pullRequestUrl: "https://github.com/RedHatInsights/i18n-hub-test-consumer/pull/33",
        }),
        result({
          phraseLocale: "ko",
          repositoryLocale: "ko",
          phase: "pending",
          jobUid: "job-ko",
          jobStatus: "ASSIGNED",
          projectUid: "project-uid",
          region: "us",
          sourceCommit,
          createdAt: "2026-10-20T14:20:00.000Z",
        }),
      ]),
    )
      .toBe(`## 🌐 Phrase reconcile · \`i18n-hub-test-consumer\` · \`locales/translation-template.json\`

> [!WARNING]
> **1 locale PR has translation errors.** Fix it in Phrase and keep the job **Completed**; the next sync updates the PR.

**Batch \`6c9099ac7718\`** · source \`cb54f58\` · submitted 2026-10-20 14:20 UTC · [Phrase project](<https://us.cloud.memsource.com/web/project2/show/project-uid>)

| Locale | Result | Phrase job | PR | Assignees | Findings |
| --- | --- | --- | --- | --- | --- |
| fr | ⚠️ invalid translation | [Completed](<https://us.cloud.memsource.com/web/job/job-fr/translate>) | [#32](<https://github.com/RedHatInsights/i18n-hub-test-consumer/pull/32>) | @petrsimon | ❌ 1 · ⚠️ 2 |
| ja | ✅ PR created | [Completed](<https://us.cloud.memsource.com/web/job/job-ja/translate>) | [#33](<https://github.com/RedHatInsights/i18n-hub-test-consumer/pull/33>) | — | ✅ |
| ko | ⏳ waiting in Phrase | [Assigned](<https://us.cloud.memsource.com/web/job/job-ko/translate>) | — | — | — |`);
  });

  it.each([
    [
      "one failed locale",
      [result({ phase: "failed", reason: "State unavailable" })],
      "> **❌ 1 locale failed.** State unavailable See the job log for details.",
    ],
    [
      "several failed locales",
      [result({ phase: "failed" }), result({ phraseLocale: "ja", phase: "failed" })],
      "> **❌ 2 locales failed.** Phrase workflow failed. See the job log for details.",
    ],
    [
      "one invalid locale",
      [result({ phase: "invalid-translation" })],
      "> **1 locale PR has translation errors.** Fix it in Phrase and keep the job **Completed**; the next sync updates the PR.",
    ],
    [
      "several invalid locales",
      [
        result({ phase: "invalid-translation" }),
        result({ phraseLocale: "ja", phase: "invalid-translation" }),
      ],
      "> **2 locale PRs have translation errors.** Fix them in Phrase and keep the jobs **Completed**; the next sync updates the PRs.",
    ],
    [
      "one retrying locale",
      [result({ phase: "retrying" })],
      "> **🔁 1 locale retries on the next run.**",
    ],
    [
      "several retrying locales",
      [result({ phase: "retrying" }), result({ phraseLocale: "ja", phase: "retrying" })],
      "> **🔁 2 locales retry on the next run.**",
    ],
    ["one pending locale", [result({ phase: "pending" })], "> **⏳ 1 locale waiting in Phrase.**"],
    [
      "several pending locales",
      [result({ phase: "pending" }), result({ phraseLocale: "ja", phase: "pending" })],
      "> **⏳ 2 locales waiting in Phrase.**",
    ],
  ] as const)("chooses the summary alert for %s", (_label, results, expected) => {
    expect(formatTmsRunSummary(context, results)).toContain(expected);
  });

  it("shows a batch-level result, FEO marker, and project link", () => {
    const summary = formatTmsRunSummary({ ...context, frontendTemplate: true }, [
      batchLevelResult({
        phase: "failed",
        reason: "State branch could not be read",
        sourceCommit,
        createdAt: "2026-10-20T14:20:00.000Z",
        projectUid: "project-uid",
        region: "us",
      }),
    ]);

    expect(summary).toContain(
      "**Batch `6c9099ac7718`** · source `cb54f58` · submitted 2026-10-20 14:20 UTC · (FEO) · [Phrase project](<https://us.cloud.memsource.com/web/project2/show/project-uid>)",
    );
    expect(summary).toContain("**Batch result:** ❌ failed — State branch could not be read");
    expect(summary).toContain("| Locale | Result | Phrase job | PR | Assignees | Findings |");
  });

  it("escapes pipes, line breaks, and backticks and title-cases job status", () => {
    const summary = formatTmsRunSummary({ ...context, sourcePath: "locales/a|b`c\n.json" }, [
      result({
        phraseLocale: "fr|de\n`x",
        phase: "retrying",
        jobUid: "job-fr",
        jobStatus: "IN_PROGRESS",
        projectUid: "project-uid",
        region: "us",
        pullRequestAssignees: ["dev|one"],
      }),
    ]);

    expect(summary).toContain("``locales/a\\|b`c .json``");
    expect(summary).toContain(
      "| fr\\|de \\`x | 🔁 retrying next run | [In Progress](<https://us.cloud.memsource.com/web/job/job-fr/translate>) | — | @dev\\|one | — |",
    );
  });

  it("limits locale rows and reports the omitted count", () => {
    const results = Array.from({ length: 205 }, (_, index) =>
      result({ phraseLocale: `locale-${index}`, phase: "pending" }),
    );
    const summary = formatTmsRunSummary(context, results);
    const localeRows = summary.match(/^\| locale-\d+ \|/gm) ?? [];

    expect(localeRows).toHaveLength(200);
    expect(summary).toContain("…and 5 more");
  });

  it("uses a tip when all results are up to date and a note when there are none", () => {
    expect(formatTmsRunSummary(context, [result({ phase: "pr-created" })])).toContain(
      "> **✅ All locale PRs are up to date.**",
    );
    expect(formatTmsRunSummary(context, [])).toContain("> No active Phrase batches.");
  });
});

describe("TMS submit summary", () => {
  it("renders a newly submitted batch", () => {
    expect(formatTmsSubmitSummary(context, phraseBatch(), true))
      .toBe(`## 🌐 Phrase submit · \`i18n-hub-test-consumer\` · \`locales/translation-template.json\`

| Batch | Result | Source | Jobs | Locales | |
| --- | --- | --- | --- | --- | --- |
| \`6c9099ac7718\` | 🆕 submitted | \`cb54f58\` | 4 | fr, ja, ko, zh-CN | [Open in Phrase](<https://us.cloud.memsource.com/web/project2/show/project-uid>) |`);
  });

  it("marks an existing unchanged batch", () => {
    expect(formatTmsSubmitSummary(context, phraseBatch(), false)).toContain(
      "| `6c9099ac7718` | ↩️ no source change | `cb54f58` | 4 | fr, ja, ko, zh-CN |",
    );
  });

  it("places failed locales and import warnings in an alert above the table", () => {
    const summary = formatTmsSubmitSummary(
      context,
      phraseBatch({
        phase: "failed",
        warningCount: 1,
        failureReason: "Phrase import failed for job job-fr",
        locales: { fr: { phase: "failed", failureReason: "Phrase import failed for job job-fr" } },
      }),
      true,
    );

    expect(summary).toContain("> [!CAUTION]");
    expect(summary).toContain(
      "> **❌ 1 locale failed.** Phrase import failed for job job-fr See the job log for details.",
    );
    expect(summary).toContain("> **1 Phrase import warning.** See the job log for details.");
    expect(summary.indexOf("> [!CAUTION]")).toBeLessThan(summary.indexOf("| Batch | Result |"));
  });
});
