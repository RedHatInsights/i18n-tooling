# Phrase through the i18n-hub

Use this reference when the Phrase mode is **Hub**. [RedHatInsights/i18n-hub](https://github.com/RedHatInsights/i18n-hub) runs `sync.yml` on weekdays at 06:17 and 14:17 UTC. Hub maintainers can also dispatch it for one consumer. For each registered consumer, it runs the shared submit and reconcile workflows with a short-lived i18n GitHub App token scoped to that consumer. Batch state on each config's state branch and locale PRs stay in the consumer repository, and the App's bot authors those PRs.

## Consumer change

The consumer change contains the Phrase config and the source catalog. The locale validation caller comes from the validation baseline. It contains no submit or reconcile callers, and its environments hold no Phrase or App secrets for this purpose.

## Registry entry

Work out one `consumers.json` entry per Phrase config: one for the app catalog and, with FEO, one for `i18n/phrase-tms-feo.json`.

```json
{
  "name": "<repository-name>",
  "repository": "RedHatInsights/<repository-name>",
  "baseRef": "<default-branch>",
  "configPath": "<path-to-phrase-tms.json>",
  "phraseProject": "yWWEIEQgpNVK650YBQhGx6",
  "phraseFile": "<repository-name>.ui.en.json"
}
```

- `name` is the repository name for the app catalog and `<repository-name>-feo` for FEO. `repository` is `RedHatInsights/<repository-name>`, in lowercase letters, digits, and hyphens.
- `baseRef` is the branch the hub syncs and bases locale PRs on, normally the default branch.
- `configPath` is the repository-relative path of that Phrase config.
- `phraseProject` equals that config's `project.uid`, the shared project's UID.
- `phraseFile` equals `sourceCatalog.filename` from the Phrase config exactly, `<repository-name>.<catalog>.en.json` (`ui` or `feo`). The hub requires it to start with `<repository-name>.` and to be unique across entries; check the current `consumers.json` (see [phrase.md](phrase.md#choose-the-mode)). The repository's source catalog path stays unchanged.

The hub reads the config from `baseRef`, so an entry is ready only once the consumer change has merged there. The hub passes `phraseProject` and `phraseFile` to the shared workflows as pins, so a run stops before any download when the config names another project or file.

## Register in the hub

Open the hub PR only when all of these hold:

- The developer chose **push and open a PR**.
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
- If a ruleset restricts branch creation, exclude each config's `state.branch` and `i18n/phrase-*`.
- Get the hub registration PR reviewed by the hub's Code Owners, and merge it after the consumer PR.

## Migrate from standalone

Run this upgrade only after the developer selects it. As one unit:

- Delete the consumer's `phrase-submit.yml` and `phrase-reconcile.yml` callers.
- Keep `phrase-tms.json`, the source catalog, the locale validation caller, and every state branch. The hub continues from the same batch state.
- Add the registry entry as above.

Add these items to the consumer PR checklist:

- Merge the consumer PR before the hub PR, so no run comes from both.
- After the first successful hub run, remove the consumer's Phrase and App secrets, and its Phrase environment if nothing else uses it.
- Never delete a state branch.
