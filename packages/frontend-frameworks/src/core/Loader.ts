import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

export class ModuleLoadError extends Data.TaggedError<"ModuleLoadError">(
  "ModuleLoadError",
)<{
  readonly specifier: string;
  readonly root: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Failed to load "${this.specifier}" from "${this.root}"`;
  }
}

/**
 * Import a module from a *project's* dependency tree rather than our own —
 * the project's `vite`, `astro`, `waku`, `next`, etc. must be the instance
 * the framework integration drives, not whatever happens to be hoisted next
 * to this package.
 *
 * Resolution runs `createRequire(<root>/package.json).resolve(specifier)` and
 * imports the resolved absolute path as a `file://` URL (required for ESM
 * `import()` on Windows). If project-relative resolution fails (e.g. a
 * non-linked global install), it falls back to a bare `import(specifier)`.
 */
export const loadProjectModule = <T = unknown>(
  root: string,
  specifier: string,
): Effect.Effect<T, ModuleLoadError> =>
  Effect.tryPromise({
    try: async () => {
      let primary: unknown;
      try {
        const require = createRequire(NodePath.resolve(root, "package.json"));
        const resolved = require.resolve(specifier);
        return (await import(
          /* @vite-ignore */ pathToFileURL(resolved).href
        )) as T;
      } catch (cause) {
        primary = cause;
      }
      try {
        // Fallback: a bare specifier resolves from our own module graph
        // (works for non-linked installs).
        return (await import(/* @vite-ignore */ specifier)) as T;
      } catch (fallback) {
        // The project-relative attempt is the meaningful failure — surface
        // it as the message and cause; the bare fallback failing only says
        // the specifier isn't in OUR graph, so it rides along in `errors`.
        const error = new AggregateError([primary, fallback], String(primary));
        error.cause = primary;
        throw error;
      }
    },
    catch: (cause) => new ModuleLoadError({ specifier, root, cause }),
  });

/**
 * Resolve the directory of a project's installed package (the directory
 * containing its `package.json`). Useful for deep paths that are not in the
 * package's exports map (e.g. `waku/dist/lib/vite-entries/entry.server.js`).
 *
 * Prefer `createRequire(<root>/package.json).resolve(name/package.json)`.
 * When that subpath is not exported (ESM-only packages such as `vinext`),
 * search `require.resolve.paths(name)` — Node's CJS lookup, which Vite's
 * ESM `import.meta.resolve` hooks do not intercept. Do not use
 * `import.meta.resolve(name, projectPackageJson)`: after `vite.createBuilder`
 * those hooks ignore parentURL and resolve from this package instead.
 */
export const resolveProjectPackageDirectory = (
  root: string,
  packageName: string,
): Effect.Effect<string, ModuleLoadError> =>
  Effect.try({
    try: () => {
      const require = createRequire(NodePath.resolve(root, "package.json"));
      try {
        return NodePath.dirname(require.resolve(`${packageName}/package.json`));
      } catch (cause) {
        const fallback = packageDirFromRequirePaths(require, packageName);
        if (fallback !== undefined) return fallback;
        throw cause;
      }
    },
    catch: (cause) =>
      new ModuleLoadError({
        specifier: `${packageName}/package.json`,
        root,
        cause,
      }),
  });

const packageDirFromRequirePaths = (
  require: ReturnType<typeof createRequire>,
  packageName: string,
): string | undefined => {
  for (const dir of require.resolve.paths(packageName) ?? []) {
    const pkgJson = NodePath.join(dir, packageName, "package.json");
    if (!NodeFs.existsSync(pkgJson)) continue;
    try {
      const name = (
        JSON.parse(NodeFs.readFileSync(pkgJson, "utf8")) as { name?: unknown }
      ).name;
      if (name === packageName) return NodePath.dirname(pkgJson);
    } catch {
      continue;
    }
  }
  return undefined;
};

/**
 * Best-effort version of `packageName` as resolved from `fromDirectory`
 * (`undefined` when unresolvable). Used to feature-detect a dependency of a
 * project package — e.g. the Vite that Astro itself resolves — without
 * loading the module.
 */
export const resolveInstalledPackageVersion = (
  fromDirectory: string,
  packageName: string,
): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    try {
      const require = createRequire(
        NodePath.join(fromDirectory, "package.json"),
      );
      const pkg = require(`${packageName}/package.json`) as {
        version?: unknown;
      };
      return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  });
