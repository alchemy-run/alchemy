import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Query parameter carrying the per-run secret of a local RPC endpoint (the
 * dev spawner and its sidecars). Both listen on loopback, but loopback is
 * reachable by every local user and by any web page the developer has open,
 * and both endpoints run code with the developer's cloud credentials. Only
 * the process that started an endpoint learns its URL, so the token in it
 * proves the caller is that process (or one it handed the URL to).
 */
export const RPC_TOKEN_PARAM = "alchemy-token";

/** A fresh 256-bit token. */
export const makeRpcToken = (): string => randomBytes(32).toString("base64url");

/** `url` with `token` attached. */
export const withRpcToken = (url: string, token: string): string => {
  const next = new URL(url);
  next.searchParams.set(RPC_TOKEN_PARAM, token);
  return next.toString();
};

/** `url` with its path replaced by `pathname`, keeping the token. */
export const rpcUrlPath = (url: string, pathname: string): string => {
  const next = new URL(url);
  next.pathname = pathname;
  return next.toString();
};

/**
 * Whether a request to a local RPC endpoint may be served: it carries the
 * endpoint's token, names the loopback address it listens on (a page that
 * rebinds its own hostname to 127.0.0.1 still sends that hostname), and is
 * not a browser request (browsers always send `Origin` on cross-origin
 * fetches and on every WebSocket upgrade; alchemy's own clients never do).
 */
export const isAuthorizedRpcRequest = (
  request: {
    readonly url: string;
    readonly headers: { readonly host?: string | null; readonly origin?: string | null };
  },
  expected: { readonly token: string; readonly host: string },
): boolean => {
  if (request.headers.origin) return false;
  if (request.headers.host !== expected.host) return false;
  const token = new URL(request.url, "http://localhost").searchParams.get(RPC_TOKEN_PARAM);
  if (token === null) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected.token);
  return a.length === b.length && timingSafeEqual(a, b);
};
