import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkEligibility, main, requiredChecks } from "./release-check.mjs";

const sha = "a".repeat(40);
const passingChecks = (headSha) =>
  requiredChecks.map((name, id) => ({
    name,
    id,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
  }));
function eligible() {
  return {
    tag: "v0.1.0",
    plugin: { name: "plugin", version: "0.1.0" },
    pipeline: { version: "0.1.0", dependencies: { plugin: "0.1.0" } },
    reachable: true,
    sha,
    checks: passingChecks(sha),
  };
}

test("accepts only matching tags, package versions, exact dependency and main ancestry", () => {
  assert.doesNotThrow(() => checkEligibility(eligible()));
  for (const tag of ["0.1.0", "v0.2.0", "main"]) {
    assert.throws(() => checkEligibility({ ...eligible(), tag }), /tag/);
  }
  assert.throws(
    () => checkEligibility({ ...eligible(), pipeline: { version: "0.2.0", dependencies: {} } }),
    /versions/,
  );
  for (const dependency of ["^0.1.0", "workspace:*", undefined]) {
    const pipeline = { version: "0.1.0", dependencies: { plugin: dependency } };
    assert.throws(() => checkEligibility({ ...eligible(), pipeline }), /exactly/);
  }
  assert.throws(() => checkEligibility({ ...eligible(), reachable: false }), /origin\/main/);
});

test("requires every check's newest run to complete successfully on the release SHA", () => {
  for (const name of requiredChecks) {
    const base = eligible();
    const patched = (patch) =>
      base.checks.map((run) => (run.name === name ? { ...run, ...patch } : run));
    const refused = [
      base.checks.filter((run) => run.name !== name),
      patched({ conclusion: "failure" }),
      patched({ conclusion: "skipped" }),
      patched({ status: "in_progress", conclusion: null }),
      patched({ head_sha: "b".repeat(40) }),
      [
        ...base.checks,
        { ...base.checks.find((run) => run.name === name), id: 100, conclusion: "failure" },
      ],
    ];
    for (const checks of refused) {
      assert.throws(() => checkEligibility({ ...base, checks }), /Required check/);
    }
  }
});

test("refuses off-main lightweight and annotated tags and binds the event SHA", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-check-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });
  process.chdir(root);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "-b", "main");
  for (const [name, manifest] of [
    ["eslint-plugin-i18n", { name: "plugin", version: "0.1.0" }],
    ["i18n-pipeline", { version: "0.1.0", dependencies: { plugin: "0.1.0" } }],
  ]) {
    await mkdir(join(root, "packages", name), { recursive: true });
    await writeFile(join(root, "packages", name, "package.json"), JSON.stringify(manifest));
  }
  git("add", ".");
  git("commit", "-m", "On main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("commit", "--allow-empty", "-m", "Off main");
  git("tag", "v0.1.0");
  const head = git("rev-parse", "HEAD");
  const env = {
    GITHUB_REF: "refs/tags/v0.1.0",
    GITHUB_SHA: head,
    GITHUB_REPOSITORY: "fixture/repo",
  };
  const run = (overrides = {}) => main({ ...env, ...overrides }, () => passingChecks(head));

  assert.throws(run, /not reachable from origin\/main/);
  git("tag", "-a", "-f", "v0.1.0", "-m", "Annotated");
  assert.throws(run, /not reachable from origin\/main/);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.throws(() => run({ GITHUB_SHA: "b".repeat(40) }), /Event SHA/);
  assert.throws(() => run({ GITHUB_REF: "refs/heads/main" }), /v<version> tag/);
  assert.doesNotThrow(() => run());
});
