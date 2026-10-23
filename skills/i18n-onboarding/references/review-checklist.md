# Onboarding review checklist

Use this checklist to review an i18n onboarding change: as the onboarding agent's final self-review, or as an independent reviewer of the onboarding PR, human or agent. Every item is a claim and the check that proves it. The onboarding rules behind each claim are in [SKILL.md](../SKILL.md) and the references next to this file.

## Run it

Inputs: the consumer repository, the onboarding branch, and the consumer's default branch, resolved from the remote (`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`). Below, `<default>` is `origin/<default branch>` after a fetch, and `<range>` is `<default>..HEAD`. With edit-files-only autonomy, check the working tree against `<default>` instead, and mark the commit-message items `n/a`.

Run every item. Record each as `pass`, `fail`, or `n/a`, with **evidence**: the command output, version, path, or commit that decides it. A result without evidence is a `fail`. An item is `n/a` only when its track or unit is not in the change; say which.

Run the checks that change files (`D3`, `G1`, `M3`) in a scratch clone of the branch, never in the working tree under review. Before the PR exists, the items about it (`S5`, `R1`–`R3`) check the description you are about to post.

## Scope

- **S1. Only intended files changed.** `git diff --stat <default>...HEAD` lists only configuration, caller workflows, package scripts, catalogs, formatter ignore entries, and source fixes. No notes, findings, or README files; the one exception is `i18n-onboarding-ticket-drafts.md` when no Jira tool was available.
- **S2. Units in order, one per commit.** `git log --reverse --format='%h %s' <range>` follows: catalog catch-up, validation, mechanical fixes, AI-drafted descriptions, dependency upgrades, Phrase, FEO. Each commit has a body that says why (`git log --format='%h%n%b' <range>`).
- **S3. No test breaks left.** A fresh clone of the branch is clean after checkout, and `validate-ci --mode error` passes on `HEAD`. An independent reviewer without the CLI uses the PR's locale validation check instead.
- **S4. Commit convention.** Every subject passes the repository's commit lint: `npx commitlint --from <default> --to HEAD` when it has a commitlint config; otherwise compare with its contribution or agent docs and recent subjects on `<default>`.
- **S5. CI is green.** `gh pr checks <number>` shows every check that ran as passing, or the description explains the failure. Before the PR exists, run the repository's local lint and test scripts instead.
- **S6. In-flight work named.** The description names every open PR and remote branch that carries i18n validation, Phrase or FEO work, with the developer's decision on each: `gh pr list --state open --search i18n` on the repository, and on its parent when it is a fork (`gh repo view --json parent`), plus `git branch -r`.

## Toolchain and dependencies

- **D1. Pinned Node and package manager.** The Node and package manager versions recorded in the PR description match the first pin that applies: an exact version in `.node-version`, `.nvmrc`, `packageManager` or `volta`; then the CI `setup-node` input, searched in `.github/workflows/` and in composite actions under `.github/actions/`; then the lowest major satisfying `engines`. Two disagreeing pins are reported, and the CI one was used. A version file holding an alias or range (`lts/*`) disagrees when it resolves to another version today.
- **D2. Every lockfile change has a reason.** List the changed entries and match each one to a line in the dependency commit body: the needed package, a dependency or peer it brings, or deduplication and metadata. For npm:

  ```bash
  base=$(mktemp) && git show <default>:package-lock.json > "$base" && node -e '
  const fs = require("fs");
  const [base, head] = process.argv.slice(1).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  if (base.lockfileVersion !== head.lockfileVersion) console.log("lockfileVersion", base.lockfileVersion, "->", head.lockfileVersion);
  const a = base.packages ?? {}, b = head.packages ?? {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) console.log(key || "(root)", a[key]?.version ?? "absent", "->", b[key]?.version ?? "absent");
  }' "$base" package-lock.json; rm -f "$base"
  ```

  An entry whose version is unchanged changed its metadata; it still needs a reason. A changed `lockfileVersion`, or `resolved` URLs on a new registry host, means the wrong package manager or registry ran: `fail`. For `bun.lock` and `pnpm-lock.yaml`, read `git diff <default>...HEAD` on the lockfile.

- **D3. The lockfile reproduces.** With the pinned versions from D1, the frozen install succeeds: `npm ci --ignore-scripts`, `bun install --frozen-lockfile --ignore-scripts`, or `pnpm install --frozen-lockfile --ignore-scripts`. For npm, `npm install --package-lock-only --ignore-scripts` then leaves `git diff --exit-code package-lock.json` clean. A diff means the lockfile was hand-edited or written by another npm major.
- **D4. Lifecycle scripts unchanged.** When the repository's dependencies were installed with scripts disabled, the dependency commit body says the update ran with `--ignore-scripts` too, and no `postinstall` output appears in the lockfile change.
- **D5. Registry age limits honored.** When `.npmrc` sets `min-release-age`, the package manager used is npm 11 or later, and each new version was published before the cutoff: `npm view <package> time.<version>`. A blocked upgrade is reported with the time it becomes eligible, not bypassed.
- **D6. Smallest dependency change.** A transitive upgrade whose parent's range already allowed it leaves `package.json` unchanged. A duplicate kept by a parent's exact peer pin is named in the commit body with the parent upgrade as a follow-up.
- **D7. Build and tests pass** after the dependency unit: the repository's own build and unit test scripts, run with the D1 versions, on the dependency commit, or on `HEAD` when no later commit changes a build or test input. Record which, and each script's own exit status, not that of a pipe.

## Package scripts

- **P1. Aggregates behave as before.** A wildcard aggregate that would match `translations:validate` (`npm-run-all translations:*`) is replaced with the scripts it matched on `<default>`, in the same order: compare the two `package.json` versions.
- **P2. No unpublished devDependency.** `@redhat-cloud-services/i18n-pipeline` is absent from `package.json` until its first npm release, and the PR description marks it pending.

## Generated files

- **G1. Generated files match their generators.** Each `generated` entry in the validation config passes `validate-ci --mode error`. Each committed catalog equals its generator's output byte for byte: rerun the repository's extract, compile and aggregate scripts in the scratch clone, then `git diff --exit-code`.
- **G2. Generated files are not reformatted.** Where the repository's formatter covers a generated catalog, its ignore file lists that catalog in the same unit. The formatter's check passes on every other file the change adds or modifies, run on those files directly, not only through the repository's lint script, whose globs may skip them.
- **G3. No hand-written locale files.** The change creates no target locale JSON and no `deploy/locales/<locale>.json`; those arrive from Phrase.

## Workflows

- **W1. Reviewed, immutable pins.** Every `uses: RedHatInsights/i18n-tooling/...@<ref>` names a 40-character commit SHA on i18n-tooling's default branch: `gh api repos/RedHatInsights/i18n-tooling/compare/<sha>...<tooling-default> --jq .status` prints `ahead` or `identical`. A `<reviewed-commit-sha>` marker is allowed only when the PR description lists replacing it; once a real SHA is pinned, the `zizmor: ignore[unpinned-uses]` comment is gone.
- **W2. Least privilege.** Each caller has top-level `permissions: {}`, and each job grants only the permissions it needs.
- **W3. Caller inputs.** The locale validation caller sets only `package-manager`, `validation-config`, `node-version` (when it differs from the tooling default) and `catalog-only` (only for a repository with no JavaScript sources).
- **W4. Caller paths cover the config.** The caller's `paths` include the caller file, the validation config, every catalog and generated file, each `catalogDirectories` entry as `<dir>/**`, every `sourceLint` file, every `feo` template, and the scripts, inputs and lockfile behind each generator.
- **W5. One Phrase mode.** Hub mode adds no submit or reconcile callers. Standalone mode adds only the missing ones. No secret was created or read.
- **W6. State branches are free.** Each new Phrase config's state branch (default `i18n-tms-state`) either does not exist (`git ls-remote --heads origin <branch>`) or holds no active record (phase other than `completed`, `failed`, `superseded`) for another project or source filename. List the records with the command in [phrase.md](phrase.md#config-both-modes).

## Message content

- **M1. Mechanical fixes change no wording.** In the mechanical-fix commit, each change is ICU syntax or a misspelled `description` key renamed with its text unchanged: `git show <commit> --word-diff`.
- **M2. AI-drafted descriptions are labelled.** They sit in their own commit, whose message says they are AI-drafted and need human review before they reach Phrase.
- **M3. Changed English is named.** A catalog catch-up commit names every message whose shipped English changes. Without a catch-up, show it was not needed: run the extractor on `<default>`'s sources in the scratch clone and `cmp` the output with `<default>`'s catalog.

## PR description

- **R1. Follow-ups are complete and true.** The admin checklist holds every admin follow-up item of the selected mode's reference that still applies ([phrase-standalone.md](phrase-standalone.md#admin-follow-up) or [phrase-hub.md](phrase-hub.md)), and each claim it makes about environments, branch policies and secret names matches the read-only `gh api` checks in [phrase-standalone.md](phrase-standalone.md#read-only-checks). The description also lists every unresolved wording finding with file and, where the CLI reports one, line; the tracking ticket link, or the developer's recorded "none" with any candidate keys found in the repository; and, for a GitHub template repository, the rename-and-register step for derived apps.
- **R2. Template kept.** The repository's PR template headings and checklists are kept; each placeholder is filled or deleted.
- **R3. Review record.** The description carries this checklist's results with evidence, who ran them (a fresh subagent or session, or the onboarding agent itself), the Node and package manager versions used, and a link to this file that resolves: at the i18n-tooling commit the callers pin when `gh api 'repos/RedHatInsights/i18n-tooling/contents/skills/i18n-onboarding/references/review-checklist.md?ref=<sha>'` finds it there, otherwise on the default branch.
