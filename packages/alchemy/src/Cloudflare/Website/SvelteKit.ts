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

export interface SvelteKitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * SvelteKit project root (the directory containing `package.json` and
   * `src/routes`). Relative paths resolve from the process working
   * directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest package-manager lockfile) is hashed; narrow the scope with
   * `include`/`exclude` globs when the project sits in a large repository.
   */
  memo?: MemoOptions;
  /**
   * SvelteKit configuration overrides. A project-owned `vite.config.*`
   * loads natively — its `sveltekit(...)` call is the primary config
   * source — and these options are merged OVER it (the override wins).
   * Without a config file, this is the whole kit config. Construction-time
   * options (`preprocess`, `extensions`, `compilerOptions`, `vitePlugin`)
   * only apply in the no-config-file case — put them in your own
   * `sveltekit(...)` call otherwise. The `adapter` field is injected by
   * Alchemy's wrangler-free Cloudflare adapter — do not set it here. Must
   * be JSON-serializable (it persists in state).
   */
  kit?: Record<string, unknown>;
  /**
   * Options for the wrangler-free Cloudflare adapter.
   */
  adapter?: {
    /**
     * Name of the static-assets binding the generated worker serves files
     * through.
     * @default "ASSETS"
     */
    assetsBinding?: string;
    /**
     * Fallback-page generation, mirroring Workers static assets
     * `not_found_handling`: `"404-page"` writes a `404.html`,
     * `"single-page-application"` writes an app-shell `index.html`.
     * @default "none"
     */
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    /**
     * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell
     * as the fallback, `"plaintext"` writes a plain `Not Found` page.
     * @default "plaintext"
     */
    fallback?: "spa" | "plaintext";
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a SvelteKit project.
 *
 * `SvelteKit` builds the app with SvelteKit's own Vite pipeline and a
 * wrangler-free in-memory Cloudflare adapter, then re-bundles the
 * Node-flavored server output for workerd. A project-owned
 * `vite.config.*` loads natively (its `sveltekit(...)` options apply) —
 * no `svelte.config.js` (kit v3 dropped it), no
 * `@sveltejs/adapter-cloudflare`, no Wrangler configuration required.
 * Client assets and prerendered pages are deployed as Worker static
 * assets; dynamic routes are served by the generated Worker.
 *
 * The `@alchemy.run/frontend-frameworks` package must be installed in your
 * project — its `/sveltekit` export is loaded dynamically at deploy time.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * SvelteKit's server code runs under `nodejs_compat` (the server graph is
 * built for Node), so the flag is always included in the Worker's
 * compatibility flags.
 *
 * Note on local dev: `alchemy dev` runs SvelteKit's own Vite dev server
 * (Node SSR with full HMR). `platform.env` carries the Worker's real
 * Cloudflare bindings (KV, R2, D1, ...) served by the cloudflare-runtime
 * platform proxy, with literal `env` values (strings and secrets)
 * overlaid.
 *
 *
 * ### Deploying a SvelteKit App
 * A single call builds and deploys the app — server-rendered routes,
 * prerendered pages, and client assets included.
 *
 * **Example:** Basic SvelteKit site
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website");
 * ```
 *
 * ### Bindings
 * Values passed via `env` are exposed to server routes through
 * SvelteKit's `platform.env`.
 *
 * **Example:** Reading env from a server route
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 *
 * // src/routes/+page.server.ts
 * // export const load = ({ platform }) => ({
 * //   hasKey: platform?.env?.API_KEY !== undefined,
 * // });
 * ```
 *
 * ### Kit and Adapter Options
 * Kit options normally live in the `sveltekit(...)` call in your
 * `vite.config.ts`, which loads natively; `kit` is a deploy-time
 * override layer merged over them (the override wins). The generated
 * Cloudflare adapter is configured via `adapter`.
 *
 * **Example:** SPA-style 404 fallback
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   adapter: {
 *     notFoundHandling: "404-page",
 *     fallback: "spa",
 *   },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when the project
 * lives in a large repository.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   memo: {
 *     include: ["src/**", "static/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `SvelteKit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.SvelteKit<Website>()(
 *   "Website",
 * ) {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const SvelteKit: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<SvelteKitProps<Bindings>>
        | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
      | InputProps<SvelteKitProps<Bindings>>
      | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(SvelteKit(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // SvelteKit's server graph is built for Node and needs
            // `nodejs_compat` — `getCompatibility` already adds it to every
            // non-python Worker.
            // The adapter's `notFoundHandling` generates the fallback pages
            // and the worker shim's 404 deferral, but the Workers assets
            // layer has its own `not_found_handling` knob — if they
            // disagree, unknown routes come back as empty-body 404s (the
            // shim defers to an assets layer still on "none"). Default the
            // assets-layer knob from the adapter so one prop configures the
            // whole story; an explicit `assets.notFoundHandling` wins.
            assets:
              props?.adapter?.notFoundHandling !== undefined &&
              props.adapter.notFoundHandling !== "none" &&
              props.assets?.notFoundHandling === undefined
                ? {
                    ...props.assets,
                    notFoundHandling: props.adapter.notFoundHandling,
                  }
                : props?.assets,
            source: {
              provider: "@alchemy.run/frontend-frameworks/sveltekit/source",
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                rootDir: props?.rootDir,
                memo: props?.memo,
                kit: props?.kit,
                adapter: props?.adapter,
              },
            },
          }),
        ),
      )) as any;
