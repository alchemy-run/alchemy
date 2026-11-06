import * as path from "node:path";
import { isRelative } from "../ast.ts";
import { packageRoot } from "../files.ts";
import type { Node, Rule } from "../types.ts";

const ALLOWED = ["@alchemy.run/domain", "effect"];
/**
 * Type-only imports allowed by default. A port's methods may require
 * `RuntimeContext` from `alchemy` (building-blocks.md, "Projection and its
 * port"), which is erased at runtime.
 */
const ALLOWED_TYPES = ["alchemy"];

const matches = (source: string, allowed: string) =>
  source === allowed || source.startsWith(`${allowed}/`);

/**
 * SKILL.md: "The domain package imports only `@alchemy.run/domain` and `effect`.
 * Cloudflare, Stripe, databases and HTTP session handling belong to the server package."
 *
 * Enable it on the domain package's source (`overrides[].files`). Relative
 * imports must stay inside the package. Type-only imports of `alchemy` are
 * allowed (a port may require `RuntimeContext`); set `allowTypes` to change that.
 * `allowPaths` lists directories (absolute, or relative to the lint's working
 * directory) a relative import may leave the package for, such as a pure
 * module shared with a package that has not moved yet.
 */
export const domainImports: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The domain package imports only `@alchemy.run/domain`, `effect` and its own files.",
    },
    messages: {
      forbidden:
        "The domain package imports only `@alchemy.run/domain` and `effect`, not `{{source}}`. Move code that needs it to the server package, behind a port or an external system.",
      outside:
        "`{{source}}` leaves the domain package. Import other packages by name, and only `@alchemy.run/domain` and `effect`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          allowTypes: { type: "array", items: { type: "string" } },
          allowPaths: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = (context.options[0] ?? {}) as {
      allow?: ReadonlyArray<string>;
      allowTypes?: ReadonlyArray<string>;
      allowPaths?: ReadonlyArray<string>;
    };
    const allowed = [...ALLOWED, ...(options.allow ?? [])];
    const allowedTypes = [...allowed, ...(options.allowTypes ?? ALLOWED_TYPES)];
    const root = packageRoot(context.filename);
    const allowedPaths = (options.allowPaths ?? []).map((dir) => path.resolve(context.cwd, dir));
    const inside = (dir: string, target: string) => {
      const relative = path.relative(dir, target);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    const check = (node: Node, source: unknown, typeOnly = false) => {
      if (typeof source !== "string") return;
      if (isRelative(source)) {
        if (root === undefined) return;
        const target = path.resolve(path.dirname(context.filename), source);
        if (!inside(root, target) && !allowedPaths.some((dir) => inside(dir, target))) {
          context.report({ node, messageId: "outside", data: { source } });
        }
        return;
      }
      if (!(typeOnly ? allowedTypes : allowed).some((entry) => matches(source, entry))) {
        context.report({ node, messageId: "forbidden", data: { source } });
      }
    };

    return {
      ImportDeclaration: (node) =>
        check(
          node.source,
          node.source.value,
          node.importKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((specifier: Node) => specifier.importKind === "type")),
        ),
      ExportAllDeclaration: (node) =>
        check(node.source, node.source.value, node.exportKind === "type"),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source, node.source.value, node.exportKind === "type");
      },
      ImportExpression: (node) => {
        if (node.source.type === "Literal") check(node.source, node.source.value);
      },
      CallExpression: (node) => {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type === "Literal"
        ) {
          check(node.arguments[0], node.arguments[0].value);
        }
      },
    };
  },
};
