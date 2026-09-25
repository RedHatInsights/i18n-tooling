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

function objectProperty(object: ESTree.Node | undefined, name: string): ESTree.Node | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  const property = object.properties.find(
    (item): item is ESTree.Property => item.type === "Property" && propertyName(item) === name,
  );
  return property?.value;
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

function isFormatJsMessageCall(callee: ESTree.Node): boolean {
  if (callee.type === "Identifier") {
    return ["defineMessage", "defineMessages", "formatMessage"].includes(callee.name);
  }

  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "formatMessage"
  );
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
      dynamicId: "Message IDs must be static string literals or no-expression templates.",
    },
  },

  create(context) {
    const options = context.options as Options;
    const catalogPath = resolveCatalogPath(context, options[0]?.catalog);
    let catalog: CatalogState | undefined;
    let catalogErrorReported = false;

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

    function checkDescriptor(node: ESTree.Node, descriptor: ESTree.Node | undefined): void {
      const idNode =
        descriptor?.type === "ObjectExpression" ? objectProperty(descriptor, "id") : undefined;
      if (!idNode) return;

      const id = staticString(idNode);
      if (!id) {
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

    function visitDescriptorTree(node: ESTree.Node | undefined): void {
      if (node?.type !== "ObjectExpression") return;
      checkDescriptor(node, node);
      for (const property of node.properties) {
        if (property.type === "Property") visitDescriptorTree(property.value);
      }
    }

    return {
      Program(node) {
        ensureCatalog(node);
      },

      CallExpression(node) {
        if (!isFormatJsMessageCall(node.callee)) return;
        const descriptor = node.arguments[0];
        if (!descriptor || descriptor.type === "SpreadElement") return;
        if (node.callee.type === "Identifier" && node.callee.name === "defineMessages") {
          visitDescriptorTree(descriptor);
        } else {
          checkDescriptor(node, descriptor);
        }
      },

      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (name !== "FormattedMessage") return;

        const idAttribute = node.attributes.find(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "id",
        );
        if (!idAttribute || idAttribute.type !== "JSXAttribute") return;

        const value = idAttribute.value;
        const idNode = value?.type === "JSXExpressionContainer" ? value.expression : value;
        const id = staticString(idNode);
        if (!id) {
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
