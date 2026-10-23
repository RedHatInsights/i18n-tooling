import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repositoryRoot, "skills/i18n-onboarding/scripts/review-checks.mjs");

function git(directory, args) {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, "git " + args.join(" ") + " failed: " + result.stderr);
  return result.stdout.trim();
}

function writeFiles(directory, files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function commit(directory, subject, body = "") {
  const args = [
    "-c",
    "user.name=Review Checks Test",
    "-c",
    "user.email=review-checks@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    subject,
  ];
  if (body) args.push("-m", body);
  git(directory, args);
}

function setup(t, files = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "i18n-review-checks-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = join(temporary, "consumer");
  const origin = join(temporary, "origin.git");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFiles(repo, {
    "package.json":
      JSON.stringify({ name: "consumer", version: "1.0.0", scripts: {} }, null, 2) + "\n",
    ...files,
  });
  git(repo, ["add", "."]);
  commit(repo, "base commit");
  git(temporary, ["init", "--bare", origin]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "origin", "main"]);
  git(repo, ["fetch", "origin"]);
  return { temporary, repo, origin };
}

function update(
  repo,
  files,
  subject = "onboarding change",
  body = "reviewed implementation details",
) {
  writeFiles(repo, files);
  git(repo, ["add", "."]);
  commit(repo, subject, body);
}

function runReview(repo, extra = []) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--repo", repo, "--base", "origin/main", "--offline", "--json", ...extra],
    { cwd: repo, encoding: "utf8" },
  );
}

function rowsFrom(result) {
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(
      "review-checks did not print JSON: " +
        error.message +
        "\n" +
        result.stdout +
        "\n" +
        result.stderr,
    );
  }
  assert.ok(Array.isArray(rows));
  return rows;
}

function row(rows, item) {
  const found = rows.find((entry) => entry.item === item);
  assert.ok(found, "missing " + item + " row");
  return found;
}

function stateRecord(phase, projectUid, filename) {
  return (
    JSON.stringify(
      {
        phase,
        config: { projectUid, sourceCatalog: { filename } },
        baseRef: "main",
      },
      null,
      2,
    ) + "\n"
  );
}

function pushStateBranch(repo, branch, records) {
  git(repo, ["switch", "-c", branch]);
  writeFiles(repo, records);
  git(repo, ["add", "."]);
  commit(repo, "add " + branch + " records");
  git(repo, ["push", "origin", branch]);
  git(repo, ["switch", "main"]);
  git(repo, ["fetch", "origin"]);
}

test("D1 selects the exact .nvmrc pin and reports an lts alias in a composite action", (t) => {
  const { repo } = setup(t, {
    ".nvmrc": "22.14.0\n",
    "package.json":
      JSON.stringify(
        {
          name: "consumer",
          version: "1.0.0",
          packageManager: "npm@11.15.0",
          scripts: {},
        },
        null,
        2,
      ) + "\n",
  });
  update(repo, {
    ".github/actions/setup-node/action.yml":
      "name: setup-node\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n      with:\n        node-version: lts/*\n",
  });
  const result = runReview(repo, ["--node", "22.14.0", "--npm", "11.15.0"]);
  assert.equal(result.status, 0, result.stderr);
  const d1 = row(rowsFrom(result), "D1");
  assert.equal(d1.result, "check");
  assert.match(d1.evidence, /selected 22\.14\.0 from \.nvmrc/);
  assert.match(d1.evidence, /lts\/\*/);
  assert.match(d1.evidence, /action\.yml node-version/);
});

test("D2 fails when a changed package-lock entry lacks a commit-body mention", (t) => {
  const lock = (a, b) => ({
    name: "consumer",
    lockfileVersion: 3,
    packages: {
      "": { name: "consumer", version: "1.0.0" },
      "node_modules/pkg-a": {
        version: a,
        resolved: "https://registry.npmjs.org/pkg-a/-/pkg-a-" + a + ".tgz",
      },
      "node_modules/pkg-b": {
        version: b,
        resolved: "https://registry.npmjs.org/pkg-b/-/pkg-b-" + b + ".tgz",
      },
    },
  });
  const { repo } = setup(t, {
    "package-lock.json": JSON.stringify(lock("1.0.0", "1.0.0"), null, 2) + "\n",
  });
  update(
    repo,
    { "package-lock.json": JSON.stringify(lock("1.1.0", "1.1.0"), null, 2) + "\n" },
    "upgrade dependencies",
    "Upgrade pkg-a for the onboarding caller.",
  );
  const result = runReview(repo);
  assert.equal(result.status, 1);
  const d2 = row(rowsFrom(result), "D2");
  assert.equal(d2.result, "fail");
  assert.match(d2.evidence, /changed packages: pkg-a, pkg-b/);
  assert.match(d2.evidence, /no commit body mentions: pkg-b/);
});

test("D1 compares version files only, not CI expressions, matrix lists or engines", (t) => {
  const { repo } = setup(t, {
    ".nvmrc": "24.15.0\n",
    "package.json":
      JSON.stringify(
        { name: "consumer", version: "1.0.0", engines: { node: ">=22" }, scripts: {} },
        null,
        2,
      ) + "\n",
  });
  update(repo, {
    ".github/workflows/ci.yml":
      "on: push\njobs:\n  test:\n    strategy:\n      matrix:\n        node: [22, 24]\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n          node-version-file: .nvmrc\n",
  });
  const result = runReview(repo, ["--node", "24.15.0", "--npm", "11.15.0"]);
  const d1 = row(rowsFrom(result), "D1");
  assert.doesNotMatch(d1.evidence, /conflicting pins/);
  assert.match(d1.evidence, /selected 24\.15\.0 from \.nvmrc/);
  assert.match(d1.evidence, /expression or engines value\(s\) not compared/);
});

test("D2 accepts a scoped package named without its scope", (t) => {
  const lock = (version) => ({
    lockfileVersion: 3,
    packages: { "node_modules/@scope/pkg": { version } },
  });
  const { repo } = setup(t, { "package-lock.json": JSON.stringify(lock("1.0.0")) + "\n" });
  update(
    repo,
    { "package-lock.json": JSON.stringify(lock("1.1.0")) + "\n" },
    "upgrade pkg",
    "Update pkg from 1.0.0 to 1.1.0.",
  );
  const d2 = row(rowsFrom(runReview(repo)), "D2");
  assert.equal(d2.result, "pass");
});

test("S6 leaves out branches already contained in HEAD", (t) => {
  const { repo } = setup(t);
  git(repo, ["switch", "-c", "parent-work"]);
  writeFiles(repo, { "i18n/catalog-validation.json": "{}\n" });
  git(repo, ["add", "."]);
  commit(repo, "add validation");
  git(repo, ["push", "origin", "parent-work"]);
  git(repo, ["switch", "-c", "onboarding"]);
  git(repo, ["fetch", "origin"]);
  const s6 = row(rowsFrom(runReview(repo)), "S6");
  assert.doesNotMatch(s6.evidence, /parent-work/);
});

test("D2 fails on a package-lock lockfileVersion change", (t) => {
  const before = { lockfileVersion: 2, packages: { "node_modules/pkg": { version: "1.0.0" } } };
  const after = { lockfileVersion: 3, packages: { "node_modules/pkg": { version: "1.0.0" } } };
  const { repo } = setup(t, { "package-lock.json": JSON.stringify(before) + "\n" });
  update(
    repo,
    { "package-lock.json": JSON.stringify(after) + "\n" },
    "refresh lockfile",
    "Maintain the dependency lock.",
  );
  const result = runReview(repo);
  assert.equal(result.status, 1);
  assert.match(row(rowsFrom(result), "D2").evidence, /lockfileVersion 2 -> 3/);
});

test("P1 fails when a run-all wildcard picks up a newly added translation script", (t) => {
  const { repo } = setup(t, {
    "package.json":
      JSON.stringify({ name: "consumer", scripts: { test: "node --test" } }, null, 2) + "\n",
  });
  update(repo, {
    "package.json":
      JSON.stringify(
        {
          name: "consumer",
          scripts: {
            test: "run-s translations:*",
            "translations:validate": "i18n-pipeline validate-ci",
          },
        },
        null,
        2,
      ) + "\n",
  });
  const result = runReview(repo);
  assert.equal(result.status, 1);
  assert.match(row(rowsFrom(result), "P1").evidence, /matches added translations:validate/);
});

test("P1 passes when a wildcard does not match the newly added script", (t) => {
  const { repo } = setup(t, {
    "package.json":
      JSON.stringify({ name: "consumer", scripts: { test: "node --test" } }, null, 2) + "\n",
  });
  update(repo, {
    "package.json":
      JSON.stringify(
        {
          name: "consumer",
          scripts: { test: "run-s lint:*", "translations:validate": "i18n-pipeline validate-ci" },
        },
        null,
        2,
      ) + "\n",
  });
  const result = runReview(repo);
  assert.equal(result.status, 0);
  assert.equal(row(rowsFrom(result), "P1").result, "pass");
});

test("P2 fails when i18n-pipeline appears in a dependency field", (t) => {
  const { repo } = setup(t);
  update(repo, {
    "package.json":
      JSON.stringify(
        {
          name: "consumer",
          scripts: {},
          devDependencies: { "@redhat-cloud-services/i18n-pipeline": "file:../i18n-pipeline" },
        },
        null,
        2,
      ) + "\n",
  });
  const result = runReview(repo);
  assert.equal(result.status, 1);
  assert.match(row(rowsFrom(result), "P2").evidence, /devDependencies/);
});

test("W1 reports marker and short refs while offline SHA comparison is skipped; W2 checks permissions", (t) => {
  const { repo } = setup(t);
  const fullSha = "0123456789abcdef0123456789abcdef01234567";
  update(repo, {
    ".github/workflows/marker.yml":
      "on: push\njobs:\n  check:\n    uses: RedHatInsights/i18n-tooling/.github/workflows/locale-validation.yml@<reviewed-commit-sha> # zizmor: ignore[unpinned-uses]\n",
    ".github/workflows/short.yml":
      "on: push\npermissions: {}\njobs:\n  check:\n    uses: RedHatInsights/i18n-tooling/.github/workflows/locale-validation.yml@abc123\n",
    ".github/workflows/full.yml":
      "on: push\npermissions: {}\njobs:\n  check:\n    uses: RedHatInsights/i18n-tooling/.github/workflows/locale-validation.yml@" +
      fullSha +
      "\n",
  });
  const result = runReview(repo);
  assert.equal(result.status, 1);
  const rows = rowsFrom(result);
  assert.equal(row(rows, "W1").result, "fail");
  assert.match(row(rows, "W1").evidence, /<reviewed-commit-sha>/);
  assert.match(row(rows, "W1").evidence, /ref abc123/);
  assert.ok(row(rows, "W1").evidence.includes(fullSha));
  assert.match(row(rows, "W1").evidence, /offline: skipped default-branch comparison/);
  assert.equal(row(rows, "W2").result, "fail");
  assert.match(row(rows, "W2").evidence, /marker\.yml/);
});

test("W1 skips full-SHA comparison offline and W2 passes with empty top-level permissions", (t) => {
  const { repo } = setup(t);
  const fullSha = "0123456789abcdef0123456789abcdef01234567";
  update(repo, {
    ".github/workflows/locale-validation.yml":
      "on: push\npermissions: {}\njobs:\n  check:\n    uses: RedHatInsights/i18n-tooling/.github/workflows/locale-validation.yml@" +
      fullSha +
      "\n",
  });
  const result = runReview(repo);
  assert.equal(result.status, 0);
  const rows = rowsFrom(result);
  assert.equal(row(rows, "W1").result, "skipped");
  assert.match(row(rows, "W1").evidence, /skipped default-branch comparison/);
  assert.equal(row(rows, "W2").result, "pass");
});

test("W6 accepts an absent branch and terminal records, and fails on an active wrong-filename record", (t) => {
  const { repo } = setup(t);
  update(repo, {
    "i18n/phrase-tms-absent.json":
      JSON.stringify(
        {
          state: { branch: "missing-state" },
          sourceCatalog: { filename: "absent.ui.en.json" },
          project: { uid: "project-1" },
        },
        null,
        2,
      ) + "\n",
    "i18n/phrase-tms-terminal.json":
      JSON.stringify(
        {
          state: { branch: "terminal-state" },
          sourceCatalog: { filename: "terminal.ui.en.json" },
          project: { uid: "project-1" },
        },
        null,
        2,
      ) + "\n",
    "i18n/phrase-tms-active.json":
      JSON.stringify(
        {
          state: { branch: "active-state" },
          sourceCatalog: { filename: "active.ui.en.json" },
          project: { uid: "project-1" },
        },
        null,
        2,
      ) + "\n",
  });
  pushStateBranch(repo, "terminal-state", {
    ".github/i18n-state/batches/terminal.json": stateRecord(
      "completed",
      "other-project",
      "other.ui.en.json",
    ),
  });
  pushStateBranch(repo, "active-state", {
    ".github/i18n-state/batches/active.json": stateRecord(
      "submitted",
      "project-1",
      "different.ui.en.json",
    ),
  });
  const result = runReview(repo);
  assert.equal(result.status, 1);
  const w6 = row(rowsFrom(result), "W6");
  assert.equal(w6.result, "fail");
  assert.match(w6.evidence, /missing-state: absent/);
  assert.match(w6.evidence, /terminal\.json \(completed/);
  assert.match(w6.evidence, /active record mismatch/);
  assert.match(w6.evidence, /different\.ui\.en\.json/);
});

test("S4 without a commitlint config shows range and base subjects", (t) => {
  const { repo } = setup(t);
  update(
    repo,
    { "README.md": "onboarding\n" },
    "feat: add onboarding validation",
    "Record why this was added.",
  );
  const result = runReview(repo);
  assert.equal(result.status, 0);
  const s4 = row(rowsFrom(result), "S4");
  assert.equal(s4.result, "check");
  assert.match(s4.evidence, /feat: add onboarding validation/);
  assert.match(s4.evidence, /base commit/);
});

test("exit statuses distinguish pass, fail, and usage errors; JSON rows have the documented shape", (t) => {
  const { repo } = setup(t);
  const good = runReview(repo);
  assert.equal(good.status, 0);
  const parsed = rowsFrom(good);
  assert.deepEqual(Object.keys(parsed[0]), ["item", "result", "evidence"]);
  assert.deepEqual(
    parsed.map(({ item }) => item),
    ["S3", "S4", "S5", "S6", "D1", "D2", "D3", "P1", "P2", "W1", "W2", "W6"],
  );

  update(repo, {
    "package.json":
      JSON.stringify(
        {
          name: "consumer",
          scripts: {},
          dependencies: { "@redhat-cloud-services/i18n-pipeline": "1.0.0" },
        },
        null,
        2,
      ) + "\n",
  });
  assert.equal(runReview(repo).status, 1);

  const missing = spawnSync(process.execPath, [scriptPath, "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  const unknown = spawnSync(
    process.execPath,
    [scriptPath, "--repo", repo, "--base", "origin/main", "--extra"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(unknown.status, 2);
  const noScratch = spawnSync(
    process.execPath,
    [scriptPath, "--repo", repo, "--base", "origin/main", "--reproduce"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(noScratch.status, 2);
});
