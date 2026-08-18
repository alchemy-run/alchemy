/**
 * OpenNext artifact takeover for effectful `Cloudflare.Website.Nextjs`
 * (Serve/DESIGN.md, tier B).
 *
 * Next.js has no bundler seam alchemy controls (webpack/turbopack are not
 * hookable), but the OpenNext artifact is post-framework and alchemy owns
 * the final esbuild pass ({@link import("./Bundle.ts").bundleWorker}). When
 * the Website construct carries an Effect program with wrapper delivery,
 * the build:
 *
 * 1. **Prebundles** the user's site module (the module default-exporting
 *    the Website class, anchored by `main: import.meta.url`) with rolldown
 *    through `@alchemy.run/cloudflare-runtime/rolldown` — the same plugin
 *    family the classic effect-Worker pipeline uses (workerd resolve
 *    conditions, unenv nodejs-compat, `cloudflare:*` externals), with
 *    `globalThis.__ALCHEMY_RUNTIME__` folded to `true` so plan-only code
 *    is dead-code-eliminated — into `.open-next/alchemy-effect/`.
 * 2. **Generates** `.open-next/alchemy-worker.js`: probes which conditional
 *    Durable Object classes `.open-next/worker.js` actually exports and
 *    re-exports exactly those, re-exports the effect program's own DO and
 *    Workflow bridge classes, and default-exports the
 *    `makeWebsiteEntryExports` wrapper class — ADDITIVE-ONLY
 *    (Serve/DESIGN.md): the OpenNext handler (with the user's route-file
 *    mount compiled inside it) serves ALL HTTP verbatim; the wrapper
 *    contributes only what a route file cannot — the non-fetch handler
 *    surface (queue/scheduled/RPC via the Worker bridge dispatch) and the
 *    class exports. HTTP dispatch order, gates, and effect routing are the
 *    mount's code, never generated.
 * 3. The final esbuild pass then bundles `alchemy-worker.js` instead of
 *    `worker.js`, with the prebundled effect module kept **external** and
 *    copied verbatim into the module set (workerd accepts multi-module
 *    uploads) so esbuild never re-processes rolldown output.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_ENTRY_NAME } from "./Bundle.ts";

export class EffectBundleError extends Data.TaggedError<"EffectBundleError">(
  "EffectBundleError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The plain-JSON description of the construct's effect entry, derived from
 * alchemy's `SourceContext.entry` (`kind: "effect"` with wrapper delivery).
 * JSON-serializable — it crosses the build-child boundary.
 */
export interface NextjsEffectEntry {
  /**
   * Absolute path (or `file://` URL — the `main: import.meta.url` anchor)
   * of the module default-exporting the Website class.
   */
  readonly mainPath: string;
  /**
   * Path globs from the construct's `server.routes`. NOT consumed by the
   * generated wrapper (routing is the user's route-file mount's code —
   * Serve/DESIGN.md); still carried for the memo hash and the legacy hmr
   * dev front dispatch until the `server.routes` purge.
   */
  readonly routes?: ReadonlyArray<string> | undefined;
  /** Durable Object class names exported by the effect program. */
  readonly doClasses: ReadonlyArray<string>;
  /** Workflow class names exported by the effect program. */
  readonly wfClasses: ReadonlyArray<string>;
}

/** The generated wrapper entry the final esbuild pass compiles. */
export const TAKEOVER_ENTRY_NAME = "alchemy-worker.js";

/** Directory (under `.open-next/`) holding the prebundled effect module. */
export const EFFECT_MODULE_DIR = "alchemy-effect";

/** The prebundled effect module's entry file (inside {@link EFFECT_MODULE_DIR}). */
export const EFFECT_MODULE_NAME = "alchemy-effect.mjs";

/** The temp rolldown input written next to the OpenNext output. */
const EFFECT_ENTRY_SOURCE_NAME = "alchemy-effect-entry.mjs";

/**
 * The Durable Object classes OpenNext's `worker.js` template re-exports
 * conditionally (per the project's `open-next.config.ts` cache/queue
 * choices). The wrapper generator probes the artifact and re-exports
 * exactly the classes that are present.
 */
export const OPEN_NEXT_DO_CLASSES = [
  "DOQueueHandler",
  "DOShardedTagCache",
  "BucketCachePurge",
] as const;

/** Which of OpenNext's conditional DO classes `worker.js` actually exports. */
export const probeOpenNextDoExports = (workerSource: string): Array<string> =>
  OPEN_NEXT_DO_CLASSES.filter((className) => workerSource.includes(className));

/**
 * The rolldown input source: imports the user's site module by absolute
 * path, exports a factory the generated wrapper calls with the OpenNext
 * handler, and the effect program's DO / Workflow bridge classes.
 *
 * ADDITIVE-ONLY (Serve/DESIGN.md): the OpenNext handler — with the user's
 * route-file mount (`app/api/[[...slug]]/route.ts`) compiled inside it — is
 * grafted verbatim as the ONE fetch handler via `makeWebsiteEntryExports`;
 * the wrapper never route-gates or intercepts. It contributes only what a
 * route file cannot: the non-fetch handler surface (queue/scheduled/RPC via
 * the Worker bridge dispatch) plus the class exports below, all derived
 * from the program's plan-time registrations.
 */
export const makeEffectEntrySource = (
  entry: NextjsEffectEntry,
  mainPath: string,
): string => {
  const needsDo = entry.doClasses.length > 0;
  const needsWf = entry.wfClasses.length > 0;
  return [
    `// Generated by alchemy — do not edit. Rolldown input for the effect`,
    `// half of the OpenNext artifact takeover.`,
    `import { ${needsDo ? "DurableObject, " : ""}WorkerEntrypoint${needsWf ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";`,
    `import { makeWebsiteEntryExports${needsDo ? ", DurableObjectBridge" : ""}${needsWf ? ", WorkflowBridge" : ""} } from "alchemy/Serve/Worker";`,
    `import Site from ${JSON.stringify(mainPath)};`,
    ``,
    `// Additive: the OpenNext handler (the user's route-file mount rides`,
    `// inside it) serves ALL HTTP verbatim; the wrapper adds the platform`,
    `// surface (queue/scheduled/RPC dispatch and the class exports below).`,
    `export const makeAlchemyWorker = (framework) =>`,
    `  makeWebsiteEntryExports(WorkerEntrypoint, {`,
    `    site: Site,`,
    `    fetch: (request, env, ctx) => framework.fetch(request, env, ctx),`,
    `  });`,
    ...(needsDo
      ? [
          ``,
          `const __AlchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: Site });`,
          ...entry.doClasses.map(
            (className) =>
              `export class ${className} extends __AlchemyDurableObjectBridge(${JSON.stringify(className)}) {}`,
          ),
        ]
      : []),
    ...(needsWf
      ? [
          ``,
          `const __AlchemyWorkflowBridge = WorkflowBridge(WorkflowEntrypoint, { site: Site });`,
          ...entry.wfClasses.map(
            (className) =>
              `export class ${className} extends __AlchemyWorkflowBridge(${JSON.stringify(className)}) {}`,
          ),
        ]
      : []),
    ``,
  ].join("\n");
};

/**
 * The generated `.open-next/alchemy-worker.js` — the entry the final
 * esbuild pass compiles instead of `worker.js`.
 */
export const makeTakeoverWorkerSource = (options: {
  /** OpenNext DO classes probed from `worker.js` (re-exported verbatim). */
  readonly openNextDoExports: ReadonlyArray<string>;
  /** The effect program's DO classes (re-exported from the prebundle). */
  readonly effectDoClasses: ReadonlyArray<string>;
  /** The effect program's Workflow classes (re-exported from the prebundle). */
  readonly effectWfClasses: ReadonlyArray<string>;
}): string => {
  const effectModule = `./${EFFECT_MODULE_DIR}/${EFFECT_MODULE_NAME}`;
  const effectClasses = [
    ...options.effectDoClasses,
    ...options.effectWfClasses,
  ];
  return [
    `// Generated by alchemy — OpenNext artifact takeover: the Next.js app`,
    `// (with the user's route-file mount inside) serves ALL HTTP; the`,
    `// wrapper adds the effect program's platform surface.`,
    `import framework from "./${WORKER_ENTRY_NAME}";`,
    `import { makeAlchemyWorker } from ${JSON.stringify(effectModule)};`,
    ...(options.openNextDoExports.length > 0
      ? [
          `export { ${options.openNextDoExports.join(", ")} } from "./${WORKER_ENTRY_NAME}";`,
        ]
      : []),
    ...(effectClasses.length > 0
      ? [
          `export { ${effectClasses.join(", ")} } from ${JSON.stringify(effectModule)};`,
        ]
      : []),
    `export default makeAlchemyWorker(framework);`,
    ``,
  ].join("\n");
};

/** `file://` URLs (the `main: import.meta.url` anchor) become plain paths. */
export const effectMainToPath = (mainPath: string): string =>
  mainPath.startsWith("file://") ? fileURLToPath(mainPath) : mainPath;

/**
 * Copy alchemy's pure-annotation transform when it is resolvable (the
 * deploying project always installs `alchemy` next to this package): it
 * annotates top-level calls in `effect`/`alchemy`/`@distilled.cloud/*`
 * modules as `#__PURE__` so the IaC half of the site module's import graph
 * tree-shakes out of the runtime bundle. Resolution failure degrades to a
 * define-only bundle (correct, larger) with a warning.
 */
const loadPurePlugin = Effect.fn(function* () {
  const specifier = "alchemy/Bundle";
  const loaded = yield* Effect.tryPromise(
    () => import(/* @vite-ignore */ specifier) as Promise<any>,
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (loaded === undefined || typeof loaded.purePlugin !== "function") {
    yield* Effect.logWarning(
      "alchemy/Bundle could not be resolved — prebundling the effect module " +
        "without pure-annotation tree-shaking (the bundle will be larger).",
    );
    return undefined;
  }
  return loaded.purePlugin({});
});

/**
 * Rebuild any `builtin:esm-external-require` plugin instance with the
 * rolldown copy this package invokes (mirror of alchemy's
 * `Sources/Rolldown.ts` — see alchemy#880: a builtin constructed by a
 * foreign rolldown copy fails rolldown's `instanceof` check and is silently
 * treated as hookless, leaving CJS requires on the throwing shim).
 */
const rebindEsmExternalRequirePlugin = (
  plugins: Array<unknown>,
  esmExternalRequirePlugin: (options: unknown) => unknown,
): Array<unknown> =>
  plugins.map((plugin) => {
    if (
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      (plugin as { name: unknown }).name === "builtin:esm-external-require" &&
      "_options" in plugin
    ) {
      return esmExternalRequirePlugin(
        (plugin as { _options: unknown })._options,
      );
    }
    return plugin;
  });

export interface BundleEffectModuleOptions {
  /** The `.open-next` directory produced by the OpenNext build pipeline. */
  readonly openNextDirectory: string;
  /** The Next.js project root (module-resolution context for `alchemy`). */
  readonly rootDir: string;
  readonly entry: NextjsEffectEntry;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: ReadonlyArray<string>;
}

/**
 * Rolldown-prebundle the site module into
 * `.open-next/alchemy-effect/alchemy-effect.mjs` (+ lazy chunks).
 */
export const bundleEffectModule = (
  options: BundleEffectModuleOptions,
): Effect.Effect<void, EffectBundleError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fail = (message: string) => (cause: unknown) =>
      new EffectBundleError({ message, cause });

    const mainPath = effectMainToPath(options.entry.mainPath);
    if (!(yield* fs.exists(mainPath).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* Effect.fail(
        new EffectBundleError({
          message:
            `The effect program's module (main: ${mainPath}) does not exist. ` +
            `Pass \`main: import.meta.url\` from the module that ` +
            `default-exports the Website class.`,
        }),
      );
    }
    const [
      { default: cloudflareRolldown },
      { esmExternalRequirePlugin },
      rolldown,
    ] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          import("@alchemy.run/cloudflare-runtime/rolldown"),
          import("rolldown/plugins"),
          import("rolldown"),
        ]),
      catch: fail("Failed to load rolldown for the effect prebundle"),
    });
    const purePlugin = yield* loadPurePlugin();

    const entrySourcePath = NodePath.join(
      options.openNextDirectory,
      EFFECT_ENTRY_SOURCE_NAME,
    );
    yield* fs
      .writeFileString(
        entrySourcePath,
        makeEffectEntrySource(options.entry, mainPath),
      )
      .pipe(Effect.mapError(fail("Failed to write the effect entry source")));

    const outDirectory = NodePath.join(
      options.openNextDirectory,
      EFFECT_MODULE_DIR,
    );
    yield* fs.remove(outDirectory, { recursive: true }).pipe(Effect.ignore);

    yield* Effect.tryPromise({
      try: async () => {
        const bundle = await rolldown.rolldown({
          input: entrySourcePath,
          cwd: options.rootDir,
          external: ["lightningcss", "fsevents"],
          plugins: [
            rebindEsmExternalRequirePlugin(
              cloudflareRolldown({
                compatibilityDate: options.compatibilityDate,
                compatibilityFlags: [...options.compatibilityFlags],
              }) as Array<unknown>,
              esmExternalRequirePlugin as (options: unknown) => unknown,
            ) as never,
            purePlugin as never,
          ],
          transform: {
            define: {
              "globalThis.__ALCHEMY_RUNTIME__": "true",
            },
          },
          moduleTypes: {
            ".sql": "text",
            ".txt": "text",
            ".html": "text",
          },
          optimization: {
            inlineConst: { mode: "smart", pass: 3 },
          },
          checks: {
            unresolvedImport: false,
            ineffectiveDynamicImport: false,
          },
        });
        const result = await bundle.write({
          dir: outDirectory,
          format: "esm",
          minify: true,
          keepNames: true,
          strictExecutionOrder: true,
          sourcemap: false,
          entryFileNames: EFFECT_MODULE_NAME,
          chunkFileNames: "chunks/[name]-[hash].mjs",
        });
        await bundle.close();
        return result;
      },
      catch: fail("The effect prebundle (rolldown) failed"),
    });

    yield* fs.remove(entrySourcePath).pipe(Effect.ignore);
  });
