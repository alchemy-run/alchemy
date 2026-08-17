/**
 * Effect entry takeover for `Cloudflare.Website.Nuxt` (alchemy DESIGN
 * §2.1.2): generators for the two alchemy-authored modules that deliver an
 * effectful Website program into a Nuxt project without any user
 * `nuxt.config.ts` (or framework-file) edits.
 *
 * - **Production** ({@link renderWorkerEntry}): a nitro entry wrapper,
 *   written under `<root>/.alchemy/nuxt/<id>/` and mapped onto
 *   `nitro.options.entry` through the existing user-entry carriage
 *   (`NuxtTargetConfig.main`). Nitro's rollup bundles it as THE worker
 *   entry, so its exports are the deployed Worker's exports: the default
 *   export is `makeWebsiteExports(...)` from `alchemy/Serve/Worker` —
 *   routes-scoped effect fetch first, nitro's `cloudflare-module` preset
 *   runtime as the framework fallback, and the full non-fetch dispatch
 *   (queue/scheduled/email + RPC) from the underlying Worker bridge — plus
 *   one `DurableObjectBridge` class per Durable Object export collected
 *   from the impl at plan time.
 *
 * - **Dev** ({@link renderEffectHandler}): a nitro middleware handler (h3
 *   v1 `__is_handler__` marker, injected through `nitro.handlers` on the
 *   dev overrides layer) that scopes itself to the effect routes and
 *   delegates to `alchemy/Nitro`'s `toHandler`. It runs inside nitro's dev SSR worker thread, where
 *   `event.context.cloudflare.env` is served by the platform proxy — so
 *   the same bindings resolve in dev, against the local simulators.
 *   Non-fetch handlers (queue/scheduled/DO classes) are production-only on
 *   Nuxt for now: the dev server runs nitro's dev preset entry, not the
 *   deploy entry.
 *
 *   The SAME renderer is the AWS Nuxt delivery module for BOTH modes
 *   (`Nuxt.ts`'s `NuxtOptions.effect`): it is cloud-neutral — nitro
 *   compiles config-injected handlers through the same virtual module into
 *   the aws-lambda prod bundle and the dev SSR worker alike.
 *
 * Both generated modules import the user's site module by absolute path
 * (the `main: import.meta.url` anchor) — the module is re-imported inside
 * the worker/dev bundle exactly as deployed effect Workers re-import their
 * `main`.
 *
 * The production wrapper does NOT hand the raw site module to nitro's
 * rollup: the alchemy/effect import graph contains dev-only reaches (vite,
 * native binaries) that rollup cannot inline, and without alchemy's
 * pure-annotation transform nothing would tree-shake. Instead the site
 * module is **rolldown-prebundled** ({@link bundleNuxtEffectModule}) with
 * the same plugin family the classic effect-Worker pipeline uses (workerd
 * resolve conditions, unenv nodejs-compat, `cloudflare:*` externals,
 * `__ALCHEMY_RUNTIME__` folded to `true`, pure-annotation tree-shaking)
 * into `.alchemy/nuxt/<id>/alchemy-effect/` — and the nitro entry wrapper
 * imports the self-contained prebundle. Mirrors the Next.js artifact
 * takeover (`../nextjs/EffectBundle.ts`).
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { NITRO_HANDLER_SPECIFIER } from "./cloudflare.ts";
import { EFFECT_VIRTUAL_SPECIFIER } from "./Nuxt.ts";

export class NuxtEffectBundleError extends Data.TaggedError<"NuxtEffectBundleError">(
  "NuxtEffectBundleError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Default URL space the effect fetch owns when the construct passes no
 * `server.routes`. Mirrors alchemy's `DEFAULT_SERVER_ROUTES` (kept as a
 * literal here — this package must not import alchemy).
 */
export const DEFAULT_EFFECT_ROUTES: ReadonlyArray<string> = ["/api/*"];

/**
 * The effect-entry descriptor carried on the Nuxt source options
 * (JSON-serializable; set by `Cloudflare.Website.Nuxt` when an impl is
 * present).
 */
export interface NuxtEffectOptions {
  /**
   * The user's site module (the `main: import.meta.url` anchor whose
   * default export is the Website class). A path or `file://` URL.
   */
  readonly main: string;
  /** Path globs the effect fetch owns. @default ["/api/*"] */
  readonly routes?: ReadonlyArray<string> | undefined;
  /**
   * `server.takeover` from the construct: `false` opts out of automatic
   * delivery — the dev half then never injects the effect middleware
   * (the explicit `alchemy/Nitro` mount tier owns the dispatch).
   */
  readonly takeover?: boolean | undefined;
}

/** Normalize a `main` anchor (path or `file://` URL) to an absolute path. */
export const effectMainToPath = (main: string): string =>
  main.startsWith("file://") ? fileURLToPath(main) : main;

/** The generated-artifacts directory for one Worker id. */
export const effectGeneratedDir = (rootDir: string, id: string): string =>
  NodePath.join(
    rootDir,
    ".alchemy",
    "nuxt",
    id.replace(/[^A-Za-z0-9_.-]/g, "_"),
  );

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const assertClassName = (name: string): string => {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Durable Object export name ${JSON.stringify(name)} is not a valid JavaScript identifier`,
    );
  }
  return name;
};

const serializeRoutes = (routes: ReadonlyArray<string>): string =>
  `[${routes.map((route) => JSON.stringify(route)).join(", ")}]`;

/** Directory (inside the generated dir) holding the prebundled effect module. */
export const EFFECT_MODULE_DIR = "alchemy-effect";

/** The prebundled effect module's entry file (inside {@link EFFECT_MODULE_DIR}). */
export const EFFECT_MODULE_NAME = "alchemy-effect.mjs";

/** The temp rolldown input written next to the generated wrapper. */
const EFFECT_ENTRY_SOURCE_NAME = "alchemy-effect-entry.mjs";

/**
 * The rolldown prebundle input: imports the user's site module by absolute
 * path, exports a factory the generated nitro entry calls with the lazy
 * framework loader (routes baked in), and the effect program's DO bridge
 * classes. `cloudflare:workers` stays external through the prebundle AND
 * nitro's rollup (both treat `cloudflare:*` as external).
 */
export const makeEffectEntrySource = (options: {
  readonly sitePath: string;
  readonly routes: ReadonlyArray<string>;
  readonly durableObjects: ReadonlyArray<string>;
}): string => {
  const hasDos = options.durableObjects.length > 0;
  return [
    "// Generated by alchemy — do not edit. Rolldown input for the effect",
    "// half of the Nuxt entry takeover.",
    `import { ${hasDos ? "DurableObject, " : ""}WorkerEntrypoint } from "cloudflare:workers";`,
    `import { makeWebsiteExports${hasDos ? ", DurableObjectBridge" : ""} } from "alchemy/Serve/Worker";`,
    `import Site from ${JSON.stringify(options.sitePath)};`,
    "",
    "export const makeAlchemyWorker = (framework) =>",
    "  makeWebsiteExports(WorkerEntrypoint, {",
    "    site: Site,",
    `    routes: ${serializeRoutes(options.routes)},`,
    "    framework,",
    "  });",
    ...(hasDos
      ? [
          "",
          "const __AlchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: Site });",
          ...options.durableObjects.map(
            (name) =>
              `export class ${assertClassName(name)} extends __AlchemyDurableObjectBridge(${JSON.stringify(name)}) {}`,
          ),
        ]
      : []),
    "",
  ].join("\n");
};

/**
 * Render the production nitro entry wrapper: default-exports the wrapper
 * worker class built by the PREBUNDLED effect module's factory, with
 * nitro's `cloudflare-module` runtime as the framework fallback, and
 * re-exports the effect program's Durable Object bridge classes.
 *
 * The prebundle is imported by {@link EFFECT_VIRTUAL_SPECIFIER} — external
 * through nitro's rollup, rewritten to the module's in-set relative path
 * by the source provider after the build.
 */
export const renderWorkerEntry = (options: {
  readonly durableObjects: ReadonlyArray<string>;
}): string =>
  [
    "// Generated by alchemy (Cloudflare.Website.Nuxt effect entry) — do not edit.",
    `import { makeAlchemyWorker } from ${JSON.stringify(EFFECT_VIRTUAL_SPECIFIER)};`,
    `import nitroHandler from ${JSON.stringify(NITRO_HANDLER_SPECIFIER)};`,
    ...(options.durableObjects.length > 0
      ? [
          `export { ${options.durableObjects.map(assertClassName).join(", ")} } from ${JSON.stringify(EFFECT_VIRTUAL_SPECIFIER)};`,
        ]
      : []),
    "",
    "export default makeAlchemyWorker(() => Promise.resolve({ default: nitroHandler }));",
    "",
  ].join("\n");

/**
 * Rebuild any `builtin:esm-external-require` plugin instance with the
 * rolldown copy this package invokes (mirror of alchemy's
 * `Sources/Rolldown.ts` — see alchemy#880: a builtin constructed by a
 * foreign rolldown copy fails rolldown's `instanceof` check and is
 * silently treated as hookless, leaving CJS requires on the throwing
 * shim).
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

/**
 * Load alchemy's pure-annotation transform when it is resolvable (the
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

export interface BundleNuxtEffectModuleOptions {
  /** The generated-artifacts directory ({@link effectGeneratedDir}). */
  readonly generatedDir: string;
  /** The Nuxt project root (module-resolution context for `alchemy`). */
  readonly rootDir: string;
  /** Absolute path of the user's site module. */
  readonly sitePath: string;
  readonly routes: ReadonlyArray<string>;
  readonly durableObjects: ReadonlyArray<string>;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: ReadonlyArray<string>;
}

/**
 * Rolldown-prebundle the site module into
 * `<generatedDir>/alchemy-effect/alchemy-effect.mjs` (+ lazy chunks), the
 * self-contained workerd ESM the generated nitro entry imports.
 */
export const bundleNuxtEffectModule = (
  options: BundleNuxtEffectModuleOptions,
): Effect.Effect<void, NuxtEffectBundleError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fail = (message: string) => (cause: unknown) =>
      new NuxtEffectBundleError({ message, cause });

    if (
      !(yield* fs
        .exists(options.sitePath)
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* Effect.fail(
        new NuxtEffectBundleError({
          message:
            `The effect program's module (main: ${options.sitePath}) does not ` +
            "exist. Pass `main: import.meta.url` from the module that " +
            "default-exports the Website class.",
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
      options.generatedDir,
      EFFECT_ENTRY_SOURCE_NAME,
    );
    yield* fs
      .makeDirectory(options.generatedDir, { recursive: true })
      .pipe(Effect.orDie);
    yield* fs
      .writeFileString(
        entrySourcePath,
        makeEffectEntrySource({
          sitePath: options.sitePath,
          routes: options.routes,
          durableObjects: options.durableObjects,
        }),
      )
      .pipe(Effect.mapError(fail("Failed to write the effect entry source")));

    const outDirectory = NodePath.join(options.generatedDir, EFFECT_MODULE_DIR);
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

/**
 * Render the effect middleware handler — the shared, cloud-neutral
 * delivery module (it imports only `alchemy/Nitro` and the site
 * module): injected through `nitro.handlers`, it is compiled by nitro into
 * whatever server bundle the build produces — Cloudflare's dev SSR worker,
 * the AWS Lambda bundle, AND the AWS `nuxt dev` worker ride the same
 * module.
 *
 * The route matcher is inlined (same glob dialect as Cloudflare's
 * `runWorkerFirst` rules / alchemy's `Serve/Routes.ts`: `*` matches any
 * run including `/`, leading `!` is an exclusion and exclusions win).
 */
export const renderEffectHandler = (options: {
  readonly sitePath: string;
  readonly routes: ReadonlyArray<string>;
}): string =>
  [
    "// Generated by alchemy (Website.Nuxt effect middleware) — do not edit.",
    `import { toHandler } from "alchemy/Nitro";`,
    `import Site from ${JSON.stringify(options.sitePath)};`,
    "",
    `const routes = ${serializeRoutes(options.routes)};`,
    "const toPattern = (glob) =>",
    '  new RegExp("^" + glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).join(".*") + "$");',
    'const inclusions = routes.filter((route) => !route.startsWith("!")).map(toPattern);',
    'const exclusions = routes.filter((route) => route.startsWith("!")).map((route) => toPattern(route.slice(1)));',
    "const matches = (pathname) =>",
    "  !exclusions.some((pattern) => pattern.test(pathname)) &&",
    "  inclusions.some((pattern) => pattern.test(pathname));",
    "",
    "// The middleware gates the routes itself (above, without the web-",
    "// request conversion cost); the handler carries the same claim, so",
    "// inside it the effect fetch is authoritative — its 404s are final.",
    "const handler = toHandler(Site, { routes });",
    "const middleware = async (event) => {",
    '  const raw = event.path ?? event.node?.req?.url ?? "/";',
    '  const pathname = raw.split("?")[0];',
    "  if (!matches(pathname)) {",
    "    return; // outside the effect routes — nitro serves",
    "  }",
    "  return handler(event);",
    "};",
    "middleware.__is_handler__ = true;",
    "export default middleware;",
    "",
  ].join("\n");

/**
 * Signals of an explicit `alchemy/Serve` mount in the user's `server/`
 * source tree (a `server/middleware/*` file importing
 * `alchemy/Nitro`'s `toHandler`): the explicit-MOUNT marker
 * byte literal or an import of an `alchemy/Serve` specifier. Kept in sync
 * with `alchemy/src/Serve/constants.ts` — duplicated here because this
 * package deliberately carries no alchemy dependency. (Same pattern as
 * the SvelteKit adapters' stand-down scan.)
 */
const SERVE_MOUNT_PATTERN =
  /__ALCHEMY_SERVE_MOUNT_v1__|["']alchemy\/(?:Serve(?:\/Worker)?|Next|Nitro|Astro|SvelteKit)["']/;

/**
 * Scan the project's `server/` source tree for an explicit `alchemy/Serve`
 * mount (DESIGN §6.3: the auto-injected middleware stands down when the
 * user mounted the bridge themselves — the explicit tier always wins,
 * never two bridges in one nitro app).
 */
export const scanForExplicitServeMount = Effect.fnUntraced(function* (
  serverDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(serverDir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  for (const entry of entries) {
    if (!/\.(?:m|c)?[tj]s$/.test(entry)) {
      continue;
    }
    const content = yield* fs
      .readFileString(NodePath.join(serverDir, entry))
      .pipe(Effect.orElseSucceed(() => ""));
    if (SERVE_MOUNT_PATTERN.test(content)) {
      return true;
    }
  }
  return false;
});

/**
 * Write a generated module, creating the directory as needed. Content is
 * deterministic for identical inputs, so rewriting is idempotent.
 */
export const writeGeneratedModule = (
  filePath: string,
  content: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(NodePath.dirname(filePath), { recursive: true })
      .pipe(Effect.orDie);
    yield* fs.writeFileString(filePath, content).pipe(Effect.orDie);
    return filePath;
  });
