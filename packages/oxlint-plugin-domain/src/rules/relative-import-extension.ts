import { isRelative } from "../ast.ts";
import type { Node, Rule } from "../types.ts";

/**
 * layout.md: "Inside a package, import with relative paths and the `.ts`
 * extension (`./Account.id.ts`)."
 */
export const relativeImportExtension: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Relative imports name the file with its `.ts` extension." },
    messages: {
      extension:
        "Import `{{source}}` with its extension (`{{source}}.ts`), so the import names the file it comes from.",
    },
  },
  create(context) {
    const check = (node: Node | null | undefined) => {
      if (node?.type !== "Literal" || typeof node.value !== "string") return;
      const source = node.value;
      if (!isRelative(source) || /\.(?:[cm]?tsx?|json|css)$/.test(source)) return;
      context.report({ node, messageId: "extension", data: { source } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};
