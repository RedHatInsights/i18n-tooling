import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendGitHubStepSummary } from "../src/append-step-summary.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("GitHub step summary append", () => {
  it("appends Markdown to the configured summary file", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "i18n-step-summary-"));
    const summaryPath = join(temporaryDirectory, "summary.md");
    await writeFile(summaryPath, "Earlier output\n", "utf8");

    const warnings: string[] = [];
    await appendGitHubStepSummary(summaryPath, "## Phrase reconcile", (warning) => {
      warnings.push(warning);
    });

    expect(await readFile(summaryPath, "utf8")).toBe("Earlier output\n\n## Phrase reconcile\n");
    expect(warnings).toEqual([]);
  });

  it("does nothing when no summary path is configured", async () => {
    const warnings: string[] = [];
    await expect(
      appendGitHubStepSummary(undefined, "## Phrase reconcile", (warning) => {
        warnings.push(warning);
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns and resolves when appending fails", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "i18n-step-summary-error-"));
    const warnings: string[] = [];

    await expect(
      appendGitHubStepSummary(temporaryDirectory, "## Phrase reconcile", (warning) => {
        warnings.push(warning);
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Warning: could not append GitHub step summary:/);
  });
});
