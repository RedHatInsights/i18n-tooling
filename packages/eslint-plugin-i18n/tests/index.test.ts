import packageMetadata from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("plugin metadata", () => {
  it("uses the package version", () => {
    expect(plugin.meta.version).toBe(packageMetadata.version);
  });
});
