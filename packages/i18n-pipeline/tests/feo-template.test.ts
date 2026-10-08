import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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
    const named = template.replace(
      "  - kind: Frontend\n    spec:",
      "  - kind: Frontend\n    metadata:\n      name: access\n    spec:",
    );
    expect(extractFeoCatalog(named)).toEqual(catalog);
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
    const multiple = template
      .replace(
        "  - kind: Frontend\n    spec:",
        "  - kind: Frontend\n    metadata:\n      name: access\n    spec:",
      )
      .replace(
        "parameters:",
        "  - kind: Frontend\n    metadata:\n      name: events\n    spec:\n      searchEntries:\n        - id: events\n          title: Events\nparameters:",
      );
    const source = extractFeoCatalog(multiple);
    const result = inlineFeoLocale(
      multiple,
      source,
      { "objects.events.spec.searchEntries.events.title": "事件" },
      "zh-CN",
    );
    expect(result.split("  - kind: Frontend\n")[1]).not.toContain("locales:");
    expect(result.split("  - kind: Frontend\n")[2]).toContain(
      "locales:\n        zh-CN:\n          searchEntries.events.title: 事件",
    );
  });

  it("uses stable Frontend names to distinguish overlapping keys and inline local keys", () => {
    const first = `  - kind: Frontend
    metadata:
      name: first-app
    spec:
      searchEntries:
        - id: shared
          title: First
      module:
        defaultDocumentTitle: Console
      locales:
        de:
          searchEntries.shared.title: Erste
`;
    const second = `  - kind: Frontend
    metadata:
      name: second-app
    spec:
      searchEntries:
        - id: shared
          title: Second
      module:
        defaultDocumentTitle: Console
`;
    const multi = `kind: Template\nobjects:\n${first}${second}`;
    const source = extractFeoCatalog(multi);
    expect(source["objects.first-app.spec.searchEntries.shared.title"]?.defaultMessage).toBe(
      "First",
    );
    expect(source["objects.second-app.spec.searchEntries.shared.title"]?.defaultMessage).toBe(
      "Second",
    );
    expect(source["objects.first-app.spec.module.defaultDocumentTitle"]?.defaultMessage).toBe(
      "Console",
    );
    expect(source["objects.second-app.spec.module.defaultDocumentTitle"]?.defaultMessage).toBe(
      "Console",
    );
    expect(source["objects.second-app.spec.searchEntries.shared.title"]?.description).toContain(
      "second-app",
    );
    expect(extractFeoCatalog(`kind: Template\nobjects:\n${second}${first}`)).toEqual(source);
    expect(
      extractFeoCatalog(
        `kind: Template\nobjects:\n${first}${second}  - kind: Frontend\n    metadata:\n      name: third-app\n    spec: {}\n`,
      ),
    ).toEqual(source);

    const target = {
      "objects.first-app.spec.searchEntries.shared.title": "Premier",
      "objects.second-app.spec.searchEntries.shared.title": "Deuxième",
      "objects.second-app.spec.module.defaultDocumentTitle": "Console FR",
    };
    const result = inlineFeoLocale(multi, source, target, "fr");
    const objects = parse(result).objects;
    expect(objects[0].spec.locales.fr).toEqual({ "searchEntries.shared.title": "Premier" });
    expect(objects[0].spec.locales.de).toEqual({ "searchEntries.shared.title": "Erste" });
    expect(objects[1].spec.locales.fr).toEqual({
      "module.defaultDocumentTitle": "Console FR",
      "searchEntries.shared.title": "Deuxième",
    });
    expect(objects[0].spec.searchEntries[0].title).toBe("First");
    expect(objects[1].spec.searchEntries[0].title).toBe("Second");
    const reordered = inlineFeoLocale(
      `kind: Template\nobjects:\n${second}${first}`,
      source,
      target,
      "fr",
    );
    expect(parse(reordered).objects[0].spec.locales.fr).toEqual(objects[1].spec.locales.fr);
    expect(parse(reordered).objects[1].spec.locales.fr).toEqual(objects[0].spec.locales.fr);
    expect(inlineFeoLocale(result, source, target, "fr")).toBe(result);
    expect(() =>
      inlineFeoLocale(multi.replace("title: Second", "title: Changed"), source, target, "fr"),
    ).toThrow("English source changed");
  });

  it("rejects ambiguous Frontend names in multi-Frontend templates", () => {
    const first = "  - kind: Frontend\n    metadata:\n      name: first-app\n    spec: {}\n";
    const second = "  - kind: Frontend\n    metadata:\n      name: second-app\n    spec: {}\n";
    const multi = `kind: Template\nobjects:\n${first}${second}`;
    expect(() => extractFeoCatalog(multi.replace("name: second-app", "name: first-app"))).toThrow(
      "Duplicate Frontend.metadata.name",
    );
    expect(() =>
      extractFeoCatalog(multi.replace("    metadata:\n      name: second-app\n", "")),
    ).toThrow("Frontend.metadata");
    expect(() => extractFeoCatalog(multi.replace("name: second-app", 'name: ""'))).toThrow(
      "Frontend.metadata.name must be a non-empty string",
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
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(() => inlineFeoLocale(template, source, { [key]: "未知" }, "zh-CN")).toThrow(
        `Unknown translation key: ${key}`,
      );
    }
    expect(() =>
      extractFeoCatalog(
        template.replace(
          "        - id: users\n          title: Users",
          "        - id: roles\n          title: Users",
        ),
      ),
    ).toThrow("Duplicate FEO message key");
  });

  it("rejects duplicate IDs even when different fields are populated", () => {
    const duplicateSearch = template.replace(
      "        - id: users\n          title: Users",
      "        - id: roles\n          description: Different field",
    );
    expect(() => extractFeoCatalog(duplicateSearch)).toThrow("Duplicate FEO message key");

    const duplicateNav = template.replace(
      "                - segmentRef:",
      "                - id: roles\n                  product: Different field\n                - segmentRef:",
    );
    expect(() => extractFeoCatalog(duplicateNav)).toThrow("Duplicate FEO message key");

    const duplicateTile = template.replace(
      "          description: View roles",
      "          description: View roles\n        - section: iam\n          group: iam\n          id: roles\n          description: Different field",
    );
    expect(() => extractFeoCatalog(duplicateTile)).toThrow("Duplicate FEO message key");

    const duplicateSegment = template.replace(
      "      module:",
      "        - bundleId: iam\n          segmentId: segment\n      module:",
    );
    expect(() => extractFeoCatalog(duplicateSegment)).toThrow("Duplicate FEO message key");
  });

  it("preserves comments on retained locale translations", () => {
    const withComments = template.replace(
      "parameters:",
      "      locales:\n        fr: # locale context\n          # translator note\n          searchEntries.roles.title: Rôles # review wording\n          searchEntries.users.title: Utilisateurs\n      arbitraryField: keep\nparameters:",
    );
    const source = extractFeoCatalog(withComments);
    const result = inlineFeoLocale(
      withComments,
      source,
      { "searchEntries.roles.title": "Les rôles" },
      "fr",
    );
    expect(result).toContain(
      "fr: # locale context\n          # translator note\n          searchEntries.roles.title: Les rôles # review wording",
    );
    expect(result).not.toContain("searchEntries.users.title: Utilisateurs");
    expect(result).toContain("arbitraryField: keep");
    expect(
      inlineFeoLocale(result, source, { "searchEntries.roles.title": "Les rôles" }, "fr"),
    ).toBe(result);
  });

  it("inlines valid templates without a trailing newline", () => {
    const noFinalNewline =
      "kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n        - id: roles\n          title: Roles";
    const source = extractFeoCatalog(noFinalNewline);
    const result = inlineFeoLocale(
      noFinalNewline,
      source,
      { "searchEntries.roles.title": "Rôles" },
      "fr",
    );
    expect(result).toContain("title: Roles\n      locales:");
    expect(result).toContain("locales:\n        fr:\n          searchEntries.roles.title: Rôles");
    expect(inlineFeoLocale(result, source, { "searchEntries.roles.title": "Rôles" }, "fr")).toBe(
      result,
    );

    const withExistingLocale = `${noFinalNewline}\n      locales:\n        fr:\n          searchEntries.roles.title: Rôles`;
    const other = inlineFeoLocale(
      withExistingLocale,
      source,
      { "searchEntries.roles.title": "Rollen" },
      "de",
    );
    expect(other).toContain("searchEntries.roles.title: Rôles\n        de:");
    expect(inlineFeoLocale(other, source, { "searchEntries.roles.title": "Rollen" }, "de")).toBe(
      other,
    );
  });
});
