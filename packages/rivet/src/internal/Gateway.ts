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

/** The header the gateway reads the caller's token from, as RivetKit's client sends it. */
export const TOKEN_HEADER = "x-rivet-token";

/** RivetKit's canonical key encoding (one part). */
const encodeKey = (key: string) =>
  key === "" ? "\\0" : key.replace(/\\/g, "\\\\").replace(/,/g, "\\,");

/**
 * The gateway URL for a request to `/path?query` on an actor addressed by
 * name and key, created in its pool on first use. The token travels in the
 * {@link TOKEN_HEADER} header, never the URL, so it stays out of proxy and
 * load balancer logs.
 */
export const gatewayUrl = (target: GatewayTarget, path: string, search: string): string => {
  const params = new URLSearchParams({
    "rvt-namespace": target.namespace,
    "rvt-method": "getOrCreate",
    "rvt-runner": target.pool,
    "rvt-key": encodeKey(target.key),
    "rvt-crash-policy": "sleep",
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
    const headers = new Headers(request.headers);
    headers.set(TOKEN_HEADER, target.token);
    return fetch(gatewayUrl(target, url.pathname, url.search), {
      method: request.method,
      headers,
      body: body === undefined || body.byteLength === 0 ? undefined : body,
      signal: request.signal,
    });
  },
});

/**
 * Send one request to the gateway over the runtime's own `fetch`, with the
 * caller's token in {@link TOKEN_HEADER}.
 */
export const gatewaySend = (
  url: string,
  token: string,
  init: {
    readonly method: string;
    readonly headers?: Record<string, string> | undefined;
    readonly body?: Uint8Array | undefined;
    readonly signal: AbortSignal;
  },
) =>
  fetch(url, {
    method: init.method,
    headers: { ...init.headers, [TOKEN_HEADER]: token },
    body: init.body as BodyInit | undefined,
    signal: init.signal,
  });
