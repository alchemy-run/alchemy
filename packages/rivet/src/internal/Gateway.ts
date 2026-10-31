/**
 * Requests to an actor through the control plane's gateway, the way
 * RivetKit's client sends them, over the runtime's own `fetch` — so callers
 * (Workers, Lambdas, containers) need no RivetKit.
 *
 * @internal
 */
import type { NativeFetcher } from "./Fetcher.ts";

export interface GatewayTarget {
  /** The control plane URL the caller reaches. */
  readonly endpoint: string;
  readonly token: string;
  readonly namespace: string;
  /** The pool that hosts the actor, so the gateway can create it there. */
  readonly pool: string;
  /** The actor name: the Durable Object's logical id. */
  readonly name: string;
  /** The instance key. */
  readonly key: string;
}

/** RivetKit's canonical key encoding (one part). */
const encodeKey = (key: string) =>
  key === "" ? "\\0" : key.replace(/\\/g, "\\\\").replace(/,/g, "\\,");

/**
 * The gateway URL for a request to `/path?query` on an actor addressed by
 * name and key, created in its pool on first use.
 */
export const gatewayUrl = (target: GatewayTarget, path: string, search: string): string => {
  const params = new URLSearchParams({
    "rvt-namespace": target.namespace,
    "rvt-method": "getOrCreate",
    "rvt-runner": target.pool,
    "rvt-key": encodeKey(target.key),
    "rvt-crash-policy": "sleep",
    "rvt-token": target.token,
  });
  const base = target.endpoint.replace(/\/+$/, "");
  const query = search === "" ? `?${params}` : `${search}&${params}`;
  return `${base}/gateway/${encodeURIComponent(target.name)}/request${path}${query}`;
};

/** A fetcher whose requests reach the actor's `onRequest` through the gateway. */
export const gatewayFetcher = (target: GatewayTarget): NativeFetcher => ({
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return fetch(gatewayUrl(target, url.pathname, url.search), {
      method: request.method,
      headers: request.headers,
      body: body === undefined || body.byteLength === 0 ? undefined : body,
      signal: request.signal,
    });
  },
});
