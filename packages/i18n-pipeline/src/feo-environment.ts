import { isMap, isScalar, isSeq, parseAllDocuments, type Document, type YAMLMap } from "yaml";
import {
  FEO_LOCALE_KEY_PATTERN,
  FEO_MAX_ENABLED_LOCALES,
  FEO_MAX_LOCALE_KEY_LENGTH,
  FEO_MAX_LOCALE_KEYS,
  FEO_MAX_LOCALES,
  FEO_MAX_MESSAGE_LENGTH,
  FEO_MAX_ENABLED_LOCALE_NAME_LENGTH,
  FEO_MIN_ENABLED_LOCALE_NAME_LENGTH,
  FEO_SOURCE_LOCALE,
  assertFeoLocaleId,
  exceedsFeoMessageLength,
  isCanonicalFeoLocaleId,
} from "./feo-locale.js";
import { feoIdentifier, spliceFeoLocaleUpdates, type FeoCatalog } from "./feo-template.js";

type Placeholder = { start: number; end: number };
type ParsedEnvironment = {
  document: Document;
  spec: YAMLMap;
  maskedTemplate: string;
  placeholders: Placeholder[];
};

export interface FeoEnvironmentTemplateInput {
  path: string;
  template: string;
}

function mapping(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) throw new Error(`${label} must be a YAML mapping`);
  return value;
}

function sequence(value: unknown, label: string) {
  if (!isSeq(value)) throw new Error(`${label} must be a YAML sequence`);
  return value;
}

function nodeRange(value: unknown): readonly number[] | undefined {
  if (typeof value !== "object" || value === null || !("range" in value)) return undefined;
  const range = value.range;
  return Array.isArray(range) && range.every((part) => typeof part === "number")
    ? range
    : undefined;
}

function containsPlaceholder(value: unknown, placeholders: readonly Placeholder[]): boolean {
  const range = nodeRange(value);
  if (!range) return false;
  // range[1] ends the value itself; range[2] would include a trailing comment.
  const end = range[1];
  return placeholders.some(
    (placeholder) => placeholder.start >= range[0]! && placeholder.end <= end!,
  );
}

function assertNoPlaceholder(
  value: unknown,
  placeholders: readonly Placeholder[],
  label: string,
): void {
  if (containsPlaceholder(value, placeholders)) {
    throw new Error(`Jinja placeholders are not supported in ${label}`);
  }
}

function maskJinja(template: string): { masked: string; placeholders: Placeholder[] } {
  if (template.includes("{%")) {
    throw new Error("FrontendEnvironment Jinja statements ({% ... %}) are not supported");
  }
  if (template.includes("{#")) {
    throw new Error("FrontendEnvironment Jinja comments ({# ... #}) are not supported");
  }
  const placeholders: Placeholder[] = [];
  const masked = template.replace(/\{\{[\s\S]*?\}\}/g, (match, offset: number) => {
    if (/[\r\n]/.test(match)) {
      throw new Error(
        `FrontendEnvironment Jinja placeholders must fit on one line: ${match.split(/\r?\n/)[0]}`,
      );
    }
    placeholders.push({ start: offset, end: offset + match.length });
    return match.replace(/[^\r\n]/g, "x");
  });
  return { masked, placeholders };
}

function kindName(root: YAMLMap): string {
  const kind = root.get("kind", true);
  return isScalar(kind) && typeof kind.value === "string" ? kind.value : "<missing or non-string>";
}

function parseEnvironment(template: string): ParsedEnvironment {
  const { masked, placeholders } = maskJinja(template);
  const documents = parseAllDocuments(masked, { uniqueKeys: true, keepSourceTokens: true });
  if (documents.length !== 1) {
    throw new Error(
      `FrontendEnvironment must be a single YAML document; found ${documents.length}`,
    );
  }
  const document = documents[0]!;
  if (document.errors.length) {
    throw new Error(`Invalid FrontendEnvironment YAML: ${document.errors[0]!.message}`);
  }
  const root = mapping(document.contents, "FrontendEnvironment document");
  const foundKind = kindName(root);
  if (foundKind !== "FrontendEnvironment") {
    throw new Error(`Expected kind FrontendEnvironment; found kind ${foundKind}`);
  }
  const spec = mapping(root.get("spec", true), "FrontendEnvironment.spec");
  if (spec.flow) {
    throw new Error("FrontendEnvironment.spec must use block-style YAML to be inlined");
  }
  assertNoPlaceholder(spec.get("locales", true), placeholders, "spec.locales");
  return { document, spec, maskedTemplate: masked, placeholders };
}

function assertNoTranslatablePlaceholders(
  item: YAMLMap,
  fields: readonly string[],
  placeholders: readonly Placeholder[],
  label: string,
): void {
  for (const field of fields) {
    assertNoPlaceholder(item.get(field, true), placeholders, `${label}.${field}`);
  }
}

function catalogKey(key: string): void {
  if (key.length > FEO_MAX_LOCALE_KEY_LENGTH) {
    throw new Error(
      `FEO spec.locales key exceeds the ${FEO_MAX_LOCALE_KEY_LENGTH}-character limit: ${key}`,
    );
  }
}

function collectEnvironmentCatalog(parsed: ParsedEnvironment): FeoCatalog {
  const { spec, placeholders } = parsed;
  const catalog: FeoCatalog = {};
  const owners = new Map<string, string>();
  const runtimeOwners = new Map<string, string>();

  // The operator maps each catalog key to a runtime key (controllers/locale_keys.go); two
  // catalog keys reaching one runtime key are ambiguous there and both translations are dropped.
  function register(key: string, runtimeKey: string, context: string): void {
    const first = owners.get(key);
    if (first) {
      throw new Error(
        `Duplicate FEO message key: ${key}; first from ${first}; also from ${context}`,
      );
    }
    owners.set(key, context);
    const firstRuntime = runtimeOwners.get(runtimeKey);
    if (firstRuntime) {
      throw new Error(
        `Duplicate FEO runtime key: ${runtimeKey}; first from ${firstRuntime}; also from ${context}`,
      );
    }
    runtimeOwners.set(runtimeKey, context);
  }

  function add(
    item: YAMLMap,
    key: string,
    runtimeKey: string,
    field: "title" | "description",
    itemContext: string,
    messageContext: string,
  ): void {
    register(key, runtimeKey, `${itemContext}.${field}`);
    const value = item.get(field, true);
    if (value === undefined || (isScalar(value) && value.value === "")) return;
    if (!isScalar(value) || typeof value.value !== "string") {
      throw new Error(`${key} must be a string`);
    }
    if (!value.value.trim()) return;
    catalogKey(key);
    catalog[key] = {
      defaultMessage: value.value,
      description: `${field} of ${messageContext}`,
    };
  }

  const bundlesValue = spec.get("bundles", true);
  if (bundlesValue !== undefined) {
    for (const [index, raw] of sequence(bundlesValue, "spec.bundles").items.entries()) {
      const item = mapping(raw, `spec.bundles[${index}]`);
      const itemContext = `bundles[${index}]`;
      assertNoTranslatablePlaceholders(
        item,
        ["id", "title", "description"],
        placeholders,
        itemContext,
      );
      const id = feoIdentifier(item, "id", "bundles");
      const context = `bundle ${id}`;
      add(
        item,
        `bundles.${id}.title`,
        `bundle.${id}.title`,
        "title",
        `${itemContext} (id=${JSON.stringify(id)})`,
        context,
      );
      add(
        item,
        `bundles.${id}.description`,
        `bundle.${id}.description`,
        "description",
        `${itemContext} (id=${JSON.stringify(id)})`,
        context,
      );
    }
  }

  const categoriesValue = spec.get("serviceCategories", true);
  if (categoriesValue !== undefined) {
    for (const [index, raw] of sequence(
      categoriesValue,
      "spec.serviceCategories",
    ).items.entries()) {
      const category = mapping(raw, `spec.serviceCategories[${index}]`);
      const categoryContext = `serviceCategories[${index}]`;
      assertNoTranslatablePlaceholders(category, ["id", "title"], placeholders, categoryContext);
      const categoryId = feoIdentifier(category, "id", "serviceCategories");
      add(
        category,
        `serviceCategories.${categoryId}.title`,
        `serviceCategory.${categoryId}.title`,
        "title",
        `${categoryContext} (id=${JSON.stringify(categoryId)})`,
        `service category ${categoryId}`,
      );

      const groupsValue = category.get("groups", true);
      if (groupsValue === undefined) continue;
      for (const [groupIndex, groupRaw] of sequence(
        groupsValue,
        `spec.serviceCategories[${index}].groups`,
      ).items.entries()) {
        const group = mapping(groupRaw, `spec.serviceCategories[${index}].groups[${groupIndex}]`);
        const groupContext = `${categoryContext}.groups[${groupIndex}]`;
        assertNoTranslatablePlaceholders(group, ["id", "title"], placeholders, groupContext);
        const groupId = feoIdentifier(group, "id", "serviceCategories.groups");
        add(
          group,
          `serviceCategories.${categoryId}.groups.${groupId}.title`,
          `serviceCategory.${categoryId}.group.${groupId}.title`,
          "title",
          `${groupContext} (id=${JSON.stringify(groupId)} in category ${JSON.stringify(categoryId)})`,
          `group ${groupId} in service category ${categoryId}`,
        );
      }
    }
  }

  return Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Extracts one FrontendEnvironment CR into a FormatJS-style source catalog. */
export function extractFeoEnvironmentCatalog(template: string): FeoCatalog {
  const parsed = parseEnvironment(template);
  return collectEnvironmentCatalog(parsed);
}

/** Extracts the union of several FrontendEnvironment CRs into one English catalog. */
export function extractFeoEnvironmentCatalogs(
  templates: readonly FeoEnvironmentTemplateInput[],
): FeoCatalog {
  if (!templates.length)
    throw new Error("FrontendEnvironment extraction requires at least one template");
  const catalog: FeoCatalog = {};
  const sources = new Map<string, { path: string; defaultMessage: string }>();
  for (const { path, template } of templates) {
    for (const [key, message] of Object.entries(extractFeoEnvironmentCatalog(template))) {
      const first = sources.get(key);
      if (first && first.defaultMessage !== message.defaultMessage) {
        throw new Error(`Conflicting English text for ${key} in ${first.path} and ${path}`);
      }
      if (!first) {
        sources.set(key, { path, defaultMessage: message.defaultMessage });
        catalog[key] = message;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function stringValue(value: unknown, label: string): string {
  if (!isScalar(value) || typeof value.value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.value;
}

function validateLocaleCatalogs(spec: YAMLMap): void {
  const rawLocales = spec.get("locales", true);
  if (rawLocales === undefined) return;
  const locales = mapping(rawLocales, "spec.locales");
  if (locales.items.length > FEO_MAX_LOCALES) {
    throw new Error(
      `spec.locales has ${locales.items.length} locales, exceeding the ${FEO_MAX_LOCALES}-locale limit`,
    );
  }
  for (const pair of locales.items) {
    const locale = stringValue(pair.key, "spec.locales locale id");
    assertFeoLocaleId(locale, "spec.locales locale");
    const messages = mapping(pair.value, `spec.locales.${locale}`);
    if (messages.items.length > FEO_MAX_LOCALE_KEYS) {
      throw new Error(
        `spec.locales.${locale} has ${messages.items.length} keys, exceeding the ` +
          `${FEO_MAX_LOCALE_KEYS}-key limit per locale`,
      );
    }
    for (const message of messages.items) {
      const key = stringValue(message.key, `spec.locales.${locale} message key`);
      const field = `spec.locales.${locale}.${key}`;
      if (key.length > FEO_MAX_LOCALE_KEY_LENGTH) {
        throw new Error(`${field} exceeds the ${FEO_MAX_LOCALE_KEY_LENGTH}-character key limit`);
      }
      if (!FEO_LOCALE_KEY_PATTERN.test(key)) {
        throw new Error(`${field} has an invalid message key`);
      }
      const value = stringValue(message.value, field);
      if (exceedsFeoMessageLength(value)) {
        throw new Error(`${field} exceeds the ${FEO_MAX_MESSAGE_LENGTH}-character message limit`);
      }
    }
  }
}

function validateEnabledLocales(spec: YAMLMap): void {
  const rawLocales = spec.get("enabledLocales", true);
  if (rawLocales === undefined) return;
  const locales = sequence(rawLocales, "spec.enabledLocales");
  if (locales.items.length > FEO_MAX_ENABLED_LOCALES) {
    throw new Error(
      `spec.enabledLocales has ${locales.items.length} items, exceeding the ` +
        `${FEO_MAX_ENABLED_LOCALES}-item limit`,
    );
  }
  let hasEnglish = false;
  let defaultCount = 0;
  const ids = new Set<string>();
  for (const [index, raw] of locales.items.entries()) {
    const locale = mapping(raw, `spec.enabledLocales[${index}]`);
    const id = stringValue(locale.get("id", true), `spec.enabledLocales[${index}].id`);
    if (!isCanonicalFeoLocaleId(id)) {
      throw new Error(`spec.enabledLocales[${index}].id has an invalid canonical locale id`);
    }
    // The CRD declares enabledLocales a list map keyed by id.
    if (ids.has(id)) throw new Error(`spec.enabledLocales lists id ${id} more than once`);
    ids.add(id);
    if (id === FEO_SOURCE_LOCALE) hasEnglish = true;
    const name = stringValue(locale.get("name", true), `spec.enabledLocales[${index}].name`);
    const nameLength = [...name].length;
    if (nameLength < FEO_MIN_ENABLED_LOCALE_NAME_LENGTH) {
      throw new Error(
        `spec.enabledLocales[${index}].name must have at least ` +
          `${FEO_MIN_ENABLED_LOCALE_NAME_LENGTH} character`,
      );
    }
    if (nameLength > FEO_MAX_ENABLED_LOCALE_NAME_LENGTH) {
      throw new Error(
        `spec.enabledLocales[${index}].name exceeds the ` +
          `${FEO_MAX_ENABLED_LOCALE_NAME_LENGTH}-character limit`,
      );
    }
    const defaultValue = locale.get("default", true);
    if (defaultValue !== undefined) {
      if (!isScalar(defaultValue) || typeof defaultValue.value !== "boolean") {
        throw new Error(`spec.enabledLocales[${index}].default must be a boolean`);
      }
      if (defaultValue.value) defaultCount += 1;
    }
  }
  if (!hasEnglish) throw new Error("spec.enabledLocales must include id en");
  if (defaultCount !== 1) {
    throw new Error(
      `spec.enabledLocales must have exactly one item with default: true (found ${defaultCount})`,
    );
  }
}

function validateEnvironment(parsed: ParsedEnvironment): void {
  validateLocaleCatalogs(parsed.spec);
  validateEnabledLocales(parsed.spec);
}

/**
 * Updates only spec.locales[locale], preserving Jinja placeholders outside that field. Translations
 * over the CRD length limit are omitted, as for Frontend inline; report them with
 * `overlongFeoTranslationsWarning`.
 */
export function inlineFeoEnvironmentLocale(
  template: string,
  source: FeoCatalog,
  target: Record<string, string>,
  locale: string,
): string {
  assertFeoLocaleId(locale, "Target locale");
  const parsed = parseEnvironment(template);
  const catalog = collectEnvironmentCatalog(parsed);
  for (const [key, message] of Object.entries(catalog)) {
    if (source[key]?.defaultMessage !== message.defaultMessage) {
      throw new Error(`English source changed for ${key}; regenerate and resubmit catalog`);
    }
  }
  const ownTarget: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) {
    if (!Object.hasOwn(catalog, key)) {
      if (Object.hasOwn(source, key)) continue;
      throw new Error(`Unknown translation key: ${key}`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid translation: ${key}`);
    }
    // Like Frontend inline: an overlong translation is omitted and falls back to English.
    if (exceedsFeoMessageLength(value)) continue;
    ownTarget[key] = value;
  }

  const spliced = spliceFeoLocaleUpdates(
    parsed.maskedTemplate,
    [{ spec: parsed.spec, locale, target: ownTarget, label: "FrontendEnvironment" }],
    template,
  );
  const result = parseEnvironment(spliced);
  const before = parsed.placeholders.map(({ start, end }) => template.slice(start, end));
  const after = result.placeholders.map(({ start, end }) => spliced.slice(start, end));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("FrontendEnvironment inlining changed a Jinja placeholder");
  }
  validateEnvironment(result);
  return spliced;
}
