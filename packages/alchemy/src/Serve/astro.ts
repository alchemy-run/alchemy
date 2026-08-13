/**
 * `alchemy/serve/astro` — mount an effectful Website in Astro's fetchable
 * (`src/fetch.ts`, Astro 7 `fetchFile`; the explicit-tier escape hatch —
 * the auto tier pre-resolves `virtual:astro:fetchable` to a generated
 * wrapper that composes this same helper):
 *
 * ```ts
 * // src/fetch.ts
 * import { FetchState, astro } from "astro/fetch";
 * import { toFetchable } from "alchemy/serve/astro";
 * import Site from "./site.ts";
 * const site = toFetchable(Site, { routes: ["/api/*"] });
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     return (
 *       (await site.fetch(request)) ?? astro(new FetchState(request))
 *     );
 *   },
 * };
 * ```
 *
 * Astro's `App.render` requires the fetchable to return a `Response`
 * (there is no undefined-falls-through contract in astro core), so the
 * mounting module composes the fallback itself: `site.fetch` resolves
 * `undefined` on passthrough/miss/outside-`routes`, and the caller then
 * runs Astro's own pipeline (`astro(state)`) — or any other fallback.
 */

import type { ServeOptions } from "./Bridge.ts";
import { matchRoutes } from "./Routes.ts";
import { make, type AnyWebsiteClass } from "./Serve.ts";

export interface AstroFetchableOptions extends ServeOptions {
  /**
   * Path globs the effect fetch owns (the construct's `server.routes`,
   * `runWorkerFirst` dialect: `*` matches any run including `/`, leading
   * `!` excludes). Requests outside the scope resolve `undefined`
   * immediately — the caller falls through to Astro. Omitted = every
   * request is offered to the effect fetch first (middleware mode).
   */
  routes?: readonly string[];
}

export interface AstroFetchable {
  /**
   * Run the effect fetch. Resolves `undefined` when the request is
   * outside `routes`, when the effect declined it (`RouteNotFound` /
   * `Serve.passthrough`), when the resolved env carries no alchemy stack
   * markers (build-time prerender worlds), or when the site has no fetch
   * handler — the caller composes Astro's own pipeline as the fallback.
   */
  fetch(request: Request): Promise<Response | undefined>;
}

/**
 * Mount an effectful Website in Astro's fetchable (`src/fetch.ts`, Astro
 * 7 `fetchFile`) — the explicit-tier escape hatch (the auto tier
 * pre-resolves `virtual:astro:fetchable` to a generated wrapper that
 * composes this same helper). Astro's `App.render` requires the
 * fetchable to return a `Response` — there is no undefined-falls-through
 * contract in astro core — so the mounting module composes the fallback
 * itself: `site.fetch` resolves `undefined` on passthrough, miss, or
 * outside-`routes`, and the caller then runs Astro's own pipeline (or
 * any other fallback).
 *
 * @binding
 * @product Serve
 *
 * @section Mounting the fetchable
 * @example src/fetch.ts
 * ```typescript
 * import { FetchState, astro } from "astro/fetch";
 * import { toFetchable } from "alchemy/serve/astro";
 * import Site from "./site.ts";
 *
 * const site = toFetchable(Site, { routes: ["/api/*"] });
 *
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     return (
 *       (await site.fetch(request)) ?? astro(new FetchState(request))
 *     );
 *   },
 * };
 * ```
 */
export const toFetchable = (
  site: AnyWebsiteClass,
  options?: AstroFetchableOptions,
): AstroFetchable => {
  const handle = make(site, options);
  const routes = options?.routes;
  return {
    fetch: (request) => {
      if (
        routes !== undefined &&
        !matchRoutes(routes, new URL(request.url).pathname)
      ) {
        return Promise.resolve(undefined);
      }
      return handle.match(request, options);
    },
  };
};
