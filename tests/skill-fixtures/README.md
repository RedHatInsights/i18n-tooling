# Onboarding skill fixtures

These folders are pre-onboarding repositories. Keep them unchanged; use a temporary copy for each skill run. The `EXPECTED.md` file in each fixture lists the expected files, config, checks, and protected content.

## Run the skill by hand

1. From the i18n-tooling checkout, build the CLI with `npm run build`.
2. Copy a fixture to a temporary directory. Initialize that copy as a temporary Git repository on its default branch if you want the skill to exercise branch detection. Do not add or commit files; choose **edit files only** for the plan.
3. Make the built CLI available to the harness by setting `I18N_PIPELINE_CLI` to the absolute path of this checkout's `packages/i18n-pipeline/dist/cli.js` before starting the harness.
4. Make the skill available from the harness's user or project skill directory as described in the root README. Start the harness with the temporary copy as its working directory.
5. Ask: “Use the i18n-onboarding skill to onboard this disposable fixture copy. When it shows its plan, choose adjust, and in the wizard select the tracks listed in its EXPECTED.md, tracking ticket none, the default one-branch layout, and edit files only. Do not commit, push, open a PR, run Phrase, create secrets, or modify files outside this copy.” For `formatjs-generated-ids`, answer the special question by keeping generated IDs and omitting the missing-ID rule. For `already-onboarded`, select no completed track. For `formatjs-frontend`, keep the default i18n-hub Phrase mode; repeat the run with standalone and the repository's own GitHub App, and check that copy as `formatjs-frontend-standalone`.

Run the same prompt in each harness:

- **Claude Code:** start a session in the temporary copy with the skill installed in `~/.claude/skills/` or `.claude/skills/`.
- **Codex CLI:** start a session in the temporary copy with the skill installed in `~/.agents/skills/` or `.agents/skills/`.
- **opencode:** start a session in the temporary copy with the skill installed in `~/.agents/skills/` or `.agents/skills/`.
- **Pi:** start a session in the temporary copy with the skill installed in `~/.agents/skills/` or `.agents/skills/`.

After the manual run, check the copy from this checkout:

```bash
node scripts/check-skill-fixture.mjs <fixture-name> <path-to-onboarded-copy>
```

The checker uses `I18N_PIPELINE_CLI` when set; otherwise it uses this checkout's built CLI at `packages/i18n-pipeline/dist/cli.js`. It runs `validate-ci --mode error`, checks required files and config sections, and compares protected files with the original fixture. A fixture that has not been onboarded is expected to fail. `already-onboarded` should pass without changes:

```bash
node scripts/check-skill-fixture.mjs already-onboarded tests/skill-fixtures/already-onboarded
```

To confirm the untouched state fails, use each original fixture path:

```bash
node scripts/check-skill-fixture.mjs formatjs-frontend tests/skill-fixtures/formatjs-frontend
node scripts/check-skill-fixture.mjs formatjs-generated-ids tests/skill-fixtures/formatjs-generated-ids
node scripts/check-skill-fixture.mjs feo-frontend tests/skill-fixtures/feo-frontend
node scripts/check-skill-fixture.mjs keyed-icu-backend tests/skill-fixtures/keyed-icu-backend
node scripts/check-skill-fixture.mjs openapi-problem-details tests/skill-fixtures/openapi-problem-details
```

These five commands should fail before onboarding and pass when pointed at the corresponding temporary copy after onboarding.
