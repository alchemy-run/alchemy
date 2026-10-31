import * as Docker from "@alchemy.run/docker";
import type { Provider } from "alchemy/Provider";
import { Self } from "alchemy/Self";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cluster } from "../Cluster.ts";
import { Host } from "../Host.ts";
import { Pool } from "../Pool.ts";
import { RivetWorkerTypeId, type RivetWorker, type RivetWorkerRuntimeContext } from "../Worker.ts";

/** The RivetKit release the node image installs. */
export const RIVETKIT_VERSION = "3.0.0-preview.4";

/** Packages the node image provides, kept out of the Worker's bundle. */
const EXTERNAL = ["rivetkit", /^rivetkit\//, /^@rivetkit\//];

/** The host was given a cluster whose nodes it cannot reach. */
export class ClusterNotOnDocker extends Data.TaggedError("RivetDocker.ClusterNotOnDocker")<{
  readonly message: string;
}> {}

export interface ServiceOptions {
  /** Host port the Worker's HTTP server is published on. */
  port: number;
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
}

/**
 * Run a `Rivet.Worker` as a Docker swarm service: a pool on the control
 * plane, and a service whose tasks run the Worker's bundle and join the
 * control plane's overlay network. Requires a `Rivet.Cluster` on a Docker
 * network — `RivetDocker.ControlPlane`.
 *
 * ### Running a Worker on Docker
 * **Example:** A Worker on the local swarm
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 * export const Host = RivetDocker.Service({ port: 8080 }).pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const Service = (
  options: ServiceOptions,
): Layer.Layer<Host, never, Cluster | Self<RivetWorker> | Provider<Pool> | Docker.Providers> =>
  Layer.effect(
    Host,
    Effect.gen(function* () {
      const cluster = yield* Cluster;
      if (globalThis.__ALCHEMY_RUNTIME__) return { kind: "docker" };
      const worker = (yield* Self<RivetWorker>(RivetWorkerTypeId)) as RivetWorker &
        RivetWorkerRuntimeContext;
      const network = cluster.network;
      if (network?.kind !== "docker") {
        return yield* Effect.die(
          new ClusterNotOnDocker({
            message:
              "RivetDocker.Service runs Workers on a Docker network, and its cluster is not on one. " +
              "Provide RivetDocker.ControlPlane to it.",
          }),
        );
      }
      const id = worker.LogicalId;
      yield* worker.registerHost(
        Effect.gen(function* () {
          const pool = yield* Pool(`${id}Pool`, {
            endpoint: cluster.endpoint,
            token: cluster.token,
            namespace: cluster.namespace,
          });
          // One node image per stack; every Worker builds FROM it.
          const image = yield* Docker.Image("RivetNodeImage", {
            build: {
              context: new URL("../../images/node", import.meta.url).pathname,
              args: { RIVETKIT_VERSION },
            },
          });
          // The service runs the Worker's own bundle. An impl is passed so the
          // bundle gets the Effect bootstrap (a props-only service is an
          // external program); the bootstrap then loads `handler`, the Worker.
          yield* Docker.Service(
            `${id}Node`,
            {
              main: worker.Props.main,
              handler: worker.Props.handler ?? "default",
              image: image.imageRef,
              port: 3000,
              ports: [{ external: options.port, internal: 3000 }],
              replicas: options.replicas ?? 1,
              networks: [{ name: network.name }],
              env: worker.env,
              environment: {
                RIVET_ENDPOINT: cluster.nodeEndpoint ?? cluster.endpoint,
                RIVET_TOKEN: cluster.token,
                RIVET_NAMESPACE: cluster.namespace,
                RIVET_POOL: pool.name,
              },
              build: { input: { external: EXTERNAL } },
            },
            Effect.succeed(undefined),
          );
          yield* worker.bind`Host`({ url: `http://localhost:${options.port}` });
        }),
      );
      return { kind: "docker" };
    }),
  );
