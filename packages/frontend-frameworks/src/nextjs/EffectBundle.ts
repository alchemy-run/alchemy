/**
 * OpenNext artifact takeover for effectful `Cloudflare.Website.Nextjs`
 * (alchemy DESIGN Amendment §2.1.1).
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
 *    re-exports exactly those, re-exports the effect program's own DO
 *    bridge classes, and default-exports the `makeWebsiteExports` wrapper
 *    class — effect-first fetch over `server.routes` with the OpenNext
 *    handler as the outside-routes fallback, and the full non-fetch handler
 *    surface (queue/scheduled/email/RPC) from the Worker bridge dispatch.
 * 3. The final esbuild pass then bundles `alchemy-worker.js` instead of
 *    `worker.js`, with the prebundled effect module kept **external** and
 *    copied verbatim into the module set (workerd accepts multi-module
 *    uploads) so esbuild never re-processes rolldown output.
 *
 * **Stand-down rule**: when the user already mounted the bridge explicitly
 * (`toRouteHandler` in a catch-all route — the `"__ALCHEMY_SERVE_v1__"`
 * sentinel appears in the OpenNext build output), the takeover stands down
 * and the framework-built artifact deploys unchanged.
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
   * Path globs the effect fetch owns (the construct's `server.routes`).
   * Omitted = middleware mode (every request offered to the effect fetch
   * first).
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
 * The wiring-handshake sentinel embedded by `alchemy/serve` (structural
 * mirror of `alchemy/src/Serve/constants.ts` — this package deliberately
 * does not import alchemy). Its presence in the OpenNext build output means
 * the user mounted the bridge explicitly and the takeover must stand down.
 */
export const SERVE_SENTINEL = "__ALCHEMY_SERVE_v1__";

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
 * path, exports a factory the generated wrapper calls with the lazy
 * framework loader, and the effect program's DO bridge classes.
 */
export const makeEffectEntrySource = (
  entry: NextjsEffectEntry,
  mainPath: string,
): string => {
  const needsDo = entry.doClasses.length > 0;
  return [
    `// Generated by alchemy — do not edit. Rolldown input for the effect`,
    `// half of the OpenNext artifact takeover.`,
    `import { ${needsDo ? "DurableObject, " : ""}WorkerEntrypoint } from "cloudflare:workers";`,
    `import { makeWebsiteExports${needsDo ? ", DurableObjectBridge" : ""} } from "alchemy/serve/worker";`,
    `import Site from ${JSON.stringify(mainPath)};`,
    ``,
    `export const makeAlchemyWorker = (framework) =>`,
    `  makeWebsiteExports(WorkerEntrypoint, {`,
    `    site: Site,`,
    ...(entry.routes !== undefined
      ? [`    routes: ${JSON.stringify(entry.routes)},`]
      : []),
    `    framework,`,
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
}): string => {
  const effectModule = `./${EFFECT_MODULE_DIR}/${EFFECT_MODULE_NAME}`;
  return [
    `// Generated by alchemy — OpenNext artifact takeover: one Worker serves`,
    `// the Next.js app (fallback) and the effect program's handlers.`,
    `import { makeAlchemyWorker } from ${JSON.stringify(effectModule)};`,
    ...(options.openNextDoExports.length > 0
      ? [
          `export { ${options.openNextDoExports.join(", ")} } from "./${WORKER_ENTRY_NAME}";`,
        ]
      : []),
    ...(options.effectDoClasses.length > 0
      ? [
          `export { ${options.effectDoClasses.join(", ")} } from ${JSON.stringify(effectModule)};`,
        ]
      : []),
    `export default makeAlchemyWorker(() => import("./${WORKER_ENTRY_NAME}"));`,
    ``,
  ].join("\n");
};

/** `file://` URLs (the `main: import.meta.url` anchor) become plain paths. */
export const effectMainToPath = (mainPath: string): string =>
  mainPath.startsWith("file://") ? fileURLToPath(mainPath) : mainPath;

/**
 * Scan the OpenNext-owned build outputs for the `alchemy/serve` sentinel —
 * NOT alchemy's own generated files, which always embed it. A hit means the
 * user compiled an explicit bridge mount (e.g. `toRouteHandler` in a
 * catch-all route) into the app.
 */
export const scanForServeSentinel = Effect.fn(function* (
  openNextDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const candidates: Array<string> = [];
  const workerEntry = NodePath.join(openNextDirectory, WORKER_ENTRY_NAME);
  if (yield* fs.exists(workerEntry).pipe(Effect.orElseSucceed(() => false))) {
    candidates.push(workerEntry);
  }
  for (const dir of ["middleware", "server-functions"]) {
    const root = NodePath.join(openNextDirectory, dir);
    const entries = yield* fs
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const entry of entries) {
      if (/\.(?:m|c)?js$/.test(entry)) {
        candidates.push(NodePath.join(root, entry));
      }
    }
  }
  for (const file of candidates) {
    const content = yield* fs
      .readFileString(file)
      .pipe(Effect.orElseSucceed(() => ""));
    if (content.includes(SERVE_SENTINEL)) {
      return true;
    }
  }
  return false;
});

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
    if (options.entry.wfClasses.length > 0) {
      return yield* Effect.fail(
        new EffectBundleError({
          message:
            `Workflow classes (${options.entry.wfClasses.join(", ")}) are not ` +
            `yet supported by the Next.js artifact takeover — only Durable ` +
            `Object exports are. Deploy Workflows on a dedicated ` +
            `Cloudflare.Worker for now.`,
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
