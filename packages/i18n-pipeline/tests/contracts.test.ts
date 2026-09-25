import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("repository i18n contracts", () => {
  it("keeps reusable validation Node-based and forwards catalog settings", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github/workflows/i18n-validate.yml"),
      "utf8",
    );

    for (const input of [
      "catalog-adapter",
      "catalog-path",
      "catalog-role",
      "catalog-locale",
      "catalog-config",
    ]) {
      const environmentName = `I18N_${input.toUpperCase().replaceAll("-", "_")}`;
      expect(workflow).toContain(`      ${input}:`);
      expect(workflow).toContain(
        `          ${environmentName}: \${{ inputs.${input} }}`,
      );
    }

    expect(workflow).toContain("uses: actions/setup-node@v4");
    expect(workflow).toContain('npm run "$VALIDATION_COMMAND"');
    expect(workflow).not.toContain("setup-python");
    expect(workflow).not.toContain("python-version");
    expect(workflow).not.toContain("python -m frontend_i18n_pipeline");
    expect(workflow).not.toContain('"${{ inputs.validation-command }}"');
    expect(workflow).not.toContain('if [ "${{ inputs.package-manager }}"');
    expect(workflow).not.toMatch(/uses:\s+[^\n]*\$\{\{/);
  });

  it("keeps backend problem details keyed by code, raw params, and English detail", async () => {
    const schema = JSON.parse(
      await readFile(
        join(repositoryRoot, "schemas/problem-details-i18n.schema.json"),
        "utf8",
      ),
    ) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties).toHaveProperty("code");
    expect(schema.properties).toHaveProperty("params");
    expect(schema.properties).toHaveProperty("detail");
    expect(schema.required).toEqual(
      expect.arrayContaining(["code", "params", "detail"]),
    );
    expect(schema.properties).not.toHaveProperty("key");
  });
});
