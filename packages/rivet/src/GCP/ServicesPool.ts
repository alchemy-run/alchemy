import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Run from "@alchemy.run/gcp/Run";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * Region of the worker pool.
   * @default the control plane's region, or the stack's
   */
  location?: string;
  /**
   * CPU of each node (Cloud Run quantity, e.g. `"1"`).
   * @default "1"
   */
  cpu?: string;
  /**
   * Memory of each node (e.g. `"2Gi"`).
   * @default "2Gi"
   */
  memory?: string;
}

/**
 * Run Rivet Services on a Cloud Run worker pool: the `services` pool on the
 * control plane, and a worker pool running Rivet's prebuilt Services node,
 * which hosts Durable Streams and agentOS. Worker pools serve no requests
 * and only connect out to the control plane: callers reach every stream
 * through its gateway, with its token. Works with any control plane it can
 * reach.
 *
 * ### Running Rivet Services on GCP
 * **Example:** Services next to a Compute Engine control plane
 * ```typescript
 * export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet");
 * export const Services = RivetGCP.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetGCP.ServicesPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: (nodes) =>
      Effect.gen(function* () {
        const location =
          options.location ??
          (nodes.network?.kind === "gcp"
            ? nodes.network.region
            : yield* GcpEnvironment.current.pipe(
                Effect.map((env) => env.region),
                Effect.orDie,
              ));
        // Cloud Run pulls Docker Hub images through a mirror that only has
        // popular ones: pull the Services image through a Docker Hub proxy
        // in Artifact Registry instead.
        const hub = yield* ArtifactRegistry.Repository(`${id}DockerHub`, {
          location,
          format: "DOCKER",
          mode: "REMOTE_REPOSITORY",
          remoteRepositoryConfig: { dockerRepository: { publicRepository: "DOCKER_HUB" } },
        });
        yield* Run.WorkerPool(`${id}Nodes`, {
          location,
          scaling: { manualInstanceCount: options.replicas ?? 1 },
          template: {
            containers: [
              {
                image: hub.registryUri.pipe(Output.map((registry) => `${registry}/${nodes.image}`)),
                env: servicesEnvironment(nodes).pipe(
                  Output.map((env) =>
                    Object.entries(env).map(([name, value]) => ({ name, value })),
                  ),
                ),
                resources: {
                  limits: { cpu: options.cpu ?? "1", memory: options.memory ?? "2Gi" },
                },
              },
            ],
          },
        });
      }),
  });
