import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CatalogAdapterRegistry, CatalogFormatError, convertCatalog } from "../src/index.js";

describe("Catalog adapters", () => {
  it("round-trips extracted source descriptors and descriptions", async () => {
    const source = JSON.parse(
      await readFile(
        new URL("./fixtures/rbac-ui/translation-template.json", import.meta.url),
        "utf8",
      ),
    );
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("formatjs-json");

    const catalog = adapter.read(source, context);

    expect(catalog.messages.accessManagementDoc?.pattern).toBe("Understanding access management");
    expect(catalog.messages.accessOrigin?.description).toEqual({
      text: "Label for the source of access",
      context: "Settings page",
    });
    expect(adapter.write(catalog, context)).toEqual(source);
  });

  it("preserves additional FormatJS descriptor metadata", () => {
    const source = {
      greeting: {
        defaultMessage: "Hello {name}",
        description: "Welcome",
        customMetadata: { owner: "identity", priority: 2 },
      },
    };
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("formatjs-json");

    const catalog = adapter.read(source, context);

    expect(catalog.messages.greeting?.metadata).toEqual({
      customMetadata: { owner: "identity", priority: 2 },
    });
    expect(adapter.write(catalog, context)).toEqual(source);
  });

  it("round-trips compiled target messages as a flat ID-to-string map", async () => {
    const target = JSON.parse(
      await readFile(new URL("./fixtures/rbac-ui/translations.json", import.meta.url), "utf8"),
    );
    const context = { locale: "es", role: "target" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("formatjs-json");

    const catalog = adapter.read(target, context);

    expect(catalog.messages.accessManagementDoc?.pattern).toBe("Comprender la gestión de acceso");
    expect(adapter.write(catalog, context)).toEqual(target);
  });

  it("round-trips keyed ICU JSON and preserves plural patterns", async () => {
    const source = JSON.parse(
      await readFile(new URL("./fixtures/insights-rbac/i18n-en.json", import.meta.url), "utf8"),
    );
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("icu-json");

    const catalog = adapter.read(source, context);

    expect(catalog.messages["insights-rbac.role.count"]?.pattern).toBe(
      "{count, plural, one {# role} other {# roles}}",
    );
    expect(adapter.write(catalog, context)).toEqual(source);
  });

  it("converts FormatJS descriptors to keyed ICU JSON through the public adapter seam", () => {
    const source = {
      greeting: { defaultMessage: "Hello {name}", description: "Welcome" },
    };
    const registry = new CatalogAdapterRegistry();
    const context = { locale: "en", role: "source" as const, options: {} };

    const converted = convertCatalog(
      source,
      registry.get("formatjs-json"),
      registry.get("icu-json"),
      context,
      context,
    );

    expect(converted).toEqual({ greeting: "Hello {name}" });
  });

  it("rejects empty message IDs", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const registry = new CatalogAdapterRegistry();

    expect(() =>
      registry.get("formatjs-json").read({ "": { defaultMessage: "Hello" } }, context),
    ).toThrowError(CatalogFormatError);
    expect(() => registry.get("icu-json").read({ "": "Hello" }, context)).toThrowError(
      CatalogFormatError,
    );
  });

  it("validates ICU syntax in FormatJS default messages", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("formatjs-json");

    expect(() =>
      adapter.read({ greeting: { defaultMessage: "Hello {name" } }, context),
    ).toThrowError(CatalogFormatError);
  });

  it("rejects malformed ICU patterns and identifies the catalog message", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("icu-json");
    const read = () => adapter.read({ greeting: "Hello {name" }, context);

    expect(read).toThrowError(CatalogFormatError);
    expect(read).toThrowError(/icu-json message "greeting" has invalid ICU syntax/);
  });
});
