import * as Docker from "@alchemy.run/docker";
import * as Output from "alchemy/Output";
import type { Provider } from "alchemy/Provider";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetDocker.ControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0-preview.4";

export interface ControlPlaneProps {
  /**
   * Host port the control plane's API is published on.
   * @default 6420
   */
  port?: number;
  /**
   * Engine image.
   * @default "rivetdev/engine:3.0.0-preview.4"
   */
  image?: string;
  /**
   * The Docker engine to run on: a context name, a `Docker.Context`, or a
   * `Docker.Swarm` (which orders the control plane after the swarm).
   * @default the current Docker context
   */
  context?: Docker.Docker.EngineRef;
}

/**
 * A single-instance Rivet control plane on a Docker swarm, as a
 * `Rivet.Cluster` Layer: the engine as a one-replica swarm service with
 * file-system storage on a named volume, a generated admin token, an overlay
 * network that Worker services join, and a namespace for the stage. The
 * Docker engine must be in swarm mode (`Docker.Swarm`, or `docker swarm
 * init`).
 *
 * It is meant for development and tests. One instance keeps recent writes
 * only on its own disk, so losing the volume loses data; production control
 * planes run three or more instances.
 *
 * ### Running a local control plane
 * **Example:** A control plane for local Workers
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 * ```
 *
 * **Example:** On another port
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet", { port: 16420 });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (
  id: string,
  props: ControlPlaneProps = {},
): Layer.Layer<Cluster, never, Provider<Namespace> | Provider<Random> | Docker.Providers> =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      const port = props.port ?? 6420;
      const endpoint = `http://localhost:${port}`;
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes read their endpoint and token from their own environment at
        // runtime; the cluster is only consulted while deploying.
        return { endpoint, token: Redacted.make(""), namespace: "default" };
      }
      const token = yield* Random(`${id}AdminToken`, { bytes: 32 });
      const context = props.context === undefined ? {} : { context: props.context };
      const network = yield* Docker.Network(`${id}Network`, { driver: "overlay", ...context });
      const volumeContext = Docker.dockerEngineContextName(props.context);
      const data = yield* Docker.Volume(
        `${id}Data`,
        volumeContext === undefined ? {} : { context: volumeContext },
      );
      const engine = yield* Docker.Service(`${id}Engine`, {
        image: props.image ?? DEFAULT_ENGINE_IMAGE,
        ...context,
        environment: {
          RIVET__AUTH__ADMIN_TOKEN: token.text,
          RIVET__STORAGE__LOG_DIRECTORY: "/var/lib/rivet",
          RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: "/var/lib/rivet/objects",
          RIVET__TELEMETRY__ENABLED: "false",
        },
        ports: [{ external: port, internal: 6420 }],
        volumes: [{ hostPath: data.name, containerPath: "/var/lib/rivet" }],
        networks: [{ name: network.name, aliases: ["rivet-engine"] }],
        replicas: 1,
      });
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Ordered after the engine container: the namespace is created
        // through the API it serves.
        endpoint: engine.name.pipe(Output.map(() => endpoint)),
        token: token.text,
      });
      return {
        endpoint,
        nodeEndpoint: "http://rivet-engine:6420",
        network: { kind: "docker", name: network.name },
        token: token.text,
        namespace: namespace.name,
      };
    }),
  );
