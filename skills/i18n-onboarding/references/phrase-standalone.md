# Standalone Phrase callers

Use this reference when the Phrase mode is **Standalone**. The consumer runs the shared submit and reconcile workflows itself, from one protected Actions environment. That environment holds the Phrase credential and, optionally, the repository's own GitHub App credentials.

## Callers

Add only the missing callers. Copy them from `assets/workflows/` next to this `references/` folder into the consumer's `.github/workflows/`. Adapt the branch, `paths`, cron minute, config path, and environment name to the repository:

- `phrase-submit.yml` runs on a merge to the default branch that changes the source catalog or the Phrase config, and on manual dispatch with `retry-failed`. It grants `contents: write`.
- `phrase-reconcile.yml` runs on a weekday schedule and on manual dispatch. It grants `contents: write` and `pull-requests: write`.

Both callers name the same environment (the template uses `phrase-pilot`). The same callers serve both GitHub auth modes: the bound environment's secrets select the mode, so the callers pass no credentials. Never dispatch them from this skill. To pilot from a feature branch before merging, follow [consumer onboarding step 6](https://github.com/RedHatInsights/i18n-tooling/blob/main/docs/consumer-onboarding.md#6-pilot-phrase-from-a-feature-branch).

## Environment and auth

The environment is protected, and its deployment refs are restricted to the default branch. It holds:

- `PHRASE_PLATFORM_API_TOKEN`: a Platform API token of a dedicated technical user (a person's token is acceptable for a pilot). Phrase Service Accounts cannot create jobs, so submit cannot use `PHRASE_SERVICE_ACCOUNT_CLIENT_ID` and `PHRASE_SERVICE_ACCOUNT_CLIENT_SECRET`. A run with both kinds of Phrase credential set fails before it makes any request.
- GitHub auth, set by the wizard answer:
  - **Own GitHub App (preferred):** `APP_CLIENT_ID` and `APP_PRIVATE_KEY`, both set. Use an App owned by this repository's team, installed on this repository with `contents: write` and `pull-requests: write`. Never use the i18n-hub App's key. Locale PRs are authored by `<app-slug>[bot]`, and their checks run normally.
  - **`GITHUB_TOKEN` (fallback):** leave both App secrets unset. Turn on the repository setting "Allow GitHub Actions to create and approve pull requests", and require Code Owner review on the default branch. GitHub may hold the `pull_request` checks of locale PRs until a maintainer approves them. Do not assume those checks start immediately.

The job log's `Phrase auth:` and `GitHub auth:` lines confirm which credentials each run used.

## Read-only checks

Use `gh api` GET requests only, and never request, print, or copy a secret value:

- `repos/{owner}/{repo}/environments` lists the environments.
- `repos/{owner}/{repo}/environments/{environment_name}/secrets` lists the environment's secret names.
- `repos/{owner}/{repo}/actions/secrets` lists repository secrets, which should hold none of these names.
- In `GITHUB_TOKEN` mode, `repos/{owner}/{repo}/actions/permissions/workflow` reports whether Actions can create pull requests.

Expect `PHRASE_PLATFORM_API_TOKEN`, plus both or neither of `APP_CLIENT_ID` and `APP_PRIVATE_KEY` to match the chosen auth mode. Flag Service Account secrets, and a lone App secret. If the repository cannot be resolved, or `gh` is absent, unauthenticated, or lacks permission, report the check as unverified and put it in the admin checklist. Do not create or update secrets or settings.

## Admin follow-up

Add these items to the consumer PR checklist:

- Create and protect the environment, restrict its deployment refs to the default branch, and add `PHRASE_PLATFORM_API_TOKEN`.
- For App mode: create or choose the repository's own App, install it with the permissions above, and add `APP_CLIENT_ID` and `APP_PRIVATE_KEY` to the environment.
- For `GITHUB_TOKEN` mode: turn on "Allow GitHub Actions to create and approve pull requests", and require Code Owner review.
