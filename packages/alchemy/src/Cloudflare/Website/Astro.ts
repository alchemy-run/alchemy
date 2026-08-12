import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import { Namespace } from "../KV/Namespace.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface AstroProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Astro project root directory.
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
   * The name of the KV binding backing Astro's session API.
   *
   * A KV namespace is auto-provisioned and bound under this name on
   * deploy, so `Astro.session` works with zero configuration. Bind your
   * own KV namespace under this name in `env` to use it instead of the
   * auto-provisioned one, or set this to `false` to disable session
   * provisioning entirely.
   * @default "SESSION"
   */
  sessionKVBindingName?: string | false;
  /**
   * Serializable Astro config merged into the in-memory configuration.
   * The project's `astro.config.*` file loads natively; astro merges
   * these options OVER it (scalars override the file). The Cloudflare
   * adapter, output target, and Vite environments are managed for you —
   * do not declare an `adapter` in the config file.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand in the
     * Worker; individual pages opt into prerendering with
     * `export const prerender = true`.
     * @default "server"
     */
    output?: "server" | "static";
    /** Source directory, relative to `rootDir`. @default "./src" */
    srcDir?: string;
    /** Public (static passthrough) directory. @default "./public" */
    publicDir?: string;
    /** Build output directory. @default "./dist" */
    outDir?: string;
    /** Trailing-slash handling for routes. */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from an [Astro](https://astro.build)
 * project.
 *
 * `Astro` runs Astro's programmatic build with a wrangler-free
 * Cloudflare adapter (`@alchemy.run/frontend-frameworks/astro`): server-rendered pages
 * execute in the Worker, prerendered pages and client assets deploy as
 * static assets. Your `astro.config.*` loads natively — no adapter
 * setup or Wrangler configuration required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default)
 * so unchanged projects skip the build and deploy entirely.
 *
 * The `@alchemy.run/frontend-frameworks` package must be installed in your
 * project; its `/astro` export is loaded dynamically at deploy time:
 *
 * ```sh
 * bun add -d @alchemy.run/frontend-frameworks
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying an Astro Site
 * A single call builds the project and deploys the server bundle plus
 * static assets. Pages are server-rendered by default; pages that
 * `export const prerender = true` are served as static assets. Astro's
 * server runtime is built against Node APIs, so `nodejs_compat` is
 * always included in the Worker's compatibility flags.
 *
 * @example Astro site
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Website");
 * ```
 *
 * @section Static Sites
 * With `astro: { output: "static" }` every page is prerendered at build
 * time and the deploy is **assets-only**: no server bundle is uploaded —
 * Cloudflare's asset layer answers every request (including the built
 * `404.html` via `assets.notFoundHandling: "404-page"`). Session
 * provisioning is skipped for declared-static sites since no Worker code
 * runs at request time.
 *
 * @example Fully static Astro site
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Docs", {
 *   astro: { output: "static" },
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @section Bindings
 * Bind resources through `env` like any other Worker. Astro code reads
 * them via `import { env } from "cloudflare:workers"` (or
 * `Astro.locals.runtime.env`).
 *
 * @example Astro site with a KV namespace and an R2 bucket
 * ```typescript
 * const kv = yield* Cloudflare.KV.Namespace("Cache");
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   env: {
 *     CACHE: kv,
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * @section Sessions
 * Astro's session API is backed by a KV namespace. One is provisioned
 * and bound under the session binding name (`SESSION` by default)
 * automatically, so `Astro.session` works with zero configuration.
 * Bind your own namespace under that name to use it instead, or set
 * `sessionKVBindingName: false` to opt out of session provisioning.
 *
 * @example Bringing your own session namespace
 * ```typescript
 * const sessions = yield* Cloudflare.KV.Namespace("Sessions");
 *
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   env: {
 *     SESSION: sessions,
 *   },
 * });
 * ```
 *
 * @example Opting out of session provisioning
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   sessionKVBindingName: false,
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project
 * has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Docs", {
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * @section Astro Configuration
 * Your `astro.config.*` file loads natively — integrations, Vite
 * plugins, and other non-serializable options work as usual. Common
 * serializable options are exposed under `astro` for deploy-specific
 * overrides; astro merges them OVER the config file (scalars override,
 * arrays like `integrations` concatenate). The Cloudflare adapter is
 * injected for you — declaring an `adapter` in the config file fails
 * the build. `output` defaults to `"server"`, superseding a file-level
 * `output`; opt into a fully prerendered site with
 * `astro: { output: "static" }`.
 *
 * @example Setting the site URL and source directory
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Blog", {
 *   astro: {
 *     site: "https://blog.example.com",
 *     srcDir: "./app",
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `Astro` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Astro<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 */
export const Astro: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<AstroProps<Bindings>>
        | Effect.Effect<InputProps<AstroProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<AstroProps<Bindings>>
      | Effect.Effect<InputProps<AstroProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Astro(id, propsEff))
    : Worker(
        id,
        Effect.gen(function* () {
          const props: any =
            (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          const session = props.sessionKVBindingName;
          const sessionBindingName =
            typeof session === "string" ? session : "SESSION";
          let env = props.env;
          // Auto-provision the KV namespace backing Astro's session API
          // unless the user opted out (`sessionKVBindingName: false`) or
          // already bound their own namespace under the session name.
          // A declared `output: "static"` site is assets-only — no Worker
          // script runs at request time, so a session namespace could never
          // be read; skip provisioning it. Resource creation is deduped by
          // logical id, so re-evaluating this props effect is safe.
          if (
            session !== false &&
            props.astro?.output !== "static" &&
            env?.[sessionBindingName] === undefined
          ) {
            const sessions = yield* Namespace(`${id}Session`);
            env = { ...env, [sessionBindingName]: sessions };
          }
          return {
            ...props,
            env,
            // Astro's vendored server runtime is built against Node APIs
            // and needs `nodejs_compat`; `getCompatibility` already adds it
            // to every non-python Worker (honoring an explicit
            // `no_nodejs_compat` opt-out and the v2-mode date guard).
            main: undefined!,
            source: {
              provider: "@alchemy.run/frontend-frameworks/astro/source",
              devMode: "server",
              options: {
                rootDir: props.rootDir,
                memo: props.memo,
                // Passed through verbatim (including `false`) so the
                // source provider can skip its session-driver wiring on
                // opt-out.
                sessionKVBindingName: props.sessionKVBindingName,
                // Server output is the documented default: astro's own
                // zero-config default is `"static"`, which would prerender
                // every page at build time inside workerd — where the
                // Worker's bindings don't exist. The inline config merges
                // OVER a project's `astro.config.*`, so an explicit
                // file-level `output` is superseded; opt into a fully
                // prerendered site with `astro: { output: "static" }`.
                astro: { output: "server", ...props.astro },
              },
            },
          };
        }),
      )) as any;
