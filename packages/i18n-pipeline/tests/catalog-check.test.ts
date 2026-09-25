import { describe, expect, it } from "vitest";
import { checkCatalogs, type Catalog } from "../src/index.js";

function catalog(messages: Record<string, string>): Catalog {
  return {
    locale: "en",
    messages: Object.fromEntries(
      Object.entries(messages).map(([id, pattern]) => [id, { pattern, metadata: {} }]),
    ),
  };
}

describe("catalog checks", () => {
  it("reports missing and extra IDs and compares nested ICU arguments", () => {
    const source = catalog({
      nested: "{gender, select, other {Welcome {name}}}",
      greeting: "Hello {name}, there are {count, number} items.",
      sourceOnly: "Source only",
    });
    const target = catalog({
      nested: "{gender, select, other {Bienvenue}}",
      greeting: "Bonjour {name}.",
      targetOnly: "Target only",
    });

    expect(checkCatalogs(source, target)).toEqual({
      missingIds: ["sourceOnly"],
      extraIds: ["targetOnly"],
      argumentMismatches: [
        { id: "greeting", source: ["count", "name"], target: ["name"] },
        { id: "nested", source: ["gender", "name"], target: ["gender"] },
      ],
    });
  });

  it("ignores argument order and repeated uses", () => {
    expect(
      checkCatalogs(
        catalog({ greeting: "{name}, hello {name}" }),
        catalog({ greeting: "Bonjour, {name}" }),
      ),
    ).toEqual({ missingIds: [], extraIds: [], argumentMismatches: [] });
  });
});
