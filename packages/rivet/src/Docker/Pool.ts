import { fileURLToPath } from "node:url";
import * as Docker from "@alchemy.run/docker";
import * as Output from "alchemy/Output";
import type { Provider } from "alchemy/Provider";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cluster } from "../Cluster.ts";
import {
  DurableObjectTypeId,
  type DurableObject,
  type DurableObjectRuntimeContext,
} from "../DurableObject.ts";
import { Pool as RivetPool, type PoolDurableObject } from "../Pool.ts";

/** The RivetKit release the node image installs. */
export const RIVETKIT_VERSION = "3.0.0-preview.4";

/** Packages the node image provides, kept out of the node bundle. */
const EXTERNAL = ["rivetkit", /^rivetkit\//, /^@rivetkit\//];

/**
 * The node entry, which imports the pool's classes from {@link VIRTUAL}.
 * Resolved while deploying only: a runtime bundle has no module URL.
 */
const nodeEntry = () =>
  fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../internal/node.ts" : "../internal/node.js",
      import.meta.url,
    ),
  );

const VIRTUAL = "virtual:rivet-durable-objects";

/** Resolve {@link VIRTUAL} to a module that imports every class the pool hosts. */
const durableObjectsPlugin = (objects: ReadonlyArray<PoolDurableObject>) => {
  const source = [
    ...objects.map(
      (object, i) =>
        `import { ${object.handler} as d${i} } from ${JSON.stringify(
          object.module.startsWith("file:") ? fileURLToPath(object.module) : object.module,
        )};`,
    ),
    `export default [${objects.map((_, i) => `d${i}`).join(", ")}];`,
  ].join("\n");
  return [
    {
      name: "rivet-durable-objects",
      resolveId: (id: string) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
      load: (id: string) => (id === `\0${VIRTUAL}` ? source : null),
    },
  ];
};

/** The pool was given a cluster whose network its nodes cannot join. */
export class ClusterNotOnDocker extends Data.TaggedError("RivetDocker.ClusterNotOnDocker")<{
  readonly message: string;
}> {}

/** The pool Layer was provided to something other than a Durable Object's Effect. */
export class PoolOutsideDurableObject extends Data.TaggedError(
  "RivetDocker.PoolOutsideDurableObject",
)<{
  readonly message: string;
}> {}

/** `${stack}-${stage}-${id}`, as a pool name: lowercase DNS label, at most 63 characters. */
const defaultPoolName = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  return `${stack.name}-${stack.stage}-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
});

export interface PoolOptions {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * Pool name on the control plane.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
}

/**
 * Run a pool's nodes on a Docker swarm: a pool on the control plane, and a
 * swarm service whose tasks host every `Rivet.DurableObject` given this
 * pool and join the control plane's overlay network. Nodes only connect
 * out to the control plane, so the service publishes no ports. Requires a
 * `Rivet.Cluster` on a Docker network — `RivetDocker.ControlPlane`.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Docker
 * **Example:** A pool on the local swarm
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 * export const Default = RivetDocker.Pool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** Two nodes
 * ```typescript
 * export const Default = RivetDocker.Pool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const Pool = (
  id: string,
  options: PoolOptions = {},
): Layer.Layer<never, never, Cluster | Self | Stack | Provider<RivetPool> | Docker.Providers> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const cluster = yield* Cluster;
      if (globalThis.__ALCHEMY_RUNTIME__) return;
      // The generic `Self` is the class whose phase is running — the typed
      // `Self<Rivet.DurableObject>` is the enclosing one while a class is
      // built inside another's (a `Rivet.Client` dependency).
      const self = yield* Self;
      if (self.Type !== DurableObjectTypeId) {
        return yield* Effect.die(
          new PoolOutsideDurableObject({
            message: `RivetDocker.Pool("${id}") was provided to ${self.Type} '${self.LogicalId}', not a Rivet.DurableObject.`,
          }),
        );
      }
      const object = self as unknown as DurableObject & DurableObjectRuntimeContext;
      const network = cluster.network;
      if (network?.kind !== "docker") {
        return yield* Effect.die(
          new ClusterNotOnDocker({
            message:
              "RivetDocker.Pool runs nodes on a Docker network, and its cluster is not on one. " +
              "Provide RivetDocker.ControlPlane to it.",
          }),
        );
      }
      // Named up front, so a class knows its pool without depending on the
      // pool resource — whose bindings carry every class's env, which can
      // name other classes' pools (a `Rivet.Client` between classes).
      const name = options.name ?? (yield* defaultPoolName(id));
      yield* object.registerPool((env) =>
        Effect.gen(function* () {
          const pool = yield* RivetPool(id, {
            endpoint: cluster.endpoint,
            token: cluster.token,
            namespace: cluster.namespace,
            name,
          });
          // The class joins the pool's nodes, and learns which pool hosts it.
          yield* pool.bind`${object.LogicalId}`({
            durableObjects: [
              {
                name: object.LogicalId,
                module: object.Props.main,
                handler: object.Props.handler ?? "default",
              },
            ],
            env,
          });
          yield* object.bind`Pool`({ pool: name });
          // One node image per stack; every pool builds FROM it.
          const image = yield* Docker.Image("RivetNodeImage", {
            build: {
              context: fileURLToPath(new URL("../../images/node", import.meta.url)),
              args: { RIVETKIT_VERSION },
            },
          });
          // Every class the pool hosts is bundled into its node image.
          yield* Docker.Service(`${id}Nodes`, {
            main: nodeEntry(),
            image: image.imageRef,
            replicas: options.replicas ?? 1,
            networks: [{ name: network.name }],
            env: pool.env,
            environment: {
              RIVET_ENDPOINT: cluster.nodeEndpoint ?? cluster.endpoint,
              RIVET_TOKEN: cluster.token,
              RIVET_NAMESPACE: cluster.namespace,
              RIVET_POOL: pool.name,
            },
            build: {
              input: {
                external: EXTERNAL,
                plugins: pool.durableObjects.pipe(Output.map(durableObjectsPlugin)),
              },
            },
          });
        }),
      );
    }),
  );
