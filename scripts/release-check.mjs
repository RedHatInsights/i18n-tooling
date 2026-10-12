import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseVersion } from "./set-version.mjs";

export const requiredChecks = ["Core validation", "Code quality", "Security checks"];

export function checkEligibility({
  tag,
  plugin,
  pipeline,
  reachable,
  checks,
  sha,
  eventRef,
  eventSha,
}) {
  parseVersion(plugin.version);
  if (tag !== `v${plugin.version}` || pipeline.version !== plugin.version) {
    throw new Error("Release tag must be v<version> and match both package versions");
  }
  if (pipeline.dependencies[plugin.name] !== plugin.version) {
    throw new Error("CLI plugin dependency must equal the release version exactly");
  }
  if (eventRef !== `refs/tags/${tag}`) {
    throw new Error("GitHub event ref must match the release tag");
  }
  if (eventSha !== sha) throw new Error("GitHub event SHA must equal the tagged commit");
  if (!reachable) throw new Error("Tagged commit is not reachable from origin/main");
  for (const name of requiredChecks) {
    const runs = checks.filter((run) => run.name === name && run.head_sha === sha);
    // Require the newest run: a stale successful run must not hide a failed rerun.
    const latest = runs.sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(`Required check "${name}" has not concluded success for ${sha}`);
    }
  }
}

export async function fetchChecks(repository, sha, token, fetchImpl = globalThis.fetch) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[a-f0-9]{40}$/i.test(sha ?? "") ||
    !token
  ) {
    throw new Error("GITHUB_REPOSITORY, RELEASE_SHA and GITHUB_TOKEN are required");
  }
  const checks = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub Checks API returned HTTP ${response.status}`);
    const data = await response.json();
    checks.push(...data.check_runs);
    if (data.check_runs.length < 100) return checks;
  }
}

export async function main(env = process.env) {
  const tag = env.RELEASE_TAG;
  if (!tag || !/^v[0-9]/.test(tag)) throw new Error("RELEASE_TAG must be a v<version> tag");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const sha = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  if (env.RELEASE_SHA !== sha || git("rev-parse", "HEAD") !== sha) {
    throw new Error("RELEASE_SHA and checkout HEAD must equal the tagged commit");
  }
  const [plugin, pipeline] = await Promise.all(
    ["eslint-plugin-i18n", "i18n-pipeline"].map(async (name) =>
      JSON.parse(await readFile(`packages/${name}/package.json`, "utf8")),
    ),
  );
  let reachable = false;
  try {
    git("merge-base", "--is-ancestor", sha, "origin/main");
    reachable = true;
  } catch {
    /* Eligibility logic reports the ancestry failure. */
  }
  const checks = await fetchChecks(env.GITHUB_REPOSITORY, env.RELEASE_SHA, env.GITHUB_TOKEN);
  checkEligibility({
    tag,
    plugin,
    pipeline,
    reachable,
    checks,
    sha,
    eventRef: env.GITHUB_REF,
    eventSha: env.GITHUB_SHA,
  });
  console.log(`Release ${tag} is eligible (${sha}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Release refused: ${error.message}`);
    process.exitCode = 1;
  });
}
