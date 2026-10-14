import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const requiredChecks = ["Core validation", "Code quality", "Security checks"];

export function checkEligibility({ tag, plugin, pipeline, reachable, checks, sha }) {
  if (tag !== `v${plugin.version}` || pipeline.version !== plugin.version) {
    throw new Error("Release tag must be v<version> and match both package versions");
  }
  if (pipeline.dependencies[plugin.name] !== plugin.version) {
    throw new Error("CLI plugin dependency must equal the release version exactly");
  }
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

function fetchChecks(repository, sha) {
  return execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      "--jq",
      ".check_runs[]",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function main(env = process.env, getChecks = fetchChecks) {
  // Resume a partial release by dispatching the workflow from the same tag.
  if (!env.GITHUB_REF?.startsWith("refs/tags/v")) throw new Error("Run from a v<version> tag");
  const tag = env.GITHUB_REF.slice("refs/tags/".length);
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const sha = git("rev-parse", "--verify", `${env.GITHUB_REF}^{commit}`);
  // Provenance names the event commit, so it must be the checked-out tag commit.
  if (env.GITHUB_SHA !== sha || git("rev-parse", "HEAD") !== sha) {
    throw new Error("Event SHA and checkout HEAD must equal the tagged commit");
  }
  const [plugin, pipeline] = ["eslint-plugin-i18n", "i18n-pipeline"].map((name) =>
    JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")),
  );
  const reachable =
    spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]).status === 0;
  const checks = getChecks(env.GITHUB_REPOSITORY, sha);
  checkEligibility({ tag, plugin, pipeline, reachable, checks, sha });
  console.log(`Release ${tag} is eligible (${sha}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`Release refused: ${error.message}`);
    process.exitCode = 1;
  }
}
