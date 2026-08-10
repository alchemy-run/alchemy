import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory, type MemoOptions } from "../../Command/Memo.ts";
import { havePropsChanged, isResolved } from "../../Diff.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import { sha256Object } from "../../Util/sha256.ts";

/**
 * The structural slice of a framework-integration module
 * (`@alchemy.run/web-frameworks/nuxt`, `@alchemy.run/web-frameworks/astro`, ...) this resource
 * drives. Typed structurally so alchemy carries no dependency on
 * `@distilled.cloud/framework-core` — the *project's* install is always the
 * one loaded. Requirement channels are erased (the module is loaded
 * dynamically, so its effects are typed post-hoc): `build` is
 * requirement-free and `dev` runs in the caller's ambient Scope.
 */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly build: (options?: {
        readonly root?: string;
      }) => Effect.Effect<FrameworkBuildOutputSlice, unknown>;
      readonly dev: (options?: {
        readonly root?: string;
        readonly port?: number;
      }) => Effect.Effect<{ readonly url: string }, unknown>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

/** The structural slice of framework-core's `BuildOutput` this resource reads. */
interface FrameworkBuildOutputSlice {
  readonly distDirectory?: string | undefined;
  readonly clientDirectory: string | undefined;
  readonly serverModules: Array<{ readonly name: string }> | undefined;
}

export class FrameworkServerError extends Data.TaggedError(
  "FrameworkServerError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerProps {
  /**
   * Module specifier of the framework-integration package that implements
   * the build and dev server (e.g. `"@alchemy.run/web-frameworks/nuxt"`). Must be
   * installed in your project — it is loaded dynamically at deploy time and
   * drives your project's own framework toolchain.
   */
  framework: string;
  /**
   * Project root directory (the directory containing the framework config),
   * relative to the process working directory.
   * @default "."
   */
  root?: string;
  /**
   * The deploy target the build is produced for: a module specifier
   * resolved from your project's `node_modules`
   * (e.g. `"@alchemy.run/web-frameworks/nuxt/aws"`).
   */
  target: string;
  /**
   * Framework-integration options forwarded to the module's `make()`
   * (e.g. `{ nuxt: { ... } }` config overrides). Must be JSON-serializable —
   * the value participates in the memo hash and is persisted in state.
   */
  options?: Record<string, unknown>;
  /**
   * Preferred dev-server port during `alchemy dev`. Defaults to an
   * ephemeral port.
   */
  port?: number;
  /**
   * Environment variables for the framework server. On deploy the
   * composite sets these on the Lambda; during `alchemy dev` they are
   * applied to the dev server's process environment (the dev sidecar and
   * any child it spawns) so server code reads the same values in both
   * modes. Changing a value restarts the dev server.
   */
  env?: Record<string, string>;
  /**
   * Controls which files are hashed to decide whether the build should
   * re-run. By default every non-gitignored file in the root is hashed,
   * plus the nearest lockfile. Set `false` to rebuild on every deploy.
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface Server extends Resource<
  "AWS.Website.Server",
  ServerProps,
  {
    /**
     * Root output directory of the build (e.g. `.output`), relative to the
     * process's initial working directory. `undefined` in dev mode (no
     * production build runs).
     */
    distDir: string | undefined;
    /**
     * Static-assets directory of the build (prerendered pages included),
     * relative to the initial working directory. `undefined` when the build
     * produced no client assets, and in dev mode.
     */
    clientDir: string | undefined;
    /**
     * The server entry module on disk (e.g. `.output/server/index.mjs`),
     * relative to the initial working directory. `undefined` for
     * assets-only builds, and in dev mode.
     */
    serverEntry: string | undefined;
    /**
     * The framework dev server's local URL (e.g. `http://localhost:3000`)
     * during `alchemy dev`. `undefined` on deploys.
     */
    url: string | undefined;
    hash: {
      /**
       * Hash of the input files (plus framework/target/options) that
       * produced this build. `undefined` in dev mode.
       */
      input: string | undefined;
      /**
       * Hash of the build output files. `undefined` in dev mode.
       */
      output: string | undefined;
    };
  }
> {}

/**
 * The framework toolchain half of an AWS website: on `alchemy deploy` it
 * runs the framework's production build with a platform deploy target and
 * tracks the on-disk output in state; on `alchemy dev` it runs the
 * framework's OWN dev server (native HMR via the framework's kit) in the
 * dev sidecar and exposes its local URL.
 *
 * The framework package and the target module are loaded from *your*
 * project's `node_modules`, so your project's framework version drives the
 * build. Build inputs are content-hashed so an unchanged project skips the
 * rebuild entirely.
 *
 * @resource
 * @section Building Frameworks
 * @example Nuxt For AWS Lambda
 * ```typescript
 * const server = yield* Server("Server", {
 *   framework: "@alchemy.run/web-frameworks/nuxt",
 *   target: "@alchemy.run/web-frameworks/nuxt/aws",
 *   root: "./app",
 * });
 * // deploy: server.serverEntry -> .output/server/index.mjs (Lambda handler)
 * //         server.clientDir   -> .output/public (static assets for the CDN)
 * // dev:    server.url         -> http://localhost:<port> (framework HMR server)
 * ```
 */
export const Server = Resource<Server>("AWS.Website.Server", {
  aliases: ["AWS.Website.FrameworkBuild"],
});

const importFrameworkModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<Partial<FrameworkModule>>,
    catch: (cause) =>
      new FrameworkServerError({
        framework: specifier,
        message:
          `Failed to import the framework integration "${specifier}". ` +
          "It must be installed in your project (it is loaded dynamically at deploy time).",
        cause,
      }),
  }).pipe(
    Effect.flatMap((module_) =>
      typeof module_.make === "function"
        ? Effect.succeed(module_ as FrameworkModule)
        : Effect.fail(
            new FrameworkServerError({
              framework: specifier,
              message: `"${specifier}" does not export the framework-integration contract (a "make" function)`,
            }),
          ),
    ),
  );

const makeFramework = (props: ServerProps, root: string) =>
  importFrameworkModule(props.framework).pipe(
    Effect.flatMap((module_) =>
      Effect.mapError(
        module_.make({
          ...props.options,
          root,
          target: props.target,
        }),
        (cause) =>
          new FrameworkServerError({
            framework: props.framework,
            message: "Failed to initialize the framework integration",
            cause,
          }),
      ),
    ),
  );

export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    live: ServerProviderLive,
    local: ServerProviderLocal,
  });

export const ServerProviderLive = () =>
  Provider.effect(
    Server,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const runBuild = Effect.fn(function* (props: ServerProps) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const service = yield* makeFramework(props, root);
        return yield* Effect.mapError(
          service.build({ root }),
          (cause) =>
            new FrameworkServerError({
              framework: props.framework,
              message: `The ${props.framework} build failed`,
              cause,
            }),
        );
      });

      const hashInput = (props: ServerProps, root: string) =>
        hashDirectory({
          cwd: root,
          memo:
            props.memo === true ||
            props.memo === undefined ||
            props.memo === false
              ? {}
              : props.memo,
        }).pipe(
          Effect.flatMap((files) =>
            sha256Object({
              files,
              framework: props.framework,
              target: props.target,
              options: props.options,
            }),
          ),
        );

      const makeOutput = Effect.fn(function* (
        props: ServerProps,
        built: FrameworkBuildOutputSlice,
      ) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const distDir = built.distDirectory ?? path.join(root, "dist");
        if (!(yield* fs.exists(distDir))) {
          return yield* Effect.fail(
            new FrameworkServerError({
              framework: props.framework,
              message: `The build produced no output directory at ${distDir}`,
            }),
          );
        }
        const entryName = built.serverModules?.[0]?.name;
        return {
          distDir: path.relative(initialCwd, distDir),
          clientDir:
            built.clientDirectory !== undefined
              ? path.relative(initialCwd, built.clientDirectory)
              : undefined,
          serverEntry:
            entryName !== undefined
              ? path.relative(initialCwd, path.join(distDir, entryName))
              : undefined,
          url: undefined,
          hash:
            props.memo === false
              ? { input: undefined, output: undefined }
              : yield* Effect.all(
                  {
                    input: hashInput(props, root),
                    output: hashDirectory({
                      cwd: distDir,
                      memo: { exclude: [], lockfile: false },
                    }),
                  },
                  { concurrency: "unbounded" },
                ),
        };
      });

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.memo === false || !output.hash.input || !output.hash.output)
            return { action: "update" };
          if (havePropsChanged(olds, news)) return { action: "update" };
          const root = path.resolve(initialCwd, news.root ?? ".");
          // Cheap check: same inputs + output still on disk with the same
          // content hash -> noop without re-running the build.
          const input = yield* hashInput(news, root);
          if (input !== output.hash.input) return { action: "update" };
          if (output.distDir === undefined) return { action: "update" };
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return { action: "update" };
          const outHash = yield* hashDirectory({
            cwd: distDir,
            memo: { exclude: [], lockfile: false },
          });
          return {
            action: Equal.equals(outHash, output.hash.output)
              ? "noop"
              : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const built = yield* runBuild(news);
          return yield* makeOutput(news, built);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.distDir === undefined) return;
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return;
          yield* fs.remove(distDir, { recursive: true });
        }),
      };
    }),
  );

/**
 * The `alchemy dev` variant: runs the framework's own dev server (native
 * HMR through the framework's kit — nuxt, astro, ...) inside the dev
 * sidecar, so it survives user-code hot reloads. Restarts when the
 * framework/target/root/options config changes.
 */
export const ServerProviderLocal = () =>
  LocalProvider.make(
    Server,
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./ServerLocal.ts" : "./ServerLocal.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      return {
        start: Effect.fn(function* ({ news: props }) {
          const root = path.resolve(initialCwd, props.root ?? ".");
          // Dev/live env parity: the composite sets these on the Lambda on
          // deploy; in dev the framework server runs inside the sidecar
          // (or as its child — `next dev`), so the sidecar's process env
          // is what SSR code reads. `env` is part of the restart surface,
          // so a changed value restarts the dev server with the new
          // environment. Values are not unset on stop: sibling dev servers
          // share the process, so clearing could clobber their keys.
          if (props.env !== undefined) {
            yield* Effect.sync(() => {
              for (const [key, value] of Object.entries(props.env!)) {
                process.env[key] = String(value);
              }
            });
          }
          const service = yield* makeFramework(props, root).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          // `dev` is scoped: the server lives in the instance scope the
          // LocalProvider helper provides and is torn down on
          // restart/delete. It resolves at readiness with the local URL.
          const { url } = yield* Effect.mapError(
            service.dev({ root, port: props.port }),
            (cause) =>
              new FrameworkServerError({
                framework: props.framework,
                message: `The ${props.framework} dev server failed to start`,
                cause,
              }),
          );
          return {
            distDir: undefined,
            clientDir: undefined,
            serverEntry: undefined,
            url,
            hash: { input: undefined, output: undefined },
          };
        }),
      } satisfies LocalProvider.LocalProviderSpec<Server>;
    }),
  );
