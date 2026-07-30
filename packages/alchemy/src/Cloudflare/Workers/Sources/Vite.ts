import cloudflare, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as ConsoleService from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type * as vite from "vite";
import { viteBuildOutputPlugin } from "../../../Bundle/Vite.ts";
import { hashDirectory, type MemoOptions } from "../../../Command/Memo.ts";
import { sha256Object } from "../../../Util/sha256.ts";
import { readAssets } from "../Assets.ts";
import type { SourceDevHandle, SourceProvider } from "../Source.ts";
import type { ViteOptions } from "../Worker.ts";
import { isWorkerLoader } from "../WorkerLoader.ts";

/**
 * This module statically imports `@distilled.cloud/cloudflare-vite-plugin`
 * (~0.5s to load), which is only needed for vite-based workers. Importers
 * MUST load it lazily (`Effect.promise(() => import("./Sources/Vite.ts"))`
 * from the dispatch in `Source.ts`, or the legacy vite arms in the
 * Worker providers) so the module cost is only paid when a vite worker
 * is actually built, hashed, or served.
 */

/**
 * Route Vite's logger through the ambient Effect `Console` service instead of
 * its default stdout logger. Under the CLI this is the global console
 * (identical output); under environments that override the Console — e.g.
 * alchemy-test's per-test buffering console — the build output is captured
 * with the test instead of leaking to the terminal.
 */
const makeViteLogger = (console: ConsoleService.Console): vite.Logger => {
  const loggedErrors = new WeakSet<object>();
  let hasWarned = false;
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => {
      hasWarned = true;
      console.warn(msg);
    },
    warnOnce: (msg) => {
      hasWarned = true;
      console.warn(msg);
    },
    error: (msg, options) => {
      if (options?.error != null) loggedErrors.add(options.error);
      console.error(msg);
    },
    clearScreen: () => {},
    hasErrorLogged: (error) => loggedErrors.has(error),
    get hasWarned() {
      return hasWarned;
    },
  };
};

/**
 * Signals to the app's own Vite config that Alchemy is injecting its
 * resource-aware Cloudflare plugin into this build/dev run.
 *
 * Apps that also build standalone (plain `vite build` in CI, no Alchemy)
 * need the Cloudflare plugin in their `vite.config.ts`. Without a guard,
 * an Alchemy-orchestrated run instantiates that config-file instance
 * *alongside* the injected one: two same-named plugin stacks whose
 * cross-plugin API lookups resolve by name, and — in dev — two workerd
 * runtimes, only one of which carries the Worker's bindings. Guarding on
 * this variable lets the config-file instance stand down:
 *
 * ```ts
 * // vite.config.ts
 * process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
 *   ? null
 *   : cloudflare({ ... })
 * ```
 *
 * The variable is set process-locally by `viteDev`/`viteBuild`, so it is
 * correct regardless of which process hosts Vite (`alchemy dev` runs the
 * dev server in the spawned local-provider host, not in the process that
 * evaluates the user's alchemy.run.ts — an env variable set there never
 * reaches the config).
 *
 * Contract: the value is `"1"` while the process is Alchemy-orchestrated;
 * absence means not injected. It is deliberately never unset — Vite
 * re-evaluates the app config on dev-server restarts long after
 * `viteDev` returned, and concurrent `viteBuild`s in one process would
 * race a save/restore. A process that ran an Alchemy build never also
 * runs a standalone (non-Alchemy) Vite build, so the flag staying set is
 * correct for the process lifetime.
 */
const ALCHEMY_CLOUDFLARE_VITE_INJECTED = "ALCHEMY_CLOUDFLARE_VITE_INJECTED";

export const viteDev = (
  rootDir: string = process.cwd(),
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
  serverOptions: vite.ServerOptions,
) =>
  Effect.acquireRelease(
    ConsoleService.consoleWith((console) =>
      Effect.promise(async () => {
        process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
        const vite = await loadVite(rootDir);
        const devServer = await vite.createServer({
          root: rootDir,
          define: getDefine(env),
          plugins: [cloudflare(pluginOptions)],
          server: serverOptions,
          customLogger: makeViteLogger(console),
        });
        await devServer.listen();
        return devServer;
      }),
    ),
    (devServer) =>
      Effect.promise(async () => {
        await devServer.close();
      }),
  );

export const viteBuild = (
  rootDir: string = process.cwd(),
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
) =>
  Effect.gen(function* () {
    const outputPlugin = yield* viteBuildOutputPlugin({
      entryEnvironment: pluginOptions.viteEnvironments?.entry ?? "ssr",
    });
    const console = yield* ConsoleService.Console;
    yield* Effect.promise(async () => {
      process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
      const vite = await loadVite(rootDir);
      const builder = await vite.createBuilder(
        {
          root: rootDir,
          define: getDefine(env),
          plugins: [cloudflare(pluginOptions), outputPlugin.plugin],
          customLogger: makeViteLogger(console),
          // Disables the NATIVE rolldown progress reporter ("transforming…",
          // "rendering chunks…", "computing gzip size…"): it prints from
          // Rust straight to fd 1 and cannot be intercepted from JS — vite
          // only enables it when logLevel >= info. Info-level build
          // summaries are suppressed with it; warnings and errors still
          // reach the customLogger above.
          logLevel: "warn",
        },
        // This is the `useLegacyBuilder` option. The Vite CLI implementation uses `null` here.
        // Originally we used `undefined` here, but this caused the static site build to fail.
        // https://github.com/vitejs/vite/blob/a07a4bd052ac75f916391c999c408ad5f2867e61/packages/vite/src/node/cli.ts#L367
        null,
      );
      await builder.buildApp();
    });
    return yield* outputPlugin.output;
  });

// Emulate `vite build` env semantics for `props.env`: only
// keys with Vite's default `VITE_` prefix are inlined into
// the bundle as `import.meta.env.*`. `Redacted` values are
// unwrapped — by prefixing with `VITE_` the user is opting
// them into the public bundle.
const getDefine = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, raw]) => {
      if (!key.startsWith("VITE_")) return [];
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      return [[`import.meta.env.${key}`, JSON.stringify(value)] as const];
    }),
  );

type ViteModule = typeof import("vite");

/**
 * Dynamically load Vite from the project root. Falls back to the bundled
 * copy if the project doesn't have its own Vite installation.
 */
async function loadVite(
  projectRoot: string = process.cwd(),
): Promise<ViteModule> {
  try {
    const require = createRequire(nodePath.join(projectRoot, "package.json"));
    const vitePath = require.resolve("vite");
    // On Windows, absolute paths must be file:// URLs for ESM import().
    const viteUrl = pathToFileURL(vitePath);
    return await import(/* @vite-ignore */ viteUrl.href);
  } catch {
    // Fallback: try to import vite from the global node_modules (works for non-linked installs)
    // The fallback is a bare specifier and works as-is.
    return await import("vite");
  }
}

/**
 * Resolve `props.env` to the literal values vite's `import.meta.env`
 * defines are computed from: strings pass through, `Redacted<string>`s
 * are unwrapped, env-bound Effects are evaluated, and `WorkerLoader`s
 * (bindings that happen to be Effects) are skipped.
 */
const resolveViteEnv = (env: Record<string, unknown>) =>
  Effect.gen(function* () {
    return Object.fromEntries(
      (yield* Effect.all(
        Object.entries(env).map(
          Effect.fn(function* ([key, value]) {
            return [
              key,
              typeof value === "string"
                ? value
                : Redacted.isRedacted(value) &&
                    typeof Redacted.value(value) === "string"
                  ? Redacted.value(value)
                  : // A `WorkerLoader` is a real Effect that also carries
                    // the `~alchemy/Kind` marker — it is a binding, not a
                    // runnable env value. Check it before `Effect.isEffect`
                    // so we don't execute it as an inlined env entry.
                    isWorkerLoader(value)
                    ? undefined
                    : Effect.isEffect(value)
                      ? yield* value as any as Effect.Effect<any>
                      : undefined,
            ];
          }),
        ),
      )).filter(([_, value]) => value !== undefined),
    );
  });

/**
 * Hash the vite project's input tree (root + workspaces + lockfiles) —
 * the rebuild-free change signal for the `input` hash slot.
 */
export const hashViteInput = Effect.fn(function* <E, R>(
  rootDir: string = process.cwd(),
  options: ViteOptions["memo"],
  additionalWorkspaces: Effect.Effect<Iterable<string>, E, R>,
) {
  const path = yield* Path.Path;
  const hashWorkspaceDirectory = (cwd: string, memo?: MemoOptions) =>
    hashDirectory({ cwd: path.resolve(rootDir, cwd), memo }).pipe(
      Effect.map((hash) => `${path.relative(rootDir, cwd)}:${hash}`),
    );
  const hashRoot = hashWorkspaceDirectory(rootDir, options);
  if (Array.isArray(options?.workspaces)) {
    return yield* Effect.all(
      [
        hashRoot,
        ...options.workspaces.map(({ cwd, ...options }) =>
          hashWorkspaceDirectory(cwd, options),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([root, ...workspaces]) =>
        sha256Object([root, ...workspaces.sort()]),
      ),
      Effect.map((hash) => ({ hash, workspaces: undefined })),
    );
  }
  const [root, workspaces] = yield* Effect.all(
    [hashRoot, additionalWorkspaces],
    { concurrency: "unbounded" },
  );
  const workspaceHashes = yield* Effect.forEach(
    workspaces,
    (cwd) => hashWorkspaceDirectory(cwd),
    { concurrency: "unbounded" },
  );
  const hash = yield* sha256Object([root, ...workspaceHashes.sort()]);
  return {
    hash,
    workspaces: Array.from(workspaces).map((cwd) =>
      path.relative(rootDir, cwd),
    ),
  };
});

/**
 * Source provider for vite-based workers (`props.vite`, set by
 * `Website.Vite`): the vite builder produces the client assets and the
 * server bundle in one pass; diff never builds — the `input` hash over
 * the project tree is the change signal.
 *
 * This module is the lazy-import boundary for the vite toolchain (see
 * the module note above): the dispatch in `Source.ts` dynamically
 * imports it, so its ~0.5s module cost is only paid for vite-based
 * workers.
 */
export const makeViteSource = (vite: ViteOptions): SourceProvider => ({
  ownsAssets: true,
  build: Effect.fn(function* (ctx) {
    const path = yield* Path.Path;
    const env = yield* resolveViteEnv(ctx.env ?? {});
    const { clientDirectory, serverBundle, externalWorkspaces } =
      yield* viteBuild(vite.rootDir, env, {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
      });
    const [assets, bundle, input] = yield* Effect.all(
      [
        clientDirectory
          ? readAssets({
              ...(ctx.assets && typeof ctx.assets !== "string"
                ? ctx.assets
                : undefined),
              directory: path.resolve(
                vite.rootDir ?? process.cwd(),
                clientDirectory,
              ),
            })
          : Effect.undefined,
        serverBundle,
        hashViteInput(vite.rootDir, vite.memo, externalWorkspaces),
      ],
      { concurrency: "unbounded" },
    );
    if (!assets && !bundle) {
      return yield* Effect.die(
        new Error("Vite build produced neither assets nor server output"),
      );
    }
    return {
      bundle,
      assets,
      hash: {
        bundle: bundle?.hash,
        assets: assets?.hash,
        input: input.hash,
        additionalWorkspaces: input.workspaces,
      },
    };
  }),
  hash: Effect.fn(function* (_ctx, previous) {
    const { hash, workspaces } = yield* hashViteInput(
      vite.rootDir,
      vite.memo,
      Effect.succeed(previous?.additionalWorkspaces ?? []),
    );
    return { input: hash, additionalWorkspaces: workspaces };
  }),
  dev: Effect.fn(function* (ctx) {
    const devServer = yield* viteDev(
      vite.rootDir,
      ctx.env ?? {},
      {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
        worker: {
          name: ctx.worker.name,
          bindings: ctx.worker.bindings,
          durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
          hyperdrives: ctx.worker.hyperdrives,
          queueConsumers: yield* ctx.worker.queueConsumers,
          assets: ctx.worker.assets,
        },
        context: ctx.runtimeContext,
      },
      { port: 0 },
    );
    return {
      mode: "server",
      url: new URL(devServer.resolvedUrls!.local[0]),
    } satisfies SourceDevHandle;
  }),
});
