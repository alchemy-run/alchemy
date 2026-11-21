/**
 * What every pool Layer shares, whatever runs its nodes: register the class
 * whose phase is running with a pool on the control plane, bind what callers
 * need onto the class, and bundle every class in the pool into one node
 * program. A host only declares the service that runs that program.
 *
 * @internal
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
  actorOptionsOf,
  DurableObjectTypeId,
  type DurableObject,
  type DurableObjectRuntimeContext,
} from "../DurableObject.ts";
import { PoolHost } from "../Host.ts";
import { Pool, type PoolDurableObject, type PoolProps } from "../Pool.ts";
import type { Providers } from "../Providers.ts";
import { stageRustProgram } from "./RustProgram.ts";

/**
 * The RivetKit release `@alchemy.run/rivet` depends on: what node images
 * install when no `rivetkit` resolves from the program or from this package.
 */
export const RIVETKIT_VERSION = "3.1.1";

/** The version of the `rivetkit` that resolves from `from`, a file or `file:` URL. */
const resolvedRivetKit = (from: string) =>
  Effect.try(() => {
    const path = from.startsWith("file:") ? fileURLToPath(from) : from;
    // A relative entry is relative to where the deploy runs.
    const file = /^(\/|[A-Za-z]:[\\/])/.test(path) ? path : `${process.cwd()}/${path}`;
    const entry = createRequire(file).resolve("rivetkit").replaceAll("\\", "/");
    const root = entry.slice(
      0,
      entry.lastIndexOf("/node_modules/rivetkit/") + "/node_modules/rivetkit".length,
    );
    const { version } = createRequire(file)(`${root}/package.json`) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * The RivetKit release a pool's nodes install for a program whose entry is
 * `main`: the `rivetkit` the program resolves, so the nodes run the release
 * the program was built and tested against. A program that installs none
 * gets the one `@alchemy.run/rivet` depends on, and failing that
 * {@link RIVETKIT_VERSION}.
 */
export const resolveRivetKitVersion = (main: string) =>
  Effect.gen(function* () {
    return (
      (yield* resolvedRivetKit(main)) ??
      (yield* resolvedRivetKit(import.meta.url)) ??
      RIVETKIT_VERSION
    );
  });

/** A node image environment: bun with RivetKit `version` installed. */
export const nodeDockerfile = (version: string) => `FROM oven/bun:1
WORKDIR /app
RUN bun add rivetkit@${version}
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
    // The actor options the pool recorded for its classes, by name.
    `export const options = ${JSON.stringify(
      Object.fromEntries(
        objects.flatMap((object) =>
          object.options === undefined ? [] : [[object.name, object.options]],
        ),
      ),
    )};`,
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

export interface PoolSettings extends Pick<
  PoolProps,
  "drainOnVersionUpgrade" | "actorEvictionDelay" | "actorEvictionPeriod" | "actorEvictionRate"
> {
  /**
   * Pool name on the control plane.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
  /**
   * RivetKit release the nodes run a JavaScript program with. Nodes speak
   * the control plane protocol of their release: a 3.0 node works with a
   * 3.0 or 3.1 control plane, a 3.1 node needs a 3.1 one. A Rust program
   * brings its own.
   * @default the `rivetkit` the program resolves, else the one `@alchemy.run/rivet` depends on
   */
  rivetkitVersion?: string;
  /**
   * Version the nodes report to the control plane (`RIVET_NODE_VERSION`).
   * Raise it on a deploy that changes the nodes: with `drainOnVersionUpgrade`
   * the control plane moves actors off older nodes once a newer one connects.
   * @default the RivetKit default (1)
   */
  version?: number;
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
  readonly context: Input<string>;
  readonly dockerfile: Input<string>;
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
  /**
   * The RivetKit release a JavaScript program runs with: the `rivetkit` it
   * resolves (see {@link resolveRivetKitVersion}).
   */
  readonly rivetkitVersion: string;
  /** Environment every node needs: the control plane, the pool, and the classes' env. */
  readonly environment: {
    readonly RIVET_ENDPOINT: ClusterShape["endpoint"];
    readonly RIVET_TOKEN: ClusterShape["token"];
    readonly RIVET_NAMESPACE: ClusterShape["namespace"];
    readonly RIVET_POOL: Pool["name"];
    readonly RIVET_NODE_VERSION?: string;
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
    const services = yield* Effect.context<Stack | Providers | Req>();
    const noop: PoolHost["Service"] = {
      deployExternal: () => Effect.void,
      deployCrate: () => Effect.void,
      deployDockerfile: () => Effect.void,
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
      // The file the program's own code starts from, which its `rivetkit` resolves from.
      source: string,
    ) {
      const pool = yield* Pool(options.id, {
        endpoint: cluster.endpoint,
        token: cluster.token,
        namespace: cluster.namespace,
        name,
        drainOnVersionUpgrade: options.settings.drainOnVersionUpgrade,
        actorEvictionDelay: options.settings.actorEvictionDelay,
        actorEvictionPeriod: options.settings.actorEvictionPeriod,
        actorEvictionRate: options.settings.actorEvictionRate,
      });
      yield* pool.bind`${object.name}`({ durableObjects: [object], env });
      yield* bindCaller;
      yield* options.nodes({
        cluster,
        network,
        pool,
        program: program(pool),
        rivetkitVersion: yield* resolveRivetKitVersion(source),
        environment: {
          RIVET_ENDPOINT: endpoint,
          RIVET_TOKEN: cluster.token,
          RIVET_NAMESPACE: cluster.namespace,
          RIVET_POOL: pool.name,
          ...(options.settings.version === undefined
            ? {}
            : { RIVET_NODE_VERSION: String(options.settings.version) }),
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
      const actorOptions = yield* actorOptionsOf(object.LogicalId, object.Props);
      yield* object.registerPool((env) =>
        deploy(
          {
            name: object.LogicalId,
            module: object.Props.main,
            handler: object.Props.handler ?? "default",
            // Absent unless set, so a pool whose classes set none plans as before.
            ...(actorOptions === undefined ? {} : { options: actorOptions }),
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
          object.Props.main,
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
          main,
        ).pipe(Effect.provide(services), Effect.orDie) as Effect.Effect<void>,
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
            // A Rust program brings its own RivetKit.
            crate,
          );
        }).pipe(Effect.provide(services), Effect.orDie) as Effect.Effect<void>,
      deployDockerfile: ({ id, context, dockerfile, resource }) =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `bind` is typed `any`; what it needs is the providers in `context`
        Effect.gen(function* () {
          // The Dockerfile's image is the node, built wherever the host builds images.
          const label = yield* stackDnsLabel(id);
          const program = yield* stageDockerfileProgram(label, context, dockerfile);
          yield* deploy(
            { name: id, module: `dockerfile:${label}`, handler: "", external: true },
            {},
            resource.bind`Pool`(caller),
            () => program,
            // An image brings its own RivetKit, as a Rust program does.
            (yield* Path.Path).resolve(context ?? "."),
          );
        }).pipe(Effect.provide(services), Effect.orDie) as Effect.Effect<void>,
    } satisfies PoolHost["Service"];
  });

/**
 * A user's Dockerfile as a node program, resolved as every container
 * resource resolves `context` and `dockerfile`: paths are relative to where
 * the deploy runs, the Dockerfile defaults to `${context}/Dockerfile`, and
 * inline content is written, once it resolves, to an empty context of its
 * own named `label`. Every host already builds an {@link ImageProgram} for
 * its platform, so it reaches each one the way a Rust crate's does.
 */
const stageDockerfileProgram = Effect.fn(function* (
  label: string,
  context: string | undefined,
  dockerfile: string | { readonly content: Input<string> } | undefined,
) {
  const path = yield* Path.Path;
  if (typeof dockerfile !== "object") {
    const dir = path.resolve(context ?? ".");
    return {
      context: dir,
      dockerfile:
        dockerfile === undefined ? path.join(dir, "Dockerfile") : path.resolve(dockerfile),
    } satisfies ImageProgram;
  }
  const fs = yield* FileSystem.FileSystem;
  const dir = path.resolve(yield* dotAlchemyDirectory, "rivet", "dockerfile", label);
  const file = path.join(dir, "Dockerfile");
  // Written once the content resolves, so an image built in the same stack
  // is built before the pool builds from it.
  const staged = output(dockerfile.content).pipe(
    Output.mapEffect((content: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(file, content);
        return dir;
      }).pipe(Effect.orDie),
    ),
  );
  return {
    context: staged,
    dockerfile: staged.pipe(Output.map(() => file)),
  } satisfies ImageProgram;
});

/** A cluster value as an Output, whether it is one already or a plain value. */
const output = <T>(value: Input<T>): Output.Output<T> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<T>;

/** Every value a node needs, its token left `Redacted`. */
const nodeValues = (
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
      RIVET_TOKEN: token,
      RIVET_NAMESPACE: namespace,
      RIVET_POOL: poolName,
      ...(environment.RIVET_NODE_VERSION === undefined
        ? {}
        : { RIVET_NODE_VERSION: environment.RIVET_NODE_VERSION }),
    })),
  );

const unwrap = (value: unknown) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

/**
 * Every value a node needs, as plain strings, for hosts whose environments
 * hold no `Redacted` (AWS task and instance environments): the token and any
 * secret a class reads as config are unwrapped.
 * `endpoint` overrides the control plane URL nodes connect to.
 */
export const nodeEnvironment = (nodes: PoolNodes<unknown>, endpoint?: Input<string>) =>
  nodeValues(nodes, endpoint).pipe(
    Output.map(
      (values) =>
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => [name, unwrap(value)]),
        ) as Omit<typeof values, "RIVET_TOKEN"> & { RIVET_TOKEN: string },
    ),
  );

/**
 * Every value a node needs, the token and any secret a class reads as config
 * still `Redacted`, for hosts that keep secrets apart (`Kubernetes.Deployment`
 * reads them from a Secret).
 */
export const secretNodeEnvironment = nodeValues;

export { SECRET_ENV } from "./SecretEnv.ts";

/**
 * A node's environment split for hosts that hand secrets over as one value
 * (a Secret Manager secret): `secrets` holds every secret a class reads as
 * config, unwrapped, for the host to keep in its secret store and pass as
 * {@link SECRET_ENV}; `plain` holds the rest, the token unwrapped.
 */
export const splitNodeEnvironment = (nodes: PoolNodes<unknown>, endpoint?: Input<string>) =>
  nodeValues(nodes, endpoint).pipe(
    Output.map((values) => {
      const plain: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const [name, value] of Object.entries(values)) {
        if (Redacted.isRedacted(value) && name !== "RIVET_TOKEN") {
          secrets[name] = String(Redacted.value(value));
        } else {
          plain[name] = String(unwrap(value));
        }
      }
      return { plain, secrets };
    }),
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
