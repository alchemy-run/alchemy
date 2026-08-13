import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";

/** The structural slice of the project's `vite` module this package drives. */
export interface ViteModule {
  readonly version?: string;
  readonly build: (config: Record<string, unknown>) => Promise<unknown>;
  readonly resolveConfig: (
    config: Record<string, unknown>,
    command: "build" | "serve",
  ) => Promise<ResolvedViteConfigSlice>;
  readonly createServer: (
    config: Record<string, unknown>,
  ) => Promise<ViteDevServer>;
}

/** The structural slice of a resolved Vite config this package reads. */
export interface ResolvedViteConfigSlice {
  readonly root: string;
  readonly build: { readonly outDir: string };
}

/** The structural slice of a Vite dev server this package reads. */
export interface ViteDevServer {
  readonly listen: () => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly resolvedUrls?:
    | { readonly local: ReadonlyArray<string> }
    | null
    | undefined;
}

/**
 * A deploy target for a client-only Vite build. The generic `DeployTarget`
 * seams are all a static build needs — assets-only output has no
 * platform-specific server code, so most targets are pure markers.
 */
export type ViteTargetInput = DeployTargetInput<DeployTarget, unknown>;

export interface ViteFrameworkOptions {
  /**
   * Project root (the directory containing `vite.config.ts`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string. Optional —
   * a client-only build has no platform-specific output, so the target's
   * only seams are the wholesale `build` takeover and the `finish` pass.
   */
  readonly target?: ViteTargetInput | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "vite", message, cause });

/**
 * Build the `Framework` service implementation for a client-only Vite
 * project (a plain SPA — [Foldkit](https://foldkit.dev) apps, vanilla Vite
 * templates, anything whose production output is static files).
 *
 * - `build` drives the PROJECT's own Vite install programmatically: one
 *   `vite build` with the project's own `vite.config.*` (plugins included)
 *   is the whole pipeline. The `BuildOutput` is assets-only: the resolved
 *   `build.outDir` becomes `clientDirectory` and `serverModules` is
 *   `undefined` — no server code is produced or deployed.
 * - `dev` runs Vite's own dev server programmatically (native HMR),
 *   scoped — closing the Scope closes the server.
 *
 * This module is target-agnostic; a target (when provided) only
 * contributes the generic `build` takeover / `finish` seams.
 */
export const make: (
  options?: ViteFrameworkOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: ViteFrameworkOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const resolveTarget = (root: string) =>
    options?.target === undefined
      ? Effect.succeed(undefined)
      : FrameworkCore.resolveDeployTarget<DeployTarget, unknown>(
          root,
          options.target,
          {},
        ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<ViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite install", error.cause),
      ),
    );

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = { root, framework: "vite" };

      // Wholesale build takeover (targets that own the entire pipeline).
      if (target?.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      // The project's own vite.config.* (plugins included) drives the
      // entire production pipeline inside this one call.
      const vite = yield* loadVite(root);
      yield* Effect.tryPromise({
        try: async () => await vite.build({ root, logLevel: "warn" }),
        catch: (error) => fail("Failed to build", error),
      });

      // Read the resolved outDir from the project's own config rather than
      // assuming `dist`.
      const resolved = yield* Effect.tryPromise({
        try: async () =>
          await vite.resolveConfig({ root, logLevel: "warn" }, "build"),
        catch: (error) =>
          fail("Failed to resolve the project's Vite config", error),
      });
      const outDir = path.resolve(resolved.root, resolved.build.outDir);
      if (!(yield* fs.exists(outDir).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* Effect.fail(
          fail(`The Vite build produced no output directory at ${outDir}`),
        );
      }

      const output: FrameworkCore.BuildOutput = {
        distDirectory: outDir,
        clientDirectory: outDir,
        serverModules: undefined,
        externalWorkspaces: new Set<string>(),
      };

      // The finishing-pass seam (none needed for a static build — the
      // contract is honored for targets that do post-process).
      return yield* FrameworkCore.applyDeployTargetFinish(
        target,
        output,
        targetContext,
      ).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
    const root = devOptions?.root ?? baseRoot;
    const vite = yield* loadVite(root);
    // `port: 0` (true OS-assigned) on Vite >= 8.2.1, probed ephemeral port
    // on older Vite — see `resolveViteDevPort`.
    const port = yield* FrameworkCore.resolveViteDevPort(
      vite.version,
      devOptions?.port ?? options?.dev?.port,
    );
    const host = devOptions?.host;

    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const server = await vite.createServer({
            root,
            server: {
              port,
              ...(host !== undefined ? { host } : undefined),
            },
          });
          await server.listen();
          return server;
        },
        catch: (error) => fail("Failed to start the Vite dev server", error),
      }),
      (server) =>
        Effect.promise(async () => {
          try {
            await server.close();
          } catch {
            // teardown is best-effort
          }
        }),
    );

    const url = server.resolvedUrls?.local[0];
    if (url === undefined) {
      return yield* Effect.fail(fail("Could not determine the dev server URL"));
    }

    // Bounded readiness probe: any HTTP response counts (vite serves
    // lazily; we only need the listener to answer).
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, { redirect: "manual" });
        await response.arrayBuffer().catch(() => {});
      },
      catch: (error) => fail("The dev server did not become reachable", error),
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
    );

    return { url };
  });

  return Framework.of({ build, dev });
});

/**
 * A `Layer` providing framework-core's `Framework` service for a client-only
 * Vite project — the fully-typed entrypoint for `e2e.config.ts` (harness
 * form 4) and alchemy's website composites.
 */
export const layer = (
  options?: ViteFrameworkOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
