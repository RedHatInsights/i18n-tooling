import fs from 'node:fs';
import path from 'node:path';
import type { Rule } from 'eslint';

type Options = [{ catalog?: string }];
type CatalogEntry = string | { defaultMessage?: unknown };
type Catalog = Record<string, CatalogEntry>;

type CatalogState = {
  ids: Set<string>;
  error?: string;
};

const catalogCache = new Map<string, { mtimeMs: number; state: CatalogState }>();

function staticString(node: any): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  if (
    node?.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }

  return undefined;
}

function propertyName(node: any): string | undefined {
  if (node?.computed) return undefined;
  return node.key?.type === 'Identifier' ? node.key.name : staticString(node.key);
}

function objectProperty(object: any, name: string): any | undefined {
  if (object?.type !== 'ObjectExpression') return undefined;
  return object.properties.find((property: any) => propertyName(property) === name)?.value;
}

function resolveCatalogPath(context: Rule.RuleContext, configuredPath: string | undefined): string {
  const cwd = typeof (context as any).getCwd === 'function' ? (context as any).getCwd() : process.cwd();
  return path.resolve(cwd, configuredPath ?? 'locales/en.json');
}

function loadCatalog(catalogPath: string): CatalogState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(catalogPath);
  } catch (error) {
    return { ids: new Set(), error: `Cannot read catalog ${catalogPath}: ${String(error)}` };
  }

  const cached = catalogCache.get(catalogPath);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.state;

  let state: CatalogState;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('catalog must be a flat JSON object');
    }

    const catalog = parsed as Catalog;
    const ids = new Set(Object.keys(catalog));
    state = { ids };
  } catch (error) {
    state = { ids: new Set(), error: `Cannot parse catalog ${catalogPath}: ${String(error)}` };
  }

  catalogCache.set(catalogPath, { mtimeMs: stat.mtimeMs, state });
  return state;
}

function isFormatJsMessageCall(callee: any): boolean {
  if (callee?.type === 'Identifier') {
    return ['defineMessage', 'defineMessages', 'formatMessage'].includes(callee.name);
  }

  return (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'formatMessage'
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require statically discoverable message IDs in the default catalog.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          catalog: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingCatalog: 'Unable to load default catalog: {{error}}',
      missingEntry: 'Message ID "{{id}}" is missing from the default catalog.',
      dynamicId: 'Message IDs must be static string literals or no-expression templates.',
    },
  },

  create(context) {
    const options = context.options as Options;
    const catalogPath = resolveCatalogPath(context, options[0]?.catalog);
    let catalog: CatalogState | undefined;
    let catalogErrorReported = false;

    function ensureCatalog(node: any): CatalogState {
      catalog ??= loadCatalog(catalogPath);
      if (catalog.error && !catalogErrorReported) {
        catalogErrorReported = true;
        context.report({
          node,
          messageId: 'missingCatalog',
          data: { error: catalog.error },
        });
      }
      return catalog;
    }

    function checkDescriptor(node: any, descriptor: any): void {
      const idNode = descriptor?.type === 'ObjectExpression' ? objectProperty(descriptor, 'id') : undefined;
      if (!idNode) return;

      const id = staticString(idNode);
      if (!id) {
        context.report({ node: idNode, messageId: 'dynamicId' });
        return;
      }

      const state = ensureCatalog(idNode);
      if (!state.error && !state.ids.has(id)) {
        context.report({
          node: idNode,
          messageId: 'missingEntry',
          data: { id },
        });
      }
    }

    function visitDescriptorTree(node: any): void {
      if (node?.type !== 'ObjectExpression') return;
      checkDescriptor(node, node);
      for (const property of node.properties) {
        if (property.type === 'Property') visitDescriptorTree(property.value);
      }
    }

    return {
      Program(node: any) {
        ensureCatalog(node);
      },

      CallExpression(node: any) {
        if (!isFormatJsMessageCall(node.callee)) return;
        const descriptor = node.arguments[0];
        if (node.callee.type === 'Identifier' && node.callee.name === 'defineMessages') {
          visitDescriptorTree(descriptor);
        } else {
          checkDescriptor(node, descriptor);
        }
      },

      JSXOpeningElement(node: any) {
        const name = node.name?.type === 'JSXIdentifier' ? node.name.name : undefined;
        if (name !== 'FormattedMessage') return;

        const idAttribute = node.attributes.find(
          (attribute: any) => attribute.type === 'JSXAttribute' && attribute.name?.name === 'id',
        );
        if (!idAttribute) return;

        const id = staticString(idAttribute.value?.expression ?? idAttribute.value);
        if (!id) {
          context.report({ node: idAttribute, messageId: 'dynamicId' });
          return;
        }

        const state = ensureCatalog(idAttribute);
        if (!state.error && !state.ids.has(id)) {
          context.report({
            node: idAttribute,
            messageId: 'missingEntry',
            data: { id },
          });
        }
      },
    };
  },
};

export default rule;
