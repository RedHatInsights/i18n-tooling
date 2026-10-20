/**
 * FEO locale ids are the keys of a Frontend's `spec.locales`, the `feo.locales` keys of the catalog
 * validation config, the `repositoryLocale` of a FEO Phrase config, and the `--locale` of
 * `feo inline`. They must match the Frontend operator's CRD rule.
 *
 * Source of truth: `api/v1alpha1/locale_types.go` in RedHatInsights/frontend-operator
 * (`LocaleCatalogs`, `LocaleMessages` and `LocaleMessage`), added by the operator's localization
 * API work (RHCLOUD-52083). Keep the pattern and the limits below, and the equivalent patterns and
 * limits in `schemas/*.schema.json`, in sync with it.
 */

/** Canonical BCP 47 limited to language, optional script and optional region. */
export const FEO_LOCALE_PATTERN_SOURCE = "^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$";
export const FEO_LOCALE_PATTERN = new RegExp(FEO_LOCALE_PATTERN_SOURCE);

/** Message keys accepted by the Frontend operator's locale catalog CRD. */
export const FEO_LOCALE_KEY_PATTERN_SOURCE =
  "^[A-Za-z0-9][A-Za-z0-9_-]*([.][A-Za-z0-9][A-Za-z0-9_-]*)*$";
export const FEO_LOCALE_KEY_PATTERN = new RegExp(FEO_LOCALE_KEY_PATTERN_SOURCE);

/** English is the source language and is never a translation target. */
export const FEO_SOURCE_LOCALE = "en";

/** `LocaleCatalogs` MaxProperties: locales per Frontend `spec.locales`. */
export const FEO_MAX_LOCALES = 32;
/** `LocaleMessages` MaxProperties: message keys per locale. */
export const FEO_MAX_LOCALE_KEYS = 2048;
/** `LocaleMessage` MaxLength: characters (Unicode code points) per message. */
export const FEO_MAX_MESSAGE_LENGTH = 4096;
/** `LocaleMessage` key limit in the Frontend operator CRD. */
export const FEO_MAX_LOCALE_KEY_LENGTH = 256;

/**
 * `spec.enabledLocales` limits from the FrontendEnvironment CRD.
 * Source of truth: frontend-operator `api/v1alpha1` (PR #712). Keep these limits in sync with it.
 */
export const FEO_MAX_ENABLED_LOCALES = 32;
export const FEO_MIN_ENABLED_LOCALE_NAME_LENGTH = 1;
export const FEO_MAX_ENABLED_LOCALE_NAME_LENGTH = 64;

function canonicalLocale(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

/**
 * Whether a locale id is canonical, as `spec.enabledLocales` needs; unlike `isFeoLocaleId`, this
 * includes English. Stricter than the CRD pattern in one way: deprecated aliases such as `iw` or `in` match it, but
 * locale resolution canonicalizes them (`he`, `id`), so a block under the alias would never be read.
 */
export function isCanonicalFeoLocaleId(locale: string): boolean {
  return FEO_LOCALE_PATTERN.test(locale) && canonicalLocale(locale) === locale;
}

/** A canonical translation locale id: English is the source language. */
export function isFeoLocaleId(locale: string): boolean {
  return isCanonicalFeoLocaleId(locale) && locale !== FEO_SOURCE_LOCALE;
}

/** The canonical spelling of a malformed locale id, when there is exactly one valid candidate. */
export function suggestFeoLocale(locale: string): string | undefined {
  const canonical = canonicalLocale(locale);
  return canonical !== undefined && canonical !== locale && isFeoLocaleId(canonical)
    ? canonical
    : undefined;
}

/** Throws when `locale` is not a FEO locale id, suggesting the canonical spelling if there is one. */
export function assertFeoLocaleId(locale: string, label: string): void {
  if (isFeoLocaleId(locale)) return;
  const suggestion = suggestFeoLocale(locale);
  throw new TypeError(
    `${label} ${JSON.stringify(locale)} is not a canonical FEO locale id` +
      (suggestion === undefined
        ? '; use canonical BCP 47 such as "fr", "zh-CN" or "zh-Hant-TW", other than "en" (the source language)'
        : `; use "${suggestion}"`),
  );
}

/** Whether a message is longer than the CRD allows; MaxLength counts Unicode code points. */
export function exceedsFeoMessageLength(value: string): boolean {
  // At most one code point per UTF-16 unit, so only longer strings need counting.
  return value.length > FEO_MAX_MESSAGE_LENGTH && [...value].length > FEO_MAX_MESSAGE_LENGTH;
}

/** Warns about translations over the CRD limit, which `feo inline` omits for English fallback. */
export function overlongFeoTranslationsWarning(
  locale: string,
  target: Record<string, unknown>,
): string | undefined {
  const keys = Object.entries(target)
    .filter(([, value]) => typeof value === "string" && exceedsFeoMessageLength(value))
    .map(([key]) => key)
    .sort();
  return keys.length
    ? `FEO locale "${locale}" has translations over the ${FEO_MAX_MESSAGE_LENGTH}-character ` +
        `limit, omitted from spec.locales so they fall back to English: ${keys.join(", ")}`
    : undefined;
}
