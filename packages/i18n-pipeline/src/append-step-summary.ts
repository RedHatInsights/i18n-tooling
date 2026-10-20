import { appendFile } from "node:fs/promises";

export async function appendGitHubStepSummary(
  path: string | undefined,
  summary: string,
  warn: (message: string) => void,
): Promise<void> {
  if (!path) return;
  try {
    await appendFile(path, `\n${summary}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`Warning: could not append GitHub step summary: ${detail}`);
  }
}
