import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseIcuMessage } from "@formatjs/icu-messageformat-parser";

export type CatalogRole = "source" | "target";

export interface AdapterContext {
  locale: string;
  role: CatalogRole;
  options: Readonly<Record<string, unknown>>;
}

export interface CatalogMessage {
  pattern: string;
  description?: string | Record<string, unknown>;
  metadata: Readonly<Record<string, unknown>>;
}

export interface Catalog {
  locale: string;
  messages: Record<string, CatalogMessage>;
}

export interface CatalogAdapter {
  readonly id: string;
  read(document: unknown, context: AdapterContext): Catalog;
  write(catalog: Catalog, context: AdapterContext): unknown;
}

export class CatalogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidIcuPattern(
  pattern: unknown,
  messageId: string,
  adapterId: string,
): asserts pattern is string {
  if (typeof pattern !== "string") {
    throw new CatalogFormatError(`${adapterId} message "${messageId}" must be a string`);
  }

  try {
    parseIcuMessage(pattern);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogFormatError(
      `${adapterId} message "${messageId}" has invalid ICU syntax: ${detail}`,
    );
  }
}

export class FormatJsJsonAdapter implements CatalogAdapter {
  readonly id = "formatjs-json";

  read(document: unknown, context: AdapterContext): Catalog {
    if (!isRecord(document)) {
      throw new CatalogFormatError("FormatJS catalog must be a JSON object");
    }

    const messages = Object.create(null) as Record<string, CatalogMessage>;
    for (const [messageId, rawMessage] of Object.entries(document)) {
      if (!messageId) {
        throw new CatalogFormatError("FormatJS message IDs must be non-empty strings");
      }
      if (context.role === "target") {
        if (typeof rawMessage !== "string") {
          throw new CatalogFormatError(
            `FormatJS target entry "${messageId}" must be a message string`,
          );
        }
        assertValidIcuPattern(rawMessage, messageId, this.id);
        messages[messageId] = { pattern: rawMessage, metadata: {} };
        continue;
      }

      if (!isRecord(rawMessage)) {
        throw new CatalogFormatError(
          `FormatJS source entry "${messageId}" must be a descriptor object`,
        );
      }
      if (typeof rawMessage.defaultMessage !== "string") {
        throw new CatalogFormatError(
          `FormatJS source entry "${messageId}" needs a string defaultMessage`,
        );
      }
      assertValidIcuPattern(rawMessage.defaultMessage, messageId, this.id);

      const description = rawMessage.description;
      if (
        description !== undefined &&
        typeof description !== "string" &&
        !isRecord(description)
      ) {
        throw new CatalogFormatError(
          `FormatJS source entry "${messageId}" description must be a string or object`,
        );
      }

      const { defaultMessage: pattern, description: _description, ...metadata } = rawMessage;
      messages[messageId] = {
        pattern,
        ...(description === undefined ? {} : { description }),
        metadata,
      };
    }

    return { locale: context.locale, messages };
  }

  write(catalog: Catalog, context: AdapterContext): unknown {
    if (context.role === "target") {
      return Object.fromEntries(
        Object.entries(catalog.messages).map(([id, message]) => {
          assertValidIcuPattern(message.pattern, id, this.id);
          return [id, message.pattern];
        }),
      );
    }

    return Object.fromEntries(
      Object.entries(catalog.messages).map(([id, message]) => {
        assertValidIcuPattern(message.pattern, id, this.id);
        return [
          id,
          {
            ...message.metadata,
            defaultMessage: message.pattern,
            ...(message.description === undefined ? {} : { description: message.description }),
          },
        ];
      }),
    );
  }
}

export class IcuJsonAdapter implements CatalogAdapter {
  readonly id = "icu-json";

  read(document: unknown, context: AdapterContext): Catalog {
    if (!isRecord(document)) {
      throw new CatalogFormatError("ICU JSON catalog must be a JSON object");
    }

    const messages = Object.create(null) as Record<string, CatalogMessage>;
    for (const [messageId, pattern] of Object.entries(document)) {
      if (!messageId) {
        throw new CatalogFormatError("ICU JSON message IDs must be non-empty strings");
      }
      if (typeof pattern !== "string") {
        throw new CatalogFormatError(`ICU JSON entry "${messageId}" must be a message string`);
      }
      assertValidIcuPattern(pattern, messageId, this.id);
      messages[messageId] = { pattern, metadata: {} };
    }

    return { locale: context.locale, messages };
  }

  write(catalog: Catalog): unknown {
    return Object.fromEntries(
      Object.entries(catalog.messages).map(([id, message]) => {
        assertValidIcuPattern(message.pattern, id, this.id);
        return [id, message.pattern];
      }),
    );
  }
}

export class CatalogAdapterRegistry {
  private readonly adapters = new Map<string, CatalogAdapter>([
    ["formatjs-json", new FormatJsJsonAdapter()],
    ["icu-json", new IcuJsonAdapter()],
  ]);

  register(adapter: CatalogAdapter): void {
    if (!adapter.id || /\s/.test(adapter.id)) {
      throw new TypeError("Catalog adapter IDs must be non-empty and contain no whitespace");
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Catalog adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): CatalogAdapter {
    const adapter = this.adapters.get(adapterId);
    if (adapter) return adapter;

    const available = [...this.adapters.keys()].sort().join(", ");
    throw new Error(`Unknown catalog adapter "${adapterId}". Available: ${available}`);
  }
}

export function convertCatalog(
  document: unknown,
  sourceAdapter: CatalogAdapter,
  targetAdapter: CatalogAdapter,
  sourceContext: AdapterContext,
  targetContext: AdapterContext,
): unknown {
  const catalog = sourceAdapter.read(document, sourceContext);
  return targetAdapter.write(catalog, targetContext);
}

export async function createCatalogAdapterRegistry(
  projectRoot = process.cwd(),
): Promise<CatalogAdapterRegistry> {
  const registry = new CatalogAdapterRegistry();
  const manifestPath = resolve(projectRoot, "package.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(manifest)) {
    throw new TypeError("Project package.json must contain a JSON object");
  }

  if (manifest.i18nTooling === undefined) return registry;
  if (!isRecord(manifest.i18nTooling)) {
    throw new TypeError('package.json "i18nTooling" must be an object');
  }
  const configuredAdapters = manifest.i18nTooling.catalogAdapters;
  if (configuredAdapters === undefined) return registry;
  if (!isRecord(configuredAdapters)) {
    throw new TypeError('package.json "i18nTooling.catalogAdapters" must be an object');
  }

  for (const [adapterId, moduleSpecifier] of Object.entries(configuredAdapters)) {
    if (typeof moduleSpecifier !== "string" || !moduleSpecifier.trim()) {
      throw new TypeError(`Module for catalog adapter "${adapterId}" must be a string`);
    }
    const specifier =
      moduleSpecifier.startsWith(".") || isAbsolute(moduleSpecifier)
        ? pathToFileURL(resolve(projectRoot, moduleSpecifier)).href
        : moduleSpecifier;

    let pluginModule: unknown;
    try {
      pluginModule = await import(specifier);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not load catalog adapter "${adapterId}" from "${moduleSpecifier}": ${detail}`,
        { cause: error },
      );
    }

    const adapter = isRecord(pluginModule) ? pluginModule.default : undefined;
    if (
      !isRecord(adapter) ||
      typeof adapter.id !== "string" ||
      typeof adapter.read !== "function" ||
      typeof adapter.write !== "function"
    ) {
      throw new TypeError(
        `Module for catalog adapter "${adapterId}" must default-export an adapter with id, read(), and write()`,
      );
    }
    if (adapter.id !== adapterId) {
      throw new TypeError(
        `Configured catalog adapter ID "${adapterId}" does not match plugin ID "${adapter.id}"`,
      );
    }
    registry.register(adapter as unknown as CatalogAdapter);
  }

  return registry;
}
