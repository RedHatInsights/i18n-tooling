# Consumer onboarding

This checklist onboards a frontend repository to shared catalog validation and the Phrase TMS round trip. It is written so a person or a coding agent can follow it in order; each step names a check that proves it is done. The [Phrase consumer integration example](phrase-consumer-integration.md) has copyable files, and the [package guide](../packages/i18n-pipeline/README.md#generic-project-validation) documents the validation config.

The traps listed under each step were found while piloting `insights-rbac-ui`. Expect the same ones in other FormatJS consumers.

## 1. Measure existing drift first

Run the consumer's own extraction, compilation, and aggregation scripts on a clean checkout of the default branch, then run `git status`.

- **Trap: the default branch is already stale.** In rbac-ui, an earlier feature PR changed `src/Messages.js` without regenerating the catalogs, so about 40 English strings were missing from every checked-in catalog. Land that catch-up as its own commit or PR, before any tooling change. Mixed into the onboarding, it hides which catalog changes the tooling caused, and reverting the onboarding would also drop real strings.
- **Trap: duplicate message IDs.** FormatJS extraction only warns when two descriptors share an ID with different text or descriptions (rbac-ui: `recommendedContentTitle`). The catalog keeps one of them, and translators see only that one. Resolve every duplicate warning before the first Phrase submission.

**Done when:** regeneration on the default branch leaves no diff, and extraction prints no duplicate-ID warnings.

## 2. Make every generator honor an output path

`validate-project` re-runs each generator into a temporary `{output}` file and compares the result with the checked-in file. Each script must therefore write where it is told, and nowhere else.

- FormatJS `extract` and `compile` accept a second `--out-file`; the last value wins. Reuse the package script (`npm run --silent translations:extract -- --out-file {output}`) instead of copying its arguments into the config, so the check runs exactly what developers run.
- Custom aggregation scripts (such as a `createDataJson.js` that writes `src/locales/data.json`) usually hard-code their output. Add an output option that defaults to the current path.
- **Trap: silently ignored CLI flags.** rbac-ui's aggregation script read options as `program.langDir`, which Commander 7 and later no longer populate, so its `-l`/`-I` flags did nothing. Use `program.opts()` and test that the new output flag is actually respected.

**Done when:** each generator, pointed at a temporary path, leaves `git status` clean.

## 3. Write the validation plan

Create `.github/i18n/catalog-validation.json`:

- `checks`: the source catalog against compiled English (and any catalog outside Phrase).
- `tmsConfig`: the path to `phrase-tms.json`. Target locales come from there; do not list them again. Phrase locale codes and repository codes differ (`zh_cn` against `zh-CN`), so keep that mapping in one file.
- `generated`: extraction, compilation, and every runtime aggregate. A locale-keyed aggregate is not a catalog, so omit `adapter` for it to get a plain JSON comparison.
- `catalogDirectories`: every directory that holds locale files, so an undeclared or leftover file fails.

**Trap: build hooks hide stale aggregates.** A `prebuild` hook that regenerates `data.json` makes builds correct but leaves the checked-in file stale, and unit tests often import the checked-in file directly. Validate the aggregate as a `generated` entry even when the build regenerates it.

**Done when:** `i18n-pipeline validate-project --config .github/i18n/catalog-validation.json` passes locally. Then deliberately break each piece (delete a message, edit the aggregate, add a stray `xx.json`) and confirm each break fails.

## 4. Wire the package scripts

- Add `translations:validate` that runs `i18n-pipeline validate-project --config .github/i18n/catalog-validation.json`.
- **Trap: wildcard script runners.** `npm-run-all translations:*` also picks up new `translations:validate` or `translations:prepare` scripts. List the steps explicitly.
- **Trap: pre-hooks match exact names.** `prestart` does not run before `start:no-proxy`. Add a hook for every entry point that serves the app, or none.
- The CLI is not published to npm. To run it locally, build `packages/i18n-pipeline` in an `i18n-tooling` checkout and put a `i18n-pipeline` wrapper for `dist/cli.js` on `PATH`. CI builds it from the pinned workflow source.

**Done when:** `npm run translations` regenerates everything and `npm run translations:validate` passes.

## 5. Add the CI callers

Copy the callers from [`examples/phrase-consumer`](../examples/phrase-consumer/.github/workflows/).

Unmapped workflow-call secret names arrive empty, so each caller must map every name it uses, even when its value is stored in the protected environment passed as `environment`. Keep credential values in that environment. For example:

```yaml
secrets:
  PHRASE_PLATFORM_API_TOKEN: ${{ secrets.PHRASE_PLATFORM_API_TOKEN }}
```

Map both `APP_*` names for App mode. Never use `secrets: inherit`.

- Pin every `uses:` to a reviewed `i18n-tooling` commit SHA. `validation-config` needs a tooling commit that contains `validate-project`; bump the SHA whenever the plan uses a newer feature.
- Set top-level `permissions: {}` and grant permissions per job.
- **Trap: source lint scope.** The default source glob scans all sources. Existing code with imported, dynamic, or inline descriptors fails immediately. Scope `sourceLint.files` in the validation config (or `source-glob` for a caller without a config) to the files that declare messages (rbac-ui: `src/Messages.js`), and track migrating the rest as separate work.

**Done when:** message-source files are included in the caller's PR path filters, and a source-only drift PR runs validation and fails.

### Check Phrase branch permissions (both modes)

Before the first submit or reconcile, inspect each config's resolved `state.branch` (default `i18n-tms-state`; FEO commonly uses `i18n-tms-state-feo`). This applies to hub and standalone automation, even when the branch does not exist yet. Submit creates the branch if missing, then writes batch records directly; later submit and reconcile runs update those records without a pull request.

Run these read-only checks for each state branch, using the consumer repository, not the hub:

```bash
repo=RedHatInsights/your-repository # Replace with the consumer repository.
state_branch=i18n-tms-state # Replace with the config's resolved state.branch.
encoded_branch=$(jq -rn --arg branch "$state_branch" '$branch | @uri')
gh api "repos/$repo/git/ref/heads/$encoded_branch"
gh api "repos/$repo/rules/branches/$encoded_branch" \
  --jq '.[] | {type, parameters, ruleset_id, ruleset_source}'
gh api "repos/$repo/rulesets?includes_parents=true" --paginate
```

- A missing ref is expected before the first sync; still inspect its effective rules. Existing branches need the same check: successful creation does not prove that batch-file writes are allowed.
- Inspect the matching repository and organization rulesets, their target patterns and bypass actors. Flag restrictions on creation or updates, required pull requests, and required status checks that prevent the automation's direct state writes. Verify access for the workflow's actual GitHub App or `GITHUB_TOKEN`, not the personal token used for inspection; an App bypass limited to pull requests does not permit direct writes.
- Also inspect classic branch protection, including wildcard patterns in repository settings. For an existing branch, `gh api "repos/$repo/branches/$encoded_branch/protection"` reads its protection. A 403/404, missing bypass details, or inaccessible organization policy is unverified, not proof of unrestricted access; ask an administrator to confirm it.
- Keep signing requirements unless separately proven incompatible. Do not disable default-branch protections or grant a repository-wide App bypass. If a matching ruleset blocks state writes, ask an administrator to exclude exactly `refs/heads/<state.branch>` from that ruleset, preserving its other settings. Check each configured state branch separately. Locale branches (`i18n/phrase-*`) also need creation and updates allowed, but their PRs must still satisfy the base branch's review and required checks.
- Record the branch, matching policy and ruleset URL, actual automation actor, and any unverified access or required admin action in the onboarding PR checklist and final report. Inspection is read-only: obtain explicit approval before changing repository settings, then re-check effective rules after the approved fix.

**Trap: state writes look like pipeline failures.** A creation restriction can produce `HTTP 422: Reference update failed` on `POST /git/refs`. An existing state branch subject to PR/check requirements can produce `HTTP 409: Repository rule violations found` on a batch-file `PUT /contents/...`. Inspect the reported GitHub rejection and effective rules; neither error alone proves a concurrency conflict, and retrying does not bypass policy.

**Done when:** every configured state branch has a recorded creation/direct-write assessment for the actual automation actor, with unresolved policy or access blockers listed as admin follow-ups. The Phrase round trip is not operational until those blockers are resolved; do not probe permissions by creating a branch or running live Phrase operations during onboarding inspection.

## 6. Pilot Phrase from a feature branch

- Run the pilot from its branch; nothing has to merge to the default branch first. GitHub starts `workflow_dispatch` and `schedule` only from workflows on the default branch, but a `push` runs the caller from the pushed branch. On the pilot branch, point the submit caller's `push.branches` at the pilot branch, give the reconcile caller the same `push` trigger in place of `schedule`, and mark both changes with `FIXME`.
- A push that changes the source catalog or the Phrase config runs submit; every push runs reconcile, so `git commit --allow-empty` and a push polls Phrase again. Locale pull requests target the pilot branch because same-repository runs check out the triggering commit and the PR base defaults to the pushed branch.
- Allow the pilot branch in the `phrase-pilot` environment's deployment refs during the pilot. Before merging, restore the triggers from the example callers and remove the pilot branch from the deployment refs.
- Store credentials only in the protected environment. Check the `Phrase auth:` line in the job log.
- Configure the Phrase project to translate `defaultMessage`, keep `description` as context, and parse ICU.
- **Trap: custom adapters stop at Phrase.** `tms submit` and `tms reconcile` run with the Phrase credentials and a GitHub token that can write, so they load only the [built-in adapters](../packages/i18n-pipeline/README.md#built-in-adapters). A Phrase config that names a custom adapter fails before any request is made. `validate-project` and `convert` still load custom adapters, so keep the file Phrase reads and writes in a built-in format and convert it in the consumer's own build.

**Done when:** submit creates jobs, reconcile opens a per-locale PR, and that PR's validation job passes. If a translator corrects a translation in Phrase while its PR is open, the next reconcile updates the same PR.

## 7. Confirm what users actually see

A delivered catalog is not a live locale. rbac-ui's `src/locales/locale.ts` always returns `en`, so translated catalogs ship but never display. Treat runtime locale selection as its own product change, with its own tests.

## 8. Turn on the merge and schedule triggers

After the pilot round trip, restore the triggers from the [example callers](../examples/phrase-consumer/.github/workflows/) so nobody has to dispatch a run:

- **Submit** runs on a push to the default branch that changes the source input or the Phrase config, and on a weekday schedule so a submission deferred while Phrase work was in flight is picked up without another push. Watch the Phrase config and actual source input: use `frontendTemplate.path` when `frontendTemplate.generateSourceCatalog` is true, otherwise `sourceCatalog.path`. A rerun for unchanged source reuses its batch instead of creating a second Phrase job. A config change that Phrase sees, such as adding a target locale, submits a new batch for every locale; see [how batches are keyed](phrase-operations.md#batches).
- **Reconcile** runs on a schedule. Pick your own minute, away from the top of the hour. Scheduled workflows run from the default branch only.
- Keep `workflow_dispatch` on both. The submit dispatch offers `retry-failed` for a batch that failed in Phrase.
- Restrict the Phrase environment's deployment refs to the default branch, and do not add required reviewers.
- A person's `PHRASE_PLATFORM_API_TOKEN` may serve until a dedicated technical user exists; then replace it with a technical-user token scoped to the business unit that owns the Phrase project. A Phrase Service Account is not an option for submit: its bot user [cannot create jobs](https://support.phrase.com/hc/en-us/articles/29488404284316-Service-Accounts). See [Phrase credentials](phrase-tms.md#phrase-credentials).
- **Trap: an environment with required reviewers.** A scheduled run then waits for approval and never starts on its own.
- **Trap: nobody sees a failed schedule.** GitHub notifies only the person who last edited the workflow's `cron` line. Agree who watches the Actions tab, or add your own notification step to the caller.
- **Trap: schedules stop in quiet repositories.** GitHub disables scheduled workflows in a public repository after 60 days without activity. Re-enable the workflow in the Actions tab.
- **Trap: locale pull request checks.** GitHub Actions holds checks on a pull request opened with `GITHUB_TOKEN` until a maintainer approves them. Konflux on locale PRs remains untested and requires a separate acceptance check; when a check does not start, a repository collaborator comments `/ok-to-test`. See the [GitHub Actions and Konflux caveats](phrase-tms.md#locale-pr-checks), and agree who watches new locale pull requests.

**Done when:** a merge that changes a message starts submit on its own, a merge touching neither the source input nor the Phrase config does not start submit, and the next scheduled reconcile runs without waiting for approval.

## Hub-owned Phrase automation

Keep catalog validation and the Phrase config in the consumer repository. Install the hub's GitHub App, [`hcc-i18n-tms-sync`](https://github.com/apps/hcc-i18n-tms-sync/installations/new), on each target consumer during onboarding, then submit a reviewed registration to `i18n-hub`'s `consumers.json` with `phraseFile` (add `phraseProject` only for a project other than the shared `hcc-ui` one); follow the README of the `RedHatInsights/i18n-hub` repository (not public). Phrase credentials and the reconcile schedule live in the hub. Complete the [branch-permission preflight](#check-phrase-branch-permissions-both-modes) on the consumer before its first hub sync; registering in the hub does not bypass consumer branch rules. Choose hub-owned or consumer-owned Phrase automation for a repository; never run both.

## Rolling back

Stop the automation first, then decide what to keep.

1. Disable the two caller workflows in the Actions tab, or remove their `push` and `schedule` triggers. Nothing runs after that.
2. Keep the state branch (`i18n-tms-state` in the example). Never delete it or its records. It is the only record of which Phrase jobs exist. Without it the next submit creates a new Phrase job for a source that was already sent, translators receive duplicate work, and reconcile no longer knows about the jobs in progress.
3. Leave open locale pull requests open, or merge them. Disabling the workflows leaves PRs intact; after resuming, reconcile refreshes eligible open PRs from Phrase. Closing one without merging does not fail the locale. A closed PR is checked for reopening while its batch remains active; reopening resumes re-export only while the branch head remains tooling-owned. Once a reconcile observes every PR in the batch merged or closed, the batch completes, and reopening afterward does not resume automation.
4. Phrase jobs keep running. The tooling never cancels them. Cancel in Phrase the ones you no longer want; cancellation fails undelivered locales. For a locale with an open PR, it blocks refresh and reports failure while preserving the PR record. See [Cancelling stale Phrase jobs](phrase-operations.md#cancelling-stale-phrase-jobs).
5. To return to an earlier tooling version, pin `uses:` back to the previous reviewed commit SHA.

To resume, enable the workflows again. Reconcile continues from the stored state and submit skips sources it has already sent.

## Agent prompt

Paste this into a coding agent session in the consumer repository:

```text
Onboard this repository to RedHatInsights/i18n-tooling catalog validation and the Phrase TMS
round trip. Follow docs/consumer-onboarding.md from i18n-tooling step by step. For every step,
run its "Done when" check and report the result before moving on. Keep catalog catch-up,
tooling onboarding, and runtime locale selection in separate commits. Never put Phrase
credentials in files. Pin reusable workflows to a reviewed commit SHA. Mark any temporary
pilot-branch settings with FIXME and list them in your final summary.
```
