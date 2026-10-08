import {
  parseDocument,
  stringify,
  isMap,
  isSeq,
  isScalar,
  type YAMLMap,
  type Document,
} from "yaml";

type Descriptor = { defaultMessage: string; description: string };
export type FeoCatalog = Record<string, Descriptor>;

function mapping(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) throw new Error(`${label} must be a YAML mapping`);
  return value;
}

function text(value: unknown, label: string): string {
  if (!isScalar(value) || typeof value.value !== "string" || !value.value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.value;
}

function identifier(node: YAMLMap, name: string, label: string): string {
  const value = text(node.get(name, true), `${label}.${name}`);
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${label}.${name} has an unsafe identifier: ${value}`);
  return value;
}

function frontendSpecs(doc: Document): YAMLMap[] {
  const root = mapping(doc.contents, "Template");
  if (text(root.get("kind", true), "Template.kind") !== "Template")
    throw new Error("Expected an OpenShift Template");
  const objects = root.get("objects", true);
  if (!isSeq(objects)) throw new Error("Template.objects must be a sequence");
  const specs: YAMLMap[] = [];
  for (const object of objects.items) {
    if (isMap(object) && object.get("kind") === "Frontend") {
      specs.push(mapping(object.get("spec", true), "Frontend.spec"));
    }
  }
  return specs;
}

function collect(doc: Document): { catalog: FeoCatalog; specs: YAMLMap[]; owned: Set<string>[] } {
  const specs = frontendSpecs(doc);
  const owned: Set<string>[] = [];
  if (!specs.length) throw new Error("Template has no Frontend objects");
  const catalog: FeoCatalog = {};
  function add(key: string, node: YAMLMap, field: string, context: string): void {
    const value = node.get(field, true);
    if (value === undefined || (isScalar(value) && value.value === "")) return;
    let message: string;
    if (field === "alt_title") {
      if (
        !isSeq(value) ||
        value.items.some(
          (item) => !isScalar(item) || typeof item.value !== "string" || item.value.includes("|"),
        )
      ) {
        throw new Error(`${key}: alt_title must contain strings without |`);
      }
      message = value.items.map((item) => (item as { value: string }).value).join("|");
    } else {
      if (!isScalar(value) || typeof value.value !== "string")
        throw new Error(`${key} must be a string`);
      message = value.value;
    }
    if (!message.trim()) return;
    if (Object.hasOwn(catalog, key)) throw new Error(`Duplicate FEO message key: ${key}`);
    catalog[key] = { defaultMessage: message, description: `${field} of ${context}` };
  }
  function entries(
    spec: YAMLMap,
    list: string,
    fields: string[],
    prefix: (item: YAMLMap) => string,
  ): void {
    const items = spec.get(list, true);
    if (items === undefined) return;
    if (!isSeq(items)) throw new Error(`${list} must be a sequence`);
    for (const raw of items.items) {
      const item = mapping(raw, list);
      const key = prefix(item);
      for (const field of fields) add(`${key}.${field}`, item, field, key);
    }
  }
  function nav(items: unknown, prefix: string): void {
    if (!isSeq(items)) throw new Error(`${prefix}.navItems/routes must be a sequence`);
    for (const raw of items.items) {
      const item = mapping(raw, prefix);
      if (item.has("segmentRef")) continue;
      const key = `${prefix}.${identifier(item, "id", prefix)}`;
      for (const field of ["title", "product"]) add(`${key}.${field}`, item, field, key);
      const routes = item.get("routes", true);
      if (routes !== undefined) nav(routes, `${key}.routes`);
    }
  }
  for (const spec of specs) {
    const before = new Set(Object.keys(catalog));
    entries(
      spec,
      "searchEntries",
      ["title", "description", "alt_title"],
      (item) => `searchEntries.${identifier(item, "id", "searchEntries")}`,
    );
    entries(
      spec,
      "serviceTiles",
      ["title", "description"],
      (item) =>
        `serviceTiles.${identifier(item, "section", "serviceTiles")}.${identifier(item, "group", "serviceTiles")}.${identifier(item, "id", "serviceTiles")}`,
    );
    const segments = spec.get("bundleSegments", true);
    if (segments !== undefined) {
      if (!isSeq(segments)) throw new Error("bundleSegments must be a sequence");
      for (const raw of segments.items) {
        const item = mapping(raw, "bundleSegments");
        const key = `bundleSegments.${identifier(item, "bundleId", "bundleSegments")}.${identifier(item, "segmentId", "bundleSegments")}.navItems`;
        const navItems = item.get("navItems", true);
        if (navItems !== undefined) nav(navItems, key);
      }
    }
    const module = spec.get("module", true);
    if (module !== undefined)
      add(
        "module.defaultDocumentTitle",
        mapping(module, "module"),
        "defaultDocumentTitle",
        "module",
      );
    owned.push(new Set(Object.keys(catalog).filter((key) => !before.has(key))));
  }
  return {
    owned,
    catalog: Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))),
    specs,
  };
}

export function extractFeoCatalog(template: string): FeoCatalog {
  return collect(parse(template)).catalog;
}

function parse(template: string): Document {
  const doc = parseDocument(template, { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`Invalid Frontend template: ${doc.errors[0]!.message}`);
  return doc;
}

/** Only updates spec.locales[locale]; English and other locale entries remain untouched. */
export function inlineFeoLocale(
  template: string,
  source: FeoCatalog,
  target: Record<string, string>,
  locale: string,
): string {
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(locale) || locale === "en")
    throw new Error(`Invalid target locale: ${locale}`);
  const doc = parse(template);
  const { catalog, specs, owned } = collect(doc);
  for (const key of new Set([...Object.keys(source), ...Object.keys(catalog)])) {
    if (source[key]?.defaultMessage !== catalog[key]?.defaultMessage) {
      throw new Error(`English source changed for ${key}; regenerate and resubmit catalog`);
    }
  }
  for (const [key, value] of Object.entries(target)) {
    if (!(key in catalog)) throw new Error(`Unknown translation key: ${key}`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid translation: ${key}`);
  }
  const sorted = Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)));
  const changes: { start: number; end: number; text: string }[] = [];
  for (const [index, spec] of specs.entries()) {
    const ownTarget = Object.fromEntries(
      Object.entries(sorted).filter(([key]) => owned[index]!.has(key)),
    );
    const locales = spec.get("locales", true);
    const existing = locales === undefined ? undefined : mapping(locales, "spec.locales");
    const pair = existing?.items.find(
      (item) => item.key && isScalar(item.key) && item.key.value === locale,
    );
    if (!Object.keys(ownTarget).length && !pair) continue;
    const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
    const valueRange = pair && isMap(pair.value) ? pair.value.range : undefined;
    const indentAt = (offset: number) => offset - template.lastIndexOf("\n", offset - 1) - 1;
    const indent = keyRange
      ? indentAt(keyRange[0])
      : existing?.range
        ? indentAt(existing.range[0])
        : spec.items[0]?.key && isScalar(spec.items[0].key) && spec.items[0].key.range
          ? indentAt(spec.items[0].key.range[0])
          : 6;
    // YAML nodes carry source ranges: splice only this locale's mapping, never reprint the Template.
    const content = existing ? { [locale]: ownTarget } : { locales: { [locale]: ownTarget } };
    const block = stringify(content, { lineWidth: 0 })
      .split("\n")
      .filter(Boolean)
      .map((line) => `${" ".repeat(indent)}${line}\n`)
      .join("");
    if (keyRange && valueRange) {
      changes.push({ start: keyRange[0] - indent, end: valueRange[1], text: block });
    } else if (existing?.range) {
      changes.push({ start: existing.range[1], end: existing.range[1], text: block });
    } else if (spec.range) {
      changes.push({ start: spec.range[1], end: spec.range[1], text: block });
    }
  }
  let result = template;
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  parse(result);
  return result;
}
