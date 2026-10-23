import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const usage =
  "Usage: node review-checks.mjs --repo <consumer-checkout> --base <ref> [--pr <number>] [--cli <path>] [--node <version>] [--npm <version>] [--scratch <dir>] [--reproduce] [--offline] [--json]";
const lockfiles = ["package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"];
const terminalPhases = new Set(["completed", "failed", "superseded"]);
const results = [];

function usageError(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      pr: { type: "string" },
      cli: { type: "string" },
      node: { type: "string" },
      npm: { type: "string" },
      scratch: { type: "string" },
      reproduce: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  usageError(error.message);
}

if (!options.repo || !options.base) usageError("Both --repo and --base are required.");
if (options.reproduce && !options.scratch) usageError("--scratch is required with --reproduce.");

const repo = resolve(options.repo);
if (!existsSync(repo) || !statSync(repo).isDirectory()) {
  usageError(`--repo is not an existing directory: ${repo}`);
}
const cli = options.cli ? resolve(options.cli) : undefined;
const scratch = options.scratch ? resolve(options.scratch) : undefined;
const base = options.base;

function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(args, cwd = repo) {
  return run("git", args, cwd);
}

function output(result) {
  return `${result.stdout}${result.stderr}`.trim();
}

function add(item, result, evidence) {
  results.push({ item, result, evidence: String(evidence).replaceAll("\n", "; ") });
}

function firstLines(value, limit = 4) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join("; ");
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function showFile(ref, path) {
  const result = git(["show", `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function changedPaths(pathspec = undefined) {
  const args = ["diff", "--name-only", `${base}...HEAD`];
  if (pathspec) args.push("--", pathspec);
  const result = git(args);
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function resultForFailure(result) {
  return result.error
    ? `spawn error: ${result.error.message}`
    : `exit ${result.status ?? result.signal}`;
}

function isLocalOrigin() {
  const result = git(["remote", "get-url", "origin"]);
  if (result.status !== 0) return false;
  const url = result.stdout.trim();
  return (
    url.startsWith("/") || url.startsWith("file:") || (!url.includes("://") && !url.includes(":"))
  );
}

function addS3() {
  const status = git(["status", "--porcelain"]);
  const dirty = status.status !== 0 || status.stdout.trim().length > 0;
  const pieces = [];
  let failed = dirty;
  if (cli) {
    const validation = run(process.execPath, [
      cli,
      "validate-ci",
      "--mode",
      "error",
      "--root",
      repo,
    ]);
    const summary = firstLines(output(validation), 1) || resultForFailure(validation);
    pieces.push(`validate-ci: ${summary} (exit ${validation.status ?? validation.signal})`);
    failed ||= validation.status !== 0;
  } else {
    pieces.push("validate-ci skipped: --cli not provided");
  }
  pieces.push(
    status.status === 0
      ? `git status --porcelain: ${dirty ? JSON.stringify(status.stdout.trim()) : "clean"}`
      : `git status --porcelain failed: ${resultForFailure(status)}`,
  );
  if (dirty) pieces.push("working tree is dirty");
  add("S3", failed ? "fail" : cli ? "pass" : "skipped", pieces.join("; "));
}

function hasCommitlintConfig() {
  const names = readdirSync(repo);
  if (
    names.some((name) => name.startsWith(".commitlintrc") || name.startsWith("commitlint.config."))
  ) {
    return true;
  }
  try {
    return Object.hasOwn(readJsonFile(join(repo, "package.json")), "commitlint");
  } catch {
    return false;
  }
}

function addS4() {
  const configured = hasCommitlintConfig();
  const binary = join(repo, "node_modules", ".bin", "commitlint");
  if (configured && existsSync(binary)) {
    const lint = run(binary, ["--from", base, "--to", "HEAD"]);
    const evidence =
      lint.status === 0
        ? `commitlint --from ${base} --to HEAD: exit 0`
        : `commitlint --from ${base} --to HEAD: ${firstLines(output(lint)) || resultForFailure(lint)}`;
    add("S4", lint.status === 0 ? "pass" : "fail", evidence);
    return;
  }
  const subjects = git(["log", "--format=%s", `${base}..HEAD`]);
  const recent = git(["log", "-5", "--format=%s", base]);
  const current = subjects.stdout.split(/\r?\n/).filter(Boolean);
  const previous = recent.stdout.split(/\r?\n/).filter(Boolean);
  if (configured) {
    add("S4", "check", "commitlint config found, but node_modules/.bin/commitlint is absent");
  } else {
    add(
      "S4",
      "check",
      `no commitlint config; range subjects [${current.join(" | ")}], last 5 on ${base} [${previous.join(" | ")}]`,
    );
  }
}

function addS5() {
  if (!options.pr) {
    add("S5", "n/a", "no --pr provided");
    return;
  }
  if (options.offline) {
    add("S5", "skipped", "--offline: gh pr checks not run");
    return;
  }
  const checks = run("gh", ["pr", "checks", options.pr, "--json", "name,state,bucket"]);
  if (checks.status !== 0) {
    add(
      "S5",
      "check",
      `gh pr checks ${options.pr}: ${firstLines(output(checks)) || resultForFailure(checks)}`,
    );
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(checks.stdout);
  } catch (error) {
    add("S5", "check", `gh pr checks returned invalid JSON: ${error.message}`);
    return;
  }
  const failed = parsed.filter((check) => check.bucket === "fail");
  const pending = parsed.filter((check) => !["pass", "skipping", "fail"].includes(check.bucket));
  if (failed.length) {
    add(
      "S5",
      "fail",
      `failing checks: ${failed.map((check) => `${check.name} (${check.state}/${check.bucket})`).join(", ")}`,
    );
  } else if (pending.length || parsed.length === 0) {
    const names = pending.map((check) => `${check.name} (${check.state}/${check.bucket})`);
    add(
      "S5",
      "check",
      names.length ? `pending checks: ${names.join(", ")}` : "gh returned no checks",
    );
  } else {
    add("S5", "pass", `all ${parsed.length} checks are pass or skipping`);
  }
}

function repoNameFromParent(parent) {
  if (!parent || typeof parent !== "object") return undefined;
  if (typeof parent.nameWithOwner === "string") return parent.nameWithOwner;
  if (typeof parent.owner?.login === "string" && typeof parent.name === "string") {
    return `${parent.owner.login}/${parent.name}`;
  }
  return undefined;
}

function remoteBranchCandidates() {
  const refs = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (refs.status !== 0) return [];
  const own = git(["branch", "--show-current"]).stdout.trim();
  const baseName = base.replace(/^refs\/remotes\//, "");
  return (
    refs.stdout
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter(
        (branch) =>
          branch && branch !== "origin/HEAD" && branch !== `origin/${own}` && branch !== baseName,
      )
      // A branch already contained in the base or in HEAD is not separate work.
      .filter(
        (branch) =>
          git(["merge-base", "--is-ancestor", branch, base]).status !== 0 &&
          git(["merge-base", "--is-ancestor", branch, "HEAD"]).status !== 0,
      )
      .map((branch) => {
        const log = git(["log", "--name-only", "--format=", `${base}..${branch}`]);
        const paths = [
          ...new Set(log.stdout.split(/\r?\n/).filter((path) => path && isI18nPath(path))),
        ];
        return paths.length ? { branch, paths } : undefined;
      })
      .filter(Boolean)
  );
}

function isI18nPath(path) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.startsWith("i18n/") ||
    normalized.startsWith(".github/i18n") ||
    normalized.startsWith("locales/") ||
    normalized.startsWith("deploy/locales/") ||
    normalized.includes("phrase") ||
    normalized.includes("catalog-validation")
  );
}

function addS6() {
  const candidates = [];
  const ghNotes = [];
  if (options.offline) {
    ghNotes.push("--offline: GitHub PR lookups skipped");
  } else {
    const current = run("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--search",
      "i18n",
      "--json",
      "number,title,url",
    ]);
    if (current.status === 0) {
      try {
        for (const pr of JSON.parse(current.stdout))
          candidates.push(`PR ${pr.number} ${pr.title} ${pr.url}`);
      } catch (error) {
        ghNotes.push(`repository PR list invalid JSON: ${error.message}`);
      }
    } else {
      ghNotes.push(
        `repository PR list unavailable: ${firstLines(output(current)) || resultForFailure(current)}`,
      );
    }
    const parentResult = run("gh", ["repo", "view", "--json", "parent"]);
    if (parentResult.status === 0) {
      try {
        const parent = repoNameFromParent(JSON.parse(parentResult.stdout).parent);
        if (parent) {
          const parentPrs = run("gh", [
            "pr",
            "list",
            "--repo",
            parent,
            "--state",
            "open",
            "--search",
            "i18n",
            "--json",
            "number,title,url",
          ]);
          if (parentPrs.status === 0) {
            for (const pr of JSON.parse(parentPrs.stdout))
              candidates.push(`parent PR ${pr.number} ${pr.title} ${pr.url}`);
          } else {
            ghNotes.push(
              `parent PR list unavailable: ${firstLines(output(parentPrs)) || resultForFailure(parentPrs)}`,
            );
          }
        }
      } catch (error) {
        ghNotes.push(`parent lookup invalid JSON: ${error.message}`);
      }
    } else {
      ghNotes.push(
        `parent lookup unavailable: ${firstLines(output(parentResult)) || resultForFailure(parentResult)}`,
      );
    }
  }
  for (const candidate of remoteBranchCandidates()) {
    candidates.push(`branch ${candidate.branch}: ${candidate.paths.join(", ")}`);
  }
  const evidence = [...candidates, ...ghNotes];
  add(
    "S6",
    "check",
    evidence.length
      ? evidence.join("; ")
      : "no open i18n PRs or unmerged origin branches touch i18n paths",
  );
}

function parseManifest() {
  try {
    return readJsonFile(join(repo, "package.json"));
  } catch {
    return {};
  }
}

function walkFiles(directory, predicate, collected = []) {
  if (!existsSync(directory)) return collected;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, collected);
    else if (entry.isFile() && predicate(path)) collected.push(path);
  }
  return collected;
}

function stripYamlScalar(value) {
  let scalar = value
    .trim()
    .replace(/\s+#.*$/, "")
    .trim();
  if (
    (scalar.startsWith('"') && scalar.endsWith('"')) ||
    (scalar.startsWith("'") && scalar.endsWith("'"))
  ) {
    scalar = scalar.slice(1, -1);
  }
  return scalar;
}

function normalizedVersion(value) {
  const candidate = String(value)
    .trim()
    .replace(/^v(?=\d)/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate)
    ? candidate
    : undefined;
}

function addD1() {
  const manifest = parseManifest();
  const nodePins = [];
  const npmPins = [];
  for (const file of [".node-version", ".nvmrc"]) {
    const path = join(repo, file);
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) nodePins.push({ source: file, value });
    }
  }
  if (manifest.volta?.node !== undefined)
    nodePins.push({ source: "package.json volta.node", value: String(manifest.volta.node) });
  if (manifest.volta?.npm !== undefined)
    npmPins.push({ source: "package.json volta.npm", value: String(manifest.volta.npm) });
  if (typeof manifest.packageManager === "string") {
    const match = /^(npm|pnpm|yarn|bun)@(.+)$/.exec(manifest.packageManager);
    if (match?.[1] === "npm")
      npmPins.push({ source: "package.json packageManager", value: match[2] });
  }
  if (manifest.engines?.node !== undefined)
    nodePins.push({ source: "package.json engines.node", value: String(manifest.engines.node) });
  if (manifest.engines?.npm !== undefined)
    npmPins.push({ source: "package.json engines.npm", value: String(manifest.engines.npm) });

  const actionFiles = walkFiles(join(repo, ".github", "actions"), (path) =>
    /\/action\.ya?ml$/i.test(path),
  );
  const workflowFiles = [
    ...walkFiles(join(repo, ".github", "workflows"), (path) => /\.ya?ml$/i.test(path)),
    ...actionFiles,
  ];
  for (const path of workflowFiles) {
    const rel = relative(repo, path).split(sep).join("/");
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = /^\s*(node-version|node-version-file)\s*:\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = stripYamlScalar(match[2]);
      if (!value) continue;
      if (match[1] === "node-version-file") {
        if (value.includes("${{")) {
          nodePins.push({ source: `${rel} node-version-file`, value, expression: true });
        } else {
          const versionPath = join(repo, value);
          const fileValue = existsSync(versionPath)
            ? readFileSync(versionPath, "utf8").trim()
            : "(missing file)";
          nodePins.push({ source: `${rel} node-version-file ${value}`, value: fileValue });
        }
      } else {
        // An expression or a matrix list is not a pin of its own.
        const expression = value.includes("${{") || value.startsWith("[");
        nodePins.push({ source: `${rel} node-version`, value, expression });
      }
    }
  }

  function assess(label, pins, actual, priority) {
    const seen = new Set();
    const all = pins
      .filter((pin) => {
        const key = `${pin.source}=${pin.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((pin) => ({ ...pin, exact: normalizedVersion(pin.value) }));
    // Expressions resolve at run time and an engines range only bounds the pin,
    // so neither can disagree with a version file.
    const comparable = all.filter((pin) => !pin.expression && !pin.source.includes("engines."));
    const ignored = all.length - comparable.length;
    const ordered = [...all].sort((left, right) => {
      const leftIndex = priority.findIndex(
        (source) => left.source === source || left.source.startsWith(`${source} `),
      );
      const rightIndex = priority.findIndex(
        (source) => right.source === source || right.source.startsWith(`${source} `),
      );
      return (
        (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    });
    const selected = ordered.find((pin) => pin.exact);
    const exactValues = new Set(comparable.map((pin) => pin.exact).filter(Boolean));
    const hasAlias = comparable.some((pin) => !pin.exact);
    const disagree = exactValues.size > 1 || (exactValues.size > 0 && hasAlias);
    const actualVersion =
      actual === undefined ? undefined : (normalizedVersion(actual) ?? String(actual).trim());
    const mismatch =
      actualVersion !== undefined && selected?.exact && actualVersion !== selected.exact;
    const pinEvidence = comparable.map(
      (pin) => `${pin.source}=${pin.value}${pin.exact ? " (exact)" : " (alias/range)"}`,
    );
    if (ignored) pinEvidence.push(`${ignored} expression or engines value(s) not compared`);
    if (selected) pinEvidence.push(`selected ${selected.exact} from ${selected.source}`);
    if (actual !== undefined) pinEvidence.push(`reported ${label}=${actual}`);
    if (!selected) pinEvidence.push("no exact pin selected");
    if (mismatch) {
      add(
        "D1",
        "fail",
        `${label}: ${pinEvidence.join(", ")}; reported version differs from selected exact pin`,
      );
      return "fail";
    }
    if (disagree) {
      add("D1", "check", `${label}: conflicting pins: ${pinEvidence.join(", ")}`);
      return "check";
    }
    if (!selected) {
      add("D1", "check", `${label}: ${pinEvidence.join(", ")}`);
      return "check";
    }
    if (actual === undefined) {
      add(
        "D1",
        "check",
        `${label}: ${pinEvidence.join(", ")}; provide --${label.toLowerCase()} to compare the version used`,
      );
      return "check";
    }
    add("D1", "pass", `${label}: ${pinEvidence.join(", ")}`);
    return "pass";
  }

  const nodePriority = [".node-version", ".nvmrc", "package.json volta.node"];
  const ciExact = nodePins.filter((pin) => pin.source.includes("node-version"));
  const node = [
    ...nodePins.filter((pin) =>
      nodePriority.some((source) => pin.source === source || pin.source.startsWith(`${source} `)),
    ),
    ...ciExact.filter((pin) => pin.source.startsWith(".github/")),
    ...nodePins.filter((pin) => pin.source === "package.json engines.node"),
  ];
  const npm = npmPins;
  const before = results.length;
  assess(
    "Node",
    node,
    options.node,
    nodePriority.concat([".github/workflows", ".github/actions", "package.json engines.node"]),
  );
  assess("npm", npm, options.npm, [
    "package.json packageManager",
    "package.json volta.npm",
    "package.json engines.npm",
  ]);
  const nodeRows = results.splice(before);
  const combined = nodeRows.map((row) => row.evidence);
  const worst = nodeRows.some((row) => row.result === "fail")
    ? "fail"
    : nodeRows.some((row) => row.result === "check")
      ? "check"
      : "pass";
  add("D1", worst, combined.join("; "));
}

function lockfileChanges() {
  return changedPaths().filter((path) => lockfiles.includes(path));
}

function packageNameFromLockKey(key) {
  const marker = "node_modules/";
  const index = key.lastIndexOf(marker);
  if (index < 0) return undefined;
  const segments = key.slice(index + marker.length).split("/");
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function hostsFromPackages(packages) {
  const hosts = new Set();
  for (const entry of Object.values(packages)) {
    if (typeof entry?.resolved !== "string") continue;
    try {
      hosts.add(new URL(entry.resolved).host.toLowerCase());
    } catch {
      // Non-URL resolutions such as git+ssh do not have a registry host.
    }
  }
  return hosts;
}

function addD2(changedLocks) {
  if (!changedLocks.length) {
    add("D2", "n/a", "no lockfile changed in the range");
    return;
  }
  const other = changedLocks.filter((path) => path !== "package-lock.json");
  const evidence = [];
  let failed = false;
  if (changedLocks.includes("package-lock.json")) {
    try {
      const baseText = showFile(base, "package-lock.json");
      const headText = existsSync(join(repo, "package-lock.json"))
        ? readFileSync(join(repo, "package-lock.json"), "utf8")
        : undefined;
      if (!baseText || !headText) {
        failed = true;
        evidence.push("package-lock.json missing at base or HEAD");
      } else {
        const before = JSON.parse(baseText);
        const after = JSON.parse(headText);
        if (before.lockfileVersion !== after.lockfileVersion) {
          failed = true;
          evidence.push(`lockfileVersion ${before.lockfileVersion} -> ${after.lockfileVersion}`);
        }
        const oldPackages = before.packages ?? {};
        const newPackages = after.packages ?? {};
        const keys = [
          ...new Set([...Object.keys(oldPackages), ...Object.keys(newPackages)]),
        ].sort();
        const changedEntries = keys.filter(
          (key) => JSON.stringify(oldPackages[key]) !== JSON.stringify(newPackages[key]),
        );
        const names = [...new Set(changedEntries.map(packageNameFromLockKey).filter(Boolean))];
        evidence.push(`changed packages: ${names.length ? names.join(", ") : "none named"}`);
        const oldHosts = hostsFromPackages(oldPackages);
        const newHosts = [...hostsFromPackages(newPackages)].filter((host) => !oldHosts.has(host));
        if (newHosts.length) {
          failed = true;
          evidence.push(`new resolved hosts: ${newHosts.join(", ")}`);
        }
        const commits = git(["log", `${base}..HEAD`, "--format=%H%x00%s%x00%b%x00"]);
        const bodies = commits.stdout
          .split("\0")
          .filter((_, index) => index % 3 === 2)
          .join("\n")
          .toLowerCase();
        // A body may name a scoped package without its scope.
        const unnamed = names.filter(
          (name) =>
            !bodies.includes(name.toLowerCase()) &&
            !bodies.includes(name.replace(/^@[^/]+\//, "").toLowerCase()),
        );
        if (unnamed.length) {
          failed = true;
          evidence.push(`no commit body mentions: ${unnamed.join(", ")}`);
        } else if (names.length) {
          evidence.push(`commit bodies mention every changed package`);
        }
      }
    } catch (error) {
      failed = true;
      evidence.push(`package-lock comparison failed: ${error.message}`);
    }
  }
  for (const path of other) {
    const diff = git(["diff", "--stat", `${base}...HEAD`, "--", path]);
    evidence.push(`${path}: ${firstLines(diff.stdout) || "no diff stat"}`);
  }
  add("D2", failed ? "fail" : other.length ? "check" : "pass", evidence.join("; "));
}

function addD3(changedLocks) {
  if (!changedLocks.length) {
    add("D3", "n/a", "no lockfile changed in the range");
    return;
  }
  if (!options.reproduce) {
    add("D3", "skipped", "use --reproduce --scratch <dir> to run the frozen install in a clone");
    return;
  }
  if (options.offline) {
    add("D3", "skipped", "--offline: frozen install may access the package registry");
    return;
  }
  const selected = changedLocks;
  if (selected.length !== 1) {
    add(
      "D3",
      "skipped",
      `multiple lockfiles changed (${selected.join(", ")}); package manager is ambiguous`,
    );
    return;
  }
  const lockfile = selected[0];
  const commands = {
    "package-lock.json": ["npm", ["ci", "--ignore-scripts"]],
    "bun.lock": ["bun", ["install", "--frozen-lockfile", "--ignore-scripts"]],
    "pnpm-lock.yaml": ["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]],
  };
  if (!commands[lockfile]) {
    add("D3", "skipped", `no frozen reproduction command specified for ${lockfile}`);
    return;
  }
  const clonePath = join(scratch, "d3");
  mkdirSync(scratch, { recursive: true });
  const clone = run("git", ["clone", "--quiet", "--no-local", repo, clonePath], repo);
  if (clone.status !== 0) {
    add(
      "D3",
      "fail",
      `git clone --quiet --no-local: ${resultForFailure(clone)} ${firstLines(output(clone))}`,
    );
    return;
  }
  const sha = git(["rev-parse", "HEAD"]).stdout.trim();
  const checkout = git(["checkout", "--detach", sha], clonePath);
  if (checkout.status !== 0) {
    add("D3", "fail", `git checkout --detach ${sha}: ${resultForFailure(checkout)}`);
    return;
  }
  const [manager, args] = commands[lockfile];
  const install = run(manager, args, clonePath);
  const steps = [`${manager} ${args.join(" ")}: exit ${install.status ?? install.signal}`];
  let failed = install.status !== 0;
  if (lockfile === "package-lock.json" && !failed) {
    const update = run("npm", ["install", "--package-lock-only", "--ignore-scripts"], clonePath);
    steps.push(
      `npm install --package-lock-only --ignore-scripts: exit ${update.status ?? update.signal}`,
    );
    failed ||= update.status !== 0;
    if (!failed) {
      const diff = git(["diff", "--exit-code", "--", "package-lock.json"], clonePath);
      steps.push(`git diff --exit-code package-lock.json: exit ${diff.status}`);
      failed ||= diff.status !== 0;
    }
  }
  add("D3", failed ? "fail" : "pass", `clone ${sha}; ${steps.join("; ")}`);
}

function packageScripts(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function wildcardPrefixes(value) {
  const prefixes = [];
  const pattern = /(?:npm-run-all|run-s|run-p)\b([^\n;&|]*)/g;
  for (const match of value.matchAll(pattern)) {
    const args = match[1].match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? [];
    for (const arg of args) {
      const clean = arg.replace(/^['"]|['"]$/g, "");
      if (clean.endsWith("*") && clean.length > 1) prefixes.push(clean.slice(0, -1));
    }
  }
  return prefixes;
}

function addP1() {
  const before = packageScripts(showFile(base, "package.json"));
  const afterText = existsSync(join(repo, "package.json"))
    ? readFileSync(join(repo, "package.json"), "utf8")
    : undefined;
  const after = packageScripts(afterText);
  const added = Object.keys(after).filter((name) => !Object.hasOwn(before, name));
  const changed = Object.keys(after).filter(
    (name) => Object.hasOwn(before, name) && before[name] !== after[name],
  );
  const failures = [];
  for (const [script, value] of Object.entries(after)) {
    if (typeof value !== "string") continue;
    for (const prefix of wildcardPrefixes(value)) {
      for (const addedName of added)
        if (addedName.startsWith(prefix))
          failures.push(`${script} glob ${prefix}* matches added ${addedName}`);
    }
  }
  const summary = `added [${added.join(", ")}], changed [${changed.join(", ")}]`;
  add(
    "P1",
    failures.length ? "fail" : "pass",
    failures.length ? `${failures.join("; ")}; ${summary}` : summary,
  );
}

function addP2() {
  const manifest = parseManifest();
  const dependencyFields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const fields = dependencyFields.filter((field) =>
    Object.hasOwn(manifest[field] ?? {}, "@redhat-cloud-services/i18n-pipeline"),
  );
  add(
    "P2",
    fields.length ? "fail" : "pass",
    fields.length
      ? `@redhat-cloud-services/i18n-pipeline is in ${fields.join(", ")}`
      : "@redhat-cloud-services/i18n-pipeline absent from dependency fields",
  );
}

function changedWorkflows() {
  return changedPaths(".github/workflows").filter(
    (path) => /\.ya?ml$/i.test(path) && existsSync(join(repo, path)),
  );
}

function toolingUses(path) {
  const content = readFileSync(join(repo, path), "utf8");
  const refs = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = /\buses\s*:\s*RedHatInsights\/i18n-tooling\/[^@\s]+@([^\s#]+)/.exec(line);
    if (match) refs.push({ ref: match[1].replace(/["']$/, ""), line: index + 1 });
  }
  return { content, refs };
}

function addW1AndGetWorkflows() {
  const workflows = [];
  const invalid = [];
  const hashes = new Set();
  for (const path of changedWorkflows()) {
    const parsed = toolingUses(path);
    if (!parsed.refs.length) continue;
    workflows.push({ path, ...parsed });
    for (const { ref, line } of parsed.refs) {
      if (!/^[0-9a-f]{40}$/i.test(ref)) {
        invalid.push(`${path}:${line} ref ${ref}`);
      } else {
        hashes.add(ref.toLowerCase());
      }
    }
    if (
      parsed.content.includes("zizmor: ignore[unpinned-uses]") &&
      parsed.refs.every(({ ref }) => /^[0-9a-f]{40}$/i.test(ref))
    ) {
      invalid.push(`${path}: zizmor ignore[unpinned-uses] remains with real SHA refs`);
    }
  }
  if (!workflows.length) {
    add("W1", "n/a", "no changed workflow calls RedHatInsights/i18n-tooling");
    return workflows;
  }
  let failed = invalid.length > 0;
  let unverified = false;
  const evidence = [...invalid];
  if (hashes.size) {
    if (options.offline) {
      evidence.push(`--offline: skipped default-branch comparison for ${[...hashes].join(", ")}`);
    } else {
      const branch = run("gh", [
        "api",
        "repos/RedHatInsights/i18n-tooling",
        "--jq",
        ".default_branch",
      ]);
      if (branch.status !== 0) {
        unverified = true;
        evidence.push(
          `default branch lookup unavailable: ${firstLines(output(branch)) || resultForFailure(branch)}`,
        );
      } else {
        const defaultBranch = branch.stdout.trim();
        for (const sha of hashes) {
          const comparison = run("gh", [
            "api",
            `repos/RedHatInsights/i18n-tooling/compare/${sha}...${defaultBranch}`,
            "--jq",
            ".status",
          ]);
          const state = comparison.stdout.trim();
          if (comparison.status !== 0) {
            unverified = true;
            evidence.push(`${sha}: compare unavailable (${resultForFailure(comparison)})`);
          } else if (!["ahead", "identical"].includes(state)) {
            failed = true;
            evidence.push(`${sha}: compare status ${state}, expected ahead or identical`);
          } else evidence.push(`${sha}: compare ${state}`);
        }
      }
    }
  }
  if (failed) add("W1", "fail", evidence.join("; "));
  else if (options.offline && hashes.size) add("W1", "skipped", evidence.join("; "));
  else if (unverified) add("W1", "check", evidence.join("; "));
  else
    add(
      "W1",
      "pass",
      evidence.length
        ? evidence.join("; ")
        : `${workflows.length} changed workflow(s) have valid pins`,
    );
  return workflows;
}

function addW2(workflows) {
  if (!workflows.length) {
    add("W2", "n/a", "no changed workflow calls RedHatInsights/i18n-tooling");
    return;
  }
  const missing = workflows
    .filter(({ content }) => !/^permissions\s*:\s*\{\s*\}\s*(?:#.*)?$/m.test(content))
    .map(({ path }) => path);
  add(
    "W2",
    missing.length ? "fail" : "pass",
    missing.length
      ? `missing top-level permissions: {} in ${missing.join(", ")}`
      : `${workflows.length} workflow(s) have top-level permissions: {}`,
  );
}

function phraseConfigPaths() {
  const paths = [];
  for (const directory of ["i18n", ".github/i18n"]) {
    const absolute = join(repo, directory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (/^phrase-tms.*\.json$/i.test(name) && existsSync(join(absolute, name)))
        paths.push(`${directory}/${name}`);
    }
  }
  return paths.sort();
}

function parseCommandJson(result) {
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const index = text.indexOf("{");
    if (index >= 0) return JSON.parse(text.slice(index));
    throw new Error("command did not print JSON");
  }
}

function phraseConfig(path) {
  if (cli) {
    const expanded = run(process.execPath, [cli, "tms", "config", "--config", join(repo, path)]);
    if (expanded.status === 0) return { config: parseCommandJson(expanded), expanded: true };
    return {
      error: `${path}: tms config failed (${resultForFailure(expanded)}): ${firstLines(output(expanded))}`,
    };
  }
  try {
    return { config: readJsonFile(join(repo, path)), expanded: false };
  } catch (error) {
    return { error: `${path}: invalid JSON: ${error.message}` };
  }
}

function addW6() {
  const paths = phraseConfigPaths();
  if (!paths.length) {
    add("W6", "n/a", "no Phrase configs at HEAD");
    return;
  }
  const configs = paths.map((path) => ({ path, ...phraseConfig(path) }));
  const errors = configs.filter((entry) => entry.error).map((entry) => entry.error);
  const usable = configs.filter((entry) => entry.config);
  const branchOwners = new Map();
  const branches = usable.map((entry) => {
    const branch = entry.config.state?.branch || "i18n-tms-state";
    if (!branchOwners.has(branch)) branchOwners.set(branch, []);
    branchOwners.get(branch).push(entry.path);
    return {
      path: entry.path,
      branch,
      projectUid: entry.config.project?.uid,
      filename: entry.config.sourceCatalog?.filename,
    };
  });
  const duplicate = [...branchOwners]
    .filter(([, owners]) => owners.length > 1)
    .map(([branch, owners]) => `${branch} shared by ${owners.join(", ")}`);
  let failed = duplicate.length > 0;
  let uncertain = errors.length > 0;
  const evidence = [...duplicate, ...errors];
  if (options.offline && !isLocalOrigin()) {
    const result = failed ? "fail" : uncertain ? "check" : "skipped";
    add(
      "W6",
      result,
      [...evidence, "--offline: state-branch ls-remote/fetch skipped for non-local origin"].join(
        "; ",
      ),
    );
    return;
  }
  for (const config of branches) {
    const remote = git(["ls-remote", "--heads", "origin", config.branch]);
    if (remote.status !== 0) {
      uncertain = true;
      evidence.push(
        `${config.path} branch ${config.branch}: ls-remote failed (${resultForFailure(remote)})`,
      );
      continue;
    }
    if (!remote.stdout.trim()) {
      evidence.push(`${config.path} branch ${config.branch}: absent`);
      continue;
    }
    const fetched = git(["fetch", "origin", config.branch]);
    if (fetched.status !== 0) {
      uncertain = true;
      evidence.push(
        `${config.path} branch ${config.branch}: fetch failed (${resultForFailure(fetched)})`,
      );
      continue;
    }
    const files = git([
      "ls-tree",
      "-r",
      "--name-only",
      "FETCH_HEAD",
      "--",
      ".github/i18n-state/batches",
    ]);
    if (files.status !== 0) {
      uncertain = true;
      evidence.push(
        `${config.path} branch ${config.branch}: cannot list batch records (${resultForFailure(files)})`,
      );
      continue;
    }
    const records = [];
    for (const file of files.stdout.split(/\r?\n/).filter((entry) => entry.endsWith(".json"))) {
      const raw = git(["show", `FETCH_HEAD:${file}`]);
      if (raw.status !== 0) {
        uncertain = true;
        evidence.push(`${config.path} branch ${config.branch}: cannot read ${file}`);
        continue;
      }
      try {
        const record = JSON.parse(raw.stdout);
        const phase = record.phase ?? "unknown";
        const projectUid = record.config?.projectUid;
        const filename = record.config?.sourceCatalog?.filename;
        const baseRef = record.baseRef;
        records.push(
          `${file} (${phase}, project=${projectUid ?? "unknown"}, source=${filename ?? "unknown"}, baseRef=${baseRef ?? "unknown"})`,
        );
        if (!terminalPhases.has(phase)) {
          const projectMismatch =
            config.projectUid !== undefined && projectUid !== config.projectUid;
          const filenameMismatch = config.filename !== undefined && filename !== config.filename;
          if (projectMismatch || filenameMismatch) {
            failed = true;
            evidence.push(
              `${config.path} active record mismatch: ${records.at(-1)}; expected project=${config.projectUid ?? "unknown"}, source=${config.filename ?? "unknown"}`,
            );
          }
        }
      } catch (error) {
        uncertain = true;
        evidence.push(`${config.path} invalid batch record ${file}: ${error.message}`);
      }
    }
    evidence.push(
      `${config.path} branch ${config.branch}: ${records.length ? records.join(", ") : "no batch records"}${config.projectUid === undefined ? " (project UID unknown; filename only)" : ""}`,
    );
  }
  add(
    "W6",
    failed ? "fail" : uncertain ? "check" : "pass",
    evidence.length
      ? evidence.join("; ")
      : "all state branches are absent or have no conflicting active records",
  );
}

const allLockfiles = lockfileChanges();
addS3();
addS4();
addS5();
addS6();
addD1();
addD2(allLockfiles);
addD3(allLockfiles);
addP1();
addP2();
const workflows = addW1AndGetWorkflows();
addW2(workflows);
addW6();

if (options.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("| Item | Result | Evidence |");
  console.log("| --- | --- | --- |");
  for (const row of results) {
    const evidence = row.evidence.replaceAll("|", "\\|");
    console.log(`| ${row.item} | ${row.result} | ${evidence} |`);
  }
}

process.exitCode = results.some((row) => row.result === "fail") ? 1 : 0;
