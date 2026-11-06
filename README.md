# i18n Tooling

Shared product-UI internationalization tooling for HCC and other Red Hat frontend applications: ICU catalog validation, source lint, FEO Frontend localization, and the Phrase TMS round trip.

## Quick start: onboard a repository

The `i18n-onboarding` agent skill onboards a repository for you in Claude Code, Codex CLI, opencode or Pi.

1. **Build the CLI** (needed until the first npm release). Export the variable in the shell you start the agent from:

   ```bash
   git clone https://github.com/RedHatInsights/i18n-tooling.git
   cd i18n-tooling && npm ci --ignore-scripts && npm run build
   export I18N_PIPELINE_CLI="$PWD/packages/i18n-pipeline/dist/cli.js"
   ```

2. **Install the skill:**

   ```bash
   npx skills add RedHatInsights/i18n-tooling -g -s i18n-onboarding -a claude-code -a codex -a opencode -a pi -y
   ```

3. **Run it.** In the repository to onboard, ask the agent to "onboard this repository to i18n tooling". It inspects the repository and proposes a plan (tracks, Phrase mode, locales, branch, whether it pushes and opens a PR) for you to approve; choose adjust to change tracks, tracking ticket, branch layout, how far to go or Phrase mode through a short wizard. It then adds catalog validation and the approved tracks.
4. **Finish the Phrase setup.** In the default hub mode, the skill opens or drafts a registration PR in `RedHatInsights/i18n-hub` (not public). Two admin steps remain:
   - A `RedHatInsights` organization owner installs the [`hcc-i18n-tms-sync`](https://github.com/apps/hcc-i18n-tms-sync) App on the repository.
   - An admin checks [Phrase branch permissions](docs/consumer-onboarding.md#check-phrase-branch-permissions-both-modes): automation must create each configured state branch and write its records directly. Resolve matching creation, PR or required-check restrictions with narrow exclusions, keeping the default branch protected.

   Once the registration merges, the hub runs on its schedule: a merged source change goes to Phrase, and each translated locale comes back as a draft PR assigned to the people who changed the source strings. [Where is my translation?](docs/phrase-operations.md#where-is-my-translation) explains how to follow a string through.

To onboard by hand, follow the [consumer onboarding checklist](docs/consumer-onboarding.md).

### Other ways to install the skill

- **Skill install details:** `npx skills add … -g` writes one copy to `~/.agents/skills/i18n-onboarding/` (read by Codex CLI, opencode and Pi) and links it into `~/.claude/skills/`. Drop `-g` to install into the current repository (`.agents/skills/` and `.claude/skills/`). Update with `npx skills update -g -y`.
- **Claude Code plugin:** `/plugin marketplace add RedHatInsights/i18n-tooling`, then `/plugin install i18n-onboarding@i18n-tooling`. Update with `/plugin marketplace update i18n-tooling`.
- **Without third-party tools:** clone this repository and symlink `skills/i18n-onboarding` into `~/.agents/skills/` and `~/.claude/skills/`.
- **CLI on `PATH`** instead of `I18N_PIPELINE_CLI`: `ln -s "$PWD/packages/i18n-pipeline/dist/cli.js" ~/bin/i18n-pipeline` from the clone. Update with `git pull` and a rebuild. Only local runs need this; the validation workflow and the i18n hub build the CLI from source.

**Phrase modes:** hub mode (default) registers the repository in the central i18n hub, which holds the Phrase credential, the GitHub App key and the schedule; the repository gets no Phrase callers or secrets. Standalone mode runs the Phrase workflows from the repository itself, with its own GitHub App or, as a fallback, `GITHUB_TOKEN`. See [Phrase TMS setup](docs/phrase-tms.md).

## What's here

| Component | Role |
| --- | --- |
| [`@redhat-cloud-services/eslint-plugin-i18n`](packages/eslint-plugin-i18n/README.md) | ESLint rules for message IDs, source catalogs and ICU source checks |
| [`@redhat-cloud-services/i18n-pipeline`](packages/i18n-pipeline/README.md) | Normalized catalog model, FormatJS and keyed ICU JSON adapters, adapter plugins, generated-catalog sync, and the `i18n-pipeline` CLI |
| [`.github/workflows/`](.github/workflows/) | Reusable validation and Phrase workflows, plus this repository's CI |
| [`schemas/`](schemas/) | Config schemas and shared contracts |
| [`examples/`](examples/) | FEO and Phrase consumer examples |
| [`skills/i18n-onboarding/`](skills/i18n-onboarding/) | The onboarding agent skill |

The packages target Node.js 22.14+. Framework extraction and compilation stay in each consumer's native tooling. Consumers need no npm dependency on this repository until the first release; the reusable workflows build the tooling from the pinned commit.

## Documentation

| Guide | Covers |
| --- | --- |
| [Consumer onboarding](docs/consumer-onboarding.md) | Step-by-step manual onboarding, hub vs standalone, rollback |
| [Catalog validation](docs/validation.md) | `i18n-validate.yml` callers and inputs, source lint, CLI, custom adapters |
| [FEO localization](docs/feo-localization.md) | `feo extract` / `feo inline`, catalog keys, locale rules, Phrase handoff |
| [Phrase TMS setup](docs/phrase-tms.md) | Config, `hcc-ui` preset, credentials, GitHub auth, repository requirements |
| [Phrase operations](docs/phrase-operations.md) | Where is my translation, locale PRs, batches, retries, recovery |
| [Phrase consumer integration example](docs/phrase-consumer-integration.md) | Copyable callers and configs |
| [Architecture](docs/architecture.md) | Design rules, terminology, adapter model, TMS workflow |
| [`i18n-pipeline` reference](packages/i18n-pipeline/README.md) | CLI, validation config, `validate-ci`, custom adapters |
| [Contributing](CONTRIBUTING.md) / [Releasing](docs/releasing.md) | Local development, checks, npm release procedure |
