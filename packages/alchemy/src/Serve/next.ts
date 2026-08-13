/**
 * `alchemy/serve/next` — mount an effectful Website as a Next.js app-router
 * catch-all route handler (the v1 explicit Next path, both clouds; compiled
 * by Next itself):
 *
 * ```ts
 * // app/api/[[...slug]]/route.ts
 * import { toRouteHandler } from "alchemy/serve/next";
 * import Site from "@/site";
 * const handler = toRouteHandler(Site);
 * export { handler as GET, handler as POST, handler as PUT,
 *          handler as PATCH, handler as DELETE, handler as HEAD,
 *          handler as OPTIONS };
 * ```
 *
 * Inside `options.routes` (default `["/api/*"]`) the effect fetch is
 * authoritative — its responses (404s included) are final. The route
 * already owns its URL space, so a decline (path outside the routes, or a
 * marker-less build world) has no framework handler to fall back to — it
 * becomes a plain 404. Env resolves from OpenNext's
 * `getCloudflareContext()`-shaped global on Cloudflare and `process.env`
 * on AWS/Node (during `next build` prerendering neither carries alchemy
 * markers, so the handler declines instead of building).
 */

import { cloudflareContextSymbol } from "./Env.ts";
import { make, type AnyWebsiteClass, type MakeOptions } from "./Serve.ts";

/**
 * Mount an effectful Website as a Next.js app-router catch-all route
 * handler — the explicit Next mount, both clouds. The route file is
 * compiled by Next itself, so the program serves in the production build
 * and in `next dev` alike. Next's router prefers more specific routes,
 * so your own route handlers keep winning over the catch-all. Inside
 * `options.routes` (default `["/api/*"]`) the effect fetch's answer is
 * final — an `HttpRouter` miss renders as the effect's own 404; a
 * decline (path outside the routes) has no framework handler left to
 * fall back to and becomes a plain 404.
 *
 * Env resolves from OpenNext's `getCloudflareContext()`-shaped global on
 * Cloudflare and `process.env` on AWS/Node. During `next build`
 * prerendering neither carries alchemy stack markers, so the handler
 * declines instead of building the runtime.
 *
 * @binding
 * @product Serve
 *
 * @section Mounting the catch-all route
 * @example app/api/[[...slug]]/route.ts
 * ```typescript
 * import { toRouteHandler } from "alchemy/serve/next";
 * import Site from "../../../src/backend.ts";
 *
 * const handler = toRouteHandler(Site);
 * export { handler as GET, handler as POST, handler as PUT,
 *          handler as PATCH, handler as DELETE, handler as HEAD,
 *          handler as OPTIONS };
 * ```
 */
export const toRouteHandler = (
  site: AnyWebsiteClass,
  options?: MakeOptions,
) => {
  const handle = make(site, options);
  return async (request: Request): Promise<Response> => {
    const cloudflareContext = (globalThis as Record<PropertyKey, any>)[
      cloudflareContextSymbol
    ];
    const ctx = cloudflareContext?.ctx;
    const matched = await handle.match(request, {
      env: options?.env ?? cloudflareContext?.env,
      waitUntil:
        options?.waitUntil ??
        (typeof ctx?.waitUntil === "function"
          ? (promise: Promise<unknown>) => ctx.waitUntil(promise)
          : undefined),
    });
    return matched ?? new Response("Not Found", { status: 404 });
  };
};
