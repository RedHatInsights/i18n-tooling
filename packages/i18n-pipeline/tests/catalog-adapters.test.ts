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

  it("flattens Phrase-exported FormatJS descriptors into target strings", () => {
    const phraseTarget = {
      greeting: {
        defaultMessage: "Bonjour {name}",
        description: "Greeting",
      },
      accessOrigin: {
        defaultMessage: "Origine d’accès",
        description: { context: "Settings page", text: "Label for the source" },
      },
    };
    const context = { locale: "fr", role: "target" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("formatjs-json");

    const catalog = adapter.read(phraseTarget, context);

    expect(catalog.messages.greeting?.pattern).toBe("Bonjour {name}");
    expect(catalog.messages.accessOrigin?.pattern).toBe("Origine d’accès");
    expect(adapter.write(catalog, context)).toEqual({
      greeting: "Bonjour {name}",
      accessOrigin: "Origine d’accès",
    });
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

  it("extracts Problem Details codes and ICU messages from OpenAPI YAML", async () => {
    const source = await readFile(
      new URL("./fixtures/openapi-i18n/problem-details.yaml", import.meta.url),
      "utf8",
    );
    const context = { locale: "en", role: "source" as const, options: {} };
    const registry = new CatalogAdapterRegistry();
    const adapter = registry.get("openapi-problem-details");
    const document = adapter.parseDocument!(source, context);

    const catalog = adapter.read(document, context);
    const converted = convertCatalog(document, adapter, registry.get("icu-json"), context, context);

    expect(catalog.messages["insights-rbac.role.not-found"]?.pattern).toBe(
      "Role {roleName} was not found.",
    );
    expect(converted).toEqual({ "insights-rbac.role.not-found": "Role {roleName} was not found." });
  });

  it("parses JSON OpenAPI documents", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.1.0",
      components: {
        schemas: {
          RoleNotFound: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                const: "insights-rbac.role.not-found",
                "x-i18n": { message: "Role {roleName} was not found." },
              },
              params: {
                type: "object",
                required: ["roleName"],
                properties: { roleName: { type: "string" } },
              },
            },
          },
        },
      },
    };

    expect(adapter.parseDocument!(JSON.stringify(document), context)).toEqual(document);
    expect(adapter.read(document, context).messages["insights-rbac.role.not-found"]?.pattern).toBe(
      "Role {roleName} was not found.",
    );
  });

  it("keeps required params from both allOf members", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.1.0",
      components: {
        schemas: {
          BaseParams: {
            type: "object",
            required: ["roleName"],
            properties: { roleName: { type: "string" } },
          },
          BaseProblem: {
            type: "object",
            required: ["params"],
            properties: { params: { $ref: "#/components/schemas/BaseParams" } },
          },
          RoleNotFoundProblem: {
            allOf: [
              { $ref: "#/components/schemas/BaseProblem" },
              {
                type: "object",
                required: ["code", "params"],
                properties: {
                  code: {
                    const: "insights-rbac.role.not-found",
                    "x-i18n": { message: "Role {roleName} not found ({requestId})." },
                  },
                  params: {
                    type: "object",
                    required: ["requestId"],
                    properties: { requestId: { type: "string" } },
                  },
                },
              },
            ],
          },
        },
      },
    };

    expect(adapter.read(document, context).messages["insights-rbac.role.not-found"]?.pattern).toBe(
      "Role {roleName} not found ({requestId}).",
    );
  });

  it("does not treat a component $ref alias as a second message definition", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.1.0",
      components: {
        schemas: {
          RoleNotFoundAlias: { $ref: "#/components/schemas/RoleNotFoundProblem" },
          RoleNotFoundProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                const: "insights-rbac.role.not-found",
                "x-i18n": { message: "Role not found." },
              },
              params: { type: "object" },
            },
          },
        },
      },
    };

    expect(Object.keys(adapter.read(document, context).messages)).toEqual([
      "insights-rbac.role.not-found",
    ]);
  });

  it("rejects OpenAPI message codes that are not literals", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: {
          InvalidCodeProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                enum: ["insights-rbac.error.first", "insights-rbac.error.second"],
                "x-i18n": { message: "A request failed." },
              },
              params: { type: "object" },
            },
          },
        },
      },
    };

    expect(() => adapter.read(document, context)).toThrowError(
      /code must be a string const or a single-value enum/,
    );
  });

  it("rejects malformed ICU messages in OpenAPI extensions", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: {
          InvalidMessageProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                enum: ["insights-rbac.role.not-found"],
                "x-i18n": { message: "Role {roleName" },
              },
              params: {
                type: "object",
                required: ["roleName"],
                properties: { roleName: { type: "string" } },
              },
            },
          },
        },
      },
    };

    expect(() => adapter.read(document, context)).toThrowError(/invalid ICU syntax/);
  });

  it("rejects OpenAPI messages with arguments missing from the params schema", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: {
          InvalidProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                enum: ["insights-rbac.role.not-found"],
                "x-i18n": { message: "Role {roleName} was not found." },
              },
              params: { type: "object", properties: { role: { type: "string" } } },
            },
          },
        },
      },
    };

    expect(() => adapter.read(document, context)).toThrowError(CatalogFormatError);
    expect(() => adapter.read(document, context)).toThrowError(/missing from params: roleName/);
  });

  it("rejects ICU arguments that are optional in the params schema", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: {
          OptionalParamProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                enum: ["insights-rbac.role.not-found"],
                "x-i18n": { message: "Role {roleName} was not found." },
              },
              params: { type: "object", properties: { roleName: { type: "string" } } },
            },
          },
        },
      },
    };

    expect(() => adapter.read(document, context)).toThrowError(/not required in params: roleName/);
  });

  it("ignores unrelated schemas with unsupported external references", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: {
          ExternalSchema: { allOf: [{ $ref: "https://example.test/schemas/External" }] },
          RoleNotFoundProblem: {
            type: "object",
            required: ["code", "params"],
            properties: {
              code: {
                type: "string",
                enum: ["insights-rbac.role.not-found"],
                "x-i18n": { message: "Role not found." },
              },
              params: { type: "object" },
            },
          },
        },
      },
    };

    expect(adapter.read(document, context).messages["insights-rbac.role.not-found"]?.pattern).toBe(
      "Role not found.",
    );
  });

  it("rejects target-role use of the source-only OpenAPI adapter", () => {
    const context = { locale: "fr", role: "target" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const document = {
      openapi: "3.0.3",
      components: { schemas: {} },
    };

    expect(() => adapter.read(document, context)).toThrowError(/source-only adapter/);
  });

  it("rejects duplicate OpenAPI message codes", () => {
    const context = { locale: "en", role: "source" as const, options: {} };
    const adapter = new CatalogAdapterRegistry().get("openapi-problem-details");
    const localizedSchema = {
      type: "object",
      required: ["code", "params"],
      properties: {
        code: {
          type: "string",
          enum: ["insights-rbac.role.not-found"],
          "x-i18n": { message: "Role not found." },
        },
        params: { type: "object", properties: {} },
      },
    };
    const document = {
      openapi: "3.0.3",
      components: { schemas: { FirstProblem: localizedSchema, SecondProblem: localizedSchema } },
    };

    expect(() => adapter.read(document, context)).toThrowError(
      /duplicate.*insights-rbac.role.not-found/i,
    );
  });
});
