import { describe, expect, it } from "vitest";
import { extractFeoCatalog, inlineFeoLocale } from "../src/feo-template.js";

const template = `# header
kind: Template
objects:
  - kind: Frontend
    spec:
      envName: \${ENV_NAME}
      searchEntries:
        - id: roles
          title: Roles
          alt_title: [role, RBAC]
        - id: users
          title: Users
      serviceTiles:
        - section: iam
          group: iam
          id: roles
          title: Roles
          description: View roles
      bundleSegments:
        - bundleId: iam
          segmentId: segment
          navItems:
            - id: access
              title: Access
              routes:
                - id: roles
                  title: Roles
                - segmentRef:
                    frontendName: other
                    segmentId: child
      module:
        defaultDocumentTitle: Access | IAM
parameters:
  - name: ENV_NAME
`;

describe("FEO template localization", () => {
  it("extracts stable ID keys, translator context and pipe-delimited search aliases", () => {
    const catalog = extractFeoCatalog(template);
    expect(catalog["searchEntries.roles.alt_title"]?.defaultMessage).toBe("role|RBAC");
    expect(
      catalog["bundleSegments.iam.segment.navItems.access.routes.roles.title"]?.defaultMessage,
    ).toBe("Roles");
    expect(catalog["serviceTiles.iam.iam.roles.description"]?.defaultMessage).toBe("View roles");
    expect(catalog["module.defaultDocumentTitle"]?.defaultMessage).toBe("Access | IAM");
    expect(catalog["searchEntries.roles.title"]?.description).toContain("searchEntries.roles");
    expect(Object.keys(catalog).some((key) => key.includes("segmentRef"))).toBe(false);
    const reordered = template.replace(
      / {8}- id: roles\n {10}title: Roles\n {10}alt_title: \[role, RBAC\]\n {8}- id: users\n {10}title: Users/,
      "        - id: users\n          title: Users\n        - id: roles\n          title: Roles\n          alt_title: [role, RBAC]",
    );
    expect(extractFeoCatalog(reordered)).toEqual(catalog);
  });

  it("splices only locale data, preserves English, other locales, comments and is idempotent", () => {
    const source = extractFeoCatalog(template);
    const first = inlineFeoLocale(
      template,
      source,
      { "searchEntries.roles.title": "角色" },
      "zh-CN",
    );
    expect(first).toBe(
      template.replace(
        "parameters:",
        "      locales:\n        zh-CN:\n          searchEntries.roles.title: 角色\nparameters:",
      ),
    );
    const withOther = inlineFeoLocale(
      first,
      source,
      { "searchEntries.roles.title": "Rollen" },
      "de",
    );
    const updated = inlineFeoLocale(
      withOther,
      source,
      { "searchEntries.roles.title": "角色" },
      "zh-CN",
    );
    expect(updated).toBe(withOther);
    expect(updated).toContain("de:\n          searchEntries.roles.title: Rollen");
  });

  it("places translations in their owning Frontend object", () => {
    const multiple = template.replace(
      "parameters:",
      "  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: events\n          title: Events\nparameters:",
    );
    const source = extractFeoCatalog(multiple);
    const result = inlineFeoLocale(
      multiple,
      source,
      { "searchEntries.events.title": "事件" },
      "zh-CN",
    );
    expect(result.split("  - kind: Frontend\n")[1]).not.toContain("locales:");
    expect(result.split("  - kind: Frontend\n")[2]).toContain(
      "locales:\n        zh-CN:\n          searchEntries.events.title: 事件",
    );
  });

  it("rejects stale source, unknown keys, and duplicate IDs", () => {
    const source = extractFeoCatalog(template);
    expect(() =>
      inlineFeoLocale(template.replace("title: Roles", "title: Duties"), source, {}, "zh-CN"),
    ).toThrow("English source changed");
    expect(() =>
      inlineFeoLocale(template, source, { "searchEntries.nope.title": "未知" }, "zh-CN"),
    ).toThrow("Unknown translation key");
    expect(() =>
      extractFeoCatalog(
        template.replace(
          "        - id: users\n          title: Users",
          "        - id: roles\n          title: Users",
        ),
      ),
    ).toThrow("Duplicate FEO message key");
  });
});
