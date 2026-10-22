import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFeoCatalog } from "../src/feo-template.js";

// Copy of feo/spec/frontend-crd.schema.json from
// @redhat-cloud-services/frontend-components-config-utilities. To move to a newer FEC release,
// unpack it (`npm pack <package>@<version>`), replace the fixture, and classify every string
// field this test reports.
const SCHEMA = join(import.meta.dirname, "fixtures/fec/frontend-crd-4.14.2.schema.json");

/** Frontend spec string fields that `feo extract` turns into messages, with a sample key. */
const TRANSLATED: Record<string, string> = {
  "baseWidgetLayouts[].displayName": "baseWidgetLayouts.layout.displayName",
  "bundleSegments[].navItems[].product": "bundleSegments.b.s.navItems.item.product",
  "bundleSegments[].navItems[].title": "bundleSegments.b.s.navItems.item.title",
  "module.defaultDocumentTitle": "module.defaultDocumentTitle",
  "navigationSegments[].navItems[].product": "navigationSegments.seg.navItems.item.product",
  "navigationSegments[].navItems[].title": "navigationSegments.seg.navItems.item.title",
  "searchEntries[].alt_title[]": "searchEntries.entry.alt_title.alias",
  "searchEntries[].description": "searchEntries.entry.description",
  "searchEntries[].title": "searchEntries.entry.title",
  "serviceTiles[].description": "serviceTiles.sec.grp.tile.description",
  "serviceTiles[].title": "serviceTiles.sec.grp.tile.title",
  "widgetRegistry[].config.headerLink.title":
    "widgetRegistry.landing.widget.default.headerLink.title",
  "widgetRegistry[].config.title": "widgetRegistry.landing.widget.default.title",
};

function notTranslatable(reason: string, paths: string[]): [string, string][] {
  return paths.map((path) => [path, reason]);
}

/** Frontend spec string fields that are not user-visible text, each with the reason. */
const NOT_TRANSLATED = new Map<string, string>([
  ...notTranslatable("identifier", [
    "baseWidgetLayouts[].name",
    "baseWidgetLayouts[].templateConfig.lg[].i",
    "baseWidgetLayouts[].templateConfig.md[].i",
    "baseWidgetLayouts[].templateConfig.sm[].i",
    "baseWidgetLayouts[].templateConfig.xl[].i",
    "bundleSegments[].bundleId",
    "bundleSegments[].navItems[].groupId",
    "bundleSegments[].navItems[].id",
    "bundleSegments[].navItems[].segmentRef.frontendName",
    "bundleSegments[].navItems[].segmentRef.segmentId",
    "bundleSegments[].segmentId",
    "envName",
    "module.moduleID",
    "module.modules[].id",
    "module.modules[].module",
    "navigationSegments[].navItems[].groupId",
    "navigationSegments[].navItems[].id",
    "navigationSegments[].navItems[].segmentRef.frontendName",
    "navigationSegments[].navItems[].segmentRef.segmentId",
    "navigationSegments[].segmentId",
    "searchEntries[].id",
    "serviceTiles[].group",
    "serviceTiles[].id",
    "serviceTiles[].section",
    "widgetRegistry[].featureFlag",
    "widgetRegistry[].importName",
    "widgetRegistry[].module",
    "widgetRegistry[].scope",
  ]),
  ...notTranslatable("URL, path or deployment location", [
    "API.specs[].url",
    "akamaiCacheBustPaths[]",
    "bundleSegments[].navItems[].href",
    "deploymentRepo",
    "frontend.paths[]",
    "image",
    "module.manifestLocation",
    "module.modules[].routes[].pathname",
    "navigationSegments[].navItems[].href",
    "searchEntries[].href",
    "serviceTiles[].href",
    "widgetRegistry[].config.headerLink.href",
  ]),
  ...notTranslatable("icon name", [
    "bundleSegments[].navItems[].icon",
    "navigationSegments[].navItems[].icon",
    "serviceTiles[].icon",
    "widgetRegistry[].config.icon",
  ]),
  ...notTranslatable("permission check", [
    "bundleSegments[].navItems[].permissions[].apps[]",
    "bundleSegments[].navItems[].permissions[].method",
    "module.modules[].routes[].permissions[].apps[]",
    "module.modules[].routes[].permissions[].method",
    "navigationSegments[].navItems[].permissions[].apps[]",
    "navigationSegments[].navItems[].permissions[].method",
    "searchEntries[].permissions[].apps[]",
    "searchEntries[].permissions[].method",
    "serviceTiles[].permissions[].apps[]",
    "serviceTiles[].permissions[].method",
    "widgetRegistry[].config.permissions[].apps[]",
    "widgetRegistry[].config.permissions[].method",
  ]),
  ...notTranslatable("configuration value", [
    "API.specs[].bundleLabels[]",
    "API.versions[]",
    "bundleSegments[].navItems[].notifier",
    "module.analytics.APIKey",
    "module.analytics.APIKeyDev",
    "module.analytics.autocaptureAPIKey",
    "module.analytics.autocaptureAPIKeyDev",
    "module.moduleConfig.ssoScopes[]",
    "module.modules[].moduleConfig.ssoScopes[]",
    "navigationSegments[].navItems[].notifier",
  ]),
  ...notTranslatable("support-case product name and version, sent to the support form as-is", [
    "module.moduleConfig.supportCaseData.product",
    "module.moduleConfig.supportCaseData.version",
    "module.modules[].moduleConfig.supportCaseData.product",
    "module.modules[].moduleConfig.supportCaseData.version",
    "module.modules[].routes[].supportCaseData.product",
    "module.modules[].routes[].supportCaseData.version",
  ]),
  ...notTranslatable("generated translations", ["locales.*.*"]),
  ...notTranslatable("undecided: is the Frontend title shown to users? (RHCLOUD-52516)", ["title"]),
]);

type SchemaNode = Record<string, unknown>;

/** Every string field under the Frontend spec, as a path with `[]` for array items. */
function stringFields(schema: SchemaNode): Set<string> {
  const defs = schema.$defs as Record<string, SchemaNode>;
  const fields = new Set<string>();
  function walk(node: unknown, path: string, seen: ReadonlySet<string>): void {
    if (!node || typeof node !== "object") return;
    const current = node as SchemaNode;
    if (typeof current.$ref === "string") {
      const name = current.$ref.split("/").at(-1)!;
      // A nav item nests further nav items; its fields are listed once at the first level.
      if (!seen.has(name)) walk(defs[name], path, new Set([...seen, name]));
      return;
    }
    const type = current.type;
    if (type === "string" || (Array.isArray(type) && type.includes("string"))) fields.add(path);
    for (const [key, value] of Object.entries((current.properties ?? {}) as SchemaNode))
      walk(value, path ? `${path}.${key}` : key, seen);
    if (current.items) walk(current.items, `${path}[]`, seen);
    if (current.additionalProperties && typeof current.additionalProperties === "object")
      walk(current.additionalProperties, `${path}.*`, seen);
    for (const key of ["anyOf", "oneOf", "allOf"])
      for (const sub of (current[key] ?? []) as unknown[]) walk(sub, path, seen);
  }
  walk(defs.frontendSpec, "", new Set(["frontendSpec"]));
  return fields;
}

describe("FEC Frontend schema coverage", () => {
  it("classifies every string field as translated or not translatable", async () => {
    const fields = stringFields(JSON.parse(await readFile(SCHEMA, "utf8")) as SchemaNode);
    const unclassified = [...fields].filter(
      (field) => !(field in TRANSLATED) && !NOT_TRANSLATED.has(field),
    );
    const stale = [...Object.keys(TRANSLATED), ...NOT_TRANSLATED.keys()].filter(
      (field) => !fields.has(field),
    );
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it("extracts every field it lists as translated", () => {
    const template = `kind: Template
objects:
  - kind: Frontend
    spec:
      searchEntries:
        - id: entry
          title: T
          description: D
          alt_title: [alias]
      serviceTiles:
        - section: sec
          group: grp
          id: tile
          title: T
          description: D
      bundleSegments:
        - bundleId: b
          segmentId: s
          navItems:
            - id: item
              title: T
              product: P
      navigationSegments:
        - segmentId: seg
          navItems:
            - id: item
              title: T
              product: P
      widgetRegistry:
        - scope: landing
          module: ./Widget
          config:
            title: T
            headerLink:
              title: L
              href: /x
      baseWidgetLayouts:
        - name: layout
          displayName: N
          templateConfig: {}
      module:
        defaultDocumentTitle: T
`;
    expect(Object.keys(extractFeoCatalog(template)).sort()).toEqual(
      Object.values(TRANSLATED).sort(),
    );
  });
});
