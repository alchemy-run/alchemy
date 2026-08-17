/**
 * `alchemy/Astro` — mount an effectful Website in Astro's fetchable
 * (`src/fetch.ts`, Astro 7 `fetchFile`; the explicit-tier escape hatch —
 * the auto tier pre-resolves `virtual:astro:fetchable` to a generated
 * wrapper that composes this same helper):
 *
 * ```ts
 * // src/fetch.ts
 * import { FetchState, astro } from "astro/fetch";
 * import { toHandler } from "alchemy/Astro";
 * import Site from "./src/backend.ts";
 * const site = toHandler(Site, { routes: ["/api/*"] });
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
 * `undefined` only for paths outside `routes` (or marker-less build
 * worlds), and the caller then runs Astro's own pipeline
 * (`astro(state)`) — or any other fallback. Inside the routes the effect
 * fetch is authoritative: its responses, 404s included, are final.
 */

import {
  toHandler as makeHandle,
  type AnyWebsiteClass,
  type MakeOptions,
} from "./Serve.ts";

/**
 * Options for {@link toHandler} — {@link MakeOptions} verbatim: the
 * per-call serve options plus the `routes` claim (default `["/api/*"]`).
 */
export type AstroFetchableOptions = MakeOptions;

export interface AstroFetchable {
  /**
   * Run the effect fetch. Resolves `undefined` ONLY when the request is
   * outside `routes` (default `["/api/*"]`), when the resolved env
   * carries no alchemy stack markers (build-time prerender worlds), or
   * when the site has no fetch handler — the caller composes Astro's own
   * pipeline as the fallback. Inside the routes the effect fetch is
   * authoritative: an `HttpRouter` miss renders as the effect's own 404,
   * never delegation.
   */
  fetch(request: Request): Promise<Response | undefined>;
}

/**
 * Mount an effectful Website in Astro's fetchable (`src/fetch.ts`, Astro
 * 7 `fetchFile`) — the explicit-tier escape hatch (the auto tier
 * pre-resolves `virtual:astro:fetchable` to a generated wrapper that
 * composes this same helper). `options.routes` (default `["/api/*"]`,
 * exclusion globs supported) decides who serves each path. Astro's
 * `App.render` requires the fetchable to return a `Response` — there is
 * no undefined-falls-through contract in astro core — so the mounting
 * module composes the fallback itself: `site.fetch` resolves `undefined`
 * only for paths outside `routes` (or marker-less build worlds), and the
 * caller then runs Astro's own pipeline (or any other fallback). Inside
 * the routes the effect fetch's answer (404s included) is final.
 *
 * @binding
 * @product Serve
 *
 * @section Mounting the fetchable
 * @example src/fetch.ts
 * ```typescript
 * import { FetchState, astro } from "astro/fetch";
 * import { toHandler } from "alchemy/Astro";
 * import Site from "./src/backend.ts";
 *
 * const site = toHandler(Site, { routes: ["/api/*"] });
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
export const toHandler = (
  site: AnyWebsiteClass,
  options?: AstroFetchableOptions,
): AstroFetchable => {
  // `make` owns the route gate (default DEFAULT_SERVER_ROUTES): `match`
  // resolves `undefined` on path-miss without invoking the effect fetch.
  const handle = makeHandle(site, options);
  return {
    fetch: (request) => handle.match(request, options),
  };
};
