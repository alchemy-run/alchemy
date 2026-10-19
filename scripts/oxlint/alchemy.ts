import * as path from "node:path";

/**
 * Oxlint plugin with alchemy's repo-specific rules.
 *
 * `alchemy/package-boundaries` enforces the boundaries `packages/alchemy/src`
 * will be split along: a provider-free core (`alchemy`) plus one package per
 * provider in {@link PROVIDERS}.
 *
 * - A provider directory never imports another provider directory.
 * - Core (every other directory and the root files) never imports a provider
 *   directory, nor a `@distilled.cloud/*` package other than `core`.
 * - No string names another provider's resource type (`"Cloudflare.Worker"`
 *   inside `Neon/`): that's a binding switching on a foreign host's `Type`,
 *   coupling the import graph can't see. Rename `aliases: [...]` are exempt.
 *
 * Pre-existing violations carry an `oxlint-disable` comment naming the phase of
 * the split that removes them.
 */

const srcRoot = path.join(import.meta.dirname, "../../packages/alchemy/src");

/** Top-level `src` directories that become their own package. */
const PROVIDERS = new Set<string>([]);

const CORE = "core";

// `rel` is a file (`AWS/S3/Bucket.ts`) or a directory import (`AWS`, from
// `@alchemy.run/aws`). Root files (`Resource.ts`) are core.
const packageOf = (rel: string): string => {
  const top = rel.split("/")[0]!;
  const isRootFile = !rel.includes("/") && /\.tsx?$/.test(rel);
  return PROVIDERS.has(top) && !isRootFile ? top : CORE;
};

const resolveSpecifier = (fromRel: string, specifier: string): string | undefined => {
  if (specifier.startsWith("alchemy/")) return specifier.slice("alchemy/".length);
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  }
  return undefined;
};

// `AWS.Lambda.Function`, `Cloudflare.Worker`: dot-separated PascalCase segments.
const TYPE_NAME = /^([A-Z][A-Za-z0-9]*)(?:\.[A-Z][A-Za-z0-9]*)+$/;

interface Node {
  type: string;
  parent?: Node;
  value?: unknown;
  key?: Node & { name?: string };
  source?: Node | null;
  argument?: Node & { literal?: Node };
}

interface Context {
  filename: string;
  report(diagnostic: { node: Node; messageId: string; data?: Record<string, string> }): void;
}

/** Whether `node` is an element of an `aliases: [ … ]` array (pre-rename type names). */
const isAlias = (node: Node) => {
  const array = node.parent;
  const property = array?.parent;
  if (array?.type !== "ArrayExpression" || property?.type !== "Property") return false;
  const key = property.key;
  return key?.name === "aliases" || key?.value === "aliases";
};

const packageBoundaries = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep packages/alchemy/src splittable into a provider-free core plus one package per provider.",
    },
    messages: {
      providerImport:
        "{{own}} must not import {{target}}. Providers only meet through core services.",
      coreImport:
        "Core must not import {{target}}. Move the code into the provider, or register it through a plugin.",
      coreDistilled: "Core must not depend on {{target}}; only @distilled.cloud/core.",
      providerType:
        '"{{value}}" names another provider\'s resource type. Pass values through the env channel (RuntimeContext) instead of matching host types.',
    },
  },
  create(context: Context) {
    const relative = path.relative(srcRoot, context.filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return {};
    const rel = relative.split(path.sep).join("/");
    const own = packageOf(rel);

    // Reported on the statement so a disable comment sits above `import`,
    // not inside a multi-line import's braces.
    const checkImport = (node: Node, source: Node | null | undefined) => {
      const specifier = source?.value;
      if (typeof specifier !== "string") return;
      if (specifier.startsWith("@distilled.cloud/")) {
        const target = specifier.split("/").slice(0, 2).join("/");
        if (own === CORE && target !== "@distilled.cloud/core") {
          context.report({ node, messageId: "coreDistilled", data: { target } });
        }
        return;
      }
      const resolved = resolveSpecifier(rel, specifier);
      if (resolved === undefined || resolved.startsWith("..")) return;
      const target = packageOf(resolved);
      if (target === CORE || target === own) return;
      context.report({
        node,
        messageId: own === CORE ? "coreImport" : "providerImport",
        data: { own, target },
      });
    };

    return {
      ImportDeclaration: (node: Node) => checkImport(node, node.source),
      ExportNamedDeclaration: (node: Node) => checkImport(node, node.source),
      ExportAllDeclaration: (node: Node) => checkImport(node, node.source),
      ImportExpression: (node: Node) => checkImport(node, node.source),
      TSImportType: (node: Node) => checkImport(node, node.argument?.literal ?? node.argument),
      Literal: (node: Node) => {
        if (typeof node.value !== "string") return;
        const prefix = TYPE_NAME.exec(node.value)?.[1];
        if (prefix === undefined || !PROVIDERS.has(prefix) || prefix === own) return;
        if (isAlias(node)) return;
        context.report({ node, messageId: "providerType", data: { value: node.value } });
      },
    };
  },
};

export default {
  meta: { name: "alchemy" },
  rules: { "package-boundaries": packageBoundaries },
};
