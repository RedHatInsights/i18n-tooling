# Phrase operations

How Phrase batches and locale pull requests behave, and what to do when one is stuck. For setup, see [Phrase TMS setup](phrase-tms.md). The internal design is in the [architecture guide](architecture.md#tms-workflow).

## Where is my translation?

Submit runs when a merge changes the configured source paths, or when the submit workflow is dispatched. Reconcile runs on the caller's schedule. The [example caller](../examples/phrase-consumer/.github/workflows/phrase-reconcile.yml) uses `23 6,14 * * 1-5` (06:23 and 14:23 UTC on weekdays). Hub-managed repositories follow the hub's schedule; see the runbook in the `RedHatInsights/i18n-hub` README (internal). Translations finished in Phrase appear on the next reconcile run; dispatch reconcile with `workflow_dispatch` to get them sooner.

1. **Open the Actions run summary.** Submit shows whether it created a batch or reused one for unchanged source, plus the short source commit, job count, locales and Phrase project link. Reconcile shows each batch's source and submission time, then one row per locale with its final Phrase job, PR, recorded assignees and validation finding counts.
2. **Follow the links** to the Phrase job or locale PR. A warning alert means a locale PR has translation errors. Detailed errors and warnings are in the PR's 🌐 Translation check comment; the summary shows only counts.
3. **Last resort:** read the batch record at `<state.branch>:<state.directory>/<key>.json`.

| Outcome | Meaning and next step |
| --- | --- |
| `pending` | Phrase is still translating. Reconcile checks again next run; the final workflow step must be `COMPLETED`. |
| `retrying` | A temporary issue; the next run retries. `Phrase has not yet exposed the new jobs; the next run continues this batch` means wait. |
| `failed` | A pipeline step failed. Read the job log and fix the Phrase job or config, then [retry](#retrying-a-failed-batch). `No Phrase job was created for this batch; voided after 15 minutes` means dispatch submit again. |
| `invalid-translation` | The locale PR was delivered with translation errors. Fix the translation in Phrase and keep the final jobs `COMPLETED`; the next run updates the same PR. |
| `pr-created` | Review the draft locale PR and its 🌐 Translation check comment. |
| `superseded` | Newer source was submitted; follow the newer batch. See [superseded PRs](#superseded-batches). |

## Locale pull requests

- One draft PR per locale, titled `i18n(<repositoryLocale>): Phrase translation update for <source path>`. The source path is `sourceCatalog.path`, or `frontendTemplate.path` for generated-source Frontend configs.
- The first creation assigns the people who changed the source strings since the previous matching batch; hub callers can pass `fallback-assignees` for when none can be assigned.
- A PR opens **even when validation fails**. The description carries a one-line findings status, and the 🌐 Translation check comment has the error and warning tables. Each validation failure is reported once per export attempt, and a new comment is posted when the findings, batch or final job change. If parsing fails, the downloaded bytes are kept. Generated Frontend YAML is not updated until validation passes, so a retained YAML block may come from an earlier valid export: do not merge it alongside an invalid catalog.
- **Corrections flow into the same PR.** Fix the translation in Phrase; while the PR is open, every reconcile re-exports from the same final job (one Phrase export per open PR per run) and commits to the same branch only if the files changed. The status line also refreshes when only the findings change. Phrase jobs stay `COMPLETED`; reconcile never comments in Phrase or changes job status.
- **Drafts stay drafts.** Tooling never marks a PR ready or merges it. An invalid re-export converts a ready PR back to draft before writing; a valid one leaves a ready PR ready. The same holds when adopting a PR after interrupted or raced creation, and invalid content for a branch without a recorded PR waits until its draft PR is established. If draft conversion fails, the branch is not updated and the locale reports a delivery failure.
- **Reviewer commits stop automation.** A branch whose head is not tooling-owned is no longer re-exported, and the commits are preserved.
- **Closing a PR** without merging ends delivery for that locale in the batch and does not fail it. Reopening resumes re-export only while the batch is active and the branch head is tooling-owned. Submitting unchanged source does not open a replacement.

## Batches

A batch is keyed by repository, PR base, exact source bytes and the Phrase-facing settings (project, region, filename, import settings, target languages). The source commit is not part of the key, so re-dispatching or pushing unrelated commits never creates a second Phrase job for unchanged source. A config change that Phrase sees, such as adding a target locale, submits a new batch for every locale. Active batches adopt repository-side mapping changes (output paths, adapters, completion policy); completed batches keep their stored configuration.

Batches live on the state branch under `.github/i18n-state/batches/`; the GitHub contents API lists at most 1,000 records per directory.

**Phases:** `creating` → `importing` → `ready` → `completed`, or `failed` / `superseded`.

- `ready` lasts while any locale PR is open. The batch becomes `completed` once every locale is final and every PR is merged or closed. Reopening a PR after that does not resume automation.
- `failed` and `superseded` batches are not reconciled again, except that submit may move past an empty stuck batch after voiding it.
- `COMPLETED` on the final Phrase workflow step is the only success signal; `DELIVERED` is not.
- `per-locale` targets deliver each locale independently, including invalid drafts. An `all-locales` target waits for every locale's final job and stays pending while another locale has validation errors, including errors on an existing draft PR.
- Reconciliation exports from one final job part per catalog and locale.
- Reconcile resumes `importing` batches whose submit timed out and repairs eligible empty `creating` or `unknown` batches.
- `tms reconcile` exits non-zero for locale failures or `retrying` errors. An error in one batch never blocks others.

### Superseded batches

When newer source is submitted, the older batch is superseded. Its locale PR closes automatically once the replacement carries the same translations for unchanged English: at the replacement's head while it is open, as merged once it merges. A replacement closed without merging carries nothing. An old PR with reviewer commits stays open with a notice. Old Phrase jobs are never cancelled automatically, since that would discard translator work; cancel stale jobs in Phrase yourself. Resubmitting superseded source that has become current again revives the existing batch instead of creating a job.

### Retrying a failed batch

A `failed` batch blocks resubmission of the same source. After fixing the Phrase job or import failure, run `tms submit --retry-failed` (workflow input `retry-failed: true`) to create a new attempt.

- For a `ready` or `completed` batch with failed locales, the retry includes only those locales and carries successful locale PRs forward. A fully successful batch stays idempotent.
- A locale with an open draft PR counts as delivered, even with validation findings. Fix its existing Phrase job; reconcile re-exports and re-validates it in place without a new job.
- After reconcile records that an invalid PR was closed without merging, `--retry-failed` can create a fresh job and PR for that locale; the closed PR is kept for audit. Merged PRs are never retried.
- An empty stuck `creating` or `unknown` batch needs no `--retry-failed`; see below.

## Errors

### Missing or ambiguous Phrase jobs

Do not edit batch state. After Phrase returns job parts, submit saves every workflow level, the job UIDs, the async request ID and the `importing` phase before verifying them. A new job that returns 404 is retried up to five times over about 60 seconds; if still missing, the batch stays `importing` and the run exits non-zero for the next run to continue. A stored-job 404 reports `retrying` while the batch is under 15 minutes old; after that it is a pin mismatch.

If a `creating` or `unknown` batch has no saved jobs, the next submit or reconcile searches Phrase. Reconcile searches only for records whose stored project and source filename match the loaded config, and still processes other configs' batches as usual. Candidates are grouped by creation time:

- **One complete group** (its locale set matches the pending locales at every workflow level): all parts are bound and the next run resumes import polling without the original async request ID.
- **No unclaimed candidates:** `retrying` for 15 minutes. After that, reconcile marks the batch failed, and submit marks it failed and starts the next attempt automatically. A batch is voided only when Phrase has no candidate jobs.
- **Anything else** (partial groups, extra locales, levels that disagree, more than one match): the batch stays unchanged and the error lists every candidate's UID, locale and creation time. The messages are `Phrase returned candidate jobs with missing or invalid recovery metadata.`, `Phrase jobs exist for this batch, but no creation-time group matches its pending locales.` or `More than one Phrase creation-time group matches this batch.`, followed by `Candidate jobs grouped by creation time: <candidates>.` **Move the jobs that do not belong to this batch to the Phrase recycle bin, then rerun.**

### GitHub write failures

Errors include the HTTP status, REST operation and bounded, token-redacted API diagnostics. A rejected write does not necessarily mean another run changed state: branch protection, missing permissions and validation can also reject it. Check the reported cause before rerunning. `Phrase batch state changed concurrently` reports a state-file revision race; an unrelated state-branch head change is retried only for HTTP 409 while the file revision is unchanged.

## Concurrency and timeouts

- Reconcile runs are serialized per target repository and config path; submit runs per target repository, config path and base ref. Different configs run in parallel, and submit and reconcile use separate groups, so a queued reconcile never cancels a submission.
- A reconcile that supersedes a batch while another reconcile updates one of its PRs is safe: the updating run re-checks eligibility just before moving the branch. At worst a superseded batch's PR gets one more export, validated against its own source.
- Running `tms` commands for the same config concurrently outside these workflows is unsupported.
- Jobs time out after 30 minutes, Phrase requests after 60 seconds, GitHub requests after 30 seconds.
