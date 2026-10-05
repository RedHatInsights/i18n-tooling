import type * as ESTree from "estree";
import type { Rule } from "eslint";

const extractableCallNames = new Set(["formatMessage", "defineMessage", "$t", "$formatMessage"]);

type ParentAwareNode = ESTree.Node & { parent?: ESTree.Node };

function propertyName(property: ESTree.Property): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : undefined;
}

function objectProperties(object: ESTree.ObjectExpression, name: string): ESTree.Property[] {
  return object.properties.filter(
    (property): property is ESTree.Property =>
      property.type === "Property" && propertyName(property) === name,
  );
}

function staticString(node: ESTree.Node): string | undefined {
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function calleeName(callee: ESTree.Node): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

function isExtractable(node: ESTree.ObjectExpression): boolean {
  const parent = (node as ParentAwareNode).parent;
  if (!parent) return false;

  if (parent.type === "CallExpression") {
    const call = parent as ESTree.CallExpression;
    return call.arguments[0] === node && extractableCallNames.has(calleeName(call.callee) ?? "");
  }

  if (parent.type !== "Property" || (parent as ESTree.Property).value !== node) return false;
  const descriptors = (parent as ParentAwareNode).parent;
  if (descriptors?.type !== "ObjectExpression") return false;

  const call = (descriptors as ParentAwareNode).parent;
  if (call?.type !== "CallExpression") return false;
  const defineMessagesCall = call as ESTree.CallExpression;
  return (
    defineMessagesCall.arguments[0] === descriptors &&
    calleeName(defineMessagesCall.callee) === "defineMessages"
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require FormatJS message descriptors to appear in extractable positions.",
    },
    schema: [],
    messages: {
      notExtractable:
        'Message "{{id}}" is not in a FormatJS-extractable position. Pass it directly to formatMessage()/defineMessage(), or declare it as a value in defineMessages().',
    },
  },

  create(context) {
    return {
      ObjectExpression(node) {
        const idProperties = objectProperties(node, "id");
        const idProperty = idProperties[idProperties.length - 1];
        if (!idProperty || objectProperties(node, "defaultMessage").length === 0) return;

        const id = staticString(idProperty.value);
        if (id === undefined || isExtractable(node)) return;

        context.report({
          node,
          messageId: "notExtractable",
          data: { id },
        });
      },
    };
  },
};

export default rule;
