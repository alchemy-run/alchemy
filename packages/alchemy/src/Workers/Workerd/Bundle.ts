/**
 * The rolldown bundler for Workers-style (workerd API) bundles, shared by
 * every engine that runs them (Cloudflare today). The engine supplies the
 * workerd compatibility plugins and the generated virtual entry.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { workerModulePlugin } from "./WorkerModulePlugin.ts";

/**
 * Bundler options for a Worker: Rolldown input/output overrides and
 * {@link Bundle.BundleExtraOptions}, merged over Alchemy's defaults.
 */
export interface WorkerBuildOptions extends Bundle.BundleConfig {
  /**
   * Rolldown output options merged over Alchemy's defaults. Use this to
   * control chunking (`codeSplitting`), minification, etc.
   */
  output?: rolldown.OutputOptions;
  /**
   * Forwarded to rolldown's `preserveEntrySignatures` input option. Some
   * `output.codeSplitting` configurations require relaxing it (e.g.
   * `includeDependenciesRecursively: false` needs `"allow-extension"`).
   * Workers must keep their entry exports, so never pass `false`.
   */
  preserveEntrySignatures?: rolldown.InputOptions["preserveEntrySignatures"];
}

export interface WorkerBundleOptions {
  id: string;
  main: string;
  compatibility: {
    date: string;
    flags: string[];
  };
  /** How the entry is wrapped: kept as-is, or behind a generated virtual entry. */
  entry: { kind: string };
  stack: { name: string; stage: string };
  extraOptions: WorkerBuildOptions | undefined;
}

/** The engine half of a workerd bundler. */
export interface WorkerBundleEngine<Options extends WorkerBundleOptions> {
  /**
   * The workerd compatibility (nodejs_compat) plugin factory, loaded lazily
   * so importing the engine never loads rolldown's native binding.
   */
  readonly loadCompatPlugins: () => Promise<
    (options: {
      compatibilityDate: string;
      compatibilityFlags: string[];
    }) => Array<rolldown.Plugin | null>
  >;
  /**
   * The generated entry wrapping the user's `main` (a function of the
   * real entry's import path), or `undefined` to bundle `main` as-is.
   */
  readonly virtualEntry: (options: Options) => ((importPath: string) => string) | undefined;
}

/**
 * Rebuild any `builtin:esm-external-require` plugin instance with OUR copy of
 * rolldown.
 *
 * A separately installed or bundled `@alchemy.run/cloudflare-runtime/rolldown`
 * can resolve a physically different copy of rolldown than the one Alchemy
 * invokes. Builtin plugins — here `builtin:esm-external-require`, which
 * rewrites CJS `require`s of Node builtins into ESM imports under
 * `nodejs_compat` — are `BuiltinPlugin` class instances that rolldown
 * recognizes with an `instanceof` check. An instance constructed by the
 * foreign rolldown copy fails that check and is silently treated as a
 * hookless JS plugin, so CJS requires keep rolldown's throwing `require`
 * shim and the Worker fails Cloudflare startup validation (#880).
 * Reconstructing the builtin from its `_options` with the rolldown copy we
 * actually invoke makes the identity check pass regardless of which copy the
 * plugin package resolved.
 */
const configureCompatPlugins = (
  plugins: Array<rolldown.Plugin | null>,
  esmExternalRequirePlugin: (typeof import("rolldown/plugins"))["esmExternalRequirePlugin"],
  aliases: NonNullable<rolldown.InputOptions["resolve"]>["alias"],
): Array<rolldown.Plugin | null> => {
  const aliasKeys = Object.entries(aliases ?? {})
    .filter(([, value]) => !Array.isArray(value) || value.length > 0)
    .map(([key]) => key);
  const isAliased = (id: string) =>
    aliasKeys.some((key) => {
      if (key.endsWith("$")) return id === key.slice(0, -1);
      const wildcard = key.indexOf("*");
      if (wildcard !== -1) {
        const prefix = key.slice(0, wildcard);
        const suffix = key.slice(wildcard + 1);
        return (
          id.length >= prefix.length + suffix.length && id.startsWith(prefix) && id.endsWith(suffix)
        );
      }
      return id === key || id.startsWith(`${key}/`) || id.startsWith(`${key}\\`);
    });
  return plugins.map((plugin) => {
    if (
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      plugin.name === "builtin:esm-external-require" &&
      "_options" in plugin
    ) {
      const options = plugin._options as Parameters<typeof esmExternalRequirePlugin>[0];
      return esmExternalRequirePlugin(
        options && {
          ...options,
          external: options.external.filter((id) => typeof id !== "string" || !isAliased(id)),
        },
      ) as rolldown.Plugin;
    }
    // Let Rolldown resolve user aliases before compatibility polyfills.
    if (plugin?.resolveId && aliasKeys.length > 0) {
      const hook = plugin.resolveId;
      const handler = typeof hook === "function" ? hook : hook.handler;
      return {
        ...plugin,
        resolveId: {
          ...(typeof hook === "function" ? {} : hook),
          handler(source, importer, options) {
            if (isAliased(source)) return null;
            return handler.call(this, source, importer, options);
          },
        },
      };
    }
    return plugin;
  });
};

export const makeWorkerBundle = <Options extends WorkerBundleOptions>(
  engine: WorkerBundleEngine<Options>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

    const makeOptions = Effect.fn(function* (options: Options) {
      const [compatRolldown, { esmExternalRequirePlugin }] = yield* Effect.promise(() =>
        Promise.all([engine.loadCompatPlugins(), import("rolldown/plugins")]),
      );
      const realMain = yield* sanitizeMain(options.main);
      const virtualEntry = engine.virtualEntry(options);
      const cwd = yield* findCwdForBundle(realMain).pipe(
        Effect.mapError((cause) =>
          Bundle.BundleError.make({
            message: `Failed to find cwd for bundle: ${realMain}`,
            cause,
          }),
        ),
        Effect.provide(context),
      );
      // The workerd compatibility plugin set, shared by the parent build and
      // by every nested `?worker` module build (see WorkerModulePlugin.ts).
      const overrides = options.extraOptions?.input;
      const compatPlugins = () =>
        configureCompatPlugins(
          compatRolldown({
            compatibilityDate: options.compatibility.date,
            compatibilityFlags: options.compatibility.flags,
          }),
          esmExternalRequirePlugin,
          overrides?.resolve?.alias,
        );
      const workerModules: rolldown.Plugin = workerModulePlugin({
        loadRolldown: () => import("rolldown"),
        nested: async () => ({
          external: ["lightningcss", "fsevents"],
          cwd,
          ...overrides,
          plugins: [overrides?.plugins, compatPlugins(), workerModules],
          checks: {
            unresolvedImport: false,
            ineffectiveDynamicImport: false,
            ...overrides?.checks,
          },
        }),
      });
      const inputOptions: rolldown.InputOptions = {
        preserveEntrySignatures: options.extraOptions?.preserveEntrySignatures,
        // Forever-devtool native modules that vite/chokidar reference behind
        // runtime guards. Rolldown resolves before tree-shaking, so the dead
        // `require('../pkg')` (lightningcss < 1.32) and `require('fsevents')`
        // (darwin-only) trip [UNRESOLVED_IMPORT] before DCE can prune them.
        // See rolldown/tsdown#212.
        external: ["lightningcss", "fsevents"],
        cwd,
        ...overrides,
        input: realMain,
        plugins: [
          overrides?.plugins,
          compatPlugins(),
          workerModules,
          virtualEntry === undefined ? undefined : [virtualEntryPlugin(virtualEntry)],
        ],
        checks: {
          // Suppress unresolved import warnings for unrelated AWS packages
          unresolvedImport: false,
          // The shared platform boundary keeps guarded Node/Bun adapter imports.
          ineffectiveDynamicImport: false,
          ...overrides?.checks,
        },
      };
      const outputOptions: rolldown.OutputOptions = {
        format: "esm",
        sourcemap: "hidden",
        minify: true,
        keepNames: true,
        // Rolldown's default chunking can split top-level initializer modules
        // (e.g. Drizzle `pgTable` schemas) away from the classes they read,
        // and workerd then evaluates a reader before its imported binding is
        // initialized — the script fails Cloudflare startup validation with
        // `ScriptStartupError: Cannot access '<minified>' before
        // initialization` (#749). `strictExecutionOrder` wraps cross-chunk
        // modules so evaluation follows ESM semantics regardless of how the
        // graph was chunked. See DrizzleSchemaChunks.test.ts.
        strictExecutionOrder: true,
        ...options.extraOptions?.output,
      };
      return { inputOptions, outputOptions, extraOptions: options.extraOptions };
    });

    const sanitizeMain = (main: string) =>
      resolveMainPath(main).pipe(
        Effect.mapError((cause) =>
          Bundle.BundleError.make({
            message: `Failed to find real path for bundle: ${main}`,
            cause,
          }),
        ),
        Effect.provide(context),
      );

    return {
      build: flow(
        makeOptions,
        Effect.flatMap((resolved) =>
          Bundle.build(resolved.inputOptions, resolved.outputOptions, resolved.extraOptions),
        ),
      ),
      watch: flow(
        makeOptions,
        Stream.fromEffect,
        Stream.flatMap((resolved) =>
          Bundle.watch(resolved.inputOptions, resolved.outputOptions, resolved.extraOptions),
        ),
      ),
    };
  });
