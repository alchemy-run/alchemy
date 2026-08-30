import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
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

export interface FoldkitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Overrides the module that becomes the deployed Worker entry. Relative
   * paths resolve from {@link rootDir}.
   *
   * A Foldkit deployment is assets-only by default — no Worker code runs
   * at request time. Point `main` at a custom module when the deployment
   * needs code at the edge — API routes, error reporting, Durable Object
   * classes. The entry serves the client build through its `ASSETS`
   * binding:
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
   * scope.
   */
  memo?: MemoOptions & {
    /**
     * Additional workspace directories to hash (relative to `rootDir`).
     * By default (`"auto"`), workspaces are auto-detected from the build's
     * module graph; an explicit array pins them.
     * @default "auto"
     */
    workspaces?: "auto" | Array<MemoOptions & { cwd: string }>;
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   *
   * No routing default is applied, because Foldkit has no single correct
   * one. Server rendering and static generation are delivery policies rather
   * than application types, so one Foldkit app can ship as any of four
   * deployments, and they do not want the same asset routing:
   *
   * - **Client-only.** `index.html` is an unrendered template and no route
   *   has a file of its own. Set `notFoundHandling: "single-page-application"`
   *   so a deep link serves that template and the app's router resolves it.
   * - **Prerendered.** The app's own `vite.config.ts` sets
   *   `ssr: { serverEntry, build: { prerender: true } }`, so the one
   *   `vite build` this resource runs writes every route as
   *   `<path>/index.html` and overwrites `index.html` with the rendered `/`.
   *   The default `htmlHandling` already resolves those, and
   *   `"single-page-application"` is wrong here: it answers an unknown path
   *   with the rendered `/` at 200 instead of a 404.
   * - **Server-rendered.** Nothing is prerendered, so `index.html` is a bare
   *   template no browser should receive. Set `htmlHandling: "none"` and
   *   `notFoundHandling: "none"` so `/` and every other page fall through to
   *   the Worker named by {@link FoldkitProps.main}.
   * - **Hybrid.** Prerendered routes are files and the rest fall through:
   *   the default `htmlHandling` plus `notFoundHandling: "none"`. Prerender
   *   `/` as well, or `htmlHandling` resolves it to the bare template.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Foldkit](https://foldkit.dev) app.
 *
 * Foldkit apps are Vite projects, so `Foldkit` drives the project's own
 * `vite build` — the Foldkit Vite plugin in the app's `vite.config.ts`
 * composes with the injected Cloudflare plugin — and deploys the client
 * output as static assets. No Wrangler configuration, build command, or
 * output directory required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * Asset routing carries no default: a Foldkit app can be delivered
 * client-only, prerendered, server-rendered, or as a mix of the last two,
 * and those want different routing. See {@link FoldkitProps.assets} for
 * which to set.
 *
 * ### Deploying a Foldkit App
 * A single call builds the project and deploys the client output as
 * static assets — no configuration required.
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
 * ### Choosing Asset Routing
 * How a Foldkit app is delivered decides what the asset layer should do
 * with a request that matches no file. {@link FoldkitProps.assets} sets it
 * out in full; these are the two shapes worth seeing side by side.
 *
 * **Example:** A client-only app
 * Deep links have no file, so they serve the template and the app's own
 * router resolves them.
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * **Example:** A server-rendered app
 * Files are still served straight from the asset layer; everything else
 * reaches the Worker and is rendered there. Without `htmlHandling: "none"`
 * the asset layer answers `/` with the unrendered template and the Worker
 * never sees the request.
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   main: "src/worker.ts",
 *   assets: {
 *     htmlHandling: "none",
 *     notFoundHandling: "none",
 *   },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * By default the deployment is assets-only. When code must run at the
 * edge — API routes, error reporting, Durable Object classes — point
 * `main` at your own module that serves the client build through the
 * `ASSETS` binding (see {@link FoldkitProps.main}). A server-rendered
 * deployment needs an entry for the same reason: rendering runs there.
 * Bindings passed in `env` are reachable from the entry (and from cron
 * handlers), not from browser code, so anything the browser needs must come
 * from a route the Worker serves.
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
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // No `assets` default. A deployment is delivered client-only
            // or server-rendered, and those want different routing —
            // defaulting to `single-page-application` served the unrendered
            // template for every deep link of a server-rendered deployment,
            // at 200, with nothing to indicate it. See
            // `FoldkitProps.assets`.
            main: undefined!,
            vite: {
              main: props?.main,
              rootDir: props?.rootDir,
              memo: props?.memo,
            },
          }),
        ),
      )) as any;
