/**
 * What every pool Layer shares, whatever runs its nodes: register the class
 * whose phase is running with a pool on the control plane, bind what callers
 * need onto the class, and bundle every class in the pool into one node
 * program. A host only declares the service that runs that program.
 *
 * @internal
 */
import { fileURLToPath } from "node:url";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { Provider } from "alchemy/Provider";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster, type ClusterShape } from "../Cluster.ts";
import {
  DurableObjectTypeId,
  type DurableObject,
  type DurableObjectRuntimeContext,
} from "../DurableObject.ts";
import { Pool, type PoolDurableObject } from "../Pool.ts";

/** The RivetKit release node images install. */
export const RIVETKIT_VERSION = "3.0.0-preview.4";

/** A node image environment: bun with RivetKit installed. */
export const NODE_DOCKERFILE = `FROM oven/bun:1
WORKDIR /app
RUN bun add rivetkit@${RIVETKIT_VERSION}
`;

/** Packages the node image provides, kept out of the node bundle. */
const EXTERNAL = ["rivetkit", /^rivetkit\//, /^@rivetkit\//];

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

/** `${stack}-${stage}-${id}` as a lowercase DNS label of at most `max` characters. */
export const stackDnsLabel = Effect.fn(function* (id: string, max = 63) {
  const stack = yield* Stack;
  return `${stack.name}-${stack.stage}-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
});

/** A pool Layer was provided to something other than a Durable Object's Effect. */
export class PoolOutsideDurableObject extends Data.TaggedError("Rivet.PoolOutsideDurableObject")<{
  readonly message: string;
}> {}

/** The pool was given a cluster whose network its nodes cannot join. */
export class ClusterNetworkMismatch extends Data.TaggedError("Rivet.ClusterNetworkMismatch")<{
  readonly message: string;
}> {}

export interface PoolSettings {
  /**
   * Pool name on the control plane.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
}

/** What a host needs to declare the service that runs a pool's nodes. */
export interface PoolNodes<Network> {
  readonly cluster: ClusterShape;
  readonly network: Network;
  readonly pool: Pool;
  /** The node program: its entry and bundler settings. */
  readonly program: {
    readonly main: string;
    readonly build: {
      readonly input: {
        readonly external: typeof EXTERNAL;
        readonly plugins: Output.Output<ReturnType<typeof durableObjectsPlugin>>;
      };
    };
  };
  /** Environment every node needs: the control plane, the pool, and the classes' env. */
  readonly environment: {
    readonly RIVET_ENDPOINT: ClusterShape["endpoint"];
    readonly RIVET_TOKEN: ClusterShape["token"];
    readonly RIVET_NAMESPACE: ClusterShape["namespace"];
    readonly RIVET_POOL: Pool["name"];
  };
}

/**
 * A pool Layer: `network` narrows the cluster's network to the one this host
 * can join, `nodes` declares the service that runs the pool's nodes.
 */
export const makePoolLayer = <Network, Req>(options: {
  readonly label: string;
  readonly id: string;
  readonly settings: PoolSettings;
  readonly network: (cluster: ClusterShape) => Network | undefined;
  readonly expected: string;
  readonly nodes: (nodes: PoolNodes<Network>) => Effect.Effect<void, never, Req>;
}): Layer.Layer<never, never, Cluster | Self | Stack | Provider<Pool> | Req> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const cluster = yield* Cluster;
      if (globalThis.__ALCHEMY_RUNTIME__) return;
      // The generic `Self` is the class whose phase is running — the typed
      // `Self<Rivet.DurableObject>` is the enclosing one while a class is
      // built inside another's.
      const self = yield* Self;
      if (self.Type !== DurableObjectTypeId) {
        return yield* Effect.die(
          new PoolOutsideDurableObject({
            message: `${options.label}("${options.id}") was provided to ${self.Type} '${self.LogicalId}', not a Rivet.DurableObject.`,
          }),
        );
      }
      const object = self as unknown as DurableObject & DurableObjectRuntimeContext;
      const network = options.network(cluster);
      if (network === undefined) {
        return yield* Effect.die(
          new ClusterNetworkMismatch({
            message: `${options.label} runs nodes on ${options.expected}, and its cluster is not on one.`,
          }),
        );
      }
      // Named up front, so a class knows its pool without depending on the
      // pool resource — whose bindings carry every class's env, which can
      // name other classes' pools.
      const name = options.settings.name ?? (yield* stackDnsLabel(options.id));
      const endpoint = cluster.nodeEndpoint ?? cluster.endpoint;
      yield* object.registerPool((env) =>
        Effect.gen(function* () {
          const pool = yield* Pool(options.id, {
            endpoint: cluster.endpoint,
            token: cluster.token,
            namespace: cluster.namespace,
            name,
          });
          // The class joins the pool's nodes.
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
          // What callers need to reach the class through the gateway.
          yield* object.bind`Pool`({
            pool: name,
            endpoint: cluster.clientEndpoint ?? cluster.endpoint,
            namespace: cluster.namespace,
            token: cluster.token,
          });
          yield* options.nodes({
            cluster,
            network,
            pool,
            program: {
              main: nodeEntry(),
              build: {
                input: {
                  external: EXTERNAL,
                  plugins: pool.durableObjects.pipe(Output.map(durableObjectsPlugin)),
                },
              },
            },
            environment: {
              RIVET_ENDPOINT: endpoint,
              RIVET_TOKEN: cluster.token,
              RIVET_NAMESPACE: cluster.namespace,
              RIVET_POOL: pool.name,
            },
          });
        }),
      );
    }),
  );

/** A cluster value as an Output, whether it is one already or a plain value. */
const output = <T>(value: Input<T>): Output.Output<T> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<T>;

/**
 * Every value a node needs, as plain strings, for hosts whose environments
 * hold no `Redacted` (AWS task and instance environments, Kubernetes env).
 * `endpoint` overrides the control plane URL nodes connect to.
 */
export const nodeEnvironment = (
  { pool, environment }: PoolNodes<unknown>,
  endpoint: Input<string> = environment.RIVET_ENDPOINT,
) =>
  Output.all(
    pool.env,
    output(endpoint),
    output(environment.RIVET_TOKEN),
    output(environment.RIVET_NAMESPACE),
    environment.RIVET_POOL,
  ).pipe(
    Output.map(([env, url, token, namespace, poolName]) => ({
      ...env,
      RIVET_ENDPOINT: url,
      RIVET_TOKEN: Redacted.value(token),
      RIVET_NAMESPACE: namespace,
      RIVET_POOL: poolName,
    })),
  );

/**
 * The node entry, which imports the pool's classes from {@link VIRTUAL}.
 * Resolved while deploying only: a runtime bundle has no module URL.
 */
const nodeEntry = () =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./node.ts" : "./node.js", import.meta.url),
  );
