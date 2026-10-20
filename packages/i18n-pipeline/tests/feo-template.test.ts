import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { extractFeoCatalog, feoTemplateLocales, inlineFeoLocale } from "../src/feo-template.js";

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

const dottedTemplate = `kind: Template
objects:
  - kind: Frontend
    spec:
      searchEntries:
        - id: RHEL.ros
          title: RHEL ROS
          description: Manage ROS
          alt_title: [acs, ACS, operators]
        - id: hosts
          title: Hosts
          alt_title: [hosts, hosts]
      serviceTiles:
        - section: rhel
          group: security
          id: malware.signatures
          title: Malware signatures
      bundleSegments:
        - bundleId: hybrid-committed-spend
          segmentId: main
          navItems:
            - id: hybrid-committed-spend.nav
              title: Committed spend
              routes:
                - id: hybrid-committed-spend.overview
                  title: Overview
                - id: hybrid-committed-spend.details
                  title: Details
`;

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected operation to throw");
}

function expectDuplicateContexts(
  template: string,
  first: string,
  second: string,
  kind: "message" | "runtime" = "message",
): void {
  const message = errorMessage(() => extractFeoCatalog(template));
  expect(message).toContain(`Duplicate FEO ${kind} key`);
  expect(message).toContain(first);
  expect(message).toContain(second);
}

describe("FEO template localization", () => {
  it("extracts stable ID keys, translator context and one message per search alias", () => {
    const catalog = extractFeoCatalog(template);
    expect(catalog["searchEntries.roles.alt_title.role"]?.defaultMessage).toBe("role");
    expect(catalog["searchEntries.roles.alt_title.rbac"]?.defaultMessage).toBe("RBAC");
    expect(catalog["searchEntries.roles.alt_title"]?.defaultMessage).toBeUndefined();
    expect(
      catalog["bundleSegments.iam.segment.navItems.access.routes.roles.title"]?.defaultMessage,
    ).toBe("Roles");
    expect(catalog["serviceTiles.iam.iam.roles.description"]?.defaultMessage).toBe("View roles");
    expect(catalog["module.defaultDocumentTitle"]?.defaultMessage).toBe("Access | IAM");
    expect(catalog["searchEntries.roles.title"]?.description).toContain("searchEntries.roles");
    expect(catalog["searchEntries.roles.alt_title.role"]?.description).toContain(
      "search alias (keyword/synonym) of searchEntries.roles",
    );
    expect(catalog["searchEntries.roles.alt_title.role"]?.description).toContain(
      "short search term, not a sentence",
    );
    expect(Object.keys(catalog).some((key) => key.includes("segmentRef"))).toBe(false);
    const unidentifiedNav = template.replace(
      "                - segmentRef:",
      "                - title: Unidentified item\n                - segmentRef:",
    );
    // A nav item without an id has no stable key, so its title could never be translated.
    expect(() => extractFeoCatalog(unidentifiedNav)).toThrow("id must be a non-empty string");
    const reordered = template.replace(
      / {8}- id: roles\n {10}title: Roles\n {10}alt_title: \[role, RBAC\]\n {8}- id: users\n {10}title: Users/,
      "        - id: users\n          title: Users\n        - id: roles\n          title: Roles\n          alt_title: [role, RBAC]",
    );
    expect(extractFeoCatalog(reordered)).toEqual(catalog);
    const aliasesReordered = template.replace("alt_title: [role, RBAC]", "alt_title: [RBAC, role]");
    expect(extractFeoCatalog(aliasesReordered)).toEqual(catalog);
    const named = template.replace(
      "  - kind: Frontend\n    spec:",
      "  - kind: Frontend\n    metadata:\n      name: access\n    spec:",
    );
    expect(extractFeoCatalog(named)).toEqual(catalog);
  });

  it("slugifies aliases by case and punctuation while allowing a pipe in an alias", () => {
    const aliased = template.replace(
      "alt_title: [role, RBAC]",
      'alt_title: [" Admin Console!! ", "RBAC|Admin", "R&D"]',
    );
    const catalog = extractFeoCatalog(aliased);

    expect(catalog["searchEntries.roles.alt_title.admin-console"]?.defaultMessage).toBe(
      " Admin Console!! ",
    );
    expect(catalog["searchEntries.roles.alt_title.rbac-admin"]?.defaultMessage).toBe("RBAC|Admin");
    expect(catalog["searchEntries.roles.alt_title.r-d"]?.defaultMessage).toBe("R&D");
  });

  it("accepts dotted IDs and shares one key between aliases with the same slug", () => {
    const catalog = extractFeoCatalog(dottedTemplate);

    expect(catalog["searchEntries.RHEL.ros.title"]?.defaultMessage).toBe("RHEL ROS");
    expect(catalog["searchEntries.RHEL.ros.description"]?.defaultMessage).toBe("Manage ROS");
    expect(catalog["searchEntries.RHEL.ros.alt_title.acs"]?.defaultMessage).toBe("acs");
    expect(catalog["searchEntries.RHEL.ros.alt_title.acs"]?.description).toContain('"ACS"');
    expect(catalog["searchEntries.RHEL.ros.alt_title.operators"]?.defaultMessage).toBe("operators");
    expect(catalog["searchEntries.hosts.alt_title.hosts"]?.defaultMessage).toBe("hosts");
    expect(catalog["searchEntries.hosts.alt_title.hosts"]?.description).toContain('"hosts"');
    expect(
      catalog[
        "bundleSegments.hybrid-committed-spend.main.navItems.hybrid-committed-spend.nav.routes.hybrid-committed-spend.overview.title"
      ]?.defaultMessage,
    ).toBe("Overview");
    expect(
      catalog[
        "bundleSegments.hybrid-committed-spend.main.navItems.hybrid-committed-spend.nav.routes.hybrid-committed-spend.details.title"
      ]?.defaultMessage,
    ).toBe("Details");
    expect(catalog["serviceTiles.rhel.security.malware.signatures.title"]?.defaultMessage).toBe(
      "Malware signatures",
    );

    const reorderedAliases = dottedTemplate.replace(
      "alt_title: [acs, ACS, operators]",
      "alt_title: [ACS, acs, operators]",
    );
    expect(
      extractFeoCatalog(reorderedAliases)["searchEntries.RHEL.ros.alt_title.acs"]?.defaultMessage,
    ).toBe("ACS");
  });

  it("rejects empty alias slugs and records aliases that share a slug", () => {
    const emptySlug = template.replace("alt_title: [role, RBAC]", 'alt_title: ["!!!"]');
    expect(() => extractFeoCatalog(emptySlug)).toThrow(
      'searchEntries.roles: alt_title alias "!!!" has an empty slug',
    );

    const duplicateSlug = template.replace(
      "alt_title: [role, RBAC]",
      'alt_title: ["Roles", "ROLES!"]',
    );
    const catalog = extractFeoCatalog(duplicateSlug);
    expect(catalog["searchEntries.roles.alt_title.roles"]?.defaultMessage).toBe("Roles");
    expect(catalog["searchEntries.roles.alt_title.roles"]?.description).toContain('"ROLES!"');
  });

  it("rejects unsafe identifier segments and FEO keys longer than 256 characters", () => {
    for (const id of ["-roles", "_roles", "a.-roles", "a._roles", "a..b", "a."]) {
      const invalid = template.replace("id: roles", `id: ${id}`);
      const message = errorMessage(() => extractFeoCatalog(invalid));
      expect(message).toContain(`searchEntries.id has an unsafe identifier: ${id}`);
      expect(message).toContain("dot-separated segments");
      expect(message).toContain("^[A-Za-z0-9][A-Za-z0-9_-]*$");
    }

    const boundaryId = "x".repeat(236);
    const boundaryKey = `searchEntries.${boundaryId}.title`;
    expect(boundaryKey.length).toBe(256);
    const withoutAliases = template.replace("          alt_title: [role, RBAC]\n", "");
    const boundary = withoutAliases.replace("id: roles", `id: ${boundaryId}`);
    expect(extractFeoCatalog(boundary)[boundaryKey]?.defaultMessage).toBe("Roles");

    const multiFrontend = boundary
      .replace(
        "  - kind: Frontend\n    spec:",
        "  - kind: Frontend\n    metadata:\n      name: first\n    spec:",
      )
      .replace(
        "parameters:",
        "  - kind: Frontend\n    metadata:\n      name: second\n    spec: {}\nparameters:",
      );
    const prefixedKey = `objects.first.spec.${boundaryKey}`;
    expect(prefixedKey.length).toBeGreaterThan(256);
    expect(extractFeoCatalog(multiFrontend)[prefixedKey]?.defaultMessage).toBe("Roles");

    const longId = "x".repeat(237);
    const longKey = `searchEntries.${longId}.title`;
    const tooLong = withoutAliases.replace("id: roles", `id: ${longId}`);
    const message = errorMessage(() => extractFeoCatalog(tooLong));
    expect(message).toContain("256-character");
    expect(message).toContain(longKey);
  });

  it("limits alias keys to 256 characters before multi-Frontend prefixes and inlines boundary keys", () => {
    const id = "x".repeat(220);
    const boundaryAlias = "a".repeat(11);
    const boundaryKey = `searchEntries.${id}.alt_title.${boundaryAlias}`;
    expect(boundaryKey.length).toBe(256);

    const aliasTemplate = (alias: string, multipleFrontends = false) => {
      const firstMetadata = multipleFrontends ? "    metadata:\n      name: first\n" : "";
      const secondFrontend = multipleFrontends
        ? "  - kind: Frontend\n    metadata:\n      name: second\n    spec: {}\n"
        : "";
      return `kind: Template\nobjects:\n  - kind: Frontend\n${firstMetadata}    spec:\n      searchEntries:\n        - id: ${id}\n          alt_title: [${alias}]\n${secondFrontend}`;
    };

    const single = aliasTemplate(boundaryAlias);
    const singleSource = extractFeoCatalog(single);
    const singleTarget = { [boundaryKey]: "Boundary alias" };
    const singleResult = inlineFeoLocale(single, singleSource, singleTarget, "fr");
    expect(parse(singleResult).objects[0].spec.locales.fr).toEqual(singleTarget);
    expect(inlineFeoLocale(singleResult, singleSource, singleTarget, "fr")).toBe(singleResult);

    const multiple = aliasTemplate(boundaryAlias, true);
    const prefixedKey = `objects.first.spec.${boundaryKey}`;
    expect(prefixedKey.length).toBeGreaterThan(256);
    const multipleSource = extractFeoCatalog(multiple);
    const multipleTarget = { [prefixedKey]: "Boundary alias" };
    const multipleResult = inlineFeoLocale(multiple, multipleSource, multipleTarget, "fr");
    expect(parse(multipleResult).objects[0].spec.locales.fr).toEqual(singleTarget);
    expect(parse(multipleResult).objects[0].spec.locales.fr).not.toHaveProperty(prefixedKey);
    expect(inlineFeoLocale(multipleResult, multipleSource, multipleTarget, "fr")).toBe(
      multipleResult,
    );

    const tooLongKey = `searchEntries.${id}.alt_title.${"a".repeat(12)}`;
    expect(tooLongKey.length).toBe(257);
    for (const multipleFrontends of [false, true]) {
      const tooLong = aliasTemplate("a".repeat(12), multipleFrontends);
      const message = errorMessage(() => extractFeoCatalog(tooLong));
      expect(message).toContain("256-character");
      expect(message).toContain(tooLongKey);
    }
  });

  it("names both source item contexts when structural paths collide", () => {
    const duplicateNav = `kind: Template
objects:
  - kind: Frontend
    spec:
      bundleSegments:
        - bundleId: app
          segmentId: main
          navItems:
            - id: x.routes.y
              title: Parent route
            - id: x
              title: Parent
              routes:
                - id: y
                  product: Child product
`;
    expectDuplicateContexts(
      duplicateNav,
      'navItems[0] (id="x.routes.y").title',
      'navItems[1] (id="x").routes[0] (id="y").title',
    );

    const duplicateSearch = `kind: Template
objects:
  - kind: Frontend
    spec:
      searchEntries:
        - id: a.alt_title
        - id: a
          alt_title: [title]
`;
    expectDuplicateContexts(
      duplicateSearch,
      'searchEntries[0] (id="a.alt_title").title',
      'searchEntries[1] (id="a") alt_title aliases ["title"]',
    );

    const duplicateTiles = `kind: Template
objects:
  - kind: Frontend
    spec:
      serviceTiles:
        - section: a.b
          group: c
          id: shared
          title: First tile
        - section: a
          group: b.c
          id: shared
          title: Second tile
`;
    expectDuplicateContexts(
      duplicateTiles,
      'serviceTiles[0] (section="a.b", group="c", id="shared")',
      'serviceTiles[1] (section="a", group="b.c", id="shared")',
    );
  });

  it("rejects nav runtime-key collisions when catalog paths differ", () => {
    const duplicateRuntimeNav = `kind: Template
objects:
  - kind: Frontend
    spec:
      bundleSegments:
        - bundleId: b
          segmentId: s.navItems.x
          navItems:
            - id: y
              title: First item
        - bundleId: b
          segmentId: s
          navItems:
            - id: navItems.x.y
              title: Second item
`;
    expectDuplicateContexts(
      duplicateRuntimeNav,
      'bundleSegments[0] (bundleId="b", segmentId="s.navItems.x").navItems[0] (id="y").title',
      'bundleSegments[1] (bundleId="b", segmentId="s").navItems[0] (id="navItems.x.y").title',
      "runtime",
    );
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

  it("inlines only translated aliases and leaves missing alias keys absent", () => {
    const source = extractFeoCatalog(template);
    const target = { "searchEntries.roles.alt_title.role": "rôle" };
    const result = inlineFeoLocale(template, source, target, "fr");

    expect(parse(result).objects[0].spec.locales.fr).toEqual(target);
    expect(result).not.toContain("searchEntries.roles.alt_title.rbac:");
    expect(inlineFeoLocale(result, source, target, "fr")).toBe(result);
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
    expect(() =>
      inlineFeoLocale(template, source, { "searchEntries.roles.alt_title": "role|RBAC" }, "zh-CN"),
    ).toThrow(
      "Unknown translation key: searchEntries.roles.alt_title; alt_title uses one message per slug",
    );
    expect(() =>
      inlineFeoLocale(
        template.replace("alt_title: [role, RBAC]", "alt_title: [role, RBAC Tools]"),
        source,
        {},
        "zh-CN",
      ),
    ).toThrow("English source changed for searchEntries.roles.alt_title.rbac");
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

  it("keeps a trailing locale comment in the splice and remains idempotent", () => {
    const source = extractFeoCatalog(template);
    const withComment = template.replace(
      "parameters:",
      "      locales:\n        fr:\n          searchEntries.roles.title: Rôles\n          # keep this note\nparameters:",
    );
    const target = { "searchEntries.roles.title": "Rôles" };
    const first = inlineFeoLocale(withComment, source, target, "fr");
    const repeated = inlineFeoLocale(first, source, target, "fr");

    expect(first.match(/# keep this note/g)).toHaveLength(1);
    expect(repeated).toBe(first);
  });

  it("converts an empty flow-style locales mapping to valid block YAML", () => {
    const emptyFlow = template.replace(
      "parameters:",
      "      locales: {} # retain this comment\nparameters:",
    );
    const source = extractFeoCatalog(emptyFlow);
    const result = inlineFeoLocale(
      emptyFlow,
      source,
      { "searchEntries.roles.title": "角色" },
      "zh-CN",
    );

    expect(parse(result).objects[0].spec.locales["zh-CN"]).toEqual({
      "searchEntries.roles.title": "角色",
    });
    expect(result).toContain("locales: # retain this comment\n        zh-CN:");
    expect(result.match(/# retain this comment/g)).toHaveLength(1);
    expect(inlineFeoLocale(result, source, { "searchEntries.roles.title": "角色" }, "zh-CN")).toBe(
      result,
    );
  });

  it("preserves every comment on an empty flow-style locales mapping and remains idempotent", () => {
    const emptyFlow = template.replace(
      "parameters:",
      "      locales: {} # locale map\n        # translator note\nparameters:",
    );
    const source = extractFeoCatalog(emptyFlow);
    const target = { "searchEntries.roles.title": "角色" };
    const result = inlineFeoLocale(emptyFlow, source, target, "zh-CN");
    const repeated = inlineFeoLocale(result, source, target, "zh-CN");

    expect(parse(result).objects[0].spec.locales["zh-CN"]).toEqual(target);
    expect(result).toContain("locales: # locale map\n        # translator note\n        zh-CN:");
    expect(result.match(/# locale map/g)).toHaveLength(1);
    expect(result.match(/# translator note/g)).toHaveLength(1);
    expect(repeated).toBe(result);
  });

  it("orders catalog and new locale keys by code unit, whatever the process locale", () => {
    const mixed = `kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n${[
      "aardvark",
      "a_b",
      "Zed",
      "a-b",
    ]
      .map((id) => `        - id: ${id}\n          title: ${id}\n`)
      .join("")}`;
    const keys = [
      "searchEntries.Zed.title",
      "searchEntries.a-b.title",
      "searchEntries.a_b.title",
      "searchEntries.aardvark.title",
    ];
    const source = extractFeoCatalog(mixed);
    expect(Object.keys(source)).toEqual(keys);
    const result = inlineFeoLocale(
      mixed,
      source,
      Object.fromEntries([...keys].reverse().map((key) => [key, "x"])),
      "fr",
    );
    expect(Object.keys(parse(result).objects[0].spec.locales.fr)).toEqual(keys);
  });

  it("lists the locales inlined in any Frontend object", () => {
    expect(feoTemplateLocales(template)).toEqual([]);
    const source = extractFeoCatalog(template);
    const translated = inlineFeoLocale(
      inlineFeoLocale(template, source, { "searchEntries.roles.title": "角色" }, "zh-CN"),
      source,
      { "searchEntries.roles.title": "Rollen" },
      "de",
    );
    expect(feoTemplateLocales(translated)).toEqual(["de", "zh-CN"]);
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

describe("FEO locale ids and CRD limits", () => {
  const source = extractFeoCatalog(template);
  const target = { "searchEntries.users.title": "Utilisateurs" };

  it.each(["fr", "ko", "ja", "zh-CN", "zh-Hant-TW", "es-419", "fil", "sr-Latn"])(
    "inlines canonical locale %s",
    (locale) => {
      expect(
        parse(inlineFeoLocale(template, source, target, locale)).objects[0].spec.locales,
      ).toEqual({ [locale]: { "searchEntries.users.title": "Utilisateurs" } });
    },
  );

  it.each([
    ["zh-cn", ' use "zh-CN"'],
    ["fr-fr", ' use "fr-FR"'],
    ["zh-hant-tw", ' use "zh-Hant-TW"'],
    ["fr-FR-u-nu-latn", "canonical BCP 47"],
    ["fr_FR", "canonical BCP 47"],
    ["EN", "canonical BCP 47"],
    ["en", "canonical BCP 47"],
  ])("rejects locale %s with a hint", (locale, hint) => {
    const message = errorMessage(() => inlineFeoLocale(template, source, target, locale));
    expect(message).toContain(`Target locale ${JSON.stringify(locale)} is not a canonical`);
    expect(message).toContain(hint.trim());
  });

  function localesBlock(count: number): string {
    const ids = Array.from(
      { length: count },
      (_, index) =>
        `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
    ).filter((id) => id !== "en");
    return `      locales:\n${ids.map((id) => `        ${id}:\n          searchEntries.users.title: x\n`).join("")}`;
  }

  it("limits a Frontend to 32 locales", () => {
    const withLocales = (count: number) =>
      template.replace("      searchEntries:", `${localesBlock(count)}      searchEntries:`);
    const at31 = withLocales(31);
    const at32 = inlineFeoLocale(at31, source, target, "fr");
    expect(Object.keys(parse(at32).objects[0].spec.locales)).toHaveLength(32);
    // Re-inlining an existing locale does not add one.
    expect(inlineFeoLocale(at32, source, target, "fr")).toBe(at32);
    const message = errorMessage(() => inlineFeoLocale(at32, source, target, "ko"));
    expect(message).toContain('Frontend already has 32 spec.locales blocks; adding "ko"');
    expect(message).toContain("32-locale limit");
    // A template already over the limit can still update the locales it has.
    const at33 = withLocales(33);
    expect(() =>
      inlineFeoLocale(at33, source, { "searchEntries.users.title": "y" }, "aa"),
    ).not.toThrow();
  });

  it("names the Frontend that would exceed the locale limit", () => {
    const multi = `kind: Template
objects:
  - kind: Frontend
    metadata:
      name: first
    spec:
${localesBlock(32)}      module:
        defaultDocumentTitle: First
  - kind: Frontend
    metadata:
      name: second
    spec:
      module:
        defaultDocumentTitle: Second
`;
    const message = errorMessage(() =>
      inlineFeoLocale(
        multi,
        extractFeoCatalog(multi),
        { "objects.first.spec.module.defaultDocumentTitle": "Premier" },
        "fr",
      ),
    );
    expect(message).toContain('Frontend "first" already has 32 spec.locales blocks');
  });

  it("renames a block under a non-canonical spelling of the locale", () => {
    const legacy = template.replace(
      "      searchEntries:",
      "      locales:\n        zh-cn:\n          searchEntries.users.title: old\n      searchEntries:",
    );
    const inlined = inlineFeoLocale(legacy, source, target, "zh-CN");
    expect(parse(inlined).objects[0].spec.locales).toEqual({
      "zh-CN": { "searchEntries.users.title": "Utilisateurs" },
    });
  });

  it.each([
    ["zh-CN", "zh-cn"],
    ["zh-cn", "zh-CN"],
    ["zh-cn", "ZH-CN"],
  ])("consolidates %s and %s into one canonical block", (first, second) => {
    const blocks = [first, second]
      .map((id) => `        ${id}:\n          searchEntries.users.title: old\n`)
      .join("");
    const french = "        fr:\n          searchEntries.users.title: Bonjour\n";
    const legacy = template.replace(
      "      searchEntries:",
      `      locales:\n${blocks}${french}      searchEntries:`,
    );

    const inlined = inlineFeoLocale(legacy, source, target, "zh-CN");

    expect(parse(inlined).objects[0].spec.locales).toEqual({
      "zh-CN": { "searchEntries.users.title": "Utilisateurs" },
      fr: { "searchEntries.users.title": "Bonjour" },
    });
    expect(inlined).toContain(french);
    expect(inlineFeoLocale(inlined, source, target, "zh-CN")).toBe(inlined);
  });

  function manyEntries(count: number): string {
    const entries = Array.from(
      { length: count },
      (_, index) => `        - id: e${index}\n          title: T\n`,
    );
    return `kind: Template\nobjects:\n  - kind: Frontend\n    spec:\n      searchEntries:\n${entries.join("")}`;
  }

  it.each([
    ["zh-CN", "zh-cn"],
    ["zh-cn", "zh-CN"],
  ])("preserves sibling indentation after trailing comments in %s before %s", (first, second) => {
    const blocks =
      `        ${first}:\n          searchEntries.users.title: old\n          # locale note\n` +
      `        ${second}:\n          searchEntries.users.title: old\n`;
    const french = "        fr:\n          searchEntries.users.title: Bonjour\n";
    const legacy = template.replace(
      "      searchEntries:",
      `      locales:\n${blocks}${french}      searchEntries:`,
    );

    const inlined = inlineFeoLocale(legacy, source, target, "zh-CN");

    expect(parse(inlined).objects[0].spec.locales).toEqual({
      "zh-CN": { "searchEntries.users.title": "Utilisateurs" },
      fr: { "searchEntries.users.title": "Bonjour" },
    });
    expect(inlined).toContain(french);
    expect(inlineFeoLocale(inlined, source, target, "zh-CN")).toBe(inlined);
  });

  it("allows more English messages than the per-locale key limit", () => {
    const english = manyEntries(2049);
    const source = extractFeoCatalog(english);
    const inlined = inlineFeoLocale(english, source, { "searchEntries.e0.title": "T" }, "fr");

    expect(Object.keys(source)).toHaveLength(2049);
    expect(parse(inlined).objects[0].spec.locales.fr).toEqual({ "searchEntries.e0.title": "T" });
  });

  it("preserves the following spec field after an alias's trailing comment", () => {
    const legacy = template.replace(
      "      searchEntries:",
      "      locales:\n        zh-CN:\n          searchEntries.users.title: old\n" +
        "        zh-cn:\n          searchEntries.users.title: old\n          # alias note\n" +
        "      searchEntries:",
    );

    const inlined = inlineFeoLocale(legacy, source, target, "zh-CN");

    expect(parse(inlined).objects[0].spec.searchEntries).toEqual(
      parse(template).objects[0].spec.searchEntries,
    );
    expect(inlineFeoLocale(inlined, source, target, "zh-CN")).toBe(inlined);
  });

  it("limits each translated locale to 2048 keys", () => {
    const ok = manyEntries(2048);
    const catalog = Object.fromEntries(
      Array.from({ length: 2048 }, (_, index) => [`searchEntries.e${index}.title`, "T"]),
    );
    const inlined = inlineFeoLocale(ok, extractFeoCatalog(ok), catalog, "fr");
    expect(Object.keys(parse(inlined).objects[0].spec.locales.fr)).toHaveLength(2048);

    const oversized = manyEntries(2049);
    const message = errorMessage(() =>
      inlineFeoLocale(
        oversized,
        extractFeoCatalog(oversized),
        { ...catalog, "searchEntries.e2048.title": "T" },
        "fr",
      ),
    );
    expect(message).toContain("2049 keys");
    expect(message).toContain("2048-key limit");
  });

  it("omits translations over 4096 characters, counting code points", () => {
    const inline = (value: string) =>
      parse(
        inlineFeoLocale(
          template,
          source,
          { "searchEntries.users.title": value, "searchEntries.roles.title": "Rôles" },
          "fr",
        ),
      ).objects[0].spec.locales.fr;
    expect(inline("a".repeat(4096))["searchEntries.users.title"]).toHaveLength(4096);
    // 4096 code points are 8192 UTF-16 units; 2049 emoji are 4098 units but only 2049 code points.
    expect(inline("\u{1F600}".repeat(4096))).toHaveProperty("searchEntries.users.title");
    expect(inline("\u{1F600}".repeat(2049))).toHaveProperty("searchEntries.users.title");
    for (const value of [
      "a".repeat(4097),
      "\u{1F600}".repeat(4097),
      `${"a".repeat(4096)}\u{1F600}`,
    ]) {
      // Only the overlong message falls back to English; the rest of the locale is kept.
      expect(inline(value)).toEqual({ "searchEntries.roles.title": "Rôles" });
    }
  });

  it("keeps empty lines of a multiline translation", () => {
    const source = extractFeoCatalog(template);
    const result = inlineFeoLocale(
      template,
      source,
      { "searchEntries.users.title": "Utilisateurs\n\nGroupes" },
      "fr",
    );
    expect(parse(result).objects[0].spec.locales.fr["searchEntries.users.title"]).toBe(
      "Utilisateurs\n\nGroupes",
    );
  });
});
