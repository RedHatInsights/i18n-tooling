import type * as ESTree from "estree";
import type { TSESTree as TS } from "@typescript-eslint/utils";
import type { Rule } from "eslint";
import {
  isFormatJsMessageCall,
  jsxAttributeText,
  jsxElementName,
  staticString,
} from "../descriptors.js";
import { createMessageResolver } from "../message-resolver.js";

type Part = { text: string; message?: boolean; link?: boolean };
type Parts = (Part | undefined)[];
// Western sentence marks must follow a word, not occur inside decimal or dotted tokens.
const sentenceMark = /(?:^|\s)[\p{L}\p{M}]+[.!?](?=\s|$)|[。！？…]|(?:^|\s)[.!?](?=\s|$)/u;
const closedBoundary = /[.!?。！？…:：][\s\p{Pe}\p{Pf}"']*$/u;
const inlineElements = new Set(["a", "span", "strong", "em", "b", "i", "small", "code", "u"]);
const asNode = (node: TS.Node) => node as unknown as ESTree.Node;

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Detect statically identifiable message fragments composed at render sites",
    },
    schema: [],
    messages: {
      composition:
        "This composition joins translated sentence fragments. Use one complete ICU message with rich-text tags so translators control link placement and punctuation.",
    },
  },
  create(context) {
    const resolveMessage = createMessageResolver(context);

    function expression(node: TS.Node): Parts {
      const text = staticString(node);
      if (text !== undefined) {
        // Explicit label/list separators are boundaries, not prose continuation.
        return /[:：\n|]/u.test(text) ? [undefined] : [{ text }];
      }
      if (node.type === "CallExpression") {
        const callee = node.callee;
        if (
          isFormatJsMessageCall(asNode(callee)) &&
          (callee.type !== "Identifier" || callee.name === "formatMessage")
        ) {
          const argument = node.arguments[0];
          const message = argument ? resolveMessage(asNode(argument)) : undefined;
          return message === undefined ? [undefined] : [{ text: message, message: true }];
        }
      }
      if (node.type === "BinaryExpression" && node.operator === "+")
        return [...expression(node.left), ...expression(node.right)];
      if (node.type === "TemplateLiteral") {
        return node.quasis.flatMap((quasi, index) => [
          ...expression(quasiAsLiteral(quasi)),
          ...(node.expressions[index] ? expression(node.expressions[index]!) : []),
        ]);
      }
      if (node.type === "JSXElement" || node.type === "JSXFragment") return jsx(node, false);
      return [undefined];
    }

    function quasiAsLiteral(quasi: TS.TemplateElement): TS.Literal {
      return { type: "Literal", value: quasi.value.cooked ?? quasi.value.raw } as TS.Literal;
    }

    function attribute(node: TS.JSXOpeningElement, name: string): string | undefined {
      const attr = node.attributes.find(
        (a): a is TS.JSXAttribute =>
          a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name,
      );
      return attr ? jsxAttributeText(attr) : undefined;
    }

    function elementName(opening: TS.JSXOpeningElement): string | undefined {
      const name = jsxElementName(opening.name);
      return name === "Content" ? attribute(opening, "component") : name;
    }

    function isCompositionExpression(node: TS.Node): boolean {
      return (
        node.type === "TemplateLiteral" ||
        (node.type === "BinaryExpression" && node.operator === "+")
      );
    }

    function jsx(node: TS.JSXElement | TS.JSXFragment, root: boolean): Parts {
      let link = false;
      if (node.type === "JSXElement") {
        const opening = node.openingElement;
        const name = jsxElementName(opening.name);
        if (name === "FormattedMessage") {
          if (opening.attributes.some((a) => a.type === "JSXSpreadAttribute")) {
            if (opening.attributes.length !== 1) return [undefined];
            const spread = opening.attributes[0] as TS.JSXSpreadAttribute;
            const text = resolveMessage(asNode(spread.argument));
            return text === undefined ? [undefined] : [{ text, message: true }];
          }
          const text = attribute(opening, "defaultMessage");
          return text === undefined ? [undefined] : [{ text, message: true }];
        }
        const element = elementName(opening);
        if (!root && (!element || !inlineElements.has(element))) return [undefined];
        link = element === "a";
      }
      return node.children
        .flatMap((child): Parts => {
          if (child.type === "JSXText")
            return /[:：|]/u.test(child.value) ? [undefined] : [{ text: child.value }];
          if (child.type === "JSXExpressionContainer") {
            if (child.expression.type === "JSXEmptyExpression") return [];
            const parts = expression(child.expression);
            // A self-contained expression owns its diagnostic; do not report it again as JSX.
            return isCompositionExpression(child.expression) && hasComposition(parts, true)
              ? [undefined]
              : parts;
          }
          if (child.type === "JSXElement" || child.type === "JSXFragment") return jsx(child, false);
          return [undefined];
        })
        .map((part) => (part && link ? { ...part, link: true } : part));
    }

    function hasComposition(parts: Parts, explicit: boolean): boolean {
      let run: Part[] = [];
      const joinsFragments = () => {
        const messages = run.filter((part) => part.message && !part.link && part.text.trim());
        if (!messages.length) return false;
        const outside = run
          .filter((part) => !part.link)
          .map((part) => part.text)
          .join("");
        const linked = run.some((part) => part.link);
        // No grammar inference: require sentence punctuation and an open message boundary.
        // Bare adjacent labels and complete independent sentences remain valid.
        return (
          sentenceMark.test(outside) &&
          messages.some(
            (part) =>
              !closedBoundary.test(part.text.replace(/<\/[A-Za-z][\w]*>/gu, "").trim()) ||
              /^\s*[,;，、；]/u.test(part.text),
          ) &&
          (linked ||
            (run.filter((part) => part.message).length > 1 &&
              (explicit || messages.some((part) => /^\s*[,;，、；]/u.test(part.text)))))
        );
      };
      for (const part of [...parts, undefined]) {
        if (part) {
          run.push(part);
          continue;
        }
        if (joinsFragments()) return true;
        run = [];
      }
      return false;
    }

    function check(node: TS.Node, parts: Parts, explicit: boolean) {
      if (hasComposition(parts, explicit))
        context.report({ node: asNode(node), messageId: "composition" });
    }

    return {
      JSXElement(node: TS.JSXElement) {
        const element = elementName(node.openingElement);
        if (
          (node.parent.type === "JSXElement" || node.parent.type === "JSXFragment") &&
          element &&
          inlineElements.has(element)
        )
          return;
        check(node, jsx(node, true), false);
      },
      JSXFragment(node: TS.JSXFragment) {
        if (node.parent.type !== "JSXElement" && node.parent.type !== "JSXFragment")
          check(node, jsx(node, true), false);
      },
      BinaryExpression(node) {
        const expressionNode = node as unknown as TS.BinaryExpression;
        if (
          node.operator === "+" &&
          !(
            expressionNode.parent.type === "BinaryExpression" &&
            expressionNode.parent.operator === "+"
          ) &&
          expressionNode.parent.type !== "TemplateLiteral"
        )
          check(expressionNode, expression(expressionNode), true);
      },
      TemplateLiteral(node) {
        if (isCompositionExpression((node as unknown as TS.TemplateLiteral).parent)) return;
        check(
          node as unknown as TS.TemplateLiteral,
          expression(node as unknown as TS.TemplateLiteral),
          true,
        );
      },
    };
  },
};
export default rule;
