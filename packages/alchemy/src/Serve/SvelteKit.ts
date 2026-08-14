/**
 * `alchemy/SvelteKit` — mount an effectful Website in SvelteKit's
 * `hooks.server.ts` (the explicit-tier escape hatch; the auto tier covers
 * SvelteKit without any framework-file edit):
 *
 * ```ts
 * // src/hooks.server.ts
 * import { sequence } from "@sveltejs/kit/hooks";
 * import { toHandle } from "alchemy/SvelteKit";
 * import Site from "./src/backend.ts";
 * export const handle = sequence(toHandle(Site));
 * ```
 *
 * Structural types only — alchemy does not depend on `@sveltejs/kit`.
 */

import { make, type AnyWebsiteClass, type MakeOptions } from "./Serve.ts";

export interface SvelteKitRequestEvent {
  request: Request;
  /** kit's adapter platform — `{ env, ctx }` on Cloudflare, absent in Node dev. */
  platform?: {
    env?: unknown;
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
}

export interface SvelteKitHandleInput<Event extends SvelteKitRequestEvent> {
  event: Event;
  resolve: (event: Event) => Response | Promise<Response>;
}

/**
 * Mount an effectful Website in SvelteKit's `hooks.server.ts` — the
 * explicit-tier escape hatch (the auto tier covers SvelteKit without any
 * framework-file edit; an explicit mount makes the generated arm stand
 * down). `options.routes` (default `["/api/*"]`, exclusion globs
 * supported) decides who serves each path: the returned kit `Handle`
 * answers requests inside the routes with the effect fetch's own
 * response (404s included — an `HttpRouter` miss is the effect's 404,
 * never delegation) and calls `resolve(event)` only for paths outside
 * the routes, so kit's own `+server` endpoints and pages keep working
 * there. Env comes from `event.platform.env` when the adapter provides
 * it (Cloudflare), falling back to the bridge's resolution ladder (Node
 * dev → `process.env`). Structural types only — alchemy does not depend
 * on `@sveltejs/kit`.
 *
 * @binding
 * @product Serve
 *
 * @section Mounting the handle
 * @example src/hooks.server.ts
 * ```typescript
 * import { sequence } from "@sveltejs/kit/hooks";
 * import { toHandle } from "alchemy/SvelteKit";
 * import Site from "./src/backend.ts";
 *
 * export const handle = sequence(toHandle(Site));
 * ```
 */
export const toHandle = (site: AnyWebsiteClass, options?: MakeOptions) => {
  const handle = make(site, options);
  return async <Event extends SvelteKitRequestEvent>({
    event,
    resolve,
  }: SvelteKitHandleInput<Event>): Promise<Response> => {
    const ctx = event.platform?.ctx;
    const matched = await handle.match(event.request, {
      env: options?.env ?? event.platform?.env,
      waitUntil:
        options?.waitUntil ??
        (ctx?.waitUntil !== undefined
          ? (promise) => ctx.waitUntil!(promise)
          : undefined),
    });
    return matched ?? resolve(event);
  };
};
