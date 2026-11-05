import fs from "node:fs";
import path from "node:path";
import type * as ESTree from "estree";
import type { TSESTree } from "@typescript-eslint/utils";
import type { Rule } from "eslint";
import {
  isFormatJsMessageCall,
  isRecord,
  objectProperties,
  objectProperty,
  staticString,
} from "../descriptors.js";

type Options = [{ catalog?: string }];

type CatalogState = {
  ids: Set<string>;
  error?: string;
};

const catalogCache = new Map<string, { mtimeMs: number; size: number; state: CatalogState }>();

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
      descriptor = descriptor === undefined ? undefined : unwrapTypeScriptAssertion(descriptor);
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
      node = unwrapTypeScriptAssertion(node);
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
          // A record that maps keys to message references (for example a
          // Record<string, MessageDescriptor> lookup table) is not itself a
          // descriptor: check each referenced descriptor instead of
          // demanding an id on the record.
          if (
            !objectProperty(node, "id") &&
            !objectProperty(node, "defaultMessage") &&
            node.properties.length > 0 &&
            node.properties.every(
              (property) => property.type === "Property" && isMessageReference(property.value),
            )
          ) {
            for (const property of node.properties) {
              if (property.type === "Property") {
                if (!checkMessageReference(property.value)) {
                  reportUninspectableDescriptor(property.value);
                }
              }
            }
            return;
          }
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

    function checkMessageReference(node: ESTree.Node): boolean {
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
          const initializer = unwrapTypeScriptAssertion(definition.node.init);
          if (initializer?.type === "ObjectExpression") {
            visitDescriptorTree(initializer);
            return true;
          }
          if (initializer?.type === "MemberExpression") {
            // A const alias of a (possibly computed) record lookup, such as
            // `const message = LABELS[key];` — including an inline record
            // literal indexed at runtime.
            if (initializer.computed && staticString(initializer.property) === undefined) {
              const object = unwrapTypeScriptAssertion(initializer.object);
              if (object.type === "ObjectExpression") {
                visitDescriptorTree(object);
                return true;
              }
            }
            return isCheckedMessageReference(initializer);
          }
          if (
            initializer?.type === "ConditionalExpression" ||
            initializer?.type === "LogicalExpression"
          ) {
            return isCheckedMessageReference(initializer);
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
        return Boolean(importDefinition);
      }
      return false;
    }

    function isCheckedMessageReference(node: ESTree.Node): boolean {
      node = unwrapTypeScriptAssertion(node);
      if (node.type === "ConditionalExpression") {
        return (
          isCheckedMessageReference(node.consequent) && isCheckedMessageReference(node.alternate)
        );
      }
      if (node.type === "LogicalExpression") {
        return isCheckedMessageReference(node.left) && isCheckedMessageReference(node.right);
      }
      if (
        node.type === "MemberExpression" &&
        node.computed &&
        staticString(node.property) === undefined
      ) {
        return checkDynamicRecordLookup(node);
      }
      return checkMessageReference(node);
    }

    /**
     * Strips TypeScript assertion wrappers (`as const`, `satisfies`, `!` and
     * angle-bracket assertions) so the wrapped initializer, argument or
     * descriptor is still statically inspected.
     */
    function unwrapTypeScriptAssertion(node: ESTree.Node | undefined | null): ESTree.Node {
      while (
        node !== undefined &&
        node !== null &&
        isTypeScriptAssertion(node)
      ) {
        node = (node as unknown as { expression: ESTree.Node }).expression;
      }
      return node as ESTree.Node;
    }

    function isTypeScriptAssertion(node: ESTree.Node): boolean {
      const type = (node as unknown as { type?: string }).type;
      return (
        type === "TSAsExpression" ||
        type === "TSSatisfiesExpression" ||
        type === "TSNonNullExpression" ||
        type === "TSTypeAssertion"
      );
    }

    function checkDynamicRecordLookup(node: ESTree.MemberExpression): boolean {
      let root: ESTree.Node = node.object;
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
          const initializer = unwrapTypeScriptAssertion(definition.node.init);
          if (initializer?.type === "ObjectExpression") {
            visitDescriptorTree(initializer);
            return true;
          }
          if (
            initializer?.type === "CallExpression" &&
            initializer.callee.type === "Identifier" &&
            initializer.callee.name === "defineMessages"
          ) {
            const descriptor = initializer.arguments[0];
            if (!descriptor || descriptor.type === "SpreadElement") {
              reportUninspectableDescriptor(descriptor ?? initializer);
            } else {
              visitDescriptorTree(descriptor, true);
            }
            return true;
          }
        }
        return false;
      }
      return false;
    }

    return {
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
