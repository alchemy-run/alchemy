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
 * The route already owns its URL space, so a passthrough/decline has no
 * framework handler to fall back to — it becomes a plain 404. Env resolves
 * from OpenNext's `getCloudflareContext()`-shaped global on Cloudflare and
 * `process.env` on AWS/Node (during `next build` prerendering neither
 * carries alchemy markers, so the handler declines instead of building).
 */

import type { ServeOptions } from "./Bridge.ts";
import { cloudflareContextSymbol } from "./Env.ts";
import { make, type AnyWebsiteClass } from "./Serve.ts";

export const toRouteHandler = (
  site: AnyWebsiteClass,
  options?: ServeOptions,
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
