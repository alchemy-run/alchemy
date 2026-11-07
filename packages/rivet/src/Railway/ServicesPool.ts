import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * The Railway project to run in.
   * @default a project of the pool's own
   */
  project?: Railway.Project;
  /**
   * Railway region of the service.
   */
  region?: string;
}

/**
 * Run Rivet Services on Railway: the `services` pool on the control plane,
 * and a Railway service running Rivet's prebuilt Services node, which hosts
 * Durable Streams and agentOS. It has no public domain and only connects
 * out: callers reach every stream through the control plane's gateway, with
 * its token. Works with any control plane it can reach.
 *
 * ### Running Rivet Services on Railway
 * **Example:** Services for a control plane elsewhere
 * ```typescript
 * export const Services = RivetRailway.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetRailway.ServicesPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: Effect.fn(function* (nodes) {
      const project = options.project ?? (yield* Railway.Project(`${id}Project`, {}));
      yield* Railway.Service(`${id}Nodes`, {
        project,
        image: nodes.image,
        publicDomain: false,
        region: options.region,
        env: servicesEnvironment(nodes),
      });
    }),
  });
