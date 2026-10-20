import {
  parseDocument,
  stringify,
  isMap,
  isSeq,
  isScalar,
  isNode,
  type YAMLMap,
  type Document,
  type Pair,
} from "yaml";
import {
  FEO_MAX_LOCALES,
  FEO_MAX_LOCALE_KEYS,
  assertFeoLocaleId,
  exceedsFeoMessageLength,
  suggestFeoLocale,
} from "./feo-locale.js";

type Descriptor = { defaultMessage: string; description: string };
export type FeoCatalog = Record<string, Descriptor>;

const maxLocaleKeyLength = 256;

type KeyOwner = { item: object; description: string };
type FrontendKeyRegistry = {
  catalog: Map<string, KeyOwner>;
  runtime: Map<string, KeyOwner>;
};

/** Code-unit order: localeCompare follows the process locale, so output would differ by machine. */
function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(value)) {
    throw new Error(
      `${label}.${name} has an unsafe identifier: ${value} ` +
        `(expected one or more dot-separated segments, each matching /^[A-Za-z0-9][A-Za-z0-9_-]*$/)`,
    );
  }
  return value;
}

function aliasSlug(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function frontendSpecs(doc: Document): {
  specs: YAMLMap[];
  prefixes: string[];
  labels: string[];
} {
  const root = mapping(doc.contents, "Template");
  if (text(root.get("kind", true), "Template.kind") !== "Template")
    throw new Error("Expected an OpenShift Template");
  const objects = root.get("objects", true);
  if (!isSeq(objects)) throw new Error("Template.objects must be a sequence");
  const specs: YAMLMap[] = [];
  const frontends: YAMLMap[] = [];
  for (const object of objects.items) {
    if (isMap(object) && object.get("kind") === "Frontend") {
      frontends.push(object);
      specs.push(mapping(object.get("spec", true), "Frontend.spec"));
    }
  }
  if (frontends.length < 2)
    return { specs, prefixes: specs.map(() => ""), labels: specs.map(() => "Frontend") };
  const seen = new Set<string>();
  const names = frontends.map((object) => {
    const metadata = mapping(object.get("metadata", true), "Frontend.metadata");
    const name = text(metadata.get("name", true), "Frontend.metadata.name");
    if (seen.has(name)) throw new Error(`Duplicate Frontend.metadata.name: ${name}`);
    seen.add(name);
    return name;
  });
  return {
    specs,
    prefixes: names.map((name) => `objects.${name}.spec.`),
    labels: names.map((name) => `Frontend ${JSON.stringify(name)}`),
  };
}

function collect(doc: Document): {
  catalog: FeoCatalog;
  specs: YAMLMap[];
  owned: Set<string>[];
  prefixes: string[];
  labels: string[];
} {
  const { specs, prefixes, labels } = frontendSpecs(doc);
  const owned: Set<string>[] = [];
  if (!specs.length) throw new Error("Template has no Frontend objects");
  for (const spec of specs) {
    const locales = spec.get("locales", true);
    if (locales === undefined) continue;
    const localeMap = mapping(locales, "spec.locales");
    if (localeMap.flow && localeMap.items.length) {
      throw new Error(
        "spec.locales must use block-style YAML; non-empty flow-style mappings cannot be inlined",
      );
    }
  }
  const catalog: FeoCatalog = {};
  let frontendPrefix = "";
  let registry: FrontendKeyRegistry = { catalog: new Map(), runtime: new Map() };
  function duplicate(
    kind: "message" | "runtime",
    key: string,
    first: string,
    second: string,
  ): never {
    throw new Error(`Duplicate FEO ${kind} key: ${key}; first from ${first}; also from ${second}`);
  }
  function register(
    keys: Map<string, KeyOwner>,
    key: string,
    item: object,
    description: string,
    kind: "message" | "runtime",
  ): void {
    const previous = keys.get(key);
    if (previous && previous.item !== item) duplicate(kind, key, previous.description, description);
    if (!previous) keys.set(key, { item, description });
  }
  function registerCatalogPath(key: string, item: object, description: string): void {
    register(registry.catalog, key, item, description, "message");
  }
  function registerPotentialMessage(
    key: string,
    runtimeKey: string,
    item: object,
    description: string,
  ): void {
    registerCatalogPath(`${frontendPrefix}${key}`, item, description);
    register(registry.runtime, runtimeKey, item, description, "runtime");
  }
  function validateLocaleKey(key: string): void {
    if (key.length > maxLocaleKeyLength) {
      throw new Error(
        `FEO spec.locales key exceeds the ${maxLocaleKeyLength}-character limit: ${key}`,
      );
    }
  }
  function add(
    catalogBase: string,
    runtimeBase: string,
    node: YAMLMap,
    field: string,
    sourceContext: string,
    item: object,
  ): void {
    const entry = `${frontendPrefix}${catalogBase}`;
    if (field === "alt_title") {
      const value = node.get(field, true);
      if (value === undefined || (isScalar(value) && value.value === "")) return;
      if (!isSeq(value))
        throw new Error(`${catalogBase}.alt_title: alt_title must contain strings`);
      const aliases = value.items.map((item) => {
        if (!isScalar(item) || typeof item.value !== "string")
          throw new Error(`${catalogBase}.alt_title: alt_title must contain strings`);
        return item.value;
      });
      const slugs = new Map<string, string[]>();
      for (const alias of aliases) {
        const slug = aliasSlug(alias);
        if (!slug) {
          throw new Error(
            `${entry}: alt_title alias ${JSON.stringify(alias)} has an empty slug (must contain an ASCII letter or digit)`,
          );
        }
        const sameSlug = slugs.get(slug);
        if (sameSlug) sameSlug.push(alias);
        else slugs.set(slug, [alias]);
      }
      for (const [slug, sameSlug] of slugs) {
        const aliasKey = `${catalogBase}.alt_title.${slug}`;
        const runtimeKey = `${runtimeBase}.alt_title.${slug}`;
        const description = `${sourceContext} alt_title aliases ${JSON.stringify(sameSlug)}`;
        validateLocaleKey(aliasKey);
        registerPotentialMessage(aliasKey, runtimeKey, item, description);
        const firstAlias = sameSlug[0]!;
        const sharedAliases = sameSlug.slice(1);
        const sharedDescription = sharedAliases.length
          ? `; also shared by aliases ${sharedAliases.map((alias) => JSON.stringify(alias)).join(", ")}`
          : "";
        catalog[`${frontendPrefix}${aliasKey}`] = {
          defaultMessage: firstAlias,
          description:
            `search alias (keyword/synonym) of ${entry}; short search term, not a sentence` +
            sharedDescription,
        };
      }
      return;
    }
    const key = `${catalogBase}.${field}`;
    registerPotentialMessage(key, `${runtimeBase}.${field}`, item, `${sourceContext}.${field}`);
    const value = node.get(field, true);
    if (value === undefined || (isScalar(value) && value.value === "")) return;
    if (!isScalar(value) || typeof value.value !== "string")
      throw new Error(`${key} must be a string`);
    const message = value.value;
    if (!message.trim()) return;
    validateLocaleKey(key);
    catalog[`${frontendPrefix}${key}`] = {
      defaultMessage: message,
      description: `${field} of ${entry}`,
    };
  }
  function entries(
    spec: YAMLMap,
    list: string,
    fields: string[],
    identify: (
      item: YAMLMap,
      index: number,
    ) => { catalogBase: string; runtimeBase: string; sourceContext: string },
  ): void {
    const items = spec.get(list, true);
    if (items === undefined) return;
    if (!isSeq(items)) throw new Error(`${list} must be a sequence`);
    for (const [index, raw] of items.items.entries()) {
      const item = mapping(raw, list);
      const { catalogBase, runtimeBase, sourceContext } = identify(item, index);
      const owner = {};
      for (const field of fields) add(catalogBase, runtimeBase, item, field, sourceContext, owner);
    }
  }
  function nav(
    items: unknown,
    catalogPrefix: string,
    runtimePrefix: string,
    sourcePrefix: string,
  ): void {
    if (!isSeq(items)) throw new Error(`${catalogPrefix}.navItems/routes must be a sequence`);
    for (const [index, raw] of items.items.entries()) {
      const item = mapping(raw, catalogPrefix);
      if (item.has("segmentRef")) continue;
      const id = identifier(item, "id", catalogPrefix);
      const key = `${catalogPrefix}.${id}`;
      const runtimeKey = `${runtimePrefix}.${id}`;
      const source = `${sourcePrefix}[${index}] (id=${JSON.stringify(id)})`;
      const owner = {};
      for (const field of ["title", "product"]) add(key, runtimeKey, item, field, source, owner);
      const routes = item.get("routes", true);
      if (routes !== undefined)
        nav(routes, `${key}.routes`, `${runtimeKey}.routes`, `${source}.routes`);
    }
  }
  for (const [index, spec] of specs.entries()) {
    frontendPrefix = prefixes[index]!;
    registry = { catalog: new Map(), runtime: new Map() };
    const before = new Set(Object.keys(catalog));
    entries(spec, "searchEntries", ["title", "description", "alt_title"], (item, index) => {
      const id = identifier(item, "id", "searchEntries");
      return {
        catalogBase: `searchEntries.${id}`,
        runtimeBase: `search.${id}`,
        sourceContext: `${frontendPrefix}searchEntries[${index}] (id=${JSON.stringify(id)})`,
      };
    });
    entries(spec, "serviceTiles", ["title", "description"], (item, index) => {
      const section = identifier(item, "section", "serviceTiles");
      const group = identifier(item, "group", "serviceTiles");
      const id = identifier(item, "id", "serviceTiles");
      return {
        catalogBase: `serviceTiles.${section}.${group}.${id}`,
        runtimeBase: `tile.${section}.${group}.${id}`,
        sourceContext:
          `${frontendPrefix}serviceTiles[${index}] ` +
          `(section=${JSON.stringify(section)}, group=${JSON.stringify(group)}, id=${JSON.stringify(id)})`,
      };
    });
    const segments = spec.get("bundleSegments", true);
    if (segments !== undefined) {
      if (!isSeq(segments)) throw new Error("bundleSegments must be a sequence");
      for (const [index, raw] of segments.items.entries()) {
        const item = mapping(raw, "bundleSegments");
        const bundleId = identifier(item, "bundleId", "bundleSegments");
        const segmentId = identifier(item, "segmentId", "bundleSegments");
        const key = `bundleSegments.${bundleId}.${segmentId}.navItems`;
        const runtimeKey = `nav.${bundleId}.${segmentId}`;
        const source =
          `${frontendPrefix}bundleSegments[${index}] ` +
          `(bundleId=${JSON.stringify(bundleId)}, segmentId=${JSON.stringify(segmentId)})`;
        registerCatalogPath(`${frontendPrefix}${key}`, {}, source);
        const navItems = item.get("navItems", true);
        if (navItems !== undefined) nav(navItems, key, runtimeKey, `${source}.navItems`);
      }
    }
    const module = spec.get("module", true);
    if (module !== undefined)
      add(
        "module",
        "module",
        mapping(module, "module"),
        "defaultDocumentTitle",
        `${frontendPrefix}module`,
        {},
      );
    owned.push(new Set(Object.keys(catalog).filter((key) => !before.has(key))));
  }
  return {
    owned,
    catalog: Object.fromEntries(Object.entries(catalog).sort(byKey)),
    specs,
    prefixes,
    labels,
  };
}

export function extractFeoCatalog(template: string): FeoCatalog {
  return collect(parse(template)).catalog;
}

export function serializeFeoCatalog(catalog: FeoCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** Locale tags that have a spec.locales block in any Frontend object. */
export function feoTemplateLocales(template: string): string[] {
  const locales = new Set<string>();
  for (const spec of frontendSpecs(parse(template)).specs) {
    const value = spec.get("locales", true);
    if (value === undefined) continue;
    for (const item of mapping(value, "spec.locales").items) {
      if (isScalar(item.key)) locales.add(String(item.key.value));
    }
  }
  return [...locales].sort();
}

export function formatFeoCatalog(template: string): string {
  return serializeFeoCatalog(extractFeoCatalog(template));
}

function parse(template: string): Document {
  const doc = parseDocument(template, { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`Invalid Frontend template: ${doc.errors[0]!.message}`);
  return doc;
}

/**
 * Only updates spec.locales[locale]; English and other locale entries remain untouched. A block
 * under a non-canonical spelling of `locale` (such as `zh-cn` for `zh-CN`) is renamed. Translations
 * over the CRD length limit are omitted like missing ones, so they fall back to English; report them
 * with `overlongFeoTranslationsWarning`.
 */
export function inlineFeoLocale(
  template: string,
  source: FeoCatalog,
  target: Record<string, string>,
  locale: string,
): string {
  assertFeoLocaleId(locale, "Target locale");
  const doc = parse(template);
  const { catalog, specs, owned, prefixes, labels } = collect(doc);
  for (const key of new Set([...Object.keys(source), ...Object.keys(catalog)])) {
    if (source[key]?.defaultMessage !== catalog[key]?.defaultMessage) {
      throw new Error(`English source changed for ${key}; regenerate and resubmit catalog`);
    }
  }
  for (const [key, value] of Object.entries(target)) {
    if (!Object.hasOwn(catalog, key)) {
      const hint = key.endsWith(".alt_title") ? "; alt_title uses one message per slug" : "";
      throw new Error(`Unknown translation key: ${key}${hint}`);
    }
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid translation: ${key}`);
  }
  const sorted = Object.fromEntries(
    Object.entries(target)
      .filter(([, value]) => !exceedsFeoMessageLength(value))
      .sort(byKey),
  );
  const changes: { start: number; end: number; text: string }[] = [];
  for (const [index, spec] of specs.entries()) {
    const ownTarget = Object.fromEntries(
      Object.entries(sorted)
        .filter(([key]) => owned[index]!.has(key))
        .map(([key, value]) => [key.slice(prefixes[index]!.length), value]),
    );
    if (Object.keys(ownTarget).length > FEO_MAX_LOCALE_KEYS) {
      throw new Error(
        `${labels[index]} spec.locales.${locale} has ${Object.keys(ownTarget).length} keys, ` +
          `exceeding the ${FEO_MAX_LOCALE_KEYS}-key limit per locale`,
      );
    }
    const locales = spec.get("locales", true);
    const existing = locales === undefined ? undefined : mapping(locales, "spec.locales");
    const localesKey = spec.items.find(
      (item) => isScalar(item.key) && item.key.value === "locales",
    )?.key;
    const localesKeyRange = isScalar(localesKey) ? localesKey.range : undefined;
    const keyOf = (item: { key: unknown }) =>
      isScalar(item.key) ? String(item.key.value) : undefined;
    const matchingPairs =
      existing?.items.filter((item) => {
        const key = keyOf(item);
        return key === locale || (key !== undefined && suggestFeoLocale(key) === locale);
      }) ?? [];
    const pair = matchingPairs.find((item) => keyOf(item) === locale) ?? matchingPairs[0];
    if (!Object.keys(ownTarget).length && !pair) continue;
    if (!pair && (existing?.items.length ?? 0) >= FEO_MAX_LOCALES) {
      throw new Error(
        `${labels[index]} already has ${existing!.items.length} spec.locales blocks; adding ` +
          `"${locale}" would exceed the ${FEO_MAX_LOCALES}-locale limit per Frontend`,
      );
    }
    const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
    const indentAt = (offset: number) => offset - template.lastIndexOf("\n", offset - 1) - 1;
    const blockRange = (entry: Pair) => {
      if (!isScalar(entry.key) || !entry.key.range) return undefined;
      const range = entry.key.range;
      const valueRange = isNode(entry.value) ? entry.value.range : undefined;
      const lineEnd = template.indexOf("\n", range[1]);
      const end =
        valueRange?.[2] ?? valueRange?.[1] ?? (lineEnd < 0 ? template.length : lineEnd + 1);
      // A trailing comment's range can include the following line's indentation. Never splice it.
      const lineStart = template.lastIndexOf("\n", end - 1) + 1;
      return {
        start: range[0] - indentAt(range[0]),
        end: template.slice(lineStart, end).trim() ? end : lineStart,
      };
    };
    // The target catalog is authoritative for this locale, including any legacy spellings.
    for (const duplicate of matchingPairs) {
      if (duplicate === pair) continue;
      const range = blockRange(duplicate);
      if (range) changes.push({ ...range, text: "" });
    }
    const emptyFlow = existing?.flow === true && existing.items.length === 0;
    const indent = keyRange
      ? indentAt(keyRange[0])
      : emptyFlow && localesKeyRange
        ? indentAt(localesKeyRange[0]) + 2
        : existing?.range
          ? indentAt(existing.range[0])
          : spec.items[0]?.key && isScalar(spec.items[0].key) && spec.items[0].key.range
            ? indentAt(spec.items[0].key.range[0])
            : 6;
    // Keep comments on translated keys while replacing only this locale's mapping.
    const localeMap = pair && isMap(pair.value) ? pair.value : undefined;
    if (localeMap) {
      for (const item of [...localeMap.items]) {
        const key =
          isScalar(item.key) && typeof item.key.value === "string" ? item.key.value : null;
        if (key === null || !Object.hasOwn(ownTarget, key)) {
          localeMap.items.splice(localeMap.items.indexOf(item), 1);
        } else if (isScalar(item.value) && typeof item.value.value === "string") {
          item.value.value = ownTarget[key]!;
        } else {
          localeMap.set(key, ownTarget[key]!);
        }
      }
      for (const [key, value] of Object.entries(ownTarget)) {
        if (!localeMap.has(key)) localeMap.set(key, value);
      }
    }
    // yaml attaches an inline comment after `fr:` to the following mapping.
    let headerComment: string | undefined;
    if (keyRange && localeMap?.commentBefore) {
      const lineEnd = template.indexOf("\n", keyRange[1]);
      const suffix = template.slice(keyRange[1], lineEnd < 0 ? template.length : lineEnd);
      const comment = suffix.match(/^:\s*(#.*)$/)?.[1];
      const [first, ...rest] = localeMap.commentBefore.split("\n");
      if (comment && first?.trim() === comment.slice(1).trim()) {
        headerComment = comment;
        localeMap.commentBefore = rest.join("\n") || undefined;
      }
    }
    // YAML nodes carry source ranges: splice only this locale's mapping, never reprint the Template.
    const content = existing
      ? { [locale]: localeMap ?? ownTarget }
      : { locales: { [locale]: ownTarget } };
    const block = stringify(content, { lineWidth: 0 })
      .split("\n")
      .filter(Boolean)
      .map(
        (line, index) =>
          `${" ".repeat(indent)}${line}${index === 0 && headerComment ? ` ${headerComment}` : ""}\n`,
      )
      .join("");
    const replacementRange = pair && blockRange(pair);
    if (replacementRange) {
      changes.push({ ...replacementRange, text: block });
    } else if (emptyFlow && existing?.range) {
      let start = existing.range[0];
      const lineStart = template.lastIndexOf("\n", start - 1) + 1;
      while (start > lineStart && template[start - 1] === " ") start -= 1;
      const commentLines = existing.comment?.split("\n").map((line) => line.trim());
      const comment = commentLines?.some(Boolean)
        ? commentLines
            .map(
              (line, index) => `${index === 0 ? "" : " ".repeat(indent)}#${line ? ` ${line}` : ""}`,
            )
            .join("\n")
        : "";
      changes.push({
        start,
        end: existing.range[2] ?? existing.range[1],
        text: `${comment ? ` ${comment}` : ""}\n${block}`,
      });
    } else if (existing?.range) {
      const offset = existing.range[1];
      changes.push({
        start: offset,
        end: offset,
        text: `${offset && template[offset - 1] !== "\n" ? "\n" : ""}${block}`,
      });
    } else if (spec.range) {
      const offset = spec.range[1];
      changes.push({
        start: offset,
        end: offset,
        text: `${offset && template[offset - 1] !== "\n" ? "\n" : ""}${block}`,
      });
    }
  }
  let result = template;
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  parse(result);
  return result;
}
