---
name: i18n-onboarding
description: Use when a developer asks to onboard a repository to i18n tooling, add i18n validation, set up translations/Phrase (i18n-hub or standalone), or localize FEO navigation/search/tiles. Inspect the repository, select applicable validation, Phrase, Konflux, and FEO tracks, and drive i18n-pipeline to wire and verify them.
---

# Onboard a repository to i18n tooling

Use this skill when a developer asks to add catalog validation, translation delivery, or FEO localization to a repository. Inspect first, then propose one plan and ask the developer to approve it. Open the wizard only when they want to adjust the plan. After approval, finish the planned work without further questions unless a real ambiguity blocks safe progress.

## Resolve and check the CLI first

Use the first available CLI in this order, and tell the developer which source you used:

1. `i18n-pipeline` on `PATH`: run `i18n-pipeline version`.
2. The repository's local devDependency: only when `package.json` declares `@redhat-cloud-services/i18n-pipeline` and its local `i18n-pipeline` shim is installed, run `npx --no-install i18n-pipeline version`. Otherwise skip this step so `npx` cannot try to reach the registry.
3. `I18N_PIPELINE_CLI` pointing to the absolute path of a built `cli.js`: run `node "$I18N_PIPELINE_CLI" version`.
4. If none is available, stop before editing. Explain that the npm package is not published yet. Ask the developer to build this repository with `npm run build` and set `I18N_PIPELINE_CLI` to `packages/i18n-pipeline/dist/cli.js`, or make the built CLI available on `PATH`.

This skill supports `i18n-pipeline` version `0.1.0`. Compare the output of `version` before doing any work. If it differs, stop and tell the developer to update the skill or the CLI. Use the selected launcher for every later CLI call. When `I18N_PIPELINE_CLI` is selected, invoke it as `node "$I18N_PIPELINE_CLI" <command>`.

Add the `translations:validate` package script during the baseline track. If an existing script would start running it, such as `npm-run-all translations:*`, keep that script's current behavior and say so in the commit body. Until the first npm release, leave the devDependency out and report it as pending. After publication, add `@redhat-cloud-services/i18n-pipeline` as a devDependency with the repository's package manager.

## Inspect before asking

Read the repository's agent instructions and relevant contribution or localization docs. Then inspect the repository without asking questions or changing files. Narrate the inspection: before each check, tell the developer in one line what you are checking and why (for example, "Konflux: checking whether the pinned shared pipeline supports i18n validation"), so no command runs unexplained.

- Identify the repository root, package manager, default branch, current branch, and clean or dirty status. Record existing dirty paths.
- Find FormatJS/react-intl usage, source and target catalogs and their formats, explicit or generated message IDs, and extract, compile, and aggregate scripts.
- Inspect `deploy/frontend.yaml` for FEO navigation, search entries, service tiles, `alt_title`, and `module.defaultDocumentTitle` strings.
- Find OpenAPI Problem Details specs and keyed ICU JSON catalogs.
- Find `i18n/catalog-validation.json` and `.github/i18n/catalog-validation.json`.
- Find current validation workflows, including any `i18n-validation.yml`, Phrase caller workflows, and `.tekton/*.yaml` PipelineRuns. For every PipelineRun, record the shared pipeline reference and revision.
- If FEO localization is present, check the **locked** Frontend CRD schema for `spec.properties.locales` as [references/feo.md](references/feo.md#check-fec-schema-support) describes.
- Run the selected CLI's `validate-ci --mode warn` before making changes. It discovers either config path above. Report the findings even though `warn` mode exits successfully for findings. On a repository with an existing config, describe its current results and completed tracks instead of replacing its baseline.

Use [references/validation-baseline.md](references/validation-baseline.md) to map repository catalogs and generators into the config. Read [references/konflux.md](references/konflux.md), [references/phrase.md](references/phrase.md), and [references/feo.md](references/feo.md) when those tracks are detected. Read [references/harnesses.md](references/harnesses.md) before asking for approval or looking for a Jira tool.

## Propose the plan and get approval

After inspection, settle every decision below on its default; a preference the developer already stated in this session replaces it. Present the result as one **plan**: what you will change, in which order, and which external actions you will take. Make every line concrete: each track with the files it adds or changes, the Phrase mode, the target locales, the branch name, whether you will commit, push and open a PR, and the Jira choice. Then ask one question: **proceed**, **adjust**, or **stop**. Start edits only after the developer approves; a plan on screen is not consent.

- **Proceed** approves the whole plan, including every external action it names.
- **Adjust** opens the **wizard**: one consolidated question set covering the applicable decisions below, each preselected with its value from the plan. The submitted wizard is the approval; restate the plan lines that changed, then start.
- **A reply that names its own changes** (for example "proceed, `fr` only") is approval of the plan with those changes. Restate the changed lines, then start.
- **Stop** ends the run with no changes; report the inspection findings.

Decisions and their defaults:

1. **Tracks to run**: the applicable validation baseline, Phrase submit/reconcile, FEO localization, and Konflux tracks. Default: every relevant available track. When FEO localization applies and the locked FEC schema does not accept `spec.locales`, list **FEC upgrade (required by FEO)** as its own track, included by default. Show Konflux as **not yet available** unless the PipelineRun's referenced shared pipeline at its recorded revision declares `i18n-validation-mode`; state that check as the condition and do not guess.
2. **Jira tickets**: none (default), draft only, or create through an available Jira tool. If creation was chosen but no Jira tool is available, write the drafts to `i18n-onboarding-ticket-drafts.md` in the repository and report that fallback.
3. **Branch layout**: one branch with one commit per logical unit (default), or one branch per selected track.
4. **Autonomy**: push and open a PR (default), commit the selected changes, or edit files only. In hub mode, push-and-PR also covers the i18n-hub registration PR. Commit, push, or open a PR only when the approved plan says so.
5. **Message IDs and source catalog, only when detected**: when IDs are generated or no source catalog is committed, keep the repository's current ID style and validate without the missing-ID rule (default), or migrate to explicit IDs.
6. **Phrase mode, only when the Phrase track is offered**: **i18n-hub** (default for a `RedHatInsights` repository), **standalone with the repository's own GitHub App**, or **standalone with `GITHUB_TOKEN`**. Outside `RedHatInsights`, drop the hub option and default to the standalone App option. [references/phrase.md](references/phrase.md) defines the modes and how to detect an existing one.
7. **Target locales, only when the Phrase or FEO track is offered and they are not discoverable**: default to the tier-1 set `fr`, `ko`, `ja`, `zh-CN`. The Phrase project is not a decision: every repository joins the shared HCC project, which [references/phrase.md](references/phrase.md#shared-project) defines.

If the repository already has a working validation config or callers, show those tracks as done in the plan and propose only missing tracks and upgrades. An upgrade means a new config field, a newer reviewed workflow pin, changing an existing `warn` setting to `error` where supported, moving a `RedHatInsights` repository's standalone Phrase callers to the i18n-hub, or switching a Phrase config to the `hcc-ui` preset ([references/phrase.md](references/phrase.md#switch-to-the-hcc-ui-preset)). When the Phrase track is already done, leave out the mode decision: the migration upgrade in the track list stands in for it.

When the message-ID decision applies and the plan keeps the existing style, generate the source catalog if the repository's extractor can produce one, include it as a repository deliverable, and omit `sourceLint.catalog` so validation does not enforce explicit IDs. Stage or commit it only if the selected autonomy allows that. If migration is selected, use stable explicit IDs and update the source catalog. Leave this decision out of the plan when neither condition is present.

## Work safely and in reviewable units

- Work on a new branch, never commit on the default branch. After approval, create a descriptive onboarding branch (or use the ticket key in its name) unless the current non-default branch is already dedicated to this onboarding. If the branch cannot be created (for example read-only Git metadata in a sandbox), say so; continue only when the developer chose edit-files-only autonomy, leaving every change unstaged, and otherwise stop. Preserve existing dirty paths; if a dirty path overlaps a file that must change and ownership or intended content is unclear, stop and explain the conflict before editing. Untracked files in a disposable fixture copy are part of that copy; inspect and preserve them rather than treating their mere presence as a conflict.
- Change files only inside the consumer's working tree unless the approved plan names an external action. Push, open a PR, or create Jira tickets only when it does.
- Never run live Phrase submit or reconcile operations, create secrets, or inspect secret values. Never hand-write generated locale JSON. Stage only files changed for the selected unit; never use `git add -A`.
- Fix unambiguous ICU syntax defects mechanically in their own unit. Do not change meaning or wording to silence a finding. Report those findings with file and line for the developer.
- Draft missing FormatJS `description` fields by reading the surrounding component. Keep all drafts in a separate unit. Its commit message must say the descriptions are AI-drafted and require human review before they reach Phrase. Where context is ambiguous, suggest a screenshot that shows the message in use.
- Keep work in this order: validation configuration and script; mechanical ICU fixes; AI-drafted descriptions; dependency upgrades; Konflux switch; Phrase files; FEO files. Open the i18n-hub registration PR last, after the consumer PR exists. With one branch per track, preserve this order within each branch where units depend on one another.
- Upgrade a dependency with the smallest change that brings in the needed version. When the needed package is transitive and its parent's range already allows the version, update only that package in the lockfile (for npm, `npm update <package>`) and leave `package.json` unchanged. Compare the lockfile before and after, list every package whose version changed in the commit body, and run the repository's build and unit tests after the upgrade. A change outside the needed package needs its own reason in that body.
- When the developer chose commits, make one commit per logical unit, in the order above. Each commit message has a subject and a body that says why the change is needed. Before each commit, run `validate-ci --mode error` on the tree being committed, and commit only when it passes. When it fails and the fix does not belong to this unit, stop: leave the unit uncommitted, report the failure, and do not push or open a PR. If they chose files only, leave all edits unstaged. If they chose a PR, put every manual follow-up item in its description and retain the repository's PR template.
- The repository change holds only configuration, callers, scripts, catalogs, and source fixes. Findings, follow-ups, admin checklists, and drafted hub entries belong in the final report and, when a PR is opened, its description, whatever the autonomy level. Add no notes, findings, or README files for them.

## Run the selected tracks

### Validation baseline

Apply [references/validation-baseline.md](references/validation-baseline.md) to the repository's format. Write a new config at `i18n/catalog-validation.json`, or update the config the repository already has, with the applicable `checks`, `generated`, `catalogDirectories`, `sourceLint`, and `feo` or OpenAPI adapter entries. Add `translations:validate` (or the repository's existing equivalent) to run `i18n-pipeline validate-ci --mode error`. Add the locale validation caller described in [references/validation-baseline.md](references/validation-baseline.md#run-it-on-pull-requests), so PRs show validation errors immediately; this holds in every Phrase mode, since the i18n-hub runs no PR checks. Prove the config with `validate-ci --mode error`, then deliberately break one item for each configured check, confirm that error mode fails, and restore the exact original content before continuing.

### Konflux

Run this track only when the referenced shared pipeline at the PipelineRun's pinned revision declares `i18n-validation-mode`. See [references/konflux.md](references/konflux.md). Once available, explain that the shared validation step runs in `warn` mode by default. When `validate-ci --mode error` passes for the repository, set `i18n-validation-mode` to `error` in its PipelineRuns; while error findings remain, leave the default and report the switch as pending. Preserve unrelated PipelineRun fields.

### Phrase submit and reconcile

Read [references/phrase.md](references/phrase.md), then the reference for the selected mode. Add or update `phrase-tms.json` and the locale validation caller, mapping Phrase locale codes to repository locale codes. In hub mode, add no submit or reconcile callers, then register the repository in the i18n-hub as [references/phrase-hub.md](references/phrase-hub.md) describes. In standalone mode, add only the missing submit and reconcile callers and check the environment's secret names read-only as [references/phrase-standalone.md](references/phrase-standalone.md) describes. List every admin step that is still needed. Never submit, reconcile, create secrets, or run a live Phrase operation.

### FEO localization

Read [references/feo.md](references/feo.md). Add stable YAML item IDs and translator context through the fields the CLI extracts, generate `deploy/locales/translation-template.json` with `feo extract`, and add the `feo` validation entry. Stage or commit the generated template only if the selected autonomy allows that. Do not create `deploy/locales/<locale>.json`; each arrives later from Phrase, which with the FEO Phrase config also writes `spec.locales.<locale>` in the same PR. Validation reports drift and does not rewrite files.

## Finish and report

Run `validate-ci --mode error` after every selected track. The run is done only when it passes on the final tree; otherwise report the errors as the first item and leave the work unpushed. Restore all deliberate test breaks and confirm the final working tree contains only intended changes. If a PR was selected, include the manual admin checklist and every unresolved wording finding in its description, above the unchanged PR template. Report the selected tracks, validation findings, CLI source and version, branch and commits, Phrase mode with the i18n-hub entry and registration PR or the standalone auth mode, Jira tickets or draft path, pending devDependency, and manual follow-ups.
