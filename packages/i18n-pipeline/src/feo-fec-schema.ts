/**
 * Whether the consumer's Frontend CRD schema accepts `spec.locales`.
 *
 * FEC (`@redhat-cloud-services/frontend-components-config-utilities`) validates `deploy/frontend.yaml`
 * against the schema it ships; releases before 4.14.0 reject `spec.locales`. The check reads the
 * schema as JSON from the consumer's installed package (lockfile-exact after `npm ci`) and never
 * runs consumer code.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

export const FEC_UTILITIES_PACKAGE = "@redhat-cloud-services/frontend-components-config-utilities";
const FEC_SCHEMA_PATH = "feo/spec/frontend-crd.schema.json";

export interface InstalledFecSchema {
  version: string;
  /** Schema path relative to the project root, for messages. */
  schemaPath: string;
  schema: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLocalRef(root: Record<string, unknown>, node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return undefined;
    seen.add(ref);
    current = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), root);
  }
  return current;
}

/**
 * Returns whether the Frontend object's `spec` declares `locales`. Throws when the schema does not
 * have the Template → `objects[]` → Frontend `spec` layout FEC uses, so callers can report the
 * check as skipped instead of guessing.
 */
export function fecSchemaAcceptsLocales(schema: unknown): boolean {
  if (!isRecord(schema)) throw new TypeError("schema is not a JSON object");
  const properties = (node: unknown, label: string): Record<string, unknown> => {
    const resolved = resolveLocalRef(schema, node);
    if (!isRecord(resolved) || !isRecord(resolved.properties)) {
      throw new TypeError(`schema has no properties for ${label}`);
    }
    return resolved.properties;
  };
  const objects = resolveLocalRef(schema, properties(schema, "the Template").objects);
  if (!isRecord(objects)) throw new TypeError("schema has no Template objects");
  const frontend = properties(objects.items, "the Frontend object");
  return Object.hasOwn(properties(frontend.spec, "the Frontend spec"), "locales");
}

/** Loads the FEC schema installed for `projectRoot`, or `undefined` when FEC is not installed. */
export async function readInstalledFecSchema(
  projectRoot: string,
): Promise<InstalledFecSchema | undefined> {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(join(projectRoot, "package.json")).resolve(
      `${FEC_UTILITIES_PACKAGE}/package.json`,
    );
  } catch {
    return undefined;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  const version =
    isRecord(packageJson) && typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown version";
  const schemaFile = join(dirname(packageJsonPath), FEC_SCHEMA_PATH);
  return {
    version,
    schemaPath: relative(projectRoot, schemaFile),
    schema: JSON.parse(await readFile(schemaFile, "utf8")) as unknown,
  };
}
