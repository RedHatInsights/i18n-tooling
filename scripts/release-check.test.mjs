import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEligibility, fetchChecks, requiredChecks } from "./release-check.mjs";

const sha = "a".repeat(40);
function eligible() {
  return {
    tag: "v0.1.0",
    plugin: { name: "plugin", version: "0.1.0" },
    pipeline: { version: "0.1.0", dependencies: { plugin: "0.1.0" } },
    reachable: true,
    sha,
    eventRef: "refs/tags/v0.1.0",
    eventSha: sha,
    checks: requiredChecks.map((name, id) => ({
      name,
      id,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    })),
  };
}

test("accepts only matching tags, package versions, exact dependency and main ancestry", () => {
  assert.doesNotThrow(() => checkEligibility(eligible()));
  for (const tag of ["0.1.0", "v0.2.0", "refs/tags/v0.1.0", "main"]) {
    assert.throws(() => checkEligibility({ ...eligible(), tag }), /tag/);
  }
  assert.throws(
    () => checkEligibility({ ...eligible(), plugin: { name: "plugin", version: "bad" } }),
    /semver/,
  );
  assert.throws(
    () =>
      checkEligibility({
        ...eligible(),
        pipeline: { version: "0.2.0", dependencies: { plugin: "0.1.0" } },
      }),
    /versions/,
  );
  for (const dependency of ["^0.1.0", "~0.1.0", "workspace:*", "0.2.0", undefined]) {
    assert.throws(
      () =>
        checkEligibility({
          ...eligible(),
          pipeline: { version: "0.1.0", dependencies: { plugin: dependency } },
        }),
      /exactly/,
    );
  }
  assert.throws(() => checkEligibility({ ...eligible(), reachable: false }), /origin\/main/);
});

test("binds dispatch input to the event tag and provenance commit", () => {
  for (const eventRef of [undefined, "refs/heads/main", "refs/tags/v0.2.0"]) {
    assert.throws(() => checkEligibility({ ...eligible(), eventRef }), /event ref/);
  }
  for (const eventSha of [undefined, "b".repeat(40)]) {
    assert.throws(() => checkEligibility({ ...eligible(), eventSha }), /event SHA/);
  }
});

test("checks eligibility without running candidate code or granting publishing permissions", async () => {
  const require = createRequire(new URL("../packages/i18n-pipeline/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  const preflight = workflow.jobs.preflight;
  const publish = workflow.jobs.release;
  assert.ok(preflight);
  assert.equal(preflight.permissions["id-token"], undefined);
  assert.equal(preflight.environment, undefined);
  assert.equal(publish.needs, "preflight");
  assert.equal(publish.permissions["id-token"], "write");
  const scripts = preflight.steps.map((step) => step.run ?? "").join("\n");
  assert.match(scripts, /git show origin\/main:scripts\/release-check\.mjs/);
  assert.match(scripts, /git show origin\/main:scripts\/set-version\.mjs/);
  assert.match(scripts, /await main\(\)/);
  assert.doesNotMatch(scripts, /npm (run|install|publish)|bun install/);
  const ci = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(ci.on.push.branches, ["**"]);
  assert.equal(ci.on.push.tags, undefined);
});

test("trusted-main policy checks ancestry for lightweight and annotated tags", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
  git("init", "-b", "main");
  await mkdir(join(root, "scripts"));
  for (const name of ["release-check.mjs", "set-version.mjs"]) {
    await writeFile(
      join(root, "scripts", name),
      await readFile(new URL(name, import.meta.url), "utf8"),
    );
  }
  for (const [name, manifest] of [
    ["eslint-plugin-i18n", { name: "plugin", version: "0.1.0" }],
    ["i18n-pipeline", { version: "0.1.0", dependencies: { plugin: "0.1.0" } }],
  ]) {
    await mkdir(join(root, "packages", name), { recursive: true });
    await writeFile(join(root, "packages", name, "package.json"), JSON.stringify(manifest));
  }
  git("add", ".");
  git("commit", "-m", "Trusted policy fixture");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  await writeFile(join(root, "candidate.txt"), "Off-main candidate\n");
  git("add", ".");
  git("commit", "-m", "Off-main candidate fixture");
  git("tag", "v0.1.0");
  const candidateSha = git("rev-parse", "HEAD");
  const policy = join(root, "trusted-policy");
  await mkdir(policy);
  for (const name of ["release-check.mjs", "set-version.mjs"]) {
    await writeFile(join(policy, name), git("show", `origin/main:scripts/${name}`));
  }
  const mock = join(root, "mock-api.mjs");
  await writeFile(
    mock,
    `globalThis.fetch = async () => new Response(JSON.stringify({ check_runs: ${JSON.stringify(requiredChecks)}.map((name, id) => ({ name, id, head_sha: process.env.RELEASE_SHA, status: "completed", conclusion: "success" })) }));`,
  );
  const options = {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: "v0.1.0",
      RELEASE_SHA: candidateSha,
      GITHUB_SHA: candidateSha,
      GITHUB_REF: "refs/tags/v0.1.0",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_TOKEN: "fixture-not-a-token",
    },
  };
  const runPolicy = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        mock,
        "--input-type=module",
        "-e",
        "const { main } = await import(process.env.POLICY_MODULE); await main();",
      ],
      {
        ...options,
        env: { ...options.env, POLICY_MODULE: join(policy, "release-check.mjs") },
      },
    );
  for (const annotated of [false, true]) {
    if (annotated) {
      git("-c", "tag.gpgsign=false", "tag", "-a", "-f", "v0.1.0", "-m", "Annotated fixture");
    }
    const result = runPolicy();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not reachable from origin\/main/);
  }
  git("update-ref", "refs/remotes/origin/main", candidateSha);
  const result = runPolicy();
  assert.equal(result.status, 0, result.stderr);
});

test("requires every check's newest run to complete successfully on the release SHA", () => {
  for (const name of requiredChecks) {
    const base = eligible();
    assert.throws(
      () => checkEligibility({ ...base, checks: base.checks.filter((run) => run.name !== name) }),
      /Required check/,
    );
    for (const patch of [
      { conclusion: "failure" },
      { conclusion: "skipped" },
      { status: "in_progress", conclusion: null },
      { head_sha: "b".repeat(40) },
    ]) {
      assert.throws(
        () =>
          checkEligibility({
            ...base,
            checks: base.checks.map((run) => (run.name === name ? { ...run, ...patch } : run)),
          }),
        /Required check/,
      );
    }
    assert.throws(
      () =>
        checkEligibility({
          ...base,
          checks: [
            ...base.checks,
            { ...base.checks.find((run) => run.name === name), id: 100, conclusion: "failure" },
          ],
        }),
      /Required check/,
    );
  }
});

test("fetches paginated checks using a read-only API request", async () => {
  const calls = [];
  const checks = await fetchChecks("owner/repo", sha, "token", async (url, options) => {
    calls.push({ url, options });
    return new globalThis.Response(
      JSON.stringify({
        check_runs:
          calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }],
      }),
    );
  });
  assert.equal(checks.length, 101);
  assert.match(calls[1].url, /page=2$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token");
  assert.equal(calls[0].options.method, undefined);
  await assert.rejects(
    fetchChecks(
      "owner/repo",
      sha,
      "token",
      async () => new globalThis.Response("", { status: 403 }),
    ),
    /HTTP 403/,
  );
  await assert.rejects(fetchChecks("bad", sha, "token"), /required/);
  await assert.rejects(fetchChecks("owner/repo", "bad", "token"), /required/);
  await assert.rejects(fetchChecks("owner/repo", sha, ""), /required/);
});
