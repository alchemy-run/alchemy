import type { IngressConfig } from "alchemy/Local/Ingress";
import type { Proxy, ProxyAttributes } from "./Proxy.ts";

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
 * `https://dev-alice.builder.myapp.localhost`, while the raw listener stays
 * the address everything inside the dev session dials.
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
 * @primitive
 */
export const Ingress = (
  proxy: Pick<Proxy | ProxyAttributes, "domain" | "port" | "stateDirectory">,
  input?: IngressInput,
): IngressConfig<"portless"> => ({
  type: "portless",
  ...(input?.name === undefined ? {} : { name: input.name }),
  options: {
    domain: proxy.domain,
    port: proxy.port,
    stateDirectory: proxy.stateDirectory,
  },
});
