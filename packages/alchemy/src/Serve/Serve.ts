/**
 * The public `alchemy/Serve` surface (see ./DESIGN.md) — `mount`, the one
 * user-facing runtime API. Mounted in the server entry (or framework hook)
 * the user owns:
 *
 * ```ts
 * // src/server.ts (TanStack shown — any fetch-shaped entry)
 * import framework from "@tanstack/react-start/server-entry";
 * import { mount } from "alchemy/Serve";
 * import Site from "./backend.ts";
 * const site = mount(Site);
 * export default {
 *   fetch: async (req, env, ctx) =>
 *     (await site.fetch(req, env, ctx)) ?? framework.fetch(req, env, ctx),
 * };
 * ```
 */

import * as Data from "effect/Data";
import { markRuntime, type ServeOptions, type SiteRuntime } from "./Bridge.ts";
import { type SERVE_MOUNT_MARKER } from "./constants.ts";

// The explicit-mount marker, written as a literal (type-checked against
// `constants.ts`) so the exact byte sequence provably survives bundling and
// minification into any framework server bundle that imports the PUBLIC
// `alchemy/Serve` surface. Framework integrations' stand-down scans grep
// built output for it to detect an explicit mount. Deliberately NOT the
// bridge's `SERVE_SENTINEL`: the bridge also rides the value-form
// `createClient` graph, so its literal appears in every effectful website's
// server bundle — this module only rides explicit mounts.
const MOUNT_MARKER: typeof SERVE_MOUNT_MARKER = "__ALCHEMY_SERVE_MOUNT_v1__";
(globalThis as Record<string, any>)[MOUNT_MARKER] = true;
import { DEFAULT_SERVER_ROUTES, matchRoutes } from "./Routes.ts";

export type { ServeOptions } from "./Bridge.ts";
export { SERVE_MOUNT_MARKER, SERVE_SENTINEL } from "./constants.ts";
export { DEFAULT_SERVER_ROUTES, matchRoutes } from "./Routes.ts";

import { bridgeOf, type ServeBridge } from "./Bridge.ts";
export { bridgeOf, type ServeBridge } from "./Bridge.ts";

/**
 * Fallback for classes constructed by a factory that does not stamp a
 * bridge yet (plain `Cloudflare.Worker` extends-form classes). Loaded
 * lazily so the neutral `alchemy/Serve` static graph carries neither
 * cloud; foreign bundlers chunk the dynamic import. Slated for removal
 * once every class factory stamps `SERVE_BRIDGE_KEY`.
 */
const fallbackBridge = (): Promise<ServeBridge> =>
  import("../Cloudflare/Workers/ServeBridge.ts").then(
    (mod) => mod.workerServeBridge,
  );

/**
 * Any effectful Website Platform class — the value default-exported by the
 * user's `src/backend.ts` (`class Site extends
 * Cloudflare.Website.Vite<Site>()(...) {}`). Identified by the `Named`
 * phantom brand the Website class-form types carry; at runtime the class
 * also exposes a real `LogicalId` static (set by `Platform.make`).
 */
export interface AnyWebsiteClass {
  readonly "~alchemy/Id": string;
}

/**
 * The slice of workerd's `ExecutionContext` the mount consumes. Structural
 * so entries type-check against any host's context object (workerd's real
 * ExecutionContext, a synthesized adapter context) without a `cloudflare`
 * type dependency.
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Construction options for {@link mount}: the shared per-call
 * {@link ServeOptions} defaults plus the handle's route claim.
 */
export interface MountOptions extends ServeOptions {
  /**
   * Path globs the effect fetch owns (`runWorkerFirst` dialect: `*`
   * matches any run including `/`, leading `!` excludes and exclusions
   * win). Requests outside the claim resolve `undefined` without invoking
   * the effect fetch — the framework serves them. Inside the claim the
   * effect fetch is authoritative: its responses (404s included) are
   * final.
   * @default DEFAULT_SERVER_ROUTES (["/api/*"])
   */
  routes?: readonly string[];
}

/** @deprecated Renamed {@link MountOptions}. */
export type MakeOptions = MountOptions;

export interface ServeHandle {
  /**
   * Run the effect fetch for this request. Resolves `undefined` ONLY when
   * the request is outside the handle's `routes` claim, when the resolved
   * env carries no alchemy stack markers (build-time prerender/SSG
   * worlds), or when the site has no fetch handler — the caller falls
   * through to the framework (`?? framework.fetch(...)`). Inside the
   * routes the effect fetch is authoritative: a `RouteNotFound` failure
   * (an `HttpRouter` miss) renders as the effect's own 404 response,
   * never delegation.
   *
   * `env` and `ctx` are whatever the caller's position in the world
   * provides — both optional, and their absence selects the correct
   * semantics for hosts that lack them:
   * - `env` omitted → resolved from the cloud's ladder (workerd importable
   *   env / framework globals / `process.env`).
   * - `ctx` omitted → the request scope settles INLINE before the
   *   response resolves (Lambda, dev servers, prerender). Present → scope
   *   finalizers ride `ctx.waitUntil` (workerd semantics).
   */
  fetch(
    request: Request,
    env?: unknown,
    ctx?: ExecutionContextLike,
  ): Promise<Response | undefined>;
  /**
   * Options-bag form of {@link fetch} — the internal seam the framework
   * adapters and dev dispatch drive.
   * @deprecated Use `fetch(request, env?, ctx?)`.
   */
  match(
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined>;
}

/**
 * Create the runtime handle for an effectful Website class — the
 * `alchemy/Serve` bridge that runs the class's Effect `fetch` inside a
 * framework-built server bundle (the explicit tier of effectful
 * Websites). The isolate-scope layer build is lazy — nothing happens
 * until the first matched request — and memoized per class per process.
 *
 * `server.routes` decides who serves each path: requests outside
 * `options.routes` (default `["/api/*"]`; exclusion globs like
 * `"!/api/auth/*"` carve paths back out) resolve `undefined` without
 * invoking the effect fetch, and inside the routes the effect fetch is
 * authoritative — an `HttpRouter` miss (`RouteNotFound`) renders as the
 * effect's own 404 response, never delegation.
 *
 * `defaults` seed every call's options; per-call options win. Env
 * resolution when `options.env` is not given: the guarded
 * `cloudflare:workers` env, then `getCloudflareContext()`-shaped
 * globals, then `process.env`. When the resolved env carries no alchemy
 * stack markers (build-time prerender/SSG worlds), `match` declines
 * every request instead of building the runtime.
 *
 * Mount in whatever file the framework lets you own — your server entry
 * (TanStack, Vite, React Router, Astro) or its hook (SvelteKit's
 * `handle`, a Next catch-all route file, a Nitro middleware). The
 * composition (`?? framework.fetch(...)`, `?? resolve(event)`) is your
 * code: dispatch order, gates, and custom routes are ordinary statements
 * around `site.fetch`.
 *
 * @binding
 * @product Serve
 *
 * @section Mounting in a fetch-shaped entry
 * `site.fetch` resolves `undefined` only when the request is outside the
 * routes claim (or the env carries no alchemy markers), so the entry
 * composes the framework handler as the fallback.
 *
 * @example TanStack Start server entry (src/server.ts)
 * ```typescript
 * import framework from "@tanstack/react-start/server-entry";
 * import { mount } from "alchemy/Serve";
 * import Site from "./backend.ts";
 *
 * const site = mount(Site);
 *
 * export default {
 *   fetch: async (request: Request, env: unknown, ctx: ExecutionContext) =>
 *     (await site.fetch(request, env, ctx)) ?? framework.fetch(request, env, ctx),
 * };
 * ```
 *
 * @example SvelteKit hook (src/hooks.server.ts)
 * ```typescript
 * import { mount } from "alchemy/Serve";
 * import Site from "$lib/backend.ts";
 *
 * const site = mount(Site);
 *
 * export const handle = async ({ event, resolve }) =>
 *   (await site.fetch(event.request, event.platform?.env, event.platform?.ctx)) ??
 *   resolve(event);
 * ```
 */
export const mount = <S extends AnyWebsiteClass>(
  site: S,
  defaults?: MountOptions,
): ServeHandle => {
  markRuntime();
  const routes = defaults?.routes ?? DEFAULT_SERVER_ROUTES;
  const merged = (options?: ServeOptions): ServeOptions | undefined =>
    defaults === undefined ? options : { ...defaults, ...options };
  // The class-carried cloud bridge serves every matched request; classes
  // from factories that do not stamp yet take the lazy fallback.
  const bridge = bridgeOf(site);
  const match = async (
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined> => {
    const pathname = new URL(request.url).pathname;
    // Strict route ownership: outside the claim the framework serves and
    // the effect fetch is never invoked; inside it the effect's answer
    // (404s included) is final.
    if (!matchRoutes(routes, pathname)) {
      return undefined;
    }
    return (bridge ?? (await fallbackBridge())).match(
      site,
      request,
      merged(options),
    );
  };
  return {
    fetch: (request, env, ctx) =>
      match(
        request,
        env === undefined && ctx === undefined
          ? undefined
          : {
              ...(env !== undefined ? { env } : {}),
              // Bind through a closure (not `.bind`) so synthesized
              // adapter contexts with getter-backed waitUntil work too.
              ...(ctx !== undefined
                ? {
                    waitUntil: (promise: Promise<unknown>) =>
                      ctx.waitUntil(promise),
                  }
                : {}),
            },
      ),
    match,
  };
};

/** @deprecated Renamed {@link mount}. */
export const toHandler = mount;

/**
 * Tear down the runtime built for a Website class by a previous
 * {@link mount} handle: the class's cloud bridge closes its
 * instance-lifetime layer scope (init finalizers run) and evicts its
 * per-class memos.
 *
 * Dev-server machinery: called after a hot swap (cache-busted re-import
 * of the backend module → fresh class → fresh `make` handle) retires the
 * previous generation, once its in-flight requests settle.
 */
export const dispose = async <S extends AnyWebsiteClass>(
  site: S,
): Promise<void> => {
  const bridge = bridgeOf(site) ?? (await fallbackBridge());
  return bridge.dispose(site);
};

export class ServeExportsUnavailableError extends Data.TaggedError(
  "ServeExportsUnavailableError",
)<{
  message: string;
}> {}

/**
 * Full exports surface (fetch/queue/scheduled + DO bridge classes) for
 * user-authored custom entries. Ships in a later phase — until then the
 * construct-generated wrapper (auto tier) delivers non-fetch handlers, and
 * {@link mount} delivers fetch on explicit mounts.
 */
export const exports = <S extends AnyWebsiteClass>(_site: S): never => {
  throw new ServeExportsUnavailableError({
    message:
      "Serve.exports is not available yet: the full exports surface for " +
      "custom entries (queue/scheduled/DO classes) ships in a later phase. " +
      "Use the construct-generated wrapper (auto tier) for non-fetch " +
      "handlers, or mount(Site) for fetch-only delivery.",
  });
};
