/**
 * Process-level DNS shim that makes `*.localhost` resolve to 127.0.0.1.
 *
 * Background: macOS's `getaddrinfo` does not honor RFC 6761 for arbitrary
 * `*.localhost` names; only the bare `localhost` is mapped to loopback.
 * workerd and browsers handle it themselves, but Node's undici-based fetch
 * (and Bun's libcurl-based fetch on some platforms) fails with `ENOTFOUND`
 * when calling URLs returned by the local Cloudflare worker proxy
 * (e.g. `http://my-worker.localhost:1337`).
 *
 * The proxy in `@distilled.cloud/cloudflare-runtime` dispatches by the
 * URL hostname, so we cannot rewrite the URL client-side to `127.0.0.1`
 * (and `Host` is a forbidden fetch header). The fix is to make the host
 * resolvable at the network layer.
 *
 * Calling `installLocalhostDns()` is idempotent.
 */

import { createRequire } from "node:module";

let installed = false;

const isLocalhost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

export const installLocalhostDns = (): void => {
  if (installed) return;
  installed = true;
  // Bun resolves `*.localhost` natively via its libcurl-based fetch on
  // Darwin and Linux, so the shim is a no-op there. If a future Bun
  // release changes this, install via Bun's undici-compatible global
  // dispatcher here.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return;
  try {
    const require = createRequire(import.meta.url);
    const undici: typeof import("undici") = require("undici");
    const dns: typeof import("node:dns") = require("node:dns");
    undici.setGlobalDispatcher(
      new undici.Agent({
        connect: {
          lookup: (hostname, options, cb: any) => {
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
  } catch {
    // undici not available; nothing to do.
  }
};
