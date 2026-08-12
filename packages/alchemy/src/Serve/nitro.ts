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
 * The handler answers matched effect routes with a web `Response` (h3
 * ≥ 1.8 sends it natively) and returns `undefined` on passthrough/miss so
 * nitro continues to the framework's own handlers. Structural h3 types
 * only — alchemy does not depend on `h3`.
 */

import type { ServeOptions } from "./Bridge.ts";
import { make, type AnyWebsiteClass } from "./Serve.ts";

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
 * Build the h3 event handler. Marked with h3's `__is_handler__` flag so
 * nitro accepts it without a `defineEventHandler` wrapper (and without
 * alchemy depending on `h3`).
 */
export const toEventHandler = (
  site: AnyWebsiteClass,
  options?: ServeOptions,
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
