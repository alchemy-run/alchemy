import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ViteModule from "vite";
import { makeEffectDevPlugin, type ViteEffectOptions } from "./effect.ts";

export type { ViteEffectOptions } from "./effect.ts";

/**
 * Names the vite environments that make up the server build, for
 * frameworks that build more than one (e.g. React Server Components).
 *
 * A single-environment SSR build needs no configuration. For a
 * multi-environment build, point `entry` at the environment that produces
 * the server entry chunk and list the remaining server-side environments
 * in `children` so their chunks ship alongside it (the collector already
 * captures every non-client environment; `children` documents the split
 * and participates in the memo hash). The `client` environment is always
 * treated as static assets.
 */
export interface ViteEnvironmentsOptions {
  /**
   * The environment whose entry chunk becomes the server entry.
   * @default "ssr"
   */
  readonly entry?: string | undefined;
  /**
   * Additional server-side environments built alongside `entry`.
   * @default []
   */
  readonly children?: Array<string> | undefined;
}

/**
 * The configuration this package assembles from {@link ViteOptions} and
 * hands to a deploy-target factory (see {@link ViteTargetInput}). The
 * target treats it as its `DeployTarget.config`; the framework half never
 * inspects a resolved target's config. Must be JSON-serializable — the
 * AWS target's wholesale build re-creates the framework from it in a
 * child process.
 */
export interface ViteTargetConfig {
  /** The server-environment split ({@link ViteOptions.viteEnvironments}). */
  readonly viteEnvironments?: ViteEnvironmentsOptions | undefined;
  /**
   * Effectful (wrapper) delivery for an effectful `Website.Vite`
   * ({@link ViteOptions.effect}): the target's finishing pass generates
   * its Lambda entry's effect arm from it.
   */
  readonly effect?: ViteEffectOptions | undefined;
}

/**
 * A deploy target for the generic Vite integration — just the generic
 * `DeployTarget` seams: the build pipeline is fully framework-neutral
 * (programmatic vite over the project's own `vite.config.*` + the shared
 * build-output collector), so a target only contributes `bundle` options
 * and a `finish` pass (and optionally a wholesale `build`).
 */
export interface ViteTarget extends DeployTarget<ViteTargetConfig> {}

/**
 * How a deploy target is passed to this package: a {@link ViteTarget}
 * value, a factory `(config) => ViteTarget`, or a module specifier
 * resolved from the *project's* `node_modules` (default-export — or named
 * export `target` — a value or factory).
 */
export type ViteTargetInput = DeployTargetInput<ViteTarget, ViteTargetConfig>;

/**
 * The default deploy target: this package's own AWS Lambda target module
 * (`src/vite/aws.ts`), loaded from the project's dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/aws";

export interface ViteOptions {
  /**
   * Vite project root (the directory containing `vite.config.*`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/vite/aws"
   */
  readonly target?: ViteTargetInput | undefined;
  /** The server-environment split for multi-environment frameworks. */
  readonly viteEnvironments?: ViteEnvironmentsOptions | undefined;
  /**
   * Extra Vite inline config merged into the build/dev config. In-process
   * only: a target whose wholesale `build` runs in a child process (the
   * AWS target) does not carry it — the project's own `vite.config.*` is
   * the configuration surface there.
   */
  readonly vite?: ViteModule.InlineConfig | undefined;
  /**
   * Effectful (wrapper) delivery for an effectful `Website.Vite`.
   * Production builds: forwarded to the target via its config (the AWS
   * target's finishing pass composes the effect fetch ahead of the
   * framework handler in the generated Lambda entry). Dev: mounts the
   * effect middleware in front of vite's dev server (see `effect.ts`).
   */
  readonly effect?: ViteEffectOptions | undefined;
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
 * Build the `Framework` service implementation for a Vite project.
 *
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build` — the AWS target's child-process build) or runs the
 *   production build via programmatic Vite (`createBuilder().buildApp()`)
 *   over the project's OWN `vite.config.*` — framework plugins (TanStack
 *   Start, SolidStart, ...) included — with the shared build-output
 *   collector capturing the client directory and server modules, and hands
 *   the built server entry to the target's `finish` pass. A plain SPA
 *   project (no SSR environment) builds assets-only: `serverModules` stays
 *   `undefined` and the finish pass passes the build through.
 * - `dev` runs vite's own dev server (Node SSR, full HMR) over the user
 *   config; an effectful site additionally mounts the effect dispatch as a
 *   front middleware (see `effect.ts`).
 *
 * The `null` second argument to `createBuilder` is load-bearing: it lets
 * vite fall back to the legacy single-environment builder when the config
 * declares no `builder` (plain SPA projects build just the client
 * environment) while frameworks that define `builder.buildApp` get the
 * full Environment API orchestration.
 */
export const make: (
  options?: ViteOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: ViteOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: ViteTargetConfig = {
    viteEnvironments: options?.viteEnvironments,
    effect: options?.effect,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<ViteTarget, ViteTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<typeof ViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite", error.cause),
      ),
    );

  /**
   * Assemble the Vite inline config. The project's own `vite.config.*`
   * loads natively (`configFile` is left to Vite's discovery — the user's
   * plugins, including their framework plugin, all apply); the inline
   * config only sets the root and injects the given plugins.
   */
  const resolveViteConfig = (
    root: string,
    plugins: Array<ViteModule.Plugin>,
  ): ViteModule.InlineConfig => ({
    root,
    // Default to warn: rolldown-vite's native progress reporter
    // ("transforming...") writes straight to the fd, which corrupts
    // hosting-process reporters that can only intercept JS-level writers.
    logLevel: "warn",
    ...options?.vite,
    plugins: [...(options?.vite?.plugins ?? []), ...plugins],
  });

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = { root, framework: "vite" };

      // Wholesale build takeover (the AWS target's child-process build —
      // vite resolves the project root against the live cwd, so production
      // builds never run inside the engine process).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      const vite = yield* loadVite(root);
      const collector = yield* FrameworkCore.makeBuildOutputCollector({
        entryEnvironment: options?.viteEnvironments?.entry ?? "ssr",
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const config = resolveViteConfig(root, [collector.plugin]);

      yield* Effect.tryPromise({
        try: async () => {
          const builder = await vite.createBuilder(config, null);
          await builder.buildApp();
        },
        catch: (error) => fail("Failed to build", error),
      });

      const output = yield* collector
        .collect()
        .pipe(Effect.mapError((error) => fail(error.message, error.cause)));

      // The built server entry chunk on disk — the finishing pass wraps it
      // in the target's own serve shell (e.g. the AWS streaming Lambda
      // entry). Absent for assets-only (SPA) builds.
      const entryName = output.serverModules?.[0]?.name;
      const distDirectory = output.distDirectory ?? path.resolve(root, "dist");
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry:
          entryName !== undefined
            ? path.join(distDirectory, entryName)
            : undefined,
      }).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
    const root = devOptions?.root ?? baseRoot;
    const plugins: Array<ViteModule.Plugin> = [];
    if (options?.effect !== undefined) {
      // Effectful Website: mount the effect middleware in front of the
      // framework (the dev analogue of the Lambda entry's effect arm).
      // The target selects the serve bridge (AWS mounts alchemy's Lambda
      // serve shell over `process.env`).
      const target = yield* resolveTarget(root);
      plugins.push(
        makeEffectDevPlugin({
          effect: options.effect,
          platform: target.platform,
        }),
      );
    }
    const vite = yield* loadVite(root);
    const config = resolveViteConfig(root, plugins);
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
            ...config,
            server: {
              ...config.server,
              port,
              ...(host !== undefined ? { host } : undefined),
            },
          });
          return await server.listen();
        },
        catch: (error) => fail("Failed to start the dev server", error),
      }),
      (server) => Effect.promise(async () => await server.close()),
    );
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) {
      return yield* Effect.fail(fail("Could not determine the dev server URL"));
    }
    return { url };
  });

  return Framework.of({ build, dev });
});

/**
 * A `Layer` providing framework-core's `Framework` service for a Vite
 * project — the fully-typed entrypoint for `e2e.config.ts` (harness form
 * 4) and alchemy's `Website.Vite` SSR composite.
 */
export const layer = (
  options?: ViteOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
