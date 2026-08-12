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

export type { ServeOptions } from "./Bridge.ts";
export { Passthrough, passthrough } from "./Passthrough.ts";
export { SERVE_SENTINEL } from "./constants.ts";

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

export interface ServeHandle {
  /**
   * Run the effect fetch for this request. Resolves `undefined` on
   * passthrough (a `RouteNotFound` failure or `Serve.passthrough`), when
   * the resolved env carries no alchemy stack markers (build-time
   * prerender/SSG worlds), or when the site has no fetch handler — the
   * caller falls through to the framework.
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
 * Create the runtime handle for a Website class. The isolate-scope layer
 * build is lazy — nothing happens until the first matched request — and
 * memoized per class per process.
 *
 * `defaults` seed every call's options; per-call options win.
 */
export const make = <S extends AnyWebsiteClass>(
  site: S,
  defaults?: ServeOptions,
): ServeHandle => {
  markRuntime();
  const merged = (options?: ServeOptions): ServeOptions | undefined =>
    defaults === undefined ? options : { ...defaults, ...options };
  return {
    match: (request, options) => matchSite(site, request, merged(options)),
    fetch: async (request, options) => {
      const matched = await matchSite(site, request, merged(options));
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
