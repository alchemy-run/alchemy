import type { Input } from "alchemy/Input";
import type * as Core from "alchemy/Local/Ingress";
import type { Proxy, ProxyAttributes } from "./Proxy.ts";

/**
 * The `dev.ingress` value `Portless.Ingress(proxy)` returns: plain data naming
 * the proxy to route through. `alchemy dev` hands it, its Outputs resolved, to
 * the router in `@alchemy.run/portless/IngressLive`, which only the dev
 * sidecar imports.
 */
export interface PortlessIngress extends Core.Ingress {
  /** The proxy's domain, for example `myapp`. */
  readonly domain: string;
  /** `localhost`, or `local` for a LAN proxy. */
  readonly tld: string;
  /** The port the proxy serves HTTPS on. */
  readonly port: number;
  /** The proxy's state directory, which holds its routes file. */
  readonly stateDirectory: string;
}

export interface IngressInput {
  /**
   * What the route is called in place of the resource's logical id:
   * `<stage>.<name>.<domain>.localhost`. Names within one stack and stage must
   * be distinct.
   * @default the resource's logical id
   */
  name?: string;
}

/**
 * Gives a local resource's dev URL a stable Portless name. Pass the result as
 * the resource's `dev.ingress`: its `url` becomes the proxy's origin, such as
 * `https://dev-alice.builder.myapp.localhost` (`.local` in LAN mode), while the
 * raw listener stays the address everything inside the dev session dials.
 *
 * The name is the one `Portless.Origin` gives the same id, so it can be handed
 * to other resources before the resource starts. The route belongs to the dev
 * sidecar and goes when the resource's route does. With `PORTLESS=0` nothing
 * is routed and the resource keeps its own address.
 *
 * ### Naming a Worker
 * **Example:** A Worker served at a Portless name
 * ```typescript
 * const proxy = yield* Portless.Proxy("Proxy", { domain: "myapp" });
 *
 * const worker = yield* Cloudflare.Worker("Builder", {
 *   main: "./src/worker.ts",
 *   dev: { ingress: Portless.Ingress(proxy) },
 * });
 * worker.url; // "https://dev-alice.builder.myapp.localhost"
 * ```
 *
 * **Example:** A route named apart from the logical id
 * ```typescript
 * const site = yield* Cloudflare.Worker("Website", {
 *   main: "./src/site.ts",
 *   dev: { ingress: Portless.Ingress(proxy, { name: "Site" }) },
 * });
 * site.url; // "https://dev-alice.site.myapp.localhost"
 * ```
 *
 * @primitive
 */
export function Ingress(
  proxy: ProxySettings<ProxyAttributes>,
  input?: IngressInput,
): PortlessIngress;
export function Ingress(
  proxy: ProxySettings<Proxy | ProxyAttributes>,
  input?: IngressInput,
): Input<PortlessIngress>;
export function Ingress(
  proxy: ProxySettings<Proxy | ProxyAttributes>,
  input?: IngressInput,
): Input<PortlessIngress> {
  return {
    module: "@alchemy.run/portless/IngressLive",
    ...(input?.name === undefined ? {} : { name: input.name }),
    domain: proxy.domain,
    tld: proxy.tld,
    port: proxy.port,
    stateDirectory: proxy.stateDirectory,
  };
}

/** The proxy settings an ingress routes through: a `Portless.Proxy`, or its deployed attributes. */
type ProxySettings<P extends Record<"domain" | "tld" | "port" | "stateDirectory", unknown>> = Pick<
  P,
  "domain" | "tld" | "port" | "stateDirectory"
>;
