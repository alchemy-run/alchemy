import * as NodeTls from "node:tls";
import { trustedCertificates } from "@alchemy.run/node-utils/trust";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Config from "../workerd/Config.ts";

export class Internet extends Context.Service<Internet, Config.Service>()(
  "cloudflare-runtime/Internet",
) {}

export const InternetLive = Layer.sync(Internet, () => {
  // `workerd`'s `trustBrowserCas` should probably be named `trustSystemCas`.
  // Rather than using a bundled CA store like Node, it uses
  // `SSL_CTX_set_default_verify_paths()` to use the system CA store:
  // https://github.com/capnproto/capnproto/blob/6e26d260d1d91e0465ca12bbb5230a1dfa28f00d/c%2B%2B/src/kj/compat/tls.c%2B%2B#L745
  // Unfortunately, this doesn't work on Windows. Luckily, Node exposes its own
  // bundled CA store's certificates, so we just use those.
  const baseCertificates = process.platform === "win32" ? Array.from(NodeTls.rootCertificates) : [];
  return {
    name: "internet",
    get network() {
      return {
        // Allow access to private/public addresses:
        // https://github.com/cloudflare/miniflare/issues/412
        allow: ["public", "private", "240.0.0.0/4"],
        deny: [],
        tlsOptions: {
          trustBrowserCas: true,
          // Read here, not when the layer is built: this getter runs each time
          // workerd's config is built, once per spawn. A provider's CA can be
          // created while the first apply is already deploying Workers, so
          // the first Worker to (re)start after it lands trusts it, instead of
          // the whole sidecar keeping the store it started with.
          trustedCertificates: [...baseCertificates, ...trustedCertificates()],
        },
      };
    },
  };
});
