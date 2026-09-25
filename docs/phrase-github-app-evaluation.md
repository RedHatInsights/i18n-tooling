# Phrase GitHub App / Connector Evaluation

**Status:** Recommended for sandbox validation, not yet production adoption

**Repository:** `i18n-tooling`

## Recommendation

Use Phrase's GitHub integration as a **provider adapter for source intake and Automated Project Creation (APC)**, not as the complete HCC localization pipeline.

Recommended shape:

```text
Frontend repository
  -> Phrase GitHub App / GITHUB2 connector
  -> Phrase APC creates or updates translation project
  -> Phrase translators/reviewers work
  -> Phrase webhook or scheduled reconciliation wakes i18n-tooling
  -> i18n-tooling re-queries final job state
  -> downloads target catalogs
  -> validates ICU, IDs, locales, and parameters
  -> opens one reviewed GitHub PR
```

Keep `i18n-tooling` in control of validation, durable source/job mapping, fallback behavior, idempotency, and PR creation. Do not let a Phrase connector bypass repository CI or merge translated files directly into a protected branch until a sandbox proves the exact behavior.

This hybrid approach gives us the low-maintenance source synchronization of the Phrase integration while preserving repository-owned catalogs and the provider-neutral gateway seam.

### Completion-signal decision

The GitHub App is not the completion signal. It authorizes Phrase's connector to access GitHub; APC uses that connector to create or update Phrase projects. Use a Phrase TMS webhook for prompt notification, then re-query Phrase before acting:

```text
Phrase JOB_STATUS_CHANGED webhook
  -> durable receiver validates token and deduplicates event
  -> repository_dispatch / workflow_dispatch
  -> GitHub Action re-queries all mapped jobs/locales
  -> require final workflow state for every expected locale
  -> download, validate, and open PR
```

For the first implementation, a scheduled GitHub Action that polls and reconciles is the simplest option because it needs no inbound service. The production design should add the webhook as a low-latency wake-up path and retain scheduled reconciliation as recovery. Never create a PR directly from the webhook payload: events can be duplicated, account-wide, and insufficient to prove that every locale is ready.

If forced to choose one completion mechanism:

- **Easiest MVP:** scheduled polling/reconciliation.
- **Best production latency and reliability:** Phrase webhook plus idempotent receiver plus scheduled polling fallback.
- **Not a completion mechanism:** GitHub App/APC alone.

### GitHub-Actions-only POC

For the first POC, omit the webhook receiver and use two GitHub workflows:

1. **Submit workflow** — manual dispatch or source-catalog change uploads/submits one batch and records its Phrase project/job mapping.
2. **Reconcile workflow** — `schedule` plus `workflow_dispatch` polls Phrase, and when every expected locale reaches the final workflow state, downloads, validates, and opens the PR with `gh pr create` or the GitHub API.

Use a Phrase Service Account in GitHub Actions secrets and the built-in `GITHUB_TOKEN` for the PR. Add workflow concurrency so two reconciliations cannot create duplicate PRs.

For a single-batch POC, keep state in a small bot-managed state file or dedicated state branch. Do not use Actions cache as the source of truth. A long-running submit-and-poll job is simpler only when the fake/sandbox translation completes within one job; it is unsuitable for human translation that may take days.

Example trigger shape:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

concurrency:
  group: i18n-reconcile
  cancel-in-progress: false
```

GitHub schedules are not real-time and may be delayed, but this approach has no inbound service, no webhook secret endpoint, and no serverless infrastructure. Add Phrase webhooks later as an acceleration path that triggers the same reconciliation command; keep the schedule as recovery.

## Why not make the Phrase App the whole pipeline?

Phrase's GitHub integration and APC can connect repositories and automate project creation, but the critical target-side behavior still needs verification:

- Does target export create a branch, commit, or pull request?
- Which repository, branch, path, and commit identity does it use?
- Can it preserve ICU JSON structure and metadata?
- Can it create exactly one PR per translation batch?
- Can it wait for the final translation/review workflow step rather than an intermediate job status?
- Can HCC control validation, missing-locale policy, and English fallback before repository changes land?
- Can Globalization allow HCC to configure and operate the organization-wide connector/APC settings?

Phrase's own APC documentation describes translation export rules, but it does not by itself establish that the result is a reviewed GitHub PR. Treat that as a sandbox acceptance test, not an assumption.

## What Phrase provides

### GitHub connector

Phrase TMS supports a `GITHUB2` connector based on the newer GitHub App model. The official connector guide says the App must be installed on the GitHub user account or organization before the connector can be created.

The documented installation URL is:

```text
https://github.com/apps/phrase-github-integrations-app/installations/new
```

The `GITHUB2` flow differs from the classic GitHub OAuth connector:

1. Start the Phrase connector authorization flow.
2. Install/authorize the Phrase GitHub App for the intended account or organization.
3. Call the GitHub2 connection endpoint:

   ```text
   POST /api2/v3/connectors/github2/connect
   ```

4. Receive a temporary local token and available GitHub logins.
5. Select the intended organization/account if more than one is returned.
6. Create the connector using `type: GITHUB2`, the selected `login`, and the temporary local token.
7. Test the connection and record the connector UID.

Phrase's connector guide explicitly warns that OAuth authorization alone does not install the GitHub App.

### Automated Project Creation

APC operates on top of an existing connector. It watches a connector-backed folder for new or changed source content and either creates a new translation project or updates a continuous project.

APC requires configuration for:

- Existing connector.
- Project template.
- Source and target languages.
- Monitored folder.
- Schedule or webhook trigger.
- Translation export rule.
- Continuous versus one-off project behavior.

Phrase documents these trigger choices as mutually exclusive:

- A schedule, such as weekly or interval-based execution.
- A `webhookToken` trigger.

APC also requires at least one translation-export rule, such as exporting when the final workflow step completes or when the project completes.

### TMS webhooks

Phrase TMS account webhooks can emit `JOB_STATUS_CHANGED`, `PROJECT_STATUS_CHANGED`, `PRE_TRANSLATION_FINISHED`, `ASYNC_REQUEST_FINISHED`, and other events.

Webhook facts relevant to our design:

- Webhooks are account-wide, not HCC-project-local.
- The receiver must filter by project/job identifiers.
- A security token is sent through `x-memsource-token` or `Authorization`.
- Phrase retries failed deliveries up to ten times, with delays computed up to thirty minutes.
- Phrase retains webhook history for fourteen days and supports replay.
- A webhook is deactivated after 3000 failed receptions.
- `JOB_STATUS_CHANGED` is a signal to reconcile state, not proof that all target locales have reached the final workflow step.

`i18n-tooling` should therefore use webhook events as wake-up signals and retain scheduled reconciliation as a safety net.

## Requirements

### 1. Phrase account and product entitlement

We need written confirmation from Localization Services that the HCC Phrase account supports:

- TMS access.
- GitHub/GITHUB2 connectors.
- APC.
- Account webhooks.
- ICU JSON import/export behavior required by FormatJS and i18next ICU catalogs.
- The target locale set: `fr`, `ko`, `ja`, and `zh-CN`.
- The desired project template and shared translation memory/term bases.

Phrase's connector documentation lists a Phrase account with TMS access, valid authentication, required role/access rights, and any applicable connector subscription add-on as prerequisites. Confirm the actual HCC account plan rather than relying on the generic documentation.

### 2. Phrase administrator

Connector configuration requires a Phrase user with:

- `ADMIN` or `PROJECT_MANAGER` role.
- Separate **Modify global server settings** access right.

The role alone is not sufficient according to Phrase's connector guide. This is likely a Localization Services or Globalization-owned operation, not a per-frontend-team responsibility.

### 3. GitHub organization approval

The target GitHub organization must approve installation of the Phrase GitHub App. Decide:

- Which organization owns `i18n-tooling` and pilot repositories.
- Whether the App may access only the pilot repository or multiple repositories.
- Whether it gets read-only source access, target-branch write access, or permission to create pull requests.
- Whether branch protection requires all imported translations to pass repository CI before merge.
- Which GitHub identity appears as the source/import author.

Phrase's public connector guide confirms the installation and authorization flow but does not define our organization's least-privilege policy. Verify the requested GitHub permissions in the installation screen and approve the minimum scope.

### 4. GitHub App authorization flow

The connector setup needs a human-assisted authorization step. It is not the same identity as the unattended `i18n-tooling` worker.

Keep these identities separate:

| Identity | Responsibility |
|---|---|
| Phrase GitHub App installation | Lets Phrase read the configured repository and use the connector/APC workflow. |
| Phrase Service Account | Lets `i18n-tooling` call TMS APIs without a human password. |
| GitHub Actions token/app | Lets `i18n-tooling` validate and open a pull request if HCC-owned import is used. |

Phrase documents Service Accounts using OAuth client credentials. A Service Account produces a `client_id` and `client_secret`; the worker exchanges them for a short-lived token, optionally restricted to the `tms` resource. Store credentials in protected CI secrets, never in a repository or developer dotfile.

### 5. Project template

The pilot needs a Phrase project template that defines:

- Source locale `en`.
- Target locales `fr`, `ko`, `ja`, and `zh-CN` using Phrase's exact language codes.
- ICU-compatible file settings.
- Translation memory and term bases.
- Translation and review workflow steps.
- Final workflow step used by APC export.
- Naming and metadata convention linking project/job IDs to source commit and repository.

Do not assume the Phrase language code exactly matches the repository tag. Verify whether the Phrase project uses `zh-CN`, `zh`, or another provider-specific code, then define an explicit gateway mapping to the repository's canonical `zh-CN`.

### 6. Monitored repository layout

Choose a pilot repository and a stable source path, for example:

```text
locales/en.json
```

or a namespace-specific path:

```text
locales/en/vulnerability.json
```

The connector/APC configuration must specify the real repository, branch, and folder. Do not use a source path that includes generated runtime bundles or temporary extraction output.

### 7. Target export behavior

Before production adoption, prove all of these in a sandbox:

- Source ICU JSON reaches the intended Phrase project.
- New source keys create expected translation jobs.
- Existing keys update without duplicating jobs.
- ICU variables and rich selectors survive import/export.
- Target files return with canonical locale mapping.
- Export waits for the intended final workflow step.
- Target output lands in the intended branch/path.
- A single translation batch produces one predictable PR or one predictable export artifact.
- Source commit, Phrase project, job, locale, and resulting PR remain traceable.
- Repeated webhook delivery or scheduled reconciliation is idempotent.

If target export behavior fails any of these, use the GitHub App/APC only for source intake and let a Node.js gateway perform target download and PR creation through the Phrase API.

## Recommended rollout

### Phase 1: sandbox

1. Create a scratch private repository in an approved test organization.
2. Install the Phrase GitHub App only for that repository.
3. Create a `GITHUB2` connector.
4. Configure one APC setting.
5. Use one project template and one target locale first.
6. Push a small ICU catalog containing interpolation and plural messages.
7. Complete or simulate the Phrase workflow.
8. Observe the target export behavior.
9. Send a `JOB_STATUS_CHANGED` event to a test receiver.
10. Run `i18n-tooling` validation and manually inspect the resulting PR/artifact.

### Phase 2: gateway integration

Implement a Phrase adapter behind the `i18n-tooling` interface:

```text
submit(source_revision, catalog, project_mapping)
status(project_or_job_mapping)
download(locale, final_job)
```

The adapter should not expose Phrase objects to consumer repositories. Persist a mapping containing at least:

```text
repository
source revision
Phrase project UID
Phrase job-part UIDs
expected locales
workflow final step
export/import status
resulting branch or PR
```

Use webhook events to wake reconciliation. Use a scheduled GitHub Action to find missed events and incomplete batches.

### Phase 3: pilot application

Use one application with:

- English source catalog.
- One target locale initially.
- No production branch write access for Phrase until validation succeeds.
- One translation PR at a time.
- Complete audit trail.

Expand to all four target locales only after ICU JSON round-trip and PR behavior pass.

## Decision

**Use the Phrase GitHub App, but do not make it the system of record or the complete delivery pipeline.**

- Phrase App/GITHUB2 + APC: source synchronization and project creation adapter.
- Phrase webhook + scheduled reconciliation: completion signals.
- `i18n-tooling`: provider-neutral state, validation, fallback policy, and PR control.
- Repository: canonical catalogs and final merge authority.

This preserves the main architectural goal: switching TMS providers later changes one adapter, not every frontend repository.

## Primary sources

- [Managing TMS Connectors](https://developers.phrase.com/en/guides/managing-connectors/overview)
- [Managing Automated Project Creation](https://developers.phrase.com/en/guides/managing-automated-project-creation/overview)
- [Phrase TMS webhooks](https://support.phrase.com/hc/en-us/articles/5709693398812-Webhooks-TMS-)
- [Create TMS webhook API](https://developers.phrase.com/en/api/tms/latest/webhook/create-webhook)
- [Phrase Platform authentication and Service Accounts](https://developers.phrase.com/en/api/platform/authentication)
- [Download target file asynchronously](https://developers.phrase.com/en/api/tms/latest/job/download-target-file-async)
- [Download target file from an async request](https://developers.phrase.com/en/api/tms/latest/job/download-target-file-based-on-async-request)
