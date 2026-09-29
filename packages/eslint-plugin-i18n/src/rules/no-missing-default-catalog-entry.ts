import fs from "node:fs";
import path from "node:path";
import type * as ESTree from "estree";
import type { TSESTree } from "@typescript-eslint/utils";
import type { Rule } from "eslint";

type Options = [{ catalog?: string }];

type CatalogState = {
  ids: Set<string>;
  error?: string;
};

const catalogCache = new Map<string, { mtimeMs: number; size: number; state: CatalogState }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function staticString(node: unknown): string | undefined {
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

function propertyName(property: ESTree.Property): string | undefined {
  if (property.computed) return undefined;
  return property.key.type === "Identifier" ? property.key.name : staticString(property.key);
}

function objectProperties(object: ESTree.Node | undefined, name: string): ESTree.Property[] {
  if (object?.type !== "ObjectExpression") return [];
  return object.properties.filter(
    (item): item is ESTree.Property => item.type === "Property" && propertyName(item) === name,
  );
}

function objectProperty(object: ESTree.Node | undefined, name: string): ESTree.Node | undefined {
  return objectProperties(object, name)[0]?.value;
}

function resolveCatalogPath(context: Rule.RuleContext, configuredPath: string | undefined): string {
  const cwd = context.cwd ?? context.getCwd();
  return path.resolve(cwd, configuredPath ?? "locales/en.json");
}

function loadCatalog(catalogPath: string): CatalogState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(catalogPath);
  } catch (error) {
    return { ids: new Set(), error: `Cannot read catalog ${catalogPath}: ${String(error)}` };
  }

  const cached = catalogCache.get(catalogPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.state;

  let state: CatalogState;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("catalog must be a flat JSON object");
    }

    state = { ids: new Set(Object.keys(parsed)) };
  } catch (error) {
    state = { ids: new Set(), error: `Cannot parse catalog ${catalogPath}: ${String(error)}` };
  }

  catalogCache.set(catalogPath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

function isMessageReference(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return true;
  if (node.type !== "MemberExpression" || node.optional) return false;
  return node.computed
    ? staticString(node.property) !== undefined
    : node.property.type === "Identifier";
}

function isFormatJsMessageCall(callee: ESTree.Node): boolean {
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

function asEslintNode(node: TSESTree.Node): ESTree.Node {
  return node as unknown as ESTree.Node;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require statically discoverable message IDs in the default catalog.",
    },
    schema: [
      {
        type: "object",
        properties: {
          catalog: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingCatalog: "Unable to load default catalog: {{error}}",
      missingEntry: 'Message ID "{{id}}" is missing from the default catalog.',
      missingId: "FormatJS messages must declare an ID.",
      dynamicId: "Message IDs must be static string literals or no-expression templates.",
      uninspectableDescriptor:
        "Message descriptors must be statically inspectable object literals.",
    },
  },

  create(context) {
    const options = context.options as Options;
    const catalogPath = resolveCatalogPath(context, options[0]?.catalog);
    let catalog: CatalogState | undefined;
    let catalogErrorReported = false;
    const checkedDescriptors = new WeakSet<ESTree.Node>();
    const visitedDescriptorTrees = new WeakSet<ESTree.Node>();
    const reportedUninspectableDescriptors = new WeakSet<ESTree.Node>();

    function ensureCatalog(node: ESTree.Node): CatalogState {
      catalog ??= loadCatalog(catalogPath);
      if (catalog.error && !catalogErrorReported) {
        catalogErrorReported = true;
        context.report({
          node,
          messageId: "missingCatalog",
          data: { error: catalog.error },
        });
      }
      return catalog;
    }

    function reportUninspectableDescriptor(node: ESTree.Node): void {
      if (reportedUninspectableDescriptors.has(node)) return;
      reportedUninspectableDescriptors.add(node);
      context.report({ node, messageId: "uninspectableDescriptor" });
    }

    function checkDescriptor(node: ESTree.Node, descriptor: ESTree.Node | undefined): void {
      if (descriptor?.type !== "ObjectExpression") {
        reportUninspectableDescriptor(descriptor ?? node);
        return;
      }
      if (checkedDescriptors.has(descriptor)) return;
      checkedDescriptors.add(descriptor);
      if (
        descriptor.properties.some(
          (property) =>
            property.type === "SpreadElement" ||
            (property.type === "Property" && property.computed),
        )
      ) {
        reportUninspectableDescriptor(descriptor);
        return;
      }

      const idProperties = objectProperties(descriptor, "id");
      if (idProperties.length === 0) {
        context.report({ node: descriptor, messageId: "missingId" });
        return;
      }
      if (idProperties.length > 1) {
        reportUninspectableDescriptor(descriptor);
        return;
      }

      const idNode = idProperties[0]!.value;
      const id = staticString(idNode);
      if (id === undefined) {
        context.report({ node: idNode, messageId: "dynamicId" });
        return;
      }

      const state = ensureCatalog(idNode);
      if (!state.error && !state.ids.has(id)) {
        context.report({
          node: idNode,
          messageId: "missingEntry",
          data: { id },
        });
      }
    }

    function visitDescriptorTree(node: ESTree.Node, isRoot = false): void {
      if (node.type !== "ObjectExpression") {
        reportUninspectableDescriptor(node);
        return;
      }
      if (visitedDescriptorTrees.has(node)) return;
      visitedDescriptorTrees.add(node);

      if (!isRoot) {
        const hasNestedDescriptors = node.properties.some(
          (property) => property.type === "Property" && property.value.type === "ObjectExpression",
        );
        if (
          objectProperty(node, "id") ||
          objectProperty(node, "defaultMessage") ||
          !hasNestedDescriptors
        ) {
          checkDescriptor(node, node);
          return;
        }
      }

      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          reportUninspectableDescriptor(property);
        } else {
          visitDescriptorTree(property.value);
        }
      }
    }

    function isCheckedMessageReference(node: ESTree.Node): boolean {
      if (!isMessageReference(node)) return false;

      let root = node;
      while (root.type === "MemberExpression") root = root.object;
      if (root.type !== "Identifier") return false;

      let scope: ReturnType<typeof context.sourceCode.getScope> | null =
        context.sourceCode.getScope(node);
      while (scope) {
        const variable = scope.set.get(root.name);
        if (!variable) {
          scope = scope.upper;
          continue;
        }

        const definition = variable.defs.find((item) => item.type === "Variable");
        if (definition?.type === "Variable" && definition.parent.kind === "const") {
          const initializer = definition.node.init;
          if (initializer?.type === "ObjectExpression") {
            visitDescriptorTree(initializer);
            return true;
          }
          if (initializer?.type === "CallExpression" && initializer.callee.type === "Identifier") {
            const descriptor = initializer.arguments[0];
            if (initializer.callee.name === "defineMessages") {
              if (!descriptor || descriptor.type === "SpreadElement") {
                reportUninspectableDescriptor(descriptor ?? initializer);
              } else {
                visitDescriptorTree(descriptor, true);
              }
              return true;
            }
            if (initializer.callee.name === "defineMessage") {
              checkDescriptor(
                initializer,
                descriptor?.type === "SpreadElement" ? undefined : descriptor,
              );
              return true;
            }
          }
        }

        const importDefinition = variable.defs.find((item) => item.type === "ImportBinding");
        const importSource = importDefinition?.parent.source.value;
        return typeof importSource === "string" && importSource.startsWith(".");
      }
      return false;
    }

    return {
      Program(node) {
        ensureCatalog(node);
      },

      CallExpression(node) {
        if (!isFormatJsMessageCall(node.callee)) return;
        const descriptor = node.arguments[0];
        if (node.callee.type === "Identifier" && node.callee.name === "defineMessages") {
          if (!descriptor || descriptor.type === "SpreadElement") {
            reportUninspectableDescriptor(descriptor ?? node);
          } else {
            visitDescriptorTree(descriptor, true);
          }
          return;
        }
        if (descriptor && isCheckedMessageReference(descriptor)) return;
        checkDescriptor(node, descriptor?.type === "SpreadElement" ? undefined : descriptor);
      },

      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        const name =
          node.name.type === "JSXIdentifier"
            ? node.name.name
            : node.name.type === "JSXMemberExpression"
              ? node.name.property.name
              : undefined;
        if (name !== "FormattedMessage") return;

        const idAttributes = node.attributes.filter(
          (attribute): attribute is TSESTree.JSXAttribute =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "id",
        );
        if (idAttributes.length === 0) {
          if (
            node.attributes.some(
              (attribute) =>
                attribute.type === "JSXSpreadAttribute" &&
                isCheckedMessageReference(asEslintNode(attribute.argument)),
            )
          ) {
            return;
          }
          context.report({ node: asEslintNode(node), messageId: "missingId" });
          return;
        }
        if (idAttributes.length > 1) {
          reportUninspectableDescriptor(asEslintNode(node));
          return;
        }

        const idAttribute = idAttributes[0]!;
        const idAttributeIndex = node.attributes.indexOf(idAttribute);
        if (
          node.attributes
            .slice(idAttributeIndex + 1)
            .some((attribute) => attribute.type === "JSXSpreadAttribute")
        ) {
          reportUninspectableDescriptor(asEslintNode(node));
          return;
        }

        const value = idAttribute.value;
        const idNode = value?.type === "JSXExpressionContainer" ? value.expression : value;
        const id = staticString(idNode);
        if (id === undefined) {
          context.report({ node: asEslintNode(idAttribute), messageId: "dynamicId" });
          return;
        }

        const nodeForReport = asEslintNode(idAttribute);
        const state = ensureCatalog(nodeForReport);
        if (!state.error && !state.ids.has(id)) {
          context.report({
            node: nodeForReport,
            messageId: "missingEntry",
            data: { id },
          });
        }
      },
    };
  },
};

export default rule;
