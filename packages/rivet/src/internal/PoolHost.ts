/**
 * What every pool Layer shares, whatever runs its nodes: register the class
 * whose phase is running with a pool on the control plane, bind what callers
 * need onto the class, and bundle every class in the pool into one node
 * program. A host only declares the service that runs that program.
 *
 * @internal
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Cluster, type ClusterShape } from "../Cluster.ts";
import {
  DurableObjectTypeId,
  type DurableObject,
  type DurableObjectRuntimeContext,
} from "../DurableObject.ts";
import { PoolHost } from "../Host.ts";
import { Pool, type PoolDurableObject } from "../Pool.ts";
import type { Providers } from "../Providers.ts";
import { stageRustProgram } from "./RustProgram.ts";

/** The RivetKit release node images install. */
export const RIVETKIT_VERSION = "3.0.0";

/** A node image environment: bun with RivetKit installed. */
export const NODE_DOCKERFILE = `FROM oven/bun:1
WORKDIR /app
RUN bun add rivetkit@${RIVETKIT_VERSION}
`;

/** Packages the node image provides, kept out of the node bundle. */
const EXTERNAL = ["rivetkit", /^rivetkit\//, /^@rivetkit\//];

/**
 * What an external program keeps out of its bundle: RivetKit and its native
 * runtime, which the node image installs. Everything else it imports,
 * `@rivetkit/effect` included, is bundled.
 */
const EXTERNAL_PROGRAM = ["rivetkit", /^rivetkit\//, /^@rivetkit\/(?!effect(\/|$))/];

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

/**
 * `${stack}-${stage}-${id}` as a lowercase DNS label of at most `max`
 * characters. A longer one keeps its start and ends in a hash of the whole,
 * so labels for different ids never collide.
 */
export const stackDnsLabel = Effect.fn(function* (id: string, max = 63) {
  const stack = yield* Stack;
  const full = `${stack.name}-${stack.stage}-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= max) return full;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(full).digest("hex").slice(0, 8),
  );
  return `${full.slice(0, max - 9).replace(/-+$/, "")}-${hash}`;
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

/** A JavaScript node program: its entry and bundler settings, run with RivetKit beside it. */
export interface BundleProgram {
  readonly main: string;
  readonly build: {
    readonly input: {
      readonly external: ReadonlyArray<string | RegExp>;
      readonly plugins: Output.Output<ReturnType<typeof durableObjectsPlugin>>;
    };
  };
}

/**
 * A node program that is a whole image: a build context and the Dockerfile
 * in it, whose `CMD` runs the node (a Rust crate's binary).
 */
export interface ImageProgram {
  readonly context: string;
  readonly dockerfile: string;
}

export type NodeProgram = BundleProgram | ImageProgram;

export const isImageProgram = (program: NodeProgram): program is ImageProgram =>
  !("main" in program);

/** What a host needs to declare the service that runs a pool's nodes. */
export interface PoolNodes<Network> {
  readonly cluster: ClusterShape;
  readonly network: Network;
  readonly pool: Pool;
  /** The node program: a JavaScript bundle, or an image of its own. */
  readonly program: NodeProgram;
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
}): Layer.Layer<PoolHost, never, Cluster | Stack | Providers | Req> =>
  Layer.effect(PoolHost, makeHost(options));

const makeHost = <Network, Req>(options: {
  readonly label: string;
  readonly id: string;
  readonly settings: PoolSettings;
  readonly network: (cluster: ClusterShape) => Network | undefined;
  readonly expected: string;
  readonly nodes: (nodes: PoolNodes<Network>) => Effect.Effect<void, never, Req>;
}) =>
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    // An external Durable Object deploys from its own Effect: give it the
    // services this Layer was built with.
    const context = yield* Effect.context<Stack | Providers | Req>();
    const noop: PoolHost["Service"] = {
      deployExternal: () => Effect.void,
      deployCrate: () => Effect.void,
    };
    if (globalThis.__ALCHEMY_RUNTIME__) return noop;
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
    // A private address only works for nodes inside the control plane's
    // network: nodes anywhere else connect to its public endpoint.
    const endpoint =
      network === cluster.network ? (cluster.nodeEndpoint ?? cluster.endpoint) : cluster.endpoint;
    const caller = {
      pool: name,
      endpoint: cluster.clientEndpoint ?? cluster.endpoint,
      namespace: cluster.namespace,
      token: cluster.token,
    };

    /** Declare the pool, put `object` on it, and declare the nodes that run `program`. */
    const deploy = Effect.fn(function* (
      object: PoolDurableObject,
      env: Record<string, unknown>,
      bindCaller: Effect.Effect<void, never, any>,
      program: (pool: Pool) => NodeProgram,
    ) {
      const pool = yield* Pool(options.id, {
        endpoint: cluster.endpoint,
        token: cluster.token,
        namespace: cluster.namespace,
        name,
      });
      yield* pool.bind`${object.name}`({ durableObjects: [object], env });
      yield* bindCaller;
      yield* options.nodes({
        cluster,
        network,
        pool,
        program: program(pool),
        environment: {
          RIVET_ENDPOINT: endpoint,
          RIVET_TOKEN: cluster.token,
          RIVET_NAMESPACE: cluster.namespace,
          RIVET_POOL: pool.name,
        },
      });
    });

    // The generic `Self` is the class whose phase is running — the typed
    // `Self<Rivet.DurableObject>` is the enclosing one while a class is
    // built inside another's. Outside a class phase there is none: the
    // pool was provided to an external Durable Object.
    const self = Option.getOrUndefined(yield* Effect.serviceOption(Self));
    if (self !== undefined) {
      if (self.Type !== DurableObjectTypeId) {
        return yield* Effect.die(
          new PoolOutsideDurableObject({
            message: `${options.label}("${options.id}") was provided to ${self.Type} '${self.LogicalId}', not a Rivet.DurableObject.`,
          }),
        );
      }
      const object = self as unknown as DurableObject & DurableObjectRuntimeContext;
      yield* object.registerPool((env) =>
        deploy(
          {
            name: object.LogicalId,
            module: object.Props.main,
            handler: object.Props.handler ?? "default",
          },
          env,
          // What callers need to reach the class through the gateway.
          object.bind`Pool`(caller),
          (pool) => ({
            main: nodeEntry(),
            build: {
              input: {
                external: EXTERNAL,
                plugins: pool.durableObjects.pipe(Output.map(durableObjectsPlugin)),
              },
            },
          }),
        ),
      );
    }

    return {
      deployExternal: ({ id, main, resource }) =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `bind` is typed `any`; what it needs is the providers in `context`
        deploy(
          { name: id, module: main, handler: "", external: true },
          {},
          resource.bind`Pool`(caller),
          () => ({
            main,
            build: {
              input: {
                external: EXTERNAL_PROGRAM,
                plugins: Output.literal([]) as unknown as Output.Output<
                  ReturnType<typeof durableObjectsPlugin>
                >,
              },
            },
          }),
        ).pipe(Effect.provide(context), Effect.orDie) as Effect.Effect<void>,
      deployCrate: ({ id, crate, build, resource }) =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `bind` is typed `any`; what it needs is the providers in `context`
        Effect.gen(function* () {
          // The crate's binary is the node, built into an image.
          const image = yield* stageRustProgram(yield* stackDnsLabel(id), crate, build);
          yield* deploy(
            { name: id, module: crate, handler: "", external: true },
            {},
            resource.bind`Pool`(caller),
            () => image,
          );
        }).pipe(Effect.provide(context), Effect.orDie) as Effect.Effect<void>,
    } satisfies PoolHost["Service"];
  });

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

/**
 * Bundle the node program into a directory of its own, once the pool knows
 * its classes, and resolve to the built entry. For hosts that run a `main`
 * as it is (a Fly or Hetzner Service without an Effect implementation).
 */
export const bundleNodes = Effect.fn(function* (host: string, id: string, program: BundleProgram) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "rivet", host, yield* stackDnsLabel(id));
  const { external, plugins } = program.build.input;
  return Output.mapEffect((resolved: Parameters<typeof Bundle.build>[0]["plugins"]) =>
    Effect.gen(function* () {
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* Bundle.build(
        {
          input: program.main,
          platform: "node",
          external: [...external],
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          plugins: resolved,
        },
        { dir, format: "esm", entryFileNames: "node.mjs", codeSplitting: false },
      );
      return path.join(dir, "node.mjs");
    }).pipe(Effect.orDie),
  )(plugins);
});
