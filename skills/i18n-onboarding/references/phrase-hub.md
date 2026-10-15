# Phrase through the i18n-hub

Use this reference when the Phrase mode is **Hub**. [RedHatInsights/i18n-hub](https://github.com/RedHatInsights/i18n-hub) runs `sync.yml` on weekdays at 06:17 and 14:17 UTC. Hub maintainers can also dispatch it for one consumer. For each registered consumer, it runs the shared submit and reconcile workflows with a short-lived i18n GitHub App token scoped to that consumer. Batch state on `i18n-tms-state` and locale PRs stay in the consumer repository, and the App's bot authors those PRs.

## Consumer change

The consumer change contains the Phrase config, the source catalog, and the locale validation caller from [phrase.md](phrase.md). It contains no submit or reconcile callers, and its environments hold no Phrase or App secrets for this purpose.

## Registry entry

Work out one `consumers.json` entry:

```json
{
  "name": "<repository-name>",
  "repository": "RedHatInsights/<repository-name>",
  "baseRef": "<default-branch>",
  "configPath": "<path-to-phrase-tms.json>",
  "phraseFile": "<source-catalog-filename>.json"
}
```

- `name` is the repository name. `repository` is `RedHatInsights/<name>`, in lowercase letters, digits, and hyphens.
- `baseRef` is the branch the hub syncs and bases locale PRs on, normally the default branch.
- `configPath` is the repository-relative path of `phrase-tms.json`.
- `phraseFile` is the source catalog's filename (for example `translation-template.json`). It must be unique across all hub entries. Check the current `consumers.json` (see [phrase.md](phrase.md#choose-the-mode)). If the name is already taken, rename the consumer's source catalog to something unique to the repository, update every reference to it, and report the rename.

The hub reads the config from `baseRef`. An entry is ready only when the Phrase config is complete (real project UID and region) and the consumer change has merged to `baseRef`.

## Register in the hub

Open the hub PR only when all of these hold:

- The developer chose **push and open a PR**.
- The Phrase config is complete.
- `gh api repos/RedHatInsights/i18n-hub` succeeds.
- The consumer PR is open.

To open it:

1. Clone i18n-hub into a new temporary directory outside the consumer, and create the branch `register-<name>`.
2. Append the entry to `consumers.json`, keeping the existing formatting.
3. Run `npm run check` and `npm test`. Both must pass.
4. Commit only `consumers.json`, push, and open a **draft** PR that keeps the hub's PR template. Its description links the consumer PR and states the merge order: the consumer PR merges first and the App is installed, then this PR is marked ready.

In every other case, print the entry in the final report and put "Register in i18n-hub" with the entry in the consumer PR checklist. Explain which condition was not met.

## Admin follow-up

Add these items to the consumer PR checklist:

- Install the i18n GitHub App on this repository with `contents: write` and `pull-requests: write`. The i18n-hub README names the App and its owners.
- If a ruleset restricts branch creation, exclude `i18n-tms-state` and `i18n/phrase-*`.
- Get the hub registration PR reviewed by the hub's Code Owners, and merge it after the consumer PR.

## Migrate from standalone

Run this upgrade only after the developer selects it. As one unit:

- Delete the consumer's `phrase-submit.yml` and `phrase-reconcile.yml` callers.
- Keep `phrase-tms.json`, the source catalog, the locale validation caller, and the `i18n-tms-state` branch. The hub continues from the same batch state.
- Add the registry entry as above.

Add these items to the consumer PR checklist:

- Merge the consumer PR before the hub PR, so no run comes from both.
- After the first successful hub run, remove the consumer's Phrase and App secrets, and its Phrase environment if nothing else uses it.
- Never delete `i18n-tms-state`.
