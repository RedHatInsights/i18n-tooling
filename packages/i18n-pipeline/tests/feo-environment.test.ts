import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  extractFeoEnvironmentCatalog,
  extractFeoEnvironmentCatalogs,
  inlineFeoEnvironmentLocale,
} from "../src/index.js";

const operatorFixture = readFileSync(
  new URL("./fixtures/frontend-environment.yaml", import.meta.url),
  "utf8",
);

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected operation to throw");
}

function environmentDocument(spec: Record<string, unknown>): string {
  return stringify(
    {
      apiVersion: "cloud.redhat.com/v1alpha1",
      kind: "FrontendEnvironment",
      metadata: { name: "stage" },
      spec: { bundles: [{ id: "iam", title: "Identity" }], ...spec },
    },
    { lineWidth: 0 },
  );
}

function inlineEnvironment(template: string): string {
  const source = extractFeoEnvironmentCatalog(template);
  return inlineFeoEnvironmentLocale(template, source, { "bundles.iam.title": "Identité" }, "fr");
}

function parseTemplatedYaml(template: string): unknown {
  return parse(template.replace(/\{\{[\s\S]*?\}\}/g, (match) => match.replace(/[^\r\n]/g, "x")));
}

describe("FrontendEnvironment localization", () => {
  it("extracts the operator fixture keys and inlines its French messages", () => {
    const catalog = extractFeoEnvironmentCatalog(operatorFixture);
    expect(Object.keys(catalog)).toEqual([
      "bundles.iam.description",
      "bundles.iam.title",
      "serviceCategories.security.groups.access.title",
      "serviceCategories.security.title",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(catalog).map(([key, message]) => [key, message.defaultMessage]),
      ),
    ).toEqual({
      "bundles.iam.description": "Manage users, groups and roles",
      "bundles.iam.title": "Identity & Access Management",
      "serviceCategories.security.groups.access.title": "Access",
      "serviceCategories.security.title": "Security",
    });
    for (const descriptor of Object.values(catalog)) {
      expect(Object.keys(descriptor)).toEqual(["defaultMessage", "description"]);
      expect(typeof descriptor.description).toBe("string");
    }

    const expectedLocales = (parse(operatorFixture) as { spec: { locales: unknown } }).spec.locales;
    const withoutLocales = operatorFixture.replace(/ {2}locales:\n {4}fr:\n(?: {6}[^\n]*\n)*/, "");
    const target = (parse(operatorFixture) as { spec: { locales: { fr: Record<string, string> } } })
      .spec.locales.fr;
    const inlined = inlineFeoEnvironmentLocale(withoutLocales, catalog, target, "fr");
    const actual = (parse(inlined) as { spec: { locales: unknown } }).spec.locales;
    expect(actual).toEqual(expectedLocales);
    expect((parse(inlined) as { spec: { enabledLocales: unknown } }).spec.enabledLocales).toEqual(
      (parse(operatorFixture) as { spec: { enabledLocales: unknown } }).spec.enabledLocales,
    );
  });

  it("merges shared English keys and reports conflicting files", () => {
    const shared = environmentDocument({});
    const catalog = extractFeoEnvironmentCatalogs([
      { path: "main.yaml", template: shared },
      { path: "stage-multicluster.yaml", template: shared },
    ]);
    expect(Object.keys(catalog)).toEqual(["bundles.iam.title"]);
    expect(() =>
      inlineFeoEnvironmentLocale(shared, catalog, { "bundles.unknown.title": "Inconnu" }, "fr"),
    ).toThrow("Unknown translation key: bundles.unknown.title");

    const changed = shared.replace("title: Identity", "title: Identity for stage");
    const conflict = errorMessage(() =>
      extractFeoEnvironmentCatalogs([
        { path: "main.yaml", template: shared },
        { path: "prod-multicluster.yaml", template: changed },
      ]),
    );
    expect(conflict).toContain("bundles.iam.title");
    expect(conflict).toContain("main.yaml");
    expect(conflict).toContain("prod-multicluster.yaml");
    expect(() => inlineFeoEnvironmentLocale(changed, catalog, {}, "fr")).toThrow(
      "English source changed for bundles.iam.title",
    );
  });

  it("rejects duplicate bundle, category, and group ids with both item contexts", () => {
    expect(
      extractFeoEnvironmentCatalog(environmentDocument({ bundles: [{ id: "a".repeat(257) }] })),
    ).toEqual({});

    const duplicateBundle = environmentDocument({
      bundles: [
        { id: "iam", title: "Identity" },
        { id: "iam", title: "Identity again" },
      ],
    });
    const bundleError = errorMessage(() => extractFeoEnvironmentCatalog(duplicateBundle));
    expect(bundleError).toContain("bundles.iam.title");
    expect(bundleError).toContain("bundles[0]");
    expect(bundleError).toContain("bundles[1]");

    const duplicateCategory = environmentDocument({
      serviceCategories: [
        { id: "security", title: "Security" },
        { id: "security", title: "Security again" },
      ],
    });
    const categoryError = errorMessage(() => extractFeoEnvironmentCatalog(duplicateCategory));
    expect(categoryError).toContain("serviceCategories.security.title");
    expect(categoryError).toContain("serviceCategories[0]");
    expect(categoryError).toContain("serviceCategories[1]");

    const duplicateGroup = environmentDocument({
      serviceCategories: [
        {
          id: "security",
          title: "Security",
          groups: [
            { id: "access", title: "Access" },
            { id: "access", title: "Access again" },
          ],
        },
      ],
    });
    const groupError = errorMessage(() => extractFeoEnvironmentCatalog(duplicateGroup));
    expect(groupError).toContain("serviceCategories.security.groups.access.title");
    expect(groupError).toContain("groups[0]");
    expect(groupError).toContain("groups[1]");
  });

  it("masks Jinja placeholders and preserves their exact text while inlining", () => {
    const template = `# Environment {{comment_value}}\napiVersion: cloud.redhat.com/v1alpha1\nkind: FrontendEnvironment\nmetadata:\n  name: {{env_name}}\nspec:\n  hostname: {{env_name}}.{{hostname}}\n  sso: {{sso_source}}\n  targetNamespaces:\n    - {{chrome_target_namespace}}\n  deployCutoffTimestampPushCache: "{{deploy_cutoff_timestamp_push_cache}}"\n  bundles:\n    - id: iam\n      title: Identity\n      description: Manage users\n`;
    const source = extractFeoEnvironmentCatalog(template);
    const result = inlineFeoEnvironmentLocale(
      template,
      source,
      { "bundles.iam.title": "Identité" },
      "fr",
    );
    const placeholders = (value: string) => value.match(/\{\{[\s\S]*?\}\}/g);
    expect(placeholders(result)).toEqual(placeholders(template));
    expect(result).toContain("# Environment {{comment_value}}");
    expect(parseTemplatedYaml(result)).toMatchObject({
      metadata: { name: "x".repeat("{{env_name}}".length) },
      spec: { locales: { fr: { "bundles.iam.title": "Identité" } } },
    });
  });

  it("rejects Jinja statements, comments, and placeholders in translatable fields or locales", () => {
    expect(() =>
      extractFeoEnvironmentCatalog(`{% if enabled %}\n${environmentDocument({})}`),
    ).toThrow("Jinja statements");
    expect(() =>
      extractFeoEnvironmentCatalog(`{# internal #}\n${environmentDocument({})}`),
    ).toThrow("Jinja comments");
    expect(() =>
      extractFeoEnvironmentCatalog(
        environmentDocument({}).replace("title: Identity", "title: {{title}}"),
      ),
    ).toThrow("bundles[0].title");
    expect(() =>
      extractFeoEnvironmentCatalog(environmentDocument({}).replace("id: iam", "id: {{bundle_id}}")),
    ).toThrow("bundles[0].id");
    expect(() =>
      extractFeoEnvironmentCatalog(
        environmentDocument({ locales: { fr: { "bundles.iam.title": "{{translation}}" } } }),
      ),
    ).toThrow("spec.locales");
  });

  it("validates enabledLocales CRD limits", () => {
    const base = [
      { id: "en", name: "English", default: true },
      { id: "fr", name: "Français" },
    ];
    const inline = (enabledLocales: unknown[]) =>
      inlineEnvironment(environmentDocument({ enabledLocales }));

    expect(() => inline([{ id: "fr", name: "Français", default: true }])).toThrow(
      "spec.enabledLocales must include id en",
    );
    expect(() => inline(base.map(({ id, name }) => ({ id, name })))).toThrow(
      "exactly one item with default: true (found 0)",
    );
    expect(() =>
      inline([
        { id: "en", name: "English", default: true },
        { id: "fr", name: "Français", default: true },
      ]),
    ).toThrow("exactly one item with default: true (found 2)");
    expect(() =>
      inline([
        { id: "en", name: "English", default: true },
        { id: "fr", name: "" },
      ]),
    ).toThrow("spec.enabledLocales[1].name");
    expect(() =>
      inline([
        { id: "en", name: "English", default: true },
        { id: "fr", name: "N".repeat(65) },
      ]),
    ).toThrow("64-character limit");
    expect(() =>
      inline([
        { id: "en", name: "English", default: true },
        { id: "zh-cn", name: "中文" },
      ]),
    ).toThrow("spec.enabledLocales[1].id");

    const atLimit = [
      { id: "en", name: "E", default: true },
      ...Array.from({ length: 31 }, (_, index) => ({
        id: `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
        name: index === 0 ? "N".repeat(64) : "N",
        ...(index === 1 ? { default: false } : {}),
      })),
    ];
    expect(() => inline(atLimit)).not.toThrow();

    const overLimit = [...atLimit, { id: "ca", name: "Català" }];
    expect(() => inline(overLimit)).toThrow("spec.enabledLocales has 33 items");
  });

  it("validates the full spec.locales block after inlining", () => {
    const invalidCases: [Record<string, unknown>, string][] = [
      [{ locales: { en: { "bundles.iam.title": "Identity" } } }, `spec.locales locale "en"`],
      [{ locales: { de: { "bad/key": "Identité" } } }, "spec.locales.de.bad/key"],
      [{ locales: { de: { ["a".repeat(257)]: "Identité" } } }, "256-character key limit"],
      [
        { locales: { de: { "bundles.iam.title": "\u{1f600}".repeat(4097) } } },
        "4096-character message limit",
      ],
    ];
    for (const [spec, expected] of invalidCases) {
      const message = errorMessage(() => inlineEnvironment(environmentDocument(spec)));
      expect(message).toContain(expected);
    }

    expect(() =>
      inlineEnvironment(environmentDocument({ locales: { de: { ["a".repeat(256)]: "value" } } })),
    ).not.toThrow();

    expect(() =>
      inlineEnvironment(
        environmentDocument({ locales: { de: { "bundles.iam.title": "\u{1f600}".repeat(4096) } } }),
      ),
    ).not.toThrow();
  });

  // Each case inlines and reparses a 2048-key block, which is slow under coverage in CI.
  it("validates the per-locale key limit after inlining", () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 2049 }, (_, index) => [`key${index}`, "value"]),
    );
    const tooManyKeyError = errorMessage(() =>
      inlineEnvironment(environmentDocument({ locales: { de: tooManyKeys } })),
    );
    expect(tooManyKeyError).toContain("spec.locales.de has 2049 keys");

    const atMaxKeys = Object.fromEntries(
      Array.from({ length: 2048 }, (_, index) => [`key${index}`, "value"]),
    );
    expect(() =>
      inlineEnvironment(environmentDocument({ locales: { de: atMaxKeys } })),
    ).not.toThrow();
  }, 30_000);

  it("validates the locale count limit after inlining", () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => {
        const id = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
        return [id, { "bundles.iam.title": "Identity" }];
      }),
    );
    expect(() => inlineEnvironment(environmentDocument({ locales: atLimit }))).not.toThrow();

    const locales = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => {
        const id = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
        return [id, { "bundles.iam.title": "Identity" }];
      }),
    );
    const tooManyLocales = errorMessage(() => inlineEnvironment(environmentDocument({ locales })));
    expect(tooManyLocales).toContain("spec.locales");
    expect(tooManyLocales).toContain("32-locale limit");
  });

  it("keeps empty lines of a multiline translation", () => {
    const template = environmentDocument({});
    const result = inlineFeoEnvironmentLocale(
      template,
      extractFeoEnvironmentCatalog(template),
      { "bundles.iam.title": "Première\n\nTroisième" },
      "fr",
    );
    expect(parse(result).spec.locales.fr["bundles.iam.title"]).toBe("Première\n\nTroisième");
  });

  it("rejects catalog keys that reach the same operator runtime key", () => {
    const message = errorMessage(() =>
      extractFeoEnvironmentCatalog(
        environmentDocument({
          bundles: [],
          serviceCategories: [
            { id: "a.group.b", title: "Category" },
            { id: "a", title: "A", groups: [{ id: "b", title: "Group" }] },
          ],
        }),
      ),
    );
    expect(message).toContain("Duplicate FEO runtime key: serviceCategory.a.group.b.title");
  });

  it("rejects duplicate enabledLocales ids", () => {
    const message = errorMessage(() =>
      inlineEnvironment(
        environmentDocument({
          enabledLocales: [
            { id: "en", name: "English", default: true },
            { id: "en", name: "Duplicate" },
          ],
        }),
      ),
    );
    expect(message).toContain("lists id en more than once");
  });

  it("allows placeholders in comments next to translatable values", () => {
    const template = environmentDocument({}).replace(
      "title: Identity",
      "title: Identity # {{ note }}",
    );
    expect(Object.keys(extractFeoEnvironmentCatalog(template))).toEqual(["bundles.iam.title"]);
    expect(inlineEnvironment(template)).toContain("# {{ note }}");
  });

  it("rejects multiline placeholders and flow-style specs", () => {
    const multiline = environmentDocument({}).replace(
      "name: stage",
      "name: {{\n    env_name\n  }}",
    );
    expect(errorMessage(() => extractFeoEnvironmentCatalog(multiline))).toContain(
      "must fit on one line",
    );
    const flow =
      "apiVersion: cloud.redhat.com/v1alpha1\nkind: FrontendEnvironment\n" +
      "spec: {bundles: [{id: iam, title: Identity}]}\n";
    expect(errorMessage(() => inlineEnvironment(flow))).toContain("block-style YAML");
  });

  it("omits overlong translations so they fall back to English, like Frontend inline", () => {
    const template = environmentDocument({
      bundles: [
        { id: "iam", title: "Identity" },
        { id: "docs", title: "Documentation" },
      ],
    });
    const result = inlineFeoEnvironmentLocale(
      template,
      extractFeoEnvironmentCatalog(template),
      { "bundles.iam.title": "Identité", "bundles.docs.title": "x".repeat(4097) },
      "fr",
    );
    expect(parse(result).spec.locales.fr).toEqual({ "bundles.iam.title": "Identité" });
  });
});
