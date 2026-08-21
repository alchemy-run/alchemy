/**
 * Fixture-local `Framework` implementation driving vocs on Cloudflare Workers.
 *
 * Vocs 2.x is built on waku (its `vocs()` vite plugin composes waku's own
 * `waku/vite-plugins` — environments, adapter-alias, static-build, ... — with
 * vocs's mdx/config/patch plugins), but it does NOT use waku's
 * `unstable_combinedPlugins`, so `@alchemy.run/frontend-frameworks/waku`'s Framework layer
 * cannot drive it directly. This layer mirrors that package's orchestration
 * (see packages/frontend-frameworks/src/waku/Waku.ts) with vocs's plugin stack swapped in:
 *
 * - the deploy-target halves (wrangler-free adapter fork + cloudflare vite
 *   plugin pinned to waku's rsc entry) come from
 *   `@alchemy.run/frontend-frameworks/waku/cloudflare` — vocs uses waku's environments
 *   plugin, so the same rsc/ssr topology applies;
 * - the plugin stack is the one vocs's own CLI assembles
 *   (`[react(), vocs()]`), with the target's plugins injected ahead of
 *   vocs/waku's (the position where the workerd proxy middleware registers
 *   before waku's Node request bridge) and the adapter selected via vocs's
 *   `unstable_adapter` passthrough;
 * - the waku-parity vite config that `@alchemy.run/frontend-frameworks/waku` carries through
 *   the in-memory waku config (dedupe, workerd optimizeDeps, neutral rolldown
 *   platform) rides the inline vite config instead, since vocs owns the waku
 *   config it builds internally.
 */
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as FrameworkCore from "@alchemy.run/frontend-frameworks/core";
import { WAKU_SERVER_ENTRY_MODULE } from "@alchemy.run/frontend-frameworks/waku";
import makeWakuCloudflareTarget from "@alchemy.run/frontend-frameworks/waku/cloudflare";
import react from "@vitejs/plugin-react";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as vite from "vite";
import { resolveConfig } from "vocs/config";
import { vocs } from "vocs/vite";

/** Fixture-side extras that don't fit the shared harness options. */
export interface VocsFrameworkExtras {
  /**
   * Default dev-server port, used when `dev` is called without an explicit
   * port (e.g. the Playwright dev fixture). Non-strict: if the port is taken,
   * vite falls back to the next free one. A port passed to `dev` directly
   * (`e2e dev --port N`) is strict and takes precedence.
   */
  readonly port?: number | undefined;
}

/**
 * `NODE_ENV` as it was when this module first loaded (see
 * packages/frontend-frameworks/src/waku/Waku.ts for the rationale: build and dev may run in the
 * same long-lived playwright worker process).
 */
const INITIAL_NODE_ENV = process.env.NODE_ENV;

const PREVIEW_SERVER_GLOBAL = "__WAKU_START_PREVIEW_SERVER__";

/** The shape waku's `unstable_startPreviewServer` expects the global to produce. */
interface WakuPreviewServer {
  readonly baseUrl: string;
  readonly middlewares: {
    readonly use: (
      fn: (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
    ) => void;
  };
  readonly close: () => Promise<void>;
}

/**
 * Waku-parity inline vite config. `@alchemy.run/frontend-frameworks/waku` injects these via
 * the in-memory waku config's `vite` field; vocs builds that config itself
 * with `vite: {}`, so they ride the top-level inline config here (vite merges
 * inline config with plugin-contributed config).
 */
const sharedViteConfig = {
  resolve: { dedupe: ["waku", "hono"] },
  environments: {
    rsc: {
      optimizeDeps: { include: ["hono/tiny"] },
      build: { rolldownOptions: { platform: "neutral" } },
    },
    ssr: {
      optimizeDeps: { include: ["waku > rsc-html-stream/server"] },
      build: { rolldownOptions: { platform: "neutral" } },
    },
  },
} satisfies vite.InlineConfig;

const VIRTUAL_USER_CONFIG = "virtual:fixtures-vocs/user-config";
const RESOLVED_VIRTUAL_USER_CONFIG = `\0${VIRTUAL_USER_CONFIG}`;

/**
 * Bridges vocs's runtime config resolution onto workerd.
 *
 * Vocs's server code calls `Config.resolve({ server: true })` at request time
 * (middleware, api routes, the ssr entry). In production that branch assumes
 * the Node server layout — `import.meta.dirname` + an on-disk
 * `dist/server/vocs.config.js` — neither of which exists inside workerd
 * (upstream vocs has node/vercel/netlify adapters only; there is no workers
 * deploy path to mirror). This plugin:
 *
 * 1. transforms vocs's `internal/config.js` in the bundled server
 *    environments so every `server: true` resolution (dev and prod) returns
 *    the build-time-resolved config from a virtual module, and guards the
 *    `process.cwd()` fallback for non-Node runtimes;
 * 2. serves that virtual module with the config resolved once in Node via
 *    vocs's own `resolveConfig` (functions are dropped from the JSON —
 *    `define` recomputes those defaults at runtime; the fixture's config is
 *    plain data).
 */
const workerdConfigBridge = (root: string): vite.Plugin => {
  let serialized: string | undefined;
  const serializeUserConfig = async (): Promise<string> => {
    serialized ??= JSON.stringify(
      await resolveConfig({ rootDir: root }),
      (_, value) => (typeof value === "function" ? undefined : value),
    );
    return serialized;
  };
  return {
    name: "fixtures-vocs:workerd-config-bridge",
    resolveId(id) {
      if (id === VIRTUAL_USER_CONFIG) return RESOLVED_VIRTUAL_USER_CONFIG;
      return;
    },
    async load(id) {
      if (id === RESOLVED_VIRTUAL_USER_CONFIG) {
        return `export default ${await serializeUserConfig()};`;
      }
      return;
    },
    transform(code, id) {
      // In the production build the modules are vocs's shipped
      // `dist/internal/*.js`; in dev, vite serves vocs's TS sources
      // (`src/internal/*.ts`) through the module runner, so both shapes (and
      // the raw-TS formatting, which user plugins see before vite's esbuild
      // transform) must match.
      // Strip the query (dev serves ids like `.../config.js?v=<hash>`).
      const normalized = (id.split("?")[0] ?? id).replaceAll("\\", "/");
      const isVocsInternal = (name: string) =>
        normalized.endsWith(`/vocs/dist/internal/${name}.js`) ||
        normalized.endsWith(`/vocs/src/internal/${name}.ts`);
      const mustReplace = (
        source: string,
        pattern: RegExp,
        replacement: string,
      ): string => {
        if (!pattern.test(source)) {
          throw new Error(
            `fixtures-vocs: ${normalized} no longer matches the workerd config bridge ` +
              `pattern ${pattern} — update the transform in fixtures/vocs/framework.ts ` +
              "for the installed vocs version",
          );
        }
        return source.replace(pattern, replacement);
      };
      // `deserializeFunctions` revives `_vocs-fn_`-serialized config functions
      // with `new Function`, which workerd forbids (no dynamic code
      // generation). Fall back to dropping the function — the only serialized
      // functions in this fixture's config are vocs's default search
      // `boostDocument` implementations, which the browser (not workerd)
      // executes. Node paths (SSG, dev tooling) still revive normally.
      if (isVocsInternal("config-serializer")) {
        return mustReplace(
          code,
          // Not the escaped copy inside `deserializeFunctionsStringified` —
          // that template's backticks/dollars are backslash-escaped.
          /return new Function\(`return \$\{value\.slice\(9\)\}`\)\(\);?/,
          "try { return new Function(`return ${value.slice(9)}`)(); } catch { return undefined; }",
        );
      }
      if (!isVocsInternal("config")) return;
      let result = mustReplace(
        code,
        /const \{ server, rootDir = process\.cwd\(\) \} = options;?/,
        "const { server } = options;\n" +
          "  const rootDir = options.rootDir ?? (() => { try { return process.cwd(); } catch { return '/'; } })();",
      );
      result = mustReplace(
        result,
        /if \(server && process\.env\['NODE_ENV'\] === 'production'\) \{\s*const configPath = path\.resolve\(import\.meta\.dirname, '\.\.\/vocs\.config\.js'\);?\s*const resolved = \(await import\(\/\* @vite-ignore \*\/ configPath\)\)\.default( as define\.Options)?;?\s*return define\(\{ \.\.\.resolved, rootDir \}\);?\s*\}/,
        "if (server) {\n" +
          `    const resolved = (await import(${JSON.stringify(VIRTUAL_USER_CONFIG)})).default;\n` +
          "    return define(resolved);\n" +
          "  }",
      );
      return result;
    },
  };
};

/**
 * Replicates waku's `cmd-build.ts` `startPreviewServerImpl`: the SSG step of
 * `builder.buildApp()` (the adapter's `build`) calls
 * `unstable_startPreviewServer`, which throws unless this global is set. The
 * preview config omits the cloudflare plugins, so SSG streams through the
 * adapter's Node fallback middleware (upstream parity: identical to a vocs
 * build without a platform vite plugin).
 */
const setPreviewServerGlobal = (root: string, adapterPath: string): void => {
  (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL] =
    async (): Promise<WakuPreviewServer> => {
      const server = await vite.preview({
        configFile: false,
        root,
        ...sharedViteConfig,
        plugins: [
          react(),
          workerdConfigBridge(root),
          vocs({ unstable_adapter: adapterPath }),
        ],
      });
      const baseUrl = server.resolvedUrls?.local[0];
      if (!baseUrl) {
        throw new Error(
          "Could not determine the URL of the vocs SSG preview server",
        );
      }
      return {
        baseUrl,
        middlewares: {
          use: (fn) => server.middlewares.use(fn as never),
        },
        close: () => server.close(),
      };
    };
};

const clearPreviewServerGlobal = (): void => {
  delete (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL];
};

/**
 * The vocs implementation of framework-core's `Framework` service.
 *
 * - `build` replicates vocs's `vocs build` CLI command (`vite.createBuilder`
 *   with `[react(), vocs()]` + `buildApp`) with the cloudflare target's
 *   plugins/adapter wired in, and collects the `BuildOutput` with a
 *   post-`buildApp` disk re-read (waku writes `__waku_build_metadata.js` and
 *   prunes static-only chunks after the bundler finishes).
 * - `dev` replicates `vocs dev` (`vite.createServer`) with the same plugin
 *   wiring, so the rsc environment runs in workerd.
 */
export const make = (
  options: Options.Options,
  extras?: VocsFrameworkExtras,
): Layer.Layer<
  FrameworkCore.Framework,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({ framework: "vocs", message, cause });

      const { worker } = Options.resolveCloudflareOptions(options);
      const target = makeWakuCloudflareTarget(worker);

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() => override ?? process.cwd());

      /** Resolve the target's adapter module + vite plugins for one pass. */
      const prepareTarget = Effect.fn(function* (
        root: string,
        phase: "build" | "dev",
      ) {
        const wakuDirectory =
          yield* FrameworkCore.resolveProjectPackageDirectory(
            root,
            "waku",
          ).pipe(
            Effect.mapError(
              fail("Failed to resolve the project's waku package directory"),
            ),
          );
        const context = { root, wakuDirectory, phase } as const;
        const [adapterPath, plugins] = yield* Effect.all(
          [target.adapter(context), target.vitePlugins(context)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            fail(`The cloudflare target failed preparing the vocs ${phase}`),
          ),
        );
        return { adapterPath, plugins };
      });

      return FrameworkCore.Framework.of({
        build: Effect.fn(function* (buildOptions) {
          const root = yield* resolveRoot(buildOptions?.root);
          const { adapterPath, plugins } = yield* prepareTarget(root, "build");
          // vocs's CLI (like waku's) runs with NODE_ENV set before loading
          // anything; waku's environmentsPlugin bakes it into `define`.
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "production";
          });
          const collector = yield* FrameworkCore.makeBuildOutputCollector({
            entryEnvironment: "rsc",
            selectEntry: (chunk) => chunk.name === WAKU_SERVER_ENTRY_MODULE,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          yield* Effect.tryPromise({
            try: async () => {
              const builder = await vite.createBuilder(
                {
                  configFile: false,
                  root,
                  ...sharedViteConfig,
                  plugins: [
                    react(),
                    ...plugins,
                    workerdConfigBridge(root),
                    vocs({ unstable_adapter: adapterPath }),
                    collector.plugin,
                  ],
                },
                null,
              );
              setPreviewServerGlobal(root, adapterPath);
              try {
                await builder.buildApp();
              } finally {
                clearPreviewServerGlobal();
              }
            },
            catch: fail("Failed to build"),
          });
          // Disk re-read: waku writes `__waku_build_metadata.js` and prunes
          // static-only server chunks during `buildApp` hooks, after the
          // in-memory `writeBundle` capture.
          const output = yield* collector
            .collect({ fromDisk: true })
            .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
          return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
            root,
            framework: "vocs",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(fail("The deploy target's finishing pass failed")),
          );
        }),
        dev: Effect.fn(function* (devOptions) {
          const root = yield* resolveRoot(devOptions?.root);
          const { adapterPath, plugins } = yield* prepareTarget(root, "dev");
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "development";
          });
          const port = devOptions?.port ?? extras?.port;
          const server = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                const server = await vite.createServer({
                  configFile: false,
                  root,
                  ...sharedViteConfig,
                  plugins: [
                    react(),
                    ...plugins,
                    workerdConfigBridge(root),
                    vocs({ unstable_adapter: adapterPath }),
                  ],
                  ...(port !== undefined
                    ? {
                        server: {
                          port,
                          strictPort: devOptions?.port !== undefined,
                        },
                      }
                    : undefined),
                });
                return await server.listen();
              },
              catch: fail("Failed to start the vocs dev server"),
            }),
            (server) => Effect.promise(async () => await server.close()),
          );
          const url = server.resolvedUrls?.local[0];
          if (url === undefined) {
            return yield* Effect.fail(
              fail("Could not determine the URL of the vocs dev server")(
                undefined,
              ),
            );
          }
          return { url };
        }),
      });
    }),
  );

export default make;
