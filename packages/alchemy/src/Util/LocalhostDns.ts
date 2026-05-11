/**
 * Process-level DNS shim that makes `*.localhost` resolve to 127.0.0.1
 * for any HTTP client that goes through undici (Node's global `fetch`,
 * undici-based clients, etc.).
 *
 * Background: macOS's `getaddrinfo` does not honor RFC 6761 for arbitrary
 * `*.localhost` names — only the bare `localhost` is mapped to loopback.
 * The Cloudflare local proxy returns URLs like
 * `http://my-worker.localhost:1337` and dispatches by the URL hostname,
 * so we cannot rewrite the URL client-side to `127.0.0.1` (and `Host` is
 * a forbidden fetch header). The fix is to make the host resolvable at
 * the network layer.
 *
 * On Bun, `globalThis.fetch` is the native (Zig) implementation and does
 * not consult undici's global dispatcher; Bun resolves `*.localhost`
 * itself on Darwin/Linux, so this shim is effectively a no-op there for
 * the global `fetch` and only matters if user code reaches for `undici`
 * directly.
 *
 * Calling `installLocalhostDns()` is idempotent.
 */

import * as dns from "node:dns";
import * as undici from "undici";

let installed = false;

const isLocalhost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

export const installLocalhostDns = (): void => {
  if (installed) return;
  installed = true;

  undici.setGlobalDispatcher(
    new undici.Agent({
      connect: {
        lookup: (hostname, options, cb) => {
          if (isLocalhost(hostname)) {
            if (options && (options as { all?: boolean }).all) {
              return cb(null, [{ address: "127.0.0.1", family: 4 }]);
            }
            return cb(null, "127.0.0.1", 4);
          }
          return dns.lookup(hostname, options, cb);
        },
      },
    }),
  );
};
