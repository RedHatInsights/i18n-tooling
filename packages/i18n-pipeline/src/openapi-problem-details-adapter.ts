import { parse as parseYaml } from "yaml";
import { getIcuArgumentNames } from "./catalog-check.js";
import { CatalogFormatError } from "./catalog-format-error.js";
import type { AdapterContext, Catalog, CatalogAdapter } from "./index.js";

const I18N_EXTENSION = "x-i18n";
const COMPONENTS_SCHEMA_REF = "#/components/schemas/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CatalogFormatError(`${label} must be an object`);
  return value;
}

function pointerName(reference: string): string {
  if (!reference.startsWith(COMPONENTS_SCHEMA_REF)) {
    throw new CatalogFormatError(
      `OpenAPI Problem Details adapter only supports local component schema references: "${reference}"`,
    );
  }
  const pointer = reference.slice(COMPONENTS_SCHEMA_REF.length);
  if (!pointer || pointer.includes("/")) {
    throw new CatalogFormatError(`Invalid component schema reference "${reference}"`);
  }
  return pointer.replaceAll("~1", "/").replaceAll("~0", "~");
}

function mergeSchema(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target, ...source };
  const targetProperties = isRecord(target.properties) ? target.properties : {};
  const sourceProperties = isRecord(source.properties) ? source.properties : {};
  if (target.properties !== undefined || source.properties !== undefined) {
    const properties = { ...targetProperties, ...sourceProperties };
    if (targetProperties.params !== undefined && sourceProperties.params !== undefined) {
      properties.params = { allOf: [targetProperties.params, sourceProperties.params] };
    }
    merged.properties = properties;
  }
  const targetRequired = Array.isArray(target.required) ? target.required : [];
  const sourceRequired = Array.isArray(source.required) ? source.required : [];
  if (target.required !== undefined || source.required !== undefined) {
    merged.required = [...new Set([...targetRequired, ...sourceRequired])];
  }
  return merged;
}

function resolveSchema(
  value: unknown,
  schemas: Record<string, unknown>,
  referenceChain = new Set<string>(),
): Record<string, unknown> {
  const schema = objectValue(value, "OpenAPI schema");
  let resolved: Record<string, unknown> = {};

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      throw new CatalogFormatError("OpenAPI schema $ref must be a string");
    }
    const name = pointerName(schema.$ref);
    if (referenceChain.has(name)) {
      throw new CatalogFormatError(
        `Circular OpenAPI component schema reference at "${schema.$ref}"`,
      );
    }
    const referencedSchema = schemas[name];
    if (referencedSchema === undefined) {
      throw new CatalogFormatError(`OpenAPI component schema "${name}" was not found`);
    }
    const nextChain = new Set(referenceChain);
    nextChain.add(name);
    resolved = resolveSchema(referencedSchema, schemas, nextChain);
  }

  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf)) {
      throw new CatalogFormatError("OpenAPI schema allOf must be an array");
    }
    for (const member of schema.allOf) {
      resolved = mergeSchema(resolved, resolveSchema(member, schemas, referenceChain));
    }
  }

  const localSchema = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$ref" && key !== "allOf"),
  );
  return mergeSchema(resolved, localSchema);
}

function hasI18nExtension(
  value: unknown,
  schemas: Record<string, unknown>,
  referenceChain = new Set<string>(),
): boolean {
  if (!isRecord(value)) return false;
  if (value[I18N_EXTENSION] !== undefined) return true;
  if (
    Array.isArray(value.allOf) &&
    value.allOf.some((member) => hasI18nExtension(member, schemas, referenceChain))
  ) {
    return true;
  }
  if (typeof value.$ref !== "string" || !value.$ref.startsWith(COMPONENTS_SCHEMA_REF)) return false;

  let name: string;
  try {
    name = pointerName(value.$ref);
  } catch {
    return false;
  }
  if (referenceChain.has(name) || !isRecord(schemas[name])) return false;
  const nextChain = new Set(referenceChain);
  nextChain.add(name);
  return hasI18nExtension(schemas[name], schemas, nextChain);
}

function hasLocalizedCodeProperty(
  value: unknown,
  schemas: Record<string, unknown>,
  referenceChain = new Set<string>(),
): boolean {
  if (!isRecord(value)) return false;
  const properties = isRecord(value.properties) ? value.properties : {};
  if (properties.code !== undefined && hasI18nExtension(properties.code, schemas)) return true;
  if (
    Array.isArray(value.allOf) &&
    value.allOf.some((member) => hasLocalizedCodeProperty(member, schemas, referenceChain))
  ) {
    return true;
  }
  if (typeof value.$ref !== "string" || !value.$ref.startsWith(COMPONENTS_SCHEMA_REF)) return false;

  let name: string;
  try {
    name = pointerName(value.$ref);
  } catch {
    return false;
  }
  if (referenceChain.has(name) || !isRecord(schemas[name])) return false;
  const nextChain = new Set(referenceChain);
  nextChain.add(name);
  return hasLocalizedCodeProperty(schemas[name], schemas, nextChain);
}

function codeValue(schema: Record<string, unknown>, schemaName: string): string {
  if (typeof schema.const === "string" && schema.const.trim()) return schema.const;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length === 1 &&
    typeof schema.enum[0] === "string" &&
    schema.enum[0].trim()
  ) {
    return schema.enum[0];
  }
  throw new CatalogFormatError(
    `OpenAPI schema "${schemaName}" code must be a string const or a single-value enum`,
  );
}

function propertySchema(
  schema: Record<string, unknown>,
  property: string,
  schemaName: string,
): Record<string, unknown> {
  const properties = objectValue(schema.properties, `OpenAPI schema "${schemaName}" properties`);
  const value = properties[property];
  if (value === undefined) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" must define a ${property} property`,
    );
  }
  return objectValue(value, `OpenAPI schema "${schemaName}" property "${property}"`);
}

function extractMessage(
  schema: Record<string, unknown>,
  schemaName: string,
  schemas: Record<string, unknown>,
): { code: string; pattern: string } | undefined {
  const unresolvedProperties = isRecord(schema.properties) ? schema.properties : {};
  const rawCodeSchema = unresolvedProperties.code;
  if (rawCodeSchema === undefined) return undefined;

  const codeSchema = resolveSchema(rawCodeSchema, schemas);
  const extension = codeSchema[I18N_EXTENSION];
  if (extension === undefined) return undefined;
  const metadata = objectValue(extension, `OpenAPI schema "${schemaName}" code ${I18N_EXTENSION}`);
  const unknownProperty = Object.keys(metadata).find((property) => property !== "message");
  if (unknownProperty) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" code ${I18N_EXTENSION} has unknown property "${unknownProperty}"`,
    );
  }
  if (typeof metadata.message !== "string" || !metadata.message.trim()) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" code ${I18N_EXTENSION}.message must be a non-empty string`,
    );
  }

  const code = codeValue(codeSchema, schemaName);
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const property of ["code", "params"]) {
    if (!required.includes(property)) {
      throw new CatalogFormatError(
        `OpenAPI schema "${schemaName}" must require its ${property} property`,
      );
    }
  }

  const rawParamsSchema = propertySchema(schema, "params", schemaName);
  const paramsSchema = resolveSchema(rawParamsSchema, schemas);
  if (paramsSchema.type !== "object") {
    throw new CatalogFormatError(`OpenAPI schema "${schemaName}" params must have type object`);
  }
  const paramsProperties = paramsSchema.properties;
  if (paramsProperties !== undefined && !isRecord(paramsProperties)) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" params.properties must be an object`,
    );
  }
  const paramNames = new Set(Object.keys(isRecord(paramsProperties) ? paramsProperties : {}));
  const requiredParams = Array.isArray(paramsSchema.required)
    ? paramsSchema.required.filter((property): property is string => typeof property === "string")
    : [];
  const requiredParamNames = new Set(requiredParams);
  let argumentNames: string[];
  try {
    argumentNames = getIcuArgumentNames(metadata.message, code, "OpenAPI");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogFormatError(`OpenAPI schema "${schemaName}": ${detail}`);
  }
  const missingParams = argumentNames.filter((argument) => !paramNames.has(argument));
  if (missingParams.length) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" message "${code}" references ICU argument(s) missing from params: ${missingParams.join(", ")}`,
    );
  }
  const optionalParams = argumentNames.filter((argument) => !requiredParamNames.has(argument));
  if (optionalParams.length) {
    throw new CatalogFormatError(
      `OpenAPI schema "${schemaName}" message "${code}" references ICU argument(s) not required in params: ${optionalParams.join(", ")}`,
    );
  }

  return { code, pattern: metadata.message };
}

/** Extracts localized RFC 9457 Problem Details from OpenAPI 3 components schemas. */
export class OpenApiProblemDetailsAdapter implements CatalogAdapter {
  readonly id = "openapi-problem-details";

  parseDocument(content: string): unknown {
    try {
      return parseYaml(content) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CatalogFormatError(`OpenAPI document is not valid JSON or YAML: ${detail}`);
    }
  }

  read(document: unknown, context: AdapterContext): Catalog {
    if (context.role !== "source") {
      throw new CatalogFormatError("openapi-problem-details is a source-only adapter");
    }
    const openApi = objectValue(document, "OpenAPI document");
    if (typeof openApi.openapi !== "string" || !/^3\.\d+\.\d+$/.test(openApi.openapi)) {
      throw new CatalogFormatError('OpenAPI document must declare a version in the "3.x.x" range');
    }
    const components = objectValue(openApi.components, "OpenAPI document components");
    const schemas = objectValue(components.schemas, "OpenAPI document components.schemas");
    const messages = Object.create(null) as Catalog["messages"];

    for (const [schemaName, rawSchema] of Object.entries(schemas)) {
      if (
        isRecord(rawSchema) &&
        typeof rawSchema.$ref === "string" &&
        Object.keys(rawSchema).every((key) => ["$ref", "summary", "description"].includes(key))
      ) {
        continue;
      }
      if (!hasLocalizedCodeProperty(rawSchema, schemas)) continue;
      const schema = resolveSchema(rawSchema, schemas);
      const extracted = extractMessage(schema, schemaName, schemas);
      if (!extracted) continue;
      if (messages[extracted.code]) {
        throw new CatalogFormatError(`Duplicate OpenAPI i18n message code "${extracted.code}"`);
      }
      messages[extracted.code] = { pattern: extracted.pattern, metadata: {} };
    }

    if (Object.keys(messages).length === 0) {
      throw new CatalogFormatError(
        `OpenAPI document has no component schemas with ${I18N_EXTENSION} messages on code properties`,
      );
    }
    return { locale: context.locale, messages };
  }

  write(): unknown {
    throw new CatalogFormatError("openapi-problem-details is a source-only adapter");
  }
}
