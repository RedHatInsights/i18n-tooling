import {
  parse as parseIcuMessage,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import type { ArgumentMismatch } from "./catalog-check.js";
import type { Catalog } from "./index.js";

const CLDR_PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many"]);
const COUNT_ARGUMENT_NAME = /^(?:count|total|num|number|amount|size|length|n)$|(?:Count|Total)$/;
/**
 * Korean particles whose form depends on whether the preceding word ends in a consonant
 * (이/가, 은/는, 을/를, 과/와, 으로/로). A bare particle must not follow a runtime value.
 */
const KOREAN_VARIABLE_PARTICLE = /^(?:으로|이|가|은|는|을|를|과|와|로)(?=$|[\s.,!?…:;)」』"'])/u;
/** A regular space before French high punctuation or inside guillemets. */
const FRENCH_BREAKING_SPACE = / (?=[:;!?»])|« /;

export type IcuLintRule =
  | "plural-category-only-arguments"
  | "unused-plural-category"
  | "unformatted-count-argument"
  | "missing-exact-plural-selector"
  | "plural-count-dropped"
  | "korean-particle-after-argument"
  | "french-punctuation-space";

export type IcuLintSeverity = "error" | "warning";

export interface IcuLintFinding {
  id: string;
  rule: IcuLintRule;
  severity: IcuLintSeverity;
  message: string;
}

type PluralElement = Extract<MessageFormatElement, { type: TYPE.plural }>;

/** An argument a plural renders only under a CLDR category branch, never under `other`. */
interface CategoryOnlyArguments {
  pluralArgument: string;
  category: string;
  arguments: string[];
}

function parse(pattern: string): MessageFormatElement[] | undefined {
  try {
    return parseIcuMessage(pattern);
  } catch {
    // Syntax errors are reported by adapter validation.
    return undefined;
  }
}

function localeTag(locale: string): string {
  return locale.replaceAll("_", "-");
}

function language(locale: string): string {
  return localeTag(locale).split("-")[0]!.toLowerCase();
}

/** CLDR categories the locale selects, or undefined when Intl does not support the locale. */
function localePluralCategories(
  locale: string,
  type: "cardinal" | "ordinal",
): Set<string> | undefined {
  try {
    const options = new Intl.PluralRules(localeTag(locale), { type }).resolvedOptions();
    // Intl silently falls back to the runtime default for unknown locales.
    if (language(locale) !== language(options.locale)) return undefined;
    return new Set(options.pluralCategories);
  } catch {
    return undefined;
  }
}

/** Visits every element, descending into plural/select options and tag children. */
function walk(
  elements: MessageFormatElement[],
  visit: (element: MessageFormatElement, siblings: MessageFormatElement[], index: number) => void,
): void {
  elements.forEach((element, index) => {
    visit(element, elements, index);
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) walk(option.value, visit);
    }
    if (element.type === TYPE.tag) walk(element.children, visit);
  });
}

function plurals(elements: MessageFormatElement[]): PluralElement[] {
  const found: PluralElement[] = [];
  walk(elements, (element) => {
    if (element.type === TYPE.plural) found.push(element);
  });
  return found;
}

function argumentOccurrences(elements: MessageFormatElement[]): Map<string, number> {
  const counts = new Map<string, number>();
  walk(elements, (element) => {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.date:
      case TYPE.number:
      case TYPE.time:
      case TYPE.select:
      case TYPE.plural:
        counts.set(element.value, (counts.get(element.value) ?? 0) + 1);
    }
  });
  return counts;
}

function categoryOnlyArguments(elements: MessageFormatElement[]): CategoryOnlyArguments[] {
  const findings: CategoryOnlyArguments[] = [];
  const allOccurrences = argumentOccurrences(elements);
  for (const element of plurals(elements)) {
    const pluralOccurrences = argumentOccurrences([element]);
    const otherNames = argumentOccurrences(element.options.other?.value ?? []);
    for (const [category, option] of Object.entries(element.options)) {
      if (!CLDR_PLURAL_CATEGORIES.has(category)) continue;
      const names = [...argumentOccurrences(option.value).keys()]
        .filter(
          (name) =>
            name !== element.value &&
            !otherNames.has(name) &&
            allOccurrences.get(name) === pluralOccurrences.get(name),
        )
        .sort();
      if (names.length)
        findings.push({ pluralArgument: element.value, category, arguments: names });
    }
  }
  return findings;
}

/** True when the elements print the plural's count, via `#` or the argument itself. */
function rendersCount(
  elements: MessageFormatElement[],
  name: string,
  poundIsCount = true,
): boolean {
  return elements.some((element) => {
    switch (element.type) {
      case TYPE.pound:
        return poundIsCount;
      case TYPE.argument:
      case TYPE.number:
        return element.value === name;
      case TYPE.plural:
        return Object.values(element.options).some((option) =>
          rendersCount(option.value, name, element.value === name),
        );
      case TYPE.select:
        return Object.values(element.options).some((option) =>
          rendersCount(option.value, name, poundIsCount),
        );
      case TYPE.tag:
        return rendersCount(element.children, name, poundIsCount);
      default:
        return false;
    }
  });
}

/** True when the element's rendered text ends with a runtime value. */
function endsWithValue(element: MessageFormatElement): boolean {
  if (
    element.type === TYPE.argument ||
    element.type === TYPE.number ||
    element.type === TYPE.pound
  ) {
    return true;
  }
  if (element.type === TYPE.tag) {
    const last = element.children.at(-1);
    return last !== undefined && endsWithValue(last);
  }
  return false;
}

function exactSelectors(elements: MessageFormatElement[]): Map<string, Set<string>> {
  const selectors = new Map<string, Set<string>>();
  for (const element of plurals(elements)) {
    const keys = selectors.get(element.value) ?? new Set<string>();
    for (const key of Object.keys(element.options)) if (key.startsWith("=")) keys.add(key);
    selectors.set(element.value, keys);
  }
  return selectors;
}

function formatNames(names: string[]): string {
  return names.map((name) => `{${name}}`).join(", ");
}

function unusedCategoryFindings(
  id: string,
  elements: MessageFormatElement[],
  locale: string,
  role: "source" | "target",
): IcuLintFinding[] {
  const findings: IcuLintFinding[] = [];
  for (const element of plurals(elements)) {
    const categories = localePluralCategories(locale, element.pluralType ?? "cardinal");
    if (!categories) continue;
    for (const category of Object.keys(element.options)) {
      if (!CLDR_PLURAL_CATEGORIES.has(category) || categories.has(category)) continue;
      const advice =
        role === "source"
          ? `Use an exact "=N" branch for a specific count (for example "=0" instead of "zero").`
          : `Remove it; the translation may have copied the source structure.`;
      findings.push({
        id,
        rule: "unused-plural-category",
        severity: "warning",
        message:
          `"${id}": plural {${element.value}} has a "${category}" branch, but ${role} locale ` +
          `"${locale}" never selects "${category}", so the branch never renders. ${advice}`,
      });
    }
  }
  return findings;
}

/**
 * Source-message checks for plural semantics that per-locale ICU validation cannot see.
 *
 * Plural categories are locale grammar, not numbers: zh, ja, and ko select only `other`, so
 * translation tools drop a `one` branch; fr `one` also matches 0 and 1.5; ru `one` matches 21.
 * Content that depends on an exact count belongs in an `=N` branch.
 */
export function lintSourceMessage(id: string, pattern: string, locale: string): IcuLintFinding[] {
  const elements = parse(pattern);
  if (!elements) return [];
  const findings: IcuLintFinding[] = [];

  for (const finding of categoryOnlyArguments(elements)) {
    findings.push({
      id,
      rule: "plural-category-only-arguments",
      severity: "warning",
      message:
        `"${id}": ${formatNames(finding.arguments)} appears only in the "${finding.category}" ` +
        `branch of plural {${finding.pluralArgument}}. Plural categories are locale grammar, ` +
        `not numbers: locales without "${finding.category}" (such as zh, ja, ko) drop it, and ` +
        `others select it for different counts (fr "one" also matches 0). Use an exact "=N" ` +
        `branch for content that depends on a specific count, and keep "${finding.category}" ` +
        `grammatically equivalent to "other".`,
    });
  }

  findings.push(...unusedCategoryFindings(id, elements, locale, "source"));

  const pluralNames = new Set(plurals(elements).map((element) => element.value));
  const reported = new Set<string>();
  walk(elements, (element) => {
    if (element.type !== TYPE.argument || reported.has(element.value)) return;
    if (!pluralNames.has(element.value) && !COUNT_ARGUMENT_NAME.test(element.value)) return;
    reported.add(element.value);
    findings.push({
      id,
      rule: "unformatted-count-argument",
      severity: "warning",
      message:
        `"${id}": {${element.value}} prints a number as raw digits in every locale (fr expects ` +
        `"1 234 567"). Use {${element.value}, number}, or # inside its plural.`,
    });
  });

  return findings;
}

/** Runs {@link lintSourceMessage} over every message in a source catalog. */
export function lintSourceCatalog(catalog: Catalog): IcuLintFinding[] {
  return Object.entries(catalog.messages)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, message]) => lintSourceMessage(id, message.pattern, catalog.locale));
}

/**
 * Checks one translated message against its source and the target locale's grammar and
 * typography. Argument-name parity is checked separately by `checkCatalogs`.
 */
export function lintTargetMessage(
  id: string,
  sourcePattern: string,
  targetPattern: string,
  locale: string,
): IcuLintFinding[] {
  const source = parse(sourcePattern);
  const target = parse(targetPattern);
  if (!source || !target) return [];
  const findings: IcuLintFinding[] = [];

  const targetSelectors = exactSelectors(target);
  for (const [name, keys] of exactSelectors(source)) {
    const translated = targetSelectors.get(name);
    const missing = [...keys].filter((key) => !translated?.has(key)).sort();
    if (missing.length) {
      findings.push({
        id,
        rule: "missing-exact-plural-selector",
        severity: "error",
        message:
          `"${id}": plural {${name}} lost exact branch ${missing.join(", ")}. Exact branches ` +
          `carry content for a specific count and must exist in every translation.`,
      });
    }
  }

  const targetPlurals = plurals(target);
  const checkedCounts = new Set<string>();
  for (const element of plurals(source)) {
    if (checkedCounts.has(element.value)) continue;
    if (!rendersCount(element.options.other?.value ?? [], element.value)) continue;
    checkedCounts.add(element.value);
    const dropped = targetPlurals.some(
      (translated) =>
        translated.value === element.value &&
        !rendersCount(translated.options.other?.value ?? [], element.value),
    );
    if (dropped) {
      findings.push({
        id,
        rule: "plural-count-dropped",
        severity: "warning",
        message:
          `"${id}": the source "other" branch of plural {${element.value}} shows the count, ` +
          `but the translation's does not. Use # where the number belongs.`,
      });
    }
  }

  findings.push(...unusedCategoryFindings(id, target, locale, "target"));

  const tag = localeTag(locale);
  if (language(locale) === "ko") {
    walk(target, (element, siblings, index) => {
      const next = siblings[index + 1];
      if (!endsWithValue(element) || next?.type !== TYPE.literal) return;
      const particle = KOREAN_VARIABLE_PARTICLE.exec(next.value)?.[0];
      if (!particle) return;
      findings.push({
        id,
        rule: "korean-particle-after-argument",
        severity: "warning",
        message:
          `"${id}": particle "${particle}" follows a runtime value, but its form depends on ` +
          `whether that value ends in a consonant. Use a combined form such as "을(를)", ` +
          `"이(가)", "은(는)", "(으)로", or rephrase.`,
      });
    });
  }

  // Canadian French typography does not space before ; ! ?.
  if (language(locale) === "fr" && !/-CA$/i.test(tag)) {
    let reported = false;
    walk(target, (element) => {
      if (reported || element.type !== TYPE.literal) return;
      if (!FRENCH_BREAKING_SPACE.test(element.value)) return;
      reported = true;
      findings.push({
        id,
        rule: "french-punctuation-space",
        severity: "warning",
        message:
          `"${id}": a regular space precedes : ; ! ? or » (or follows «), so the line can break ` +
          `before the punctuation. Use a non-breaking space (U+00A0, or narrow U+202F).`,
      });
    });
  }

  return findings;
}

/** Runs {@link lintTargetMessage} over every message present in both catalogs. */
export function lintTargetCatalog(source: Catalog, target: Catalog): IcuLintFinding[] {
  return Object.keys(source.messages)
    .filter((id) => target.messages[id])
    .sort()
    .flatMap((id) =>
      lintTargetMessage(
        id,
        source.messages[id]!.pattern,
        target.messages[id]!.pattern,
        target.locale,
      ),
    );
}

/**
 * Explains a source/target argument mismatch caused by a source argument that only a CLDR
 * category branch renders. Returns undefined when the source does not explain the mismatch.
 */
export function argumentMismatchHint(
  sourcePattern: string,
  mismatch: ArgumentMismatch,
): string | undefined {
  const elements = parse(sourcePattern);
  if (!elements) return undefined;
  const missing = new Set(mismatch.source.filter((name) => !mismatch.target.includes(name)));
  const explained = categoryOnlyArguments(elements).filter((finding) =>
    finding.arguments.some((name) => missing.has(name)),
  );
  if (!explained.length) return undefined;
  return explained
    .map(
      (finding) =>
        `source renders ${formatNames(finding.arguments.filter((name) => missing.has(name)))} ` +
        `only in the "${finding.category}" branch of plural {${finding.pluralArgument}}, ` +
        `which can be dropped in locales without that category; use an exact "=N" ` +
        `source branch for count-specific content`,
    )
    .join("; ");
}

/** Formats one argument mismatch with both argument sets and, when known, the source cause. */
export function describeArgumentMismatch(
  sourcePattern: string,
  mismatch: ArgumentMismatch,
): string {
  const hint = argumentMismatchHint(sourcePattern, mismatch);
  return (
    `"${mismatch.id}": source [${mismatch.source.join(", ")}], ` +
    `target [${mismatch.target.join(", ")}]${hint ? ` (${hint})` : ""}`
  );
}
