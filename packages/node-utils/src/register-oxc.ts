import * as NodeModule from "node:module";
import {
  registerHooks,
  type LoadFnOutput,
  type LoadHookContext,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import { pathToFileURL } from "node:url";
import {
  filePathOfUrl,
  isFileLikeSpecifier,
  isProjectPath,
  SpecifierResolver,
  splitSpecifierMetadata,
} from "./resolve-specifier.ts";
import { SourceTransformer } from "./transform-source.ts";

export interface OxcLoaderOptions {
  /**
   * Additional package export conditions used during module resolution.
   * They are made available alongside Node's ambient conditions to both the
   * TypeScript-aware resolver and Node's package exports resolver.
   */
  readonly conditions?: ReadonlyArray<string> | undefined;
  /**
   * Honour `tsconfig.json` discovered upward from each file: compiler
   * options for the transform, `paths`/`baseUrl` aliases for resolution.
   * @default true
   */
  readonly tsconfig?: boolean | undefined;
  /** Controls which file URLs belong to the fresh import graph. */
  readonly shouldInvalidate?: ((url: string, parentURL: string | undefined) => boolean) | undefined;
  /**
   * Limits transformation to matching absolute file paths; everything else
   * loads through Node untouched. Lets a published install transpile only
   * the user's own TypeScript while alchemy and its dependencies run their
   * built JavaScript.
   */
  readonly filter?: ((path: string) => boolean) | undefined;
  /**
   * On-disk cache of Oxc output shared by every process on the machine, so
   * the CLI, its dev exec child and the local-provider sidecars transpile
   * each source file once between them rather than once each. `false`
   * disables it, a string names the directory.
   * @default `$ALCHEMY_TRANSFORM_CACHE` (`0` disables), else a per-user
   * directory under the OS temp directory
   */
  readonly cache?: boolean | string | undefined;
}

export interface RegisterOxcOptions extends OxcLoaderOptions {
  /**
   * Isolates one import graph in the runtime's module cache: every file
   * URL the graph resolves carries this namespace as a query parameter, so
   * the same files import again as fresh modules under a new namespace.
   * This is how `alchemy dev` reloads the user's stack (see
   * `watch-import.ts`); an un-namespaced registration is the process-wide
   * TypeScript loader.
   */
  readonly namespace?: string | undefined;
  /** Called once the runtime loads a file in this registration's graph. */
  readonly onImport?: ((url: string) => void) | undefined;
}

export interface OxcLoader {
  /**
   * Imports a file under this registration's namespace. `specifier` is a
   * file URL, an absolute path, or a path relative to `parentURL`.
   */
  import<T = unknown>(specifier: string, parentURL: string): Promise<T>;
  unregister(): void;
}

const namespaceParameter = "alchemy-import-namespace";
const globalRegistrationKey = Symbol.for("@alchemy.run/node-utils/register-oxc");

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput;

const namespaceOf = (url: string | undefined) => {
  if (url === undefined || !url.startsWith("file:")) return undefined;
  return new URL(url).searchParams.get(namespaceParameter) ?? undefined;
};

const withoutNamespace = (url: string) => {
  if (!url.startsWith("file:")) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(namespaceParameter);
  return parsed.href;
};

const withNamespace = (url: string, namespace: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set(namespaceParameter, namespace);
  return parsed.href;
};

/**
 * Node's module compile cache (`module.enableCompileCache`) keeps V8 code
 * cache for compiled modules — transformed TypeScript included, since it is
 * keyed by the compiled source — but Node only persists it once after the
 * entry module evaluated and again on a clean exit. Alchemy processes load
 * most of their graph lazily after that point (commands, the user's stack,
 * provider layers) and usually stop on a signal, so without an explicit
 * flush that code never reaches the cache. Flush once module loading has
 * gone quiet; a no-op when the cache is off or this Node predates it.
 */
const scheduleCompileCacheFlush = (() => {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (NodeModule.getCompileCacheDir?.() === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      NodeModule.flushCompileCache?.();
    }, 1000);
    timer.unref();
  };
})();

/**
 * Whether `require()` breaks inside an imported CommonJS module whose source
 * the load hook supplied (nodejs/node#62920, fixed in 24.18 and 26.2, never
 * in 25.x): Node evaluates it with a stand-in `require` that cannot load ES
 * modules, so a `.cts` requiring TypeScript fails. On these versions the
 * hook leaves imported CommonJS to Node's default load, which defers it to
 * the real CommonJS loader without reading it; that loader's `require()`
 * calls reach the hook again, now in a require context, and are transpiled
 * there. Returning `source: null` directly is rejected by synchronous hooks
 * on older 24.x; Node's default load defers from 24.11.1, alchemy's minimum.
 * A namespaced (reloaded) graph loses its freshness for such files: the
 * CommonJS cache is keyed by path.
 */
const importedCommonJsNeedsNodeLoader = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return (major === 24 && minor < 18) || major === 25 || (major === 26 && minor < 2);
})();

/** Specifiers Node owns outright: builtins, data URLs, remote schemes. */
const isForeignSpecifier = (specifier: string) =>
  /^(?:node:|data:|[a-z][a-z\d+.-]*:\/\/)/i.test(specifier) && !specifier.startsWith("file:");

/**
 * tsx-compatible resolution. Oxc's resolver handles project code the way
 * TypeScript does (tsconfig `paths`, `.js` → `.ts` substitution,
 * extensionless and directory imports); a file it finds is final, as in
 * nub, rather than handed back to Node to resolve a second time. Packages
 * and everything Oxc cannot place stay with Node, which also reports the
 * canonical errors. The format is left to the load step.
 */
const resolveSpecifier = (
  resolver: SpecifierResolver,
  specifier: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput => {
  if (isForeignSpecifier(specifier)) return nextResolve(specifier, context);

  const parentPath = filePathOfUrl(context.parentURL);
  const { specifier: clean, metadata } = splitSpecifierMetadata(specifier);
  const conditions = context.conditions ?? [];

  // TypeScript's rules apply to project code. Dependencies keep Node's plain
  // resolution so published packages behave exactly as they would without us.
  if (parentPath !== undefined && isProjectPath(parentPath)) {
    const candidate = resolver.resolve(parentPath, clean, conditions);
    if (candidate !== undefined) {
      return { url: pathToFileURL(candidate).href + metadata, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
};

/**
 * Key for memoizing a resolution, or `undefined` when it must not be. The
 * result of resolving a specifier depends on the importing module's
 * directory, not the module itself (node_modules lookup, package scope,
 * tsconfig discovery and relative paths are all per directory), and on the
 * conditions. A graph of thousands of modules repeats the same handful of
 * specifiers per directory, so each is resolved once.
 */
const resolutionKey = (specifier: string, context: ResolveHookContext) => {
  const { parentURL } = context;
  if (parentURL === undefined || isForeignSpecifier(specifier)) return undefined;
  const queryIndex = parentURL.search(/[?#]/);
  const parent = queryIndex === -1 ? parentURL : parentURL.slice(0, queryIndex);
  return `${parent.slice(0, parent.lastIndexOf("/") + 1)}\0${specifier}\0${context.conditions.join(",")}`;
};

/**
 * `import data from "./x.json"` without an import attribute is how
 * TypeScript projects import JSON (`resolveJsonModule`); Node insists on
 * `with { type: "json" }` for ESM. Supply it, as tsx does.
 */
const withJsonAttribute = (url: string, context: LoadHookContext) => {
  if (!/\.json(?:[?#]|$)/.test(url) || context.importAttributes?.type) {
    return context;
  }
  return {
    ...context,
    importAttributes: { ...context.importAttributes, type: "json" },
  };
};

/**
 * Registers synchronous Node module hooks that transpile TypeScript with
 * Rolldown's Oxc transformer and resolve it the way TypeScript (and tsx)
 * does. A namespaced registration also provides a scoped import whose
 * namespace propagates through the complete ESM graph.
 */
export const registerOxc = (options: RegisterOxcOptions = {}): OxcLoader => {
  // One global (un-namespaced) registration per process. Alchemy starts every
  // Node process with `--import` of a file that calls this, and in-process
  // callers (the dev exec child, tests) may call it again; a second copy of
  // the hooks would only re-run the resolve chain. The marker lives on
  // globalThis because a checkout can load this module twice (src/ and lib/).
  const globalRegistration = globalThis as typeof globalThis & {
    [globalRegistrationKey]?: OxcLoader;
  };
  if (options.namespace === undefined) {
    const existing = globalRegistration[globalRegistrationKey];
    if (existing !== undefined) return existing;
  }
  const transformer = new SourceTransformer(options);
  const resolver = new SpecifierResolver({
    tsconfig: options.tsconfig ?? true,
  });
  const shouldInvalidate = options.shouldInvalidate ?? (() => true);
  // Per registration: a reloaded graph registers afresh, so files added or
  // removed between generations are seen.
  const resolutions = new Map<string, ResolveFnOutput>();

  // Transformed sources reference their source maps (see transform-source);
  // Node only reads and applies them to stack traces once source-map support
  // is on. `nodeModules` stays on: a published alchemy runs its own `lib/`
  // from `node_modules`, and ships maps back to its `src/`.
  const previousSourceMapsSupport = NodeModule.getSourceMapsSupport();
  NodeModule.setSourceMapsSupport(true, {
    nodeModules: true,
    generatedCode: previousSourceMapsSupport.generatedCode,
  });

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // A graph's entry carries the namespace itself (see `import` below);
      // everything it imports inherits it from the importing module's URL.
      const namespace =
        options.namespace === undefined
          ? undefined
          : (namespaceOf(specifier) ?? namespaceOf(context.parentURL));

      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextResolve(specifier, context);
      }

      const resolutionContext =
        options.conditions === undefined || options.conditions.length === 0
          ? context
          : {
              ...context,
              conditions: [...new Set([...options.conditions, ...context.conditions])],
            };
      const key = resolutionKey(specifier, resolutionContext);
      let resolved = key === undefined ? undefined : resolutions.get(key);
      if (resolved === undefined) {
        resolved = resolveSpecifier(resolver, specifier, resolutionContext, nextResolve);
        // A memoized result skips the rest of the hook chain, which Node
        // only accepts when it says so.
        if (key !== undefined) resolutions.set(key, { ...resolved, shortCircuit: true });
      }
      if (
        namespace !== undefined &&
        resolved.url.startsWith("file:") &&
        shouldInvalidate(
          withoutNamespace(resolved.url),
          context.parentURL === undefined ? undefined : withoutNamespace(context.parentURL),
        )
      ) {
        return { ...resolved, url: withNamespace(resolved.url, namespace) };
      }
      return resolved;
    },
    load(url, context, nextLoad): LoadFnOutput {
      scheduleCompileCacheFlush();
      const namespace = namespaceOf(url);
      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextLoad(url, context);
      }

      const cleanUrl = withoutNamespace(url);
      const filePath = filePathOfUrl(cleanUrl);
      if (filePath === undefined) return nextLoad(cleanUrl, context);
      options.onImport?.(cleanUrl);

      if (options.filter !== undefined && !options.filter(filePath)) {
        return nextLoad(cleanUrl, withJsonAttribute(cleanUrl, context));
      }
      const transformed = transformer.transform(filePath, context.format);
      if (transformed === undefined) {
        return nextLoad(cleanUrl, withJsonAttribute(cleanUrl, context));
      }
      // `importAttributes` is present on every import and absent on require().
      if (
        importedCommonJsNeedsNodeLoader &&
        transformed.format === "commonjs" &&
        context.importAttributes !== undefined
      ) {
        return nextLoad(cleanUrl, { ...context, format: "commonjs" });
      }
      return { ...transformed, shortCircuit: true };
    },
  });

  const loader: OxcLoader = {
    import<T>(specifier: string, parentURL: string) {
      if (!isFileLikeSpecifier(specifier)) {
        throw new Error(`Cannot import '${specifier}': expected a file URL or path.`);
      }
      const base = parentURL.startsWith("file:") ? parentURL : pathToFileURL(parentURL).href;
      const url = specifier.startsWith("file:")
        ? specifier
        : new URL(specifier.startsWith(".") ? specifier : pathToFileURL(specifier).href, base).href;
      return import(
        options.namespace === undefined ? url : withNamespace(url, options.namespace)
      ) as Promise<T>;
    },
    unregister() {
      hooks.deregister();
      if (globalRegistration[globalRegistrationKey] === loader) {
        delete globalRegistration[globalRegistrationKey];
      }
      const { enabled, ...options } = previousSourceMapsSupport;
      NodeModule.setSourceMapsSupport(enabled, options);
    },
  };
  if (options.namespace === undefined) {
    globalRegistration[globalRegistrationKey] = loader;
  }
  return loader;
};
