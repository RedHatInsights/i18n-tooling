/**
 * FEO locale ids are the keys of a Frontend's `spec.locales`, the `feo.locales` keys of the catalog
 * validation config, the `repositoryLocale` of a FEO Phrase config, and the `--locale` of
 * `feo inline`. They must match the Frontend operator's CRD rule.
 *
 * Source of truth: `api/v1alpha1/locale_types.go` in RedHatInsights/frontend-operator
 * (`LocaleCatalogs`, `LocaleMessages` and `LocaleMessage`). Keep the pattern and the limits below,
 * and the equivalent patterns in `schemas/*.schema.json`, in sync with it.
 */

/** Canonical BCP 47 limited to language, optional script and optional region. */
export const FEO_LOCALE_PATTERN_SOURCE = "^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$";
export const FEO_LOCALE_PATTERN = new RegExp(FEO_LOCALE_PATTERN_SOURCE);

/** English is the source language and is never a translation target. */
export const FEO_SOURCE_LOCALE = "en";

/** `LocaleCatalogs` MaxProperties: locales per Frontend `spec.locales`. */
export const FEO_MAX_LOCALES = 32;
/** `LocaleMessages` MaxProperties: message keys per locale. */
export const FEO_MAX_LOCALE_KEYS = 2048;
/** `LocaleMessage` MaxLength: characters (Unicode code points) per message. */
export const FEO_MAX_MESSAGE_LENGTH = 4096;

export function isFeoLocaleId(locale: string): boolean {
  return FEO_LOCALE_PATTERN.test(locale) && locale !== FEO_SOURCE_LOCALE;
}

/** The canonical spelling of a malformed locale id, when there is exactly one valid candidate. */
export function suggestFeoLocale(locale: string): string | undefined {
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
  return canonical !== undefined && canonical !== locale && isFeoLocaleId(canonical)
    ? canonical
    : undefined;
}

/** Text to append to an error about an invalid FEO locale id. */
export function feoLocaleHint(locale: string): string {
  const suggestion = suggestFeoLocale(locale);
  return suggestion === undefined
    ? '; use canonical BCP 47 casing such as "fr", "zh-CN" or "zh-Hant-TW" (English is the source language)'
    : `; use "${suggestion}"`;
}

/** Whether a message is longer than the CRD allows; MaxLength counts Unicode code points. */
export function exceedsFeoMessageLength(value: string): boolean {
  // At most one code point per UTF-16 unit, so only longer strings need counting.
  return value.length > FEO_MAX_MESSAGE_LENGTH && [...value].length > FEO_MAX_MESSAGE_LENGTH;
}
