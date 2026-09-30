import type { AdapterContext, CatalogAdapter } from "./index.js";

/** Parse adapter-specific catalog text, defaulting to JSON for existing adapters. */
export function parseCatalogDocument(
  content: string,
  adapter: CatalogAdapter,
  context: AdapterContext,
): unknown {
  return adapter.parseDocument ? adapter.parseDocument(content, context) : JSON.parse(content);
}

/** Serialize a catalog document, defaulting to formatted JSON for existing adapters. */
export function serializeCatalogDocument(
  document: unknown,
  adapter: CatalogAdapter,
  context: AdapterContext,
): string {
  if (adapter.serializeDocument) {
    const serialized = adapter.serializeDocument(document, context);
    if (typeof serialized !== "string") {
      throw new TypeError(
        `Catalog adapter "${adapter.id}" serializeDocument() must return a string`,
      );
    }
    return serialized;
  }

  const serialized = JSON.stringify(document, null, 2);
  if (serialized === undefined) {
    throw new TypeError(`Catalog adapter "${adapter.id}" did not produce a JSON document`);
  }
  return `${serialized}\n`;
}
