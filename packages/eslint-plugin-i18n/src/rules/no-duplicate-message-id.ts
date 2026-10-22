import type * as ESTree from "estree";
import type { TSESTree } from "@typescript-eslint/utils";
import type { Rule } from "eslint";
import { isFormatJsMessageCall, objectProperty, staticString } from "../descriptors.js";

type Declaration = {
  node: ESTree.Node;
  defaultMessage: string | undefined;
  description: string | undefined;
};

function jsxAttributeText(attribute: TSESTree.JSXAttribute): string | undefined {
  const value = attribute.value;
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "JSXExpressionContainer") return staticString(value.expression);
  return undefined;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow two message descriptors in one file that share an id but differ in defaultMessage or description",
    },
    schema: [],
    messages: {
      duplicateId:
        'Message id "{{id}}" is also declared on line {{line}} with a different defaultMessage or description; only one reaches the source catalog.',
    },
  },

  create(context) {
    const declarations = new Map<string, Declaration[]>();
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    // A non-literal description (an object of translator metadata) is compared by its source text.
    function descriptionText(node: ESTree.Node | undefined): string | undefined {
      if (!node) return undefined;
      return staticString(node) ?? sourceCode.getText(node);
    }

    function record(id: string | undefined, declaration: Declaration): void {
      if (id === undefined) return;
      const list = declarations.get(id);
      if (list) list.push(declaration);
      else declarations.set(id, [declaration]);
    }

    function recordDescriptor(descriptor: ESTree.Node): void {
      record(staticString(objectProperty(descriptor, "id")), {
        node: descriptor,
        defaultMessage: staticString(objectProperty(descriptor, "defaultMessage")),
        description: descriptionText(objectProperty(descriptor, "description")),
      });
    }

    function visitDescriptorTree(node: ESTree.Node): void {
      if (node.type !== "ObjectExpression") return;
      if (objectProperty(node, "id")) {
        recordDescriptor(node);
        return;
      }
      for (const property of node.properties) {
        if (property.type === "Property") visitDescriptorTree(property.value as ESTree.Node);
      }
    }

    return {
      CallExpression(node) {
        if (!isFormatJsMessageCall(node.callee)) return;
        const descriptor = node.arguments[0];
        if (!descriptor || descriptor.type !== "ObjectExpression") return;
        if (node.callee.type === "Identifier" && node.callee.name === "defineMessages") {
          visitDescriptorTree(descriptor);
        } else {
          recordDescriptor(descriptor);
        }
      },

      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        const name =
          node.name.type === "JSXIdentifier"
            ? node.name.name
            : node.name.type === "JSXMemberExpression"
              ? node.name.property.name
              : undefined;
        if (name !== "FormattedMessage") return;
        const attributes = new Map<string, TSESTree.JSXAttribute>();
        for (const attribute of node.attributes) {
          if (attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier")
            attributes.set(attribute.name.name, attribute);
        }
        const text = (key: string) => {
          const attribute = attributes.get(key);
          return attribute ? jsxAttributeText(attribute) : undefined;
        };
        record(text("id"), {
          node: node as unknown as ESTree.Node,
          defaultMessage: text("defaultMessage"),
          description: text("description"),
        });
      },

      "Program:exit"() {
        for (const [id, list] of declarations) {
          const [first, ...rest] = list;
          for (const declaration of rest) {
            if (
              declaration.defaultMessage === first!.defaultMessage &&
              declaration.description === first!.description
            )
              continue;
            context.report({
              node: declaration.node,
              messageId: "duplicateId",
              data: { id, line: String(first!.node.loc?.start.line ?? "?") },
            });
          }
        }
      },
    };
  },
};

export default rule;
