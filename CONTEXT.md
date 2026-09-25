# Internationalization Tooling

Shared language for translatable product messages and their locale-specific translations.

## Messages and catalogs

**Message ID**:
Stable identifier for a translatable message across application code and locales.

**Locale catalog**:
Collection of localized messages for one locale, indexed by message ID.
_Avoid_: ICU resource bundle, ICU catalog

**Source catalog**:
Canonical locale catalog in the source language. In this project, English is the source locale and fallback.
_Avoid_: Default catalog when naming source-language content

**Target catalog**:
Locale catalog containing translations from the source language.

## Message format and storage

**ICU MessageFormat pattern**:
Message syntax for parameters and grammatical selection such as plural and select; describes message content, not its storage.
_Avoid_: ICU resource bundle

**ICU resource bundle**:
ICU's native locale-aware data container and lookup/fallback model.
_Avoid_: Locale catalog
