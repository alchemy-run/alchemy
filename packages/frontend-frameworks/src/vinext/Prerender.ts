import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
 * The KV data-cache adapter throws during local prerender (no Worker
 * `env`) and vinext may log a wrangler.jsonc snippet. That hint is
 * wrong on the Alchemy path — drop those lines so deploy logs do not
 * look like a missing Wrangler file.
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
  if (!vinextRoot) {
    return { ran: false } satisfies VinextPrerenderResult;
  }

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
 * Locate the project's `vinext` install. Returns `undefined` when the
 * package is not a dependency of `root` — non-vinext Vite sites.
 */
export const resolveVinextRoot = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.try({
      try: () => {
        const requireFromRoot = createRequire(path.join(root, "package.json"));
        return path.dirname(requireFromRoot.resolve("vinext/package.json"));
      },
      catch: () => new Error("vinext is not installed"),
    }).pipe(Effect.orElseSucceed(() => undefined));
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
