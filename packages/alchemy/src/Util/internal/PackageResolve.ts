/**
 * Resolve a package specifier the way an ESM `import` in the project would,
 * from the project's directory rather than from alchemy's own install. Under
 * pnpm alchemy usually can't see a project's dependencies, and a CommonJS
 * resolver would pick `require` targets for a module loaded with `import()`.
 *
 * Internal: shared by `Contributions` and `Local/Ingress`; not part of
 * alchemy's public API.
 */
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The conditions an ESM `import` matches. Node picks the first matching key in
 * the `exports` object's own order, so only membership matters here.
 */
const importConditions = new Set(
  typeof Bun !== "undefined" ? ["bun", "import", "node", "default"] : ["import", "node", "default"],
);

/** An `exports` target under {@link importConditions}, with `*` filled in. */
const exportTarget = (target: unknown, star: string): string | undefined => {
  if (typeof target === "string") return target.replaceAll("*", star);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = exportTarget(candidate, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === "object" && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!importConditions.has(condition)) continue;
      const resolved = exportTarget(value, star);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** A package's own subpath (`"."`, `"./Contributions"`) through its `exports` map. */
export const packageExport = (exports: unknown, main: string | undefined, subpath: string) => {
  if (exports === undefined) return subpath === "." ? (main ?? "./index.js") : subpath;
  const entries =
    typeof exports === "object" && exports !== null && !Array.isArray(exports)
      ? Object.entries(exports)
      : [];
  // Subpath keys, or the package's one export ("exports": "./index.js").
  const map = new Map<string, unknown>(
    entries.some(([key]) => key.startsWith(".")) ? entries : [[".", exports]],
  );
  if (map.has(subpath)) return exportTarget(map.get(subpath), "");
  for (const [pattern, target] of map) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return exportTarget(target, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
};

/** Find `node_modules/<name>/package.json` from `dir` upwards. */
export const findDependencyManifest = Effect.fn(function* (dir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = dir;
  while (true) {
    const candidate = path.join(current, "node_modules", name, "package.json");
    if (yield* fs.exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});

/** `@scope/pkg/sub/path` → `["@scope/pkg", "./sub/path"]`; `pkg` → `["pkg", "."]`. */
const splitSpecifier = (specifier: string): readonly [string, string] => {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(size).join("/");
  return [parts.slice(0, size).join("/"), rest === "" ? "." : `./${rest}`];
};

/**
 * The file URL a bare `specifier` imports from a project in `dir`, through the
 * installed package's `exports` with ESM import conditions. `undefined` when
 * the package isn't installed there or doesn't export that subpath. A URL or
 * path (anything not a bare specifier) is returned as it is.
 */
export const resolveFromProject = Effect.fn(function* (specifier: string, dir: string) {
  if (/^([a-z][a-z0-9+.-]*:|\.{0,2}\/)/i.test(specifier)) return specifier;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [name, subpath] = splitSpecifier(specifier);
  const file = yield* findDependencyManifest(dir, name);
  if (file === undefined) return undefined;
  const manifest = yield* fs.readFileString(file).pipe(
    Effect.flatMap((text) =>
      Effect.try(() => JSON.parse(text) as { readonly exports?: unknown; readonly main?: string }),
    ),
    Effect.option,
  );
  if (manifest._tag === "None") return undefined;
  const target = packageExport(manifest.value.exports, manifest.value.main, subpath);
  if (target === undefined) return undefined;
  return pathToFileURL(path.join(path.dirname(file), target)).href;
});
