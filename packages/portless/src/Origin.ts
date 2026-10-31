import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HostnameInvalid, OriginPortRequired } from "./Errors.ts";
import { hostnameOf, hostnameOrThrow, originOf, routedName } from "./internal/Hostname.ts";
import * as Mode from "./internal/Mode.ts";
import { DEFAULT_PORT } from "./internal/State.ts";
import type { Proxy } from "./Proxy.ts";

/**
 * The origin a service will have once it runs, known before it starts. A
 * service that others must be told about first (an API whose CORS list holds
 * the web app's origin) can't wait for the web app to start; the origin only
 * depends on the stage, the service's id and the proxy.
 *
 * It is the same string the service's own `origin` attribute resolves to:
 * `<stage>.<id>.<domain>.localhost` on HTTPS. With a `proxy` resource it is an
 * Output that resolves once the proxy has; with a plain `{ domain }` it is the
 * string itself. With `PORTLESS=0` there is no proxy to name it, so the origin
 * is `http://localhost:<port>` and `port` is required.
 *
 * ### Naming a service before it starts
 * **Example:** Let the API allow the web app's origin
 * ```typescript
 * const webOrigin = yield* Portless.Origin("Web", {
 *   proxy,
 *   port: 5173,
 * });
 *
 * const api = yield* Portless.Dev("Api", {
 *   proxy,
 *   command: "node --watch server.ts",
 *   env: { CORS_ORIGIN: webOrigin },
 * });
 * ```
 *
 * @primitive
 */
export function Origin(
  id: string,
  input: {
    /** The port the service listens on with `PORTLESS=0`, where it is served on `http://localhost`. */
    readonly port?: number | undefined;
    readonly proxy: { readonly domain: string; readonly port?: number | undefined };
  },
): Effect.Effect<string, Config.ConfigError | OriginPortRequired | HostnameInvalid, Stage>;
export function Origin(
  id: string,
  input: {
    readonly port?: number | undefined;
    readonly proxy: Pick<Proxy, "domain" | "port">;
  },
): Effect.Effect<Output.Output<string>, Config.ConfigError | OriginPortRequired, Stage>;
export function Origin(
  id: string,
  {
    port,
    proxy,
  }: {
    readonly port?: number | undefined;
    readonly proxy: {
      readonly domain: string | Output.Output<string>;
      readonly port?: number | Output.Output<number> | undefined;
    };
  },
) {
  return Effect.gen(function* () {
    const stage = yield* Stage;
    const { domain } = proxy;

    if (yield* Mode.disabled) {
      if (port === undefined) return yield* new OriginPortRequired({ id });
      // The shape follows the caller's `domain`: a stage that hands in a proxy resource
      // gets an Output it can compose with other Outputs.
      return Output.isOutput(domain)
        ? Output.asOutput(Mode.localOrigin(port))
        : Mode.localOrigin(port);
    }

    if (typeof domain === "string") {
      const hostname = yield* hostnameOf(routedName(id, stage, domain));
      return originOf(hostname, typeof proxy.port === "number" ? proxy.port : DEFAULT_PORT);
    }
    return Output.all(domain, Output.asOutput(proxy.port ?? DEFAULT_PORT)).pipe(
      // An Output maps with a pure function, so an invalid name is thrown, not failed.
      Output.map(([name, proxyPort]) =>
        originOf(hostnameOrThrow(routedName(id, stage, name)), proxyPort),
      ),
    );
  });
}
