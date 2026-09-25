import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogAdapterRegistry } from "../src/index.js";

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("catalog adapter plugins", () => {
  it("loads configured adapter modules and checks their stable IDs", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "i18n-adapter-plugin-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        i18nTooling: {
          catalogAdapters: {
            "example-json": "./example-adapter.mjs",
          },
        },
      }),
    );
    await writeFile(
      join(projectRoot, "example-adapter.mjs"),
      `export default {
        id: "example-json",
        read(document, context) { return { locale: context.locale, messages: document }; },
        write(catalog) { return catalog.messages; }
      };`,
    );

    const registry = await createCatalogAdapterRegistry(projectRoot);

    expect(registry.get("example-json").id).toBe("example-json");
  });
});
