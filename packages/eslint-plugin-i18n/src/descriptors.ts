import type * as ESTree from "estree";

/** AST helpers shared by the plugin's rules. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function staticString(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }

  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const quasi = node.quasis[0];
    if (!isRecord(quasi) || !isRecord(quasi.value)) return undefined;
    return typeof quasi.value.cooked === "string"
      ? quasi.value.cooked
      : typeof quasi.value.raw === "string"
        ? quasi.value.raw
        : undefined;
  }

  return undefined;
}

export function propertyName(property: ESTree.Property): string | undefined {
  if (property.computed) return undefined;
  return property.key.type === "Identifier" ? property.key.name : staticString(property.key);
}

export function objectProperties(object: ESTree.Node | undefined, name: string): ESTree.Property[] {
  if (object?.type !== "ObjectExpression") return [];
  return object.properties.filter(
    (item): item is ESTree.Property => item.type === "Property" && propertyName(item) === name,
  );
}

export function objectProperty(
  object: ESTree.Node | undefined,
  name: string,
): ESTree.Node | undefined {
  return objectProperties(object, name)[0]?.value;
}

export function isFormatJsMessageCall(callee: ESTree.Node): boolean {
  if (callee.type === "Identifier") {
    return ["defineMessage", "defineMessages", "formatMessage"].includes(callee.name);
  }

  if (callee.type !== "MemberExpression") return false;
  const propertyName =
    callee.property.type === "Identifier"
      ? callee.property.name
      : callee.computed
        ? staticString(callee.property)
        : undefined;
  return propertyName === "formatMessage";
}
