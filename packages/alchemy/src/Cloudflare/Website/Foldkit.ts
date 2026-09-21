import * as Effect from "effect/Effect";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type ViteOptions,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface FoldkitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * A Worker entry of your own, for a client-only app that must also do
   * something at the edge — serve an API route, wrap the app in error
   * reporting, export Durable Object classes. Relative paths resolve from
   * {@link rootDir}. The entry serves the client build through its
   * `ASSETS` binding:
   *
   * ```typescript
   * // src/worker.ts
   * export default {
   *   async fetch(request: Request, env: { ASSETS: Fetcher }) {
   *     const url = new URL(request.url);
   *     if (url.pathname === "/api/health") {
   *       return Response.json({ ok: true });
   *     }
   *     return env.ASSETS.fetch(request);
   *   },
   * };
   * ```
   *
   * A server-rendered or prerendered app needs none: its Worker is the
   * `fetch` handler the app's own build emits (`ssr.build` in
   * `vite.config.ts`), and that build owns the server entry — a `main`
   * alongside it fails the build.
   */
  main?: string;
  /**
   * Foldkit project root directory.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether a rebuild is needed.
   * By default every non-gitignored file under `rootDir` is hashed, plus the
   * nearest package-manager lockfile. Provide explicit globs to narrow the
   * scope; `workspaces` adds sibling workspace directories (see
   * {@link ViteOptions.memo}).
   */
  memo?: ViteOptions["memo"];
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   *
   * A server-rendered or prerendered app needs nothing here. Its build
   * writes `foldkit.build.json` beside the server bundle, recording which
   * paths it prerendered, and the routing follows from that: a prerendered
   * route is a file the asset layer serves, and every other page request,
   * the front page included, reaches the `fetch` handler. The build keeps
   * the unfilled template out of the client output, so no file stands in
   * for a page it did not render. Anything set here wins over what is
   * derived.
   *
   * A client-only app has no server and no manifest, so it gets
   * `notFoundHandling: "single-page-application"`: a deep link serves the
   * template and the app's router resolves it. An app that ships a real
   * 404 page declares `"404-page"` instead.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Foldkit](https://foldkit.dev) app.
 *
 * Foldkit apps are Vite projects, so `Foldkit` drives the project's own
 * `vite build` — the Foldkit Vite plugin in the app's `vite.config.ts`
 * composes with the injected Cloudflare plugin — and deploys what it
 * emits. The client output becomes the Worker's static assets. With
 * `ssr.build` set in the app's config, the same build also emits
 * `dist/server/fetch.js`, a Web `fetch` handler with the built shell
 * embedded, and that handler is the Worker — exactly as a TanStack Start
 * server bundle is. No Wrangler configuration, build command, output
 * directory, adapter, or Worker entry of your own.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * ### Deploying a Foldkit App
 * A single call builds the project and deploys it. Whether the result is
 * client-only, server-rendered, or prerendered is decided by the app's
 * `vite.config.ts`, not by the declaration.
 *
 * **Example:** Foldkit app
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website");
 * ```
 *
 * **Example:** Foldkit project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Server Rendering and Prerendering
 * The app's own config declares its server entry and asks the build to
 * emit the handler; `prerender` additionally writes every path the entry
 * lists as a static page. The declaration above does not change.
 *
 * **Example:** vite.config.ts for a server-rendered app
 * ```typescript
 * import { foldkit } from "@foldkit/vite-plugin";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [
 *     foldkit({
 *       buildId: process.env.FOLDKIT_BUILD_ID,
 *       ssr: { serverEntry: "/src/entry.server.ts", build: true },
 *     }),
 *   ],
 * });
 * ```
 *
 * **Example:** vite.config.ts for a prerendered app
 * ```typescript
 * foldkit({
 *   buildId: process.env.FOLDKIT_BUILD_ID,
 *   ssr: {
 *     serverEntry: "/src/entry.server.ts",
 *     build: { prerender: true },
 *   },
 * });
 * ```
 *
 * ### Choosing Asset Routing
 * No `assets` config is needed for any shape. A server-rendered or
 * prerendered app's build records what it prerendered in
 * `foldkit.build.json` and the routing follows from it; a client-only
 * app gets the single-page-application fallback, so deep links serve the
 * template and the app's own router resolves them (see
 * {@link FoldkitProps.assets}). Anything declared wins.
 *
 * **Example:** A client-only app that ships its own 404 page
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   assets: {
 *     notFoundHandling: "404-page",
 *   },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * A client-only app that must also run code at the edge — API routes,
 * error reporting, Durable Object classes — points `main` at its own
 * module, which serves the client build through the `ASSETS` binding
 * (see {@link FoldkitProps.main}). Bindings passed in `env` are reachable
 * from that entry (and from cron handlers), not from browser code, so
 * anything the browser needs must come from a route the Worker serves.
 *
 * **Example:** Custom entry serving an API route from a KV namespace
 * ```typescript
 * const ticker = yield* Cloudflare.KV.Namespace("Ticker");
 *
 * const site = yield* Cloudflare.Website.Foldkit("Platform", {
 *   main: "src/worker.ts",
 *   env: {
 *     TICKER: ticker,
 *   },
 *   assets: {
 *     runWorkerFirst: ["/api/*"],
 *   },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project
 * has large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Foldkit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Foldkit<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Foldkit: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<FoldkitProps<Bindings>>
        | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [
          binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
        ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<FoldkitProps<Bindings>>
      | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [
        binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
      ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Foldkit(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff)
            ? (propsEff as Effect.Effect<any, never, any>)
            : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            main: undefined!,
            source: {
              provider: "@alchemy.run/frontend-frameworks/foldkit/source",
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                main: props?.main,
                rootDir: props?.rootDir,
                memo: props?.memo,
              },
            },
          }),
        ),
      )) as any;
