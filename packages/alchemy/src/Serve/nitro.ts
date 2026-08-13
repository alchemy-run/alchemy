/**
 * `alchemy/serve/nitro` — mount an effectful Website as Nuxt/nitro server
 * middleware (the v1 explicit Nuxt path, both clouds; runs in prod and in
 * the nitro dev worker):
 *
 * ```ts
 * // server/middleware/alchemy.ts
 * import { toEventHandler } from "alchemy/serve/nitro";
 * import Site from "../../site";
 * export default toEventHandler(Site);
 * ```
 *
 * The handler answers requests inside `options.routes` (default
 * `["/api/*"]`) with the effect fetch's own web `Response` (h3 ≥ 1.8
 * sends it natively; the effect's 404s are real 404s) and returns
 * `undefined` only for paths outside the routes so nitro continues to
 * the framework's own handlers. Structural h3 types only — alchemy does
 * not depend on `h3`.
 */

import { make, type AnyWebsiteClass, type MakeOptions } from "./Serve.ts";

/** Defeats static resolution of the specifier by foreign bundlers. */
const DO_NOT_BUNDLE = "";

export interface NitroEventLike {
  path?: string;
  method?: string;
  /** h3's node compat layer (present on the node/workerd nitro presets). */
  node?: { req?: any };
  /** Populated when h3 is driven by a web request. */
  web?: { request?: Request };
  context?: {
    cloudflare?: {
      env?: unknown;
      context?: { waitUntil?: (promise: Promise<unknown>) => void };
    };
  };
}

const toWebRequest = async (
  event: NitroEventLike,
): Promise<Request | undefined> => {
  if (event.web?.request !== undefined) {
    return event.web.request;
  }
  const req = event.node?.req;
  if (req === undefined || req === null) {
    return undefined;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(
    (req.headers ?? {}) as Record<string, string | string[] | undefined>,
  )) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const host = headers.get("host") ?? "localhost";
  const url = new URL(event.path ?? req.url ?? "/", `${proto}://${host}`);
  const method = (event.method ?? req.method ?? "GET").toUpperCase();
  let body: ReadableStream | undefined;
  if (method !== "GET" && method !== "HEAD") {
    // Lazy, non-bundleable import: only the node runtime reaches this
    // branch (workerd nitro events carry `event.web.request`).
    const { Readable } = await import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE + "node:stream"
    );
    body = Readable.toWeb(req) as ReadableStream;
  }
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body, duplex: "half" } : {}),
  } as RequestInit);
};

/**
 * Mount an effectful Website as Nuxt/nitro server middleware — the
 * explicit Nuxt mount, both clouds. The middleware is compiled by nitro
 * itself, so the program serves in the deployed server bundle and in the
 * nitro dev worker alike. `options.routes` (default `["/api/*"]`,
 * exclusion globs supported) decides who serves each path: inside the
 * routes the effect fetch answers with its own web `Response` (h3 ≥ 1.8
 * sends it natively; an `HttpRouter` miss renders as the effect's own
 * 404, never delegation), and the middleware returns `undefined` only
 * for paths outside the routes so nitro continues to the framework's
 * own handlers.
 *
 * The returned handler carries h3's `__is_handler__` flag, so nitro
 * accepts it without a `defineEventHandler` wrapper — alchemy does not
 * depend on `h3` (structural types only).
 *
 * @binding
 * @product Serve
 *
 * @section Mounting the middleware
 * @example server/middleware/alchemy.ts
 * ```typescript
 * import { toEventHandler } from "alchemy/serve/nitro";
 * import Site from "../../src/site.ts";
 *
 * export default toEventHandler(Site);
 * ```
 */
export const toEventHandler = (
  site: AnyWebsiteClass,
  options?: MakeOptions,
) => {
  const handle = make(site, options);
  const handler = async (
    event: NitroEventLike,
  ): Promise<Response | undefined> => {
    const request = await toWebRequest(event);
    if (request === undefined) {
      return undefined;
    }
    const cloudflare = event.context?.cloudflare;
    const ctx = cloudflare?.context;
    return handle.match(request, {
      env: options?.env ?? cloudflare?.env,
      waitUntil:
        options?.waitUntil ??
        (ctx?.waitUntil !== undefined
          ? (promise) => ctx.waitUntil!(promise)
          : undefined),
    });
  };
  (handler as any).__is_handler__ = true;
  return handler;
};
