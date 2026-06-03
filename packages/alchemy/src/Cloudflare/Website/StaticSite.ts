import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { Command, type CommandProps } from "../../Build/Command.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface StaticSiteProps<Bindings extends WorkerBindingProps = {}>
  extends
    Omit<WorkerProps<Bindings, WorkerAssetsConfig>, "assets" | "dev">,
    Omit<CommandProps, "env"> {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assetsConfig?: AssetsConfig;
  /**
   * Local dev configuration. When `alchemy dev` runs, the build command is
   * skipped and `command` is spawned instead. Alchemy picks a free port,
   * passes it via the `PORT` env var, waits for the dev server to start
   * listening, and proxies the Worker URL at it.
   *
   * @example
   * ```typescript
   * Cloudflare.StaticSite("App", {
   *   command: "npm run build",
   *   outdir: "dist",
   *   main: "./src/worker.ts",
   *   dev: { command: "npm run dev" },
   * });
   * ```
   */
  dev?: {
    /**
     * Shell command to run as the upstream dev server (e.g. `npm run dev`).
     * The command must respect the `PORT` env var alchemy passes to it.
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to {@link CommandProps.cwd}
     * (the build command's `cwd`), or `process.cwd()` if neither is set.
     */
    cwd?: string;
    /**
     * Host the local proxy binds to.
     * @default "localhost"
     */
    host?: string;
    /**
     * Port the local proxy listens on.
     * @default 1337
     */
    port?: number;
    /**
     * When `true`, fail instead of falling back to another port if {@link port}
     * is already in use.
     * @default false
     */
    strictPort?: boolean;
  };
}

type StaticSiteWorker<Bindings extends WorkerBindingProps> = Worker<{
  [binding in keyof NormalizedBindings<
    Bindings,
    WorkerAssetsConfig
  >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
}>;

/**
 * A Cloudflare Worker that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), content-hashes
 * the output directory, and deploys the result as a Cloudflare Worker with
 * static assets. Use this when your site has its own build step that
 * produces a directory of files — Hugo, Zola, Eleventy, or any custom
 * pipeline.
 *
 * For Vite-based projects, prefer `Cloudflare.Vite` which handles
 * building automatically.
 *
 * @resource
 *
 * @section Basic Usage
 * Point `command` at your build script, `outdir` at where it writes
 * output, and `main` at a Worker entrypoint that serves the assets.
 * Alchemy runs the command, hashes the output, and deploys the
 * Worker bound to the built assets.
 *
 * The Worker receives an `ASSETS` binding it can delegate to. A
 * minimal passthrough Worker looks like:
 *
 * ```typescript
 * // src/worker.ts
 * export default {
 *   fetch: (request: Request, env: { ASSETS: Fetcher }) =>
 *     env.ASSETS.fetch(request),
 * };
 * ```
 *
 * @example Deploying a Hugo site
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * });
 * ```
 *
 * @section Asset Configuration
 * Use `assetsConfig` to control how Cloudflare handles routing for
 * your static files — HTML handling, not-found behavior, etc.
 *
 * @example SPA-style routing
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   assetsConfig: {
 *     htmlHandling: "auto-trailing-slash",
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @section Building from a Subdirectory
 * Set `cwd` to run the build command in a subdirectory (e.g. a
 * monorepo package). `outdir` is resolved relative to `cwd`.
 *
 * @example Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "apps/web/worker.ts",
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, all non-gitignored files are hashed to decide whether
 * the build should re-run. Use `memo` to narrow the scope.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   memo: {
 *     include: ["content/**", "templates/**", "config.toml"],
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `StaticSite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Blog extends Cloudflare.StaticSite<Blog>()("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * }) {}
 *
 * const site = yield* Blog;
 * ```
 */
export const StaticSite: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff:
        | InputProps<StaticSiteProps<Bindings>, "dev">
        | Effect.Effect<
            InputProps<StaticSiteProps<Bindings>, "dev">,
            never,
            Req
          >,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): StaticSiteWorker<Bindings>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff:
      | InputProps<StaticSiteProps<Bindings>, "dev">
      | Effect.Effect<InputProps<StaticSiteProps<Bindings>, "dev">, never, Req>,
  ): Effect.Effect<StaticSiteWorker<Bindings>, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeStaticSite(id, propsEff))
    : makeStaticSite(id, propsEff)) as any;

const makeStaticSite = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff:
    | InputProps<StaticSiteProps<Bindings>, "dev">
    | Effect.Effect<InputProps<StaticSiteProps<Bindings>, "dev">, never, Req>,
) =>
  Effect.gen(function* () {
    const props = Effect.isEffect(propsEff)
      ? propsEff
      : Effect.succeed(propsEff);
    const { dev: isDevPhase } = yield* AlchemyContext;

    return yield* Effect.gen(function* () {
      const resolved = yield* props;
      const useDevServer = isDevPhase && resolved.dev !== undefined;

      // In dev mode with a dev.command, skip the build entirely — the dev
      // server handles assets at runtime.
      const build = useDevServer
        ? undefined
        : yield* Command("Build", {
            command: resolved.command,
            cwd: resolved.cwd,
            memo: resolved.memo,
            outdir: resolved.outdir,
            env: resolved.env
              ? Object.fromEntries(
                  Object.entries(resolved.env).flatMap(([k, v]) => {
                    if (v === undefined) return [];
                    if (typeof v === "string" || Redacted.isRedacted(v))
                      return [[k, v]];
                    return [[k, JSON.stringify(v)]];
                  }),
                )
              : undefined,
          });

      return yield* Worker<Bindings, WorkerAssetsConfig, Req>("Worker", {
        ...resolved,
        assets: build
          ? {
              path: build.outdir,
              hash: build.hash,
              config: resolved.assetsConfig,
            }
          : undefined,
        dev: useDevServer
          ? {
              command: resolved.dev!.command,
              cwd: resolved.dev!.cwd ?? resolved.cwd,
              host: resolved.dev!.host,
              port: resolved.dev!.port,
              strictPort: resolved.dev!.strictPort,
            }
          : undefined,
      });
    });
  }).pipe(Namespace.push(id));
