import { phraseJobUrl, phraseProjectUrl } from "./phrase-client.js";
import {
  codeSpan,
  NO_PHRASE_JOB_CREATED_VOID_REASON,
  normalizeTableCell,
} from "./phrase-workflow.js";
import type { PhraseBatchRecord, PhraseReconcileResult } from "./phrase-workflow.js";

export interface TmsSummaryContext {
  repository: string;
  sourcePath: string;
  frontendTemplate?: boolean;
}

const RESULT_CELLS: Record<PhraseReconcileResult["phase"], string> = {
  pending: "⏳ waiting in Phrase",
  retrying: "🔁 retrying next run",
  failed: "❌ failed",
  "invalid-translation": "⚠️ invalid translation",
  "pr-created": "✅ PR created",
  superseded: "⏭️ superseded",
};

const MAX_SUMMARY_ROWS = 200;
const MAX_STEP_SUMMARY_BYTES = 900_000;

export function formatTmsNextStep(result: PhraseReconcileResult): string {
  switch (result.phase) {
    case "pending":
      return "waiting for translation in Phrase; continues when the job is Completed";
    case "retrying":
      return ["temporary; the next run continues", result.reason].filter(Boolean).join(" — ");
    case "failed": {
      const reason = result.reason ?? "Phrase reported a failure";
      const lowerReason = reason.toLowerCase();
      if (lowerReason.includes("phrase recycle bin")) return reason;
      if (reason === NO_PHRASE_JOB_CREATED_VOID_REASON) {
        return `${reason}; dispatch submit again to start the next attempt`;
      }
      if (result.pullRequestUrl) {
        return `${reason}; fix the translation in Phrase, then reconcile again`;
      }
      if (lowerReason.includes("validation") || lowerReason.includes("translation")) {
        return `${reason}; fix the translation in Phrase, then reconcile again`;
      }
      return `${reason}; fix the Phrase job or configuration before retrying`;
    }
    case "invalid-translation":
      return "fix the translation in Phrase; the next sync updates the PR";
    case "pr-created":
      return "review the locale pull request";
    case "superseded":
      return "newer source submitted";
  }
}

export function formatTmsResultLine(result: PhraseReconcileResult): string {
  const locale = result.repositoryLocale ?? result.phraseLocale ?? "(batch)";
  const nextStep = formatTmsNextStep(result);
  const withAssignmentWarning =
    result.phase === "pr-created" && result.reason ? `${nextStep} — ${result.reason}` : nextStep;
  const parts = [
    `${result.batchKey.slice(0, 12)} ${locale}: ${result.phase} — ${withAssignmentWarning}`,
  ];
  if (result.jobUid && result.region) {
    const status = result.jobStatus ? ` (${titleCaseStatus(result.jobStatus)})` : "";
    parts.push(`Phrase job${status}: ${phraseJobUrl(result.region, result.jobUid)}`);
  } else if (result.jobStatus) {
    parts.push(`Phrase job status: ${titleCaseStatus(result.jobStatus)}`);
  }
  if (result.pullRequestUrl) {
    const label =
      result.phase === "failed" || result.phase === "invalid-translation"
        ? "PR (draft with errors)"
        : "PR";
    parts.push(`${label}: ${result.pullRequestUrl}`);
  }
  return parts
    .join(" — ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTmsRunSummary(
  context: TmsSummaryContext,
  results: readonly PhraseReconcileResult[],
): string {
  const lines = [reconcileHeading(context)];
  if (!results.length) {
    lines.push("", "> [!NOTE]", "> No active Phrase batches.");
    return keepWithinStepSummaryLimit(lines);
  }

  lines.push("", ...formatReconcileAlert(results));
  let shownRows = 0;
  const batches = groupByBatch(results);
  for (const [batchKey, batchResults] of batches) {
    lines.push("", formatBatchLine(batchKey, batchResults, context.frontendTemplate === true));
    for (const result of batchResults.filter((candidate) => !candidate.phraseLocale)) {
      const detail = shorten(result.reason ?? formatTmsNextStep(result), 200);
      lines.push(
        `**Batch result:** ${RESULT_CELLS[result.phase]}${detail ? ` — ${escapeTableCell(detail)}` : ""}`,
      );
    }
    lines.push(
      "",
      "| Locale | Result | Phrase job | PR | Assignees | Findings |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const result of batchResults.filter((candidate) => candidate.phraseLocale)) {
      if (shownRows === MAX_SUMMARY_ROWS) continue;
      lines.push(formatReconcileRow(result));
      shownRows += 1;
    }
  }

  const localeCount = results.filter((result) => result.phraseLocale).length;
  const hiddenRows = localeCount - shownRows;
  if (hiddenRows > 0) lines.push("", `…and ${hiddenRows} more`);
  return keepWithinStepSummaryLimit(lines);
}

export function formatTmsSubmitSummary(
  context: TmsSummaryContext,
  batch: PhraseBatchRecord,
  createdThisRun: boolean,
): string {
  const lines = [submitHeading(context)];
  const failedLocales = batch.config.targetLocales
    .map((target) => batch.locales[target.phraseLocale])
    .filter((locale) => locale?.phase === "failed");
  const failureCount = failedLocales.length || (batch.phase === "failed" ? 1 : 0);
  const importWarnings = batch.warningCount;

  if (failureCount) {
    const firstReason = failedLocales.find((locale) => locale.failureReason)?.failureReason;
    const reason = shorten(firstReason ?? batch.failureReason ?? "Phrase submission failed.", 200);
    lines.push(
      "",
      "> [!CAUTION]",
      `> **❌ ${failureCount} locale${failureCount === 1 ? "" : "s"} failed.** ${escapeAlertText(reason)} See the job log for details.`,
    );
    if (importWarnings) {
      lines.push(
        `> **${importWarnings} Phrase import warning${importWarnings === 1 ? "" : "s"}.** See the job log for details.`,
      );
    }
  } else if (importWarnings) {
    lines.push(
      "",
      "> [!WARNING]",
      `> **${importWarnings} Phrase import warning${importWarnings === 1 ? "" : "s"}.** See the job log for details.`,
    );
  }

  const locales = batch.config.targetLocales
    .map((target) => escapeTableCell(target.repositoryLocale))
    .join(", ");
  const projectLink = markdownLink(
    "Open in Phrase",
    phraseProjectUrl(batch.config.region, batch.config.projectUid),
  );
  lines.push(
    "",
    "| Batch | Result | Source | Jobs | Locales | |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${codeSpan(batch.key.slice(0, 12))} | ${createdThisRun ? "🆕 submitted" : "↩️ no source change"} | ${codeSpan(batch.sourceCommit.slice(0, 7))} | ${batch.jobs.length} | ${locales} | ${projectLink} |`,
  );
  return keepWithinStepSummaryLimit(lines);
}

export function formatTmsFailureSummary(
  command: "submit" | "reconcile",
  context: TmsSummaryContext,
): string {
  const lines = [command === "submit" ? submitHeading(context) : reconcileHeading(context)];
  lines.push(
    "",
    "> [!CAUTION]",
    `> **${command === "submit" ? "Submit" : "Reconcile"} stopped before locale results were available.** See the job log for details.`,
  );
  if (command === "submit") {
    lines.push(
      "",
      "| Batch | Result | Source | Jobs | Locales | |",
      "| --- | --- | --- | --- | --- | --- |",
    );
  }
  return keepWithinStepSummaryLimit(lines);
}

function reconcileHeading(context: TmsSummaryContext): string {
  return `## 🌐 Phrase reconcile · ${codeSpan(shorten(repositoryName(context.repository), 300))} · ${codeSpan(shorten(context.sourcePath, 300))}`;
}

function submitHeading(context: TmsSummaryContext): string {
  return `## 🌐 Phrase submit · ${codeSpan(shorten(repositoryName(context.repository), 300))} · ${codeSpan(shorten(context.sourcePath, 300))}`;
}

function repositoryName(repository: string): string {
  return repository.split("/").at(-1) || repository;
}

function groupByBatch(
  results: readonly PhraseReconcileResult[],
): Map<string, PhraseReconcileResult[]> {
  const batches = new Map<string, PhraseReconcileResult[]>();
  for (const result of results) {
    const batch = batches.get(result.batchKey) ?? [];
    batch.push(result);
    batches.set(result.batchKey, batch);
  }
  return batches;
}

function formatReconcileAlert(results: readonly PhraseReconcileResult[]): string[] {
  const failed = results.filter((result) => result.phase === "failed");
  if (failed.length) {
    const reason = shorten(
      failed.find((result) => result.reason)?.reason ?? "Phrase workflow failed.",
      200,
    );
    return [
      "> [!CAUTION]",
      `> **❌ ${failed.length} locale${failed.length === 1 ? "" : "s"} failed.** ${escapeAlertText(reason)} See the job log for details.`,
    ];
  }

  const invalid = results.filter((result) => result.phase === "invalid-translation");
  if (invalid.length) {
    const plural = invalid.length === 1 ? "" : "s";
    const pronoun = invalid.length === 1 ? "it" : "them";
    const article = invalid.length === 1 ? "the job" : "the jobs";
    const finalPr = invalid.length === 1 ? "the PR" : "the PRs";
    const verb = invalid.length === 1 ? "has" : "have";
    return [
      "> [!WARNING]",
      `> **${invalid.length} locale PR${plural} ${verb} translation errors.** Fix ${pronoun} in Phrase and keep ${article} **Completed**; the next sync updates ${finalPr}.`,
    ];
  }

  const retrying = results.filter((result) => result.phase === "retrying");
  if (retrying.length) {
    return [
      "> [!NOTE]",
      `> **🔁 ${retrying.length} locale${retrying.length === 1 ? "" : "s"} ${retrying.length === 1 ? "retries" : "retry"} on the next run.**`,
    ];
  }

  const pending = results.filter((result) => result.phase === "pending");
  if (pending.length) {
    return [
      "> [!NOTE]",
      `> **⏳ ${pending.length} locale${pending.length === 1 ? "" : "s"} waiting in Phrase.**`,
    ];
  }

  return ["> [!TIP]", "> **✅ All locale PRs are up to date.**"];
}

function formatBatchLine(
  batchKey: string,
  results: readonly PhraseReconcileResult[],
  frontendTemplate: boolean,
): string {
  const sourceCommit = results.find((result) => result.sourceCommit)?.sourceCommit;
  const createdAt = results.find((result) => result.createdAt)?.createdAt;
  const project = results.find((result) => result.projectUid && result.region);
  const projectLink =
    project?.projectUid && project.region
      ? markdownLink("Phrase project", phraseProjectUrl(project.region, project.projectUid))
      : undefined;
  const parts = [
    `**Batch ${codeSpan(batchKey.slice(0, 12))}**`,
    `source ${sourceCommit ? codeSpan(sourceCommit.slice(0, 7)) : "—"}`,
    `submitted ${formatTimestamp(createdAt)}`,
  ];
  if (frontendTemplate) parts.push("(FEO)");
  if (projectLink) parts.push(projectLink);
  return parts.join(" · ");
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "—";
  return `${new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatReconcileRow(result: PhraseReconcileResult): string {
  const locale = result.repositoryLocale ?? result.phraseLocale ?? "—";
  const phraseJob = formatPhraseJobCell(result);
  const pullRequest = formatPullRequestCell(result);
  const assignees = result.pullRequestAssignees?.length
    ? result.pullRequestAssignees.map((login) => `@${login}`).join(", ")
    : "—";
  const findings = formatFindingsCell(result);
  return `| ${escapeTableCell(locale)} | ${RESULT_CELLS[result.phase]} | ${phraseJob} | ${pullRequest} | ${escapeTableCell(assignees)} | ${findings} |`;
}

function formatPhraseJobCell(result: PhraseReconcileResult): string {
  if (result.jobUid && result.region) {
    const label = result.jobStatus ? titleCaseStatus(result.jobStatus) : "Open job";
    return markdownLink(label, phraseJobUrl(result.region, result.jobUid));
  }
  return result.jobStatus ? escapeTableCell(titleCaseStatus(result.jobStatus)) : "—";
}

function formatPullRequestCell(result: PhraseReconcileResult): string {
  if (!result.pullRequestUrl) return "—";
  const number = pullRequestNumber(result.pullRequestUrl);
  return number ? markdownLink(`#${number}`, result.pullRequestUrl) : "—";
}

function pullRequestNumber(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.pathname.match(/\/pull\/(\d+)\/?$/)?.[1];
  } catch {
    return undefined;
  }
}

function formatFindingsCell(result: PhraseReconcileResult): string {
  if (!result.pullRequestUrl) return "—";
  const counts = [
    result.validationErrorCount ? `❌ ${result.validationErrorCount}` : "",
    result.validationWarningCount ? `⚠️ ${result.validationWarningCount}` : "",
  ].filter(Boolean);
  return counts.length ? counts.join(" · ") : "✅";
}

function markdownLink(label: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return escapeTableCell(label);
    return `[${escapeTableCell(label)}](<${url.href.replaceAll("|", "%7C")}>)`;
  } catch {
    return escapeTableCell(label);
  }
}

function titleCaseStatus(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function escapeTableCell(value: string): string {
  return shorten(normalizeTableCell(value), 500).replaceAll("`", "\\`");
}

function escapeAlertText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(value: string, max: number): string {
  const characters = [
    ...value
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  return characters.length > max
    ? `${characters.slice(0, max - 1).join("")}…`
    : characters.join("");
}

function keepWithinStepSummaryLimit(lines: readonly string[]): string {
  const summary = lines.join("\n");
  if (new TextEncoder().encode(summary).byteLength <= MAX_STEP_SUMMARY_BYTES) return summary;

  const suffix = "\n\n…summary shortened to fit GitHub's step-summary limit.";
  const retained: string[] = [];
  for (const line of lines) {
    const candidate = [...retained, line].join("\n");
    if (new TextEncoder().encode(`${candidate}${suffix}`).byteLength > MAX_STEP_SUMMARY_BYTES) {
      break;
    }
    retained.push(line);
  }
  return `${retained.join("\n")}${suffix}`;
}
