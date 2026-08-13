/**
 * The public `alchemy/serve` surface (DESIGN §3.3) — the explicit-tier
 * runtime helper mounted in framework server entries:
 *
 * ```ts
 * // src/server.ts (TanStack shown — any fetch-shaped entry)
 * import handler from "@tanstack/react-start/server-entry";
 * import { Serve } from "alchemy/serve";
 * import Site from "./site.ts";
 * const site = Serve.make(Site);
 * export default {
 *   fetch: async (req) => (await site.match(req)) ?? handler.fetch(req),
 * };
 * ```
 */

import * as Data from "effect/Data";
import { markRuntime, matchSite, type ServeOptions } from "./Bridge.ts";
import { SERVE_SHELL_KEY } from "./constants.ts";
import { DEFAULT_SERVER_ROUTES, matchRoutes } from "./Routes.ts";

export type { ServeOptions } from "./Bridge.ts";
export { SERVE_SENTINEL } from "./constants.ts";
export { DEFAULT_SERVER_ROUTES } from "./Routes.ts";

/**
 * A cloud-specific serve shell a Website class may carry under
 * {@link SERVE_SHELL_KEY}: the runtime half {@link make} dispatches matched
 * requests to instead of the default (Cloudflare-flavored) bridge. AWS
 * Website classes attach the Lambda/Node shell here at class construction
 * so it rides the site module's own import graph — `alchemy/serve` never
 * statically imports both clouds' runtime recipes.
 */
export interface ServeShell {
  match(
    site: object,
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined>;
}

const shellOf = (site: object): ServeShell | undefined =>
  (site as Record<string, unknown>)[SERVE_SHELL_KEY] as ServeShell | undefined;

/**
 * Any effectful Website Platform class — the value default-exported by the
 * user's `site.ts` (`class Site extends
 * Cloudflare.Website.Vite<Site>()(...) {}`). Identified by the `Named`
 * phantom brand the Website class-form types carry; at runtime the class
 * also exposes a real `LogicalId` static (set by `Platform.make`).
 */
export interface AnyWebsiteClass {
  readonly "~alchemy/Id": string;
}

/**
 * Construction options for {@link make}: the shared per-call
 * {@link ServeOptions} defaults plus the handle's route claim.
 */
export interface MakeOptions extends ServeOptions {
  /**
   * Path globs the effect fetch owns (the construct's `server.routes`,
   * `runWorkerFirst` dialect: `*` matches any run including `/`, leading
   * `!` excludes and exclusions win). Requests outside the claim resolve
   * `undefined` without invoking the effect fetch — the framework serves
   * them. Inside the claim the effect fetch is authoritative: its
   * responses (404s included) are final.
   * @default DEFAULT_SERVER_ROUTES (["/api/*"])
   */
  routes?: readonly string[];
}

export interface ServeHandle {
  /**
   * Run the effect fetch for this request. Resolves `undefined` ONLY when
   * the request is outside the handle's `routes` claim, when the resolved
   * env carries no alchemy stack markers (build-time prerender/SSG
   * worlds), or when the site has no fetch handler — the caller falls
   * through to the framework. Inside the routes the effect fetch is
   * authoritative: a `RouteNotFound` failure (an `HttpRouter` miss)
   * renders as the effect's own 404 response, never delegation.
   */
  match(
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined>;
  /**
   * {@link match} with a mandatory response — for entries where the user
   * module IS the handler. Declined requests go to `fallback`, or a plain
   * 404 when none is given.
   */
  fetch(
    request: Request,
    options?: ServeOptions & {
      fallback?: (request: Request) => Promise<Response>;
    },
  ): Promise<Response>;
}

/**
 * Create the runtime handle for an effectful Website class — the
 * `alchemy/serve` bridge that runs the class's Effect `fetch` inside a
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
 * Prefer the per-framework mounts where one exists — `toRouteHandler`
 * (`alchemy/serve/next`), `toEventHandler` (`alchemy/serve/nitro`),
 * `toHandle` (`alchemy/serve/sveltekit`), `toFetchable`
 * (`alchemy/serve/astro`) — and reach for `make` in any other
 * fetch-shaped server entry.
 *
 * @binding
 * @product Serve
 *
 * @section Mounting in a fetch-shaped entry
 * `match` resolves `undefined` only when the request is outside the
 * routes claim (or the env carries no alchemy markers), so the entry
 * composes the framework handler as the fallback.
 *
 * @example TanStack Start server entry (src/server.ts)
 * ```typescript
 * import handler from "@tanstack/react-start/server-entry";
 * import * as Serve from "alchemy/serve";
 * import Site from "./site.ts";
 *
 * const site = Serve.make(Site);
 *
 * export default {
 *   fetch: async (request: Request) =>
 *     (await site.match(request)) ?? handler.fetch(request),
 * };
 * ```
 *
 * @section The handler owns the entry
 * Use `fetch` instead of `match` when the mounting module IS the
 * handler — declined requests go to the optional `fallback`, or a plain
 * 404.
 *
 * @example Standalone fetch entry
 * ```typescript
 * import * as Serve from "alchemy/serve";
 * import Site from "./site.ts";
 *
 * const site = Serve.make(Site);
 *
 * export default {
 *   fetch: (request: Request) => site.fetch(request),
 * };
 * ```
 */
export const make = <S extends AnyWebsiteClass>(
  site: S,
  defaults?: MakeOptions,
): ServeHandle => {
  markRuntime();
  const routes = defaults?.routes ?? DEFAULT_SERVER_ROUTES;
  const merged = (options?: ServeOptions): ServeOptions | undefined =>
    defaults === undefined ? options : { ...defaults, ...options };
  // A class carrying its own cloud-specific shell (AWS Lambda/Node) is
  // served by that shell; everything else takes the default bridge.
  const shell = shellOf(site);
  const match = (
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined> => {
    // Strict route ownership: outside the claim the framework serves and
    // the effect fetch is never invoked; inside it the effect's answer
    // (404s included) is final.
    if (!matchRoutes(routes, new URL(request.url).pathname)) {
      return Promise.resolve(undefined);
    }
    return shell !== undefined
      ? shell.match(site, request, merged(options))
      : matchSite(site, request, merged(options));
  };
  return {
    match,
    fetch: async (request, options) => {
      const matched = await match(request, options);
      if (matched !== undefined) {
        return matched;
      }
      if (options?.fallback !== undefined) {
        return options.fallback(request);
      }
      return new Response("Not Found", { status: 404 });
    },
  };
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
 * {@link make} delivers fetch on explicit mounts.
 */
export const exports = <S extends AnyWebsiteClass>(_site: S): never => {
  throw new ServeExportsUnavailableError({
    message:
      "Serve.exports is not available yet: the full exports surface for " +
      "custom entries (queue/scheduled/DO classes) ships in a later phase. " +
      "Use the construct-generated wrapper (auto tier) for non-fetch " +
      "handlers, or mount Serve.make(Site) for fetch-only delivery.",
  });
};
