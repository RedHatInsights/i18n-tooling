import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The skill must work without a checkout of this repository, so it ships its
// own copies of the consumer caller workflows. Keep them identical to the example.
for (const name of ["phrase-submit.yml", "phrase-reconcile.yml", "locale-validation.yml"]) {
  test(`skill workflow template ${name} matches the consumer example`, async () => {
    const [template, example] = await Promise.all([
      readFile(join(repositoryRoot, "skills/i18n-onboarding/assets/workflows", name), "utf8"),
      readFile(join(repositoryRoot, "examples/phrase-consumer/.github/workflows", name), "utf8"),
    ]);
    assert.equal(template, example);
  });
}
