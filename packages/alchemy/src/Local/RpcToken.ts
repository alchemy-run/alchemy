import * as Effect from "effect/Effect";

/**
 * Per-process tokens for the local dev servers (the RPC spawner and its
 * sidecars). Each server only answers requests that carry its token as the
 * first path segment of its URL. The URL is handed to clients over the
 * child's stdout pipe or its environment.
 */

/** A fresh 256-bit token, hex encoded. */
export const makeRpcToken = Effect.sync(() => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** `base` with `token` as its path: `http://127.0.0.1:1234` → `http://127.0.0.1:1234/<token>`. */
export const withRpcToken = (base: string, token: string): string => {
  const url = new URL(base);
  url.pathname = `/${token}`;
  return url.toString();
};

/**
 * Append `path` to a tokened server URL, keeping the token: use this
 * instead of `new URL("/path", url)`, which drops it.
 */
export const rpcSubpath = (url: string | URL, path: string): string => {
  const next = new URL(url);
  next.pathname = `${next.pathname.replace(/\/+$/, "")}${path}`;
  return next.toString();
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

/**
 * The rest of `pathname` after the `/<token>` prefix (`""` for the root,
 * `"/parent"`, …), or `undefined` when the request does not carry the token.
 */
export const matchRpcToken = (pathname: string, token: string): string | undefined => {
  const prefix = `/${token}`;
  if (token.length === 0 || pathname.length < prefix.length) return undefined;
  if (!constantTimeEqual(pathname.slice(0, prefix.length), prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === "/") return "";
  return rest === "" || rest.startsWith("/") ? rest : undefined;
};

/** The pathname of a request URL that may be relative (Node) or absolute (Bun). */
export const requestPathname = (url: string | undefined): string => {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
};
