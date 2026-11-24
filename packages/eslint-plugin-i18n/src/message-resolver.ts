import { readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type * as ESTree from "estree";
import { Linter, type Rule, type SourceCode } from "eslint";
import { objectProperty, propertyName, staticString } from "./descriptors.js";

/** Resolve const descriptors and relative source imports without executing consumer code. */
export function createMessageResolver(context: Rule.RuleContext) {
  const modules = new Map<string, SourceCode | undefined>();
  const visiting = new Set<ESTree.Node>();

  function importedSource(from: string, specifier: string): [string, SourceCode] | undefined {
    if (!specifier.startsWith(".")) return undefined;
    if (extname(specifier) && ![".ts", ".tsx", ".js", ".jsx"].includes(extname(specifier)))
      return undefined;
    const base = resolve(dirname(from), specifier);
    const stem = extname(base) ? base.slice(0, -extname(base).length) : base;
    const candidates = [
      base,
      ...[".ts", ".tsx", ".js", ".jsx"].map((ext) => stem + ext),
      ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => resolve(base, name)),
    ];
    for (const filename of candidates) {
      if (!modules.has(filename)) {
        // Cache failures too; missing dependencies and unsupported syntax are unknowns, not findings.
        modules.set(filename, undefined);
        try {
          if (!statSync(filename).isFile()) continue;
          const linter = new Linter();
          const messages = linter.verify(readFileSync(filename, "utf8"), {
            languageOptions: context.languageOptions,
          });
          if (!messages.some((message) => message.fatal))
            modules.set(filename, linter.getSourceCode());
        } catch {
          // Resolution is deliberately best-effort; this rule does not diagnose module loading.
        }
      }
      const source = modules.get(filename);
      if (source) return [filename, source];
    }
    return undefined;
  }

  function descriptor(
    node: ESTree.Node | undefined,
    source: SourceCode,
    filename: string,
  ): { node: ESTree.Node; source: SourceCode; filename: string } | undefined {
    if (!node || visiting.has(node)) return undefined;
    visiting.add(node);
    try {
      if (node.type === "ObjectExpression") {
        const names = node.properties.map((p) =>
          p.type === "Property" && !p.computed ? propertyName(p) : undefined,
        );
        return names.some((name) => name === undefined) || new Set(names).size !== names.length
          ? undefined
          : { node, source, filename };
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        ["defineMessage", "defineMessages"].includes(node.callee.name)
      ) {
        const argument = node.arguments[0];
        return argument?.type === "SpreadElement"
          ? undefined
          : descriptor(argument, source, filename);
      }
      if (node.type === "MemberExpression") {
        const key = node.computed
          ? staticString(node.property)
          : node.property.type === "Identifier"
            ? node.property.name
            : undefined;
        const object = descriptor(node.object, source, filename);
        return key === undefined || !object
          ? undefined
          : descriptor(objectProperty(object.node, key), object.source, object.filename);
      }
      if (node.type !== "Identifier") return undefined;
      let scope: ReturnType<SourceCode["getScope"]> | null = source.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (!variable) {
          scope = scope.upper;
          continue;
        }
        // Do not infer text from mutable bindings or objects with statically visible writes.
        if (
          variable.references.some((ref) => {
            if (ref.isWrite() && !ref.init) return true;
            let target = ref.identifier as ESTree.Node & { parent?: ESTree.Node };
            while (target.parent?.type === "MemberExpression" && target.parent.object === target)
              target = target.parent;
            const parent = target.parent;
            return (
              (parent?.type === "AssignmentExpression" && parent.left === target) ||
              parent?.type === "UpdateExpression" ||
              (parent?.type === "UnaryExpression" && parent.operator === "delete")
            );
          })
        )
          return undefined;
        const definition = variable.defs[0];
        if (definition?.type === "Variable" && definition.parent.kind === "const") {
          return descriptor(definition.node.init ?? undefined, source, filename);
        }
        if (definition?.type !== "ImportBinding") return undefined;
        const specifier = definition.node;
        const loaded = importedSource(filename, definition.parent.source.value as string);
        if (!loaded || specifier.type === "ImportNamespaceSpecifier") return undefined;
        const [importPath, imported] = loaded;
        for (const statement of imported.ast.body) {
          if (
            specifier.type === "ImportDefaultSpecifier" &&
            statement.type === "ExportDefaultDeclaration" &&
            statement.declaration.type !== "ClassDeclaration" &&
            statement.declaration.type !== "FunctionDeclaration"
          )
            return descriptor(statement.declaration, imported, importPath);
          if (
            specifier.type === "ImportSpecifier" &&
            statement.type === "ExportNamedDeclaration" &&
            statement.declaration?.type === "VariableDeclaration"
          ) {
            const name =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value;
            const declaration = statement.declaration.declarations.find(
              (d) => d.id.type === "Identifier" && d.id.name === name,
            );
            if (statement.declaration.kind === "const" && declaration?.id.type === "Identifier")
              return descriptor(declaration.id, imported, importPath);
          }
        }
        return undefined;
      }
      return undefined;
    } finally {
      visiting.delete(node);
    }
  }

  return (node: ESTree.Node | undefined): string | undefined => {
    const resolved = descriptor(node, context.sourceCode, context.filename);
    return staticString(objectProperty(resolved?.node, "defaultMessage"));
  };
}
