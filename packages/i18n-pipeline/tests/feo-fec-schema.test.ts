import { describe, expect, it } from "vitest";
import { fecSchemaAcceptsLocales } from "../src/feo-fec-schema.js";

function templateSchema(specProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    $defs: {
      frontendSpec: { type: "object", properties: specProperties, additionalProperties: false },
      frObject: { type: "object", properties: { spec: { $ref: "#/$defs/frontendSpec" } } },
    },
    type: "object",
    properties: { objects: { type: "array", items: { $ref: "#/$defs/frObject" } } },
  };
}

describe("fecSchemaAcceptsLocales", () => {
  it("follows the Template objects to the Frontend spec", () => {
    expect(fecSchemaAcceptsLocales(templateSchema({ module: {}, locales: {} }))).toBe(true);
    expect(fecSchemaAcceptsLocales(templateSchema({ module: {} }))).toBe(false);
  });

  it("rejects a schema without the FEC Template layout", () => {
    expect(() => fecSchemaAcceptsLocales({ type: "object", properties: {} })).toThrow(
      "schema has no Template objects",
    );
    expect(() =>
      fecSchemaAcceptsLocales({
        $defs: { loop: { $ref: "#/$defs/loop" } },
        properties: { objects: { items: { $ref: "#/$defs/loop" } } },
      }),
    ).toThrow("schema has no properties for the Frontend object");
    expect(() => fecSchemaAcceptsLocales([])).toThrow("schema is not a JSON object");
  });
});
