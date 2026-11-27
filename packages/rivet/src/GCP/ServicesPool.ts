import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Run from "@alchemy.run/gcp/Run";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
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
    // The nodes join no network of the control plane's, so they connect to its
    // public endpoint, never a private address they can't reach.
    network: () => ({ kind: "none" as const }),
    nodes: (nodes) =>
      Effect.gen(function* () {
        const location =
          options.location ??
          (nodes.cluster.network?.kind === "gcp"
            ? nodes.cluster.network.region
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
        // The control plane's token reaches the nodes from Secret Manager,
        // never the worker pool's config.
        const token = yield* SecretManager.Secret(`${id}Token`, {
          value: nodes.environment.RIVET_TOKEN,
        });
        // By id: the secret is in the pool's project, and Cloud Run caps the
        // reference at 255 characters.
        const tokenRef = Output.all(token.secretId, token.version).pipe(
          Output.map(([secret, version]) => ({
            secret,
            version: (version ?? "").split("/versions/")[1] ?? "latest",
          })),
        );
        const workerPool = yield* Run.WorkerPool(`${id}Nodes`, {
          location,
          scaling: { manualInstanceCount: options.replicas ?? 1 },
          template: {
            containers: [
              {
                image: hub.registryUri.pipe(Output.map((registry) => `${registry}/${nodes.image}`)),
                env: Output.all(servicesEnvironment(nodes), tokenRef).pipe(
                  Output.map(([env, secretKeyRef]) => [
                    ...Object.entries(env)
                      .filter(([name]) => name !== "RIVET_TOKEN")
                      .map(([name, value]) => ({ name, value })),
                    { name: "RIVET_TOKEN", valueSource: { secretKeyRef } },
                  ]),
                ),
                resources: {
                  limits: { cpu: options.cpu ?? "1", memory: options.memory ?? "2Gi" },
                },
              },
            ],
          },
        });
        // Cloud Run checks a revision can read the token before it rolls it
        // out: the worker pool grants its own account first.
        yield* workerPool.bind`RivetGCP.ServicesPool.token(${id})`(
          token.name.pipe(
            Output.map((name) => ({
              iam: [
                {
                  role: "roles/secretmanager.secretAccessor",
                  resource: { kind: "secretmanager.secret" as const, name },
                },
              ],
            })),
          ),
        );
      }),
  });
