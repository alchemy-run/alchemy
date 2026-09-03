import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleLoadError } from "../core/Loader.ts";

export type VinextPrerenderResult = {
  readonly ran: boolean;
  /** Absolute path of the RSC worker entry after path-table injection. */
  readonly entryPath?: string;
};

const PATH_TABLE_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const PATH_TABLE_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";

const exists = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));

/**
 * vinext's `kvDataAdapter()` throws during local prerender (no Worker
 * `env`) and then logs a wrangler.jsonc snippet. That hint is wrong on
 * the Alchemy path — drop those lines so deploy logs do not look like
 * a missing Wrangler file.
 */
const isWranglerKvHint = (text: string) =>
  text.includes("failed to initialize the configured data cache adapter") ||
  text.includes("Add it to wrangler.jsonc") ||
  (text.includes("KV data cache adapter requires") &&
    text.includes("KV namespace binding")) ||
  text.includes('"kv_namespaces"');

const withLocalPrerenderLogs = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      };
      const filter =
        (write: typeof console.log) =>
        (...args: Array<unknown>) => {
          const text = args.map((arg) => String(arg)).join(" ");
          if (isWranglerKvHint(text)) return;
          write(...args);
        };
      console.log = filter(original.log);
      console.warn = filter(original.warn);
      console.error = filter(original.error);
      console.info = filter(original.info);
      return original;
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
        console.info = original.info;
      }),
  );

/**
 * After `vite build`, run vinext's prerender phase when the project
 * configured `vinext({ prerender: true })` (or `{ routes: "*" }`).
 *
 * Alchemy's Website Vite path only runs `vite build`, which vinext does
 * not prerender by itself — that step lives in `vinext build`. This hook
 * is not a reimplementation: it resolves the project's `vinext` and calls
 * `runPrerender` / `emitPrerenderPathManifest`. The path-table injection
 * is the only Alchemy-owned glue.
 */
export const runVinextPrerenderIfConfigured = Effect.fn(function* (
  rootDir: string,
) {
  const path = yield* Path.Path;
  const root = path.resolve(rootDir);
  const vinextRoot = yield* resolveVinextRoot(root);

  const importVinextDist = (rel: string) =>
    Effect.promise(
      () => import(pathToFileURL(path.join(vinextRoot, rel)).href),
    );

  const [
    {
      loadVinextPrerenderConfigFromViteConfig,
      resolveVinextPrerenderDecision,
      formatVinextPrerenderLabel,
    },
    vite,
  ] = yield* Effect.all(
    [
      importVinextDist("dist/config/prerender.js"),
      Effect.promise(() => import("vite")),
    ],
    { concurrency: "unbounded" },
  );

  const prerenderConfig = yield* Effect.promise(() =>
    loadVinextPrerenderConfigFromViteConfig(vite, root),
  );
  const decision = resolveVinextPrerenderDecision({
    vinextPrerenderConfig: prerenderConfig,
  });
  if (!decision) {
    return { ran: false } satisfies VinextPrerenderResult;
  }

  yield* Console.log(`  ${formatVinextPrerenderLabel(decision)}`);
  yield* Console.log(
    "  Local prerender has no Worker bindings. VINEXT_KV_CACHE is provisioned and seeded on deploy; do not add wrangler.jsonc.",
  );

  const { runPrerender, assertNoFatalPrerenderRoutes } =
    (yield* importVinextDist("dist/build/run-prerender.js")) as {
      runPrerender: (options: {
        root: string;
      }) => Promise<{ routes?: readonly unknown[] } | null>;
      assertNoFatalPrerenderRoutes: (routes: readonly unknown[]) => void;
    };
  const prerenderResult = yield* withLocalPrerenderLogs(
    Effect.promise(() => runPrerender({ root })),
  );
  if (prerenderResult?.routes) {
    assertNoFatalPrerenderRoutes(prerenderResult.routes);
  }

  const { emitPrerenderPathManifest } = yield* importVinextDist(
    "dist/build/prerender-paths.js",
  );
  yield* Effect.promise(() => emitPrerenderPathManifest({ root }));
  yield* injectPregeneratedConcretePaths(root);

  const fs = yield* FileSystem.FileSystem;
  const entryPath = path.join(root, "dist", "server", "index.js");
  return {
    ran: true,
    entryPath: (yield* exists(fs, entryPath)) ? entryPath : undefined,
  } satisfies VinextPrerenderResult;
});

/**
 * Absolute path to the project's `vinext` package root.
 *
 * Prefer `import.meta.resolve("vinext")` over
 * `createRequire(...).resolve("vinext/package.json")` — that subpath is
 * not in vinext's `exports`, and CJS resolve misses the ESM `import`
 * condition under Node.
 */
export const resolveVinextRoot = (
  root: string,
): Effect.Effect<string, ModuleLoadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const resolvedRoot = path.resolve(root);
    const from = pathToFileURL(path.join(resolvedRoot, "package.json")).href;

    const entry = yield* Effect.try({
      try: () => fileURLToPath(import.meta.resolve("vinext", from)),
      catch: (cause) =>
        new ModuleLoadError({
          specifier: "vinext",
          root: resolvedRoot,
          cause,
        }),
    });

    let dir = path.dirname(entry);
    for (;;) {
      const pkgJson = path.join(dir, "package.json");
      if (yield* exists(fs, pkgJson)) {
        const name = yield* fs.readFileString(pkgJson).pipe(
          Effect.map((raw) => {
            try {
              return (JSON.parse(raw) as { name?: unknown }).name;
            } catch {
              return undefined;
            }
          }),
          Effect.mapError(
            (cause) =>
              new ModuleLoadError({
                specifier: "vinext",
                root: resolvedRoot,
                cause,
              }),
          ),
        );
        if (name === "vinext") return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return yield* new ModuleLoadError({
          specifier: "vinext",
          root: resolvedRoot,
          cause: new Error(
            `Resolved "${entry}" but no ancestor package.json has name "vinext"`,
          ),
        });
      }
      dir = parent;
    }
  });

const injectPregeneratedConcretePaths = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const workerEntry = path.join(root, "dist", "server", "index.js");
    if (!(yield* exists(fs, workerEntry))) {
      return;
    }

    const escapedStart = PATH_TABLE_START.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const escapedEnd = PATH_TABLE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");

    let code = (yield* fs.readFileString(workerEntry)).replace(re, "");
    const manifestPath = path.join(
      root,
      "dist",
      "server",
      "vinext-prerender.json",
    );
    if (!(yield* exists(fs, manifestPath))) {
      yield* fs.writeFileString(workerEntry, code);
      return;
    }

    const manifest = JSON.parse(yield* fs.readFileString(manifestPath)) as {
      pregeneratedConcretePaths?: unknown;
    };
    const table = manifest.pregeneratedConcretePaths ?? [];
    if (Array.isArray(table) && table.length > 0) {
      code =
        `${PATH_TABLE_START}\n` +
        `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
        `${PATH_TABLE_END}\n` +
        code;
    }
    yield* fs.writeFileString(workerEntry, code);
  });
