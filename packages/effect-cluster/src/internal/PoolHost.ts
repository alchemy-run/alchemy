/**
 * What every pool Layer shares, whatever runs its pool: register the
 * entity whose Construction phase is running with the pool resource, bind
 * what callers need onto the entity, and bundle every class the pool hosts
 * into one Node program. A host only declares the service that runs it.
 *
 * @internal
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Database, type DatabaseShape } from "../Database.ts";
import { shardGroupKey, type Entity } from "../Entity.ts";
import { Pool, type PoolEntity } from "../Pool.ts";
import type { Providers } from "../Providers.ts";
import { GATEWAY_PORT, RUNNER_PORT } from "./Gateway.ts";
import type { HostedClass } from "./HostedRuntime.ts";
import { HOSTED_TYPES, shortLabel, stackDnsLabel } from "./Naming.ts";
import { PoolHost } from "./PoolHostService.ts";

const VIRTUAL = "virtual:cluster-entities";

/** Resolve {@link VIRTUAL} to a module that imports every class the pool hosts. */
const entitiesPlugin = (entities: ReadonlyArray<PoolEntity>) => {
  const source = [
    ...entities.map(
      (entity, i) =>
        `import { ${entity.handler} as e${i} } from ${JSON.stringify(
          entity.module.startsWith("file:") ? fileURLToPath(entity.module) : entity.module,
        )};`,
    ),
    `export default [${entities
      .map((entity, i) => `{ name: ${JSON.stringify(entity.name)}, value: e${i} }`)
      .join(", ")}];`,
  ].join("\n");
  return [
    {
      name: "cluster-entities",
      resolveId: (id: string) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
      load: (id: string) => (id === `\0${VIRTUAL}` ? source : null),
    },
  ];
};

/** The pool was given a database whose network it cannot join. */
export class DatabaseNetworkMismatch extends Data.TaggedError("Cluster.DatabaseNetworkMismatch")<{
  readonly message: string;
}> {}

export interface PoolSettings {
  /**
   * The name the pool is known by. It is also the shard group the
   * entities they host are placed in.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
  /**
   * The shard groups an external program's entities use, which these
   * runners serve. Entities declared with Alchemy always use the pool's
   * own group.
   * @default ["default"]
   */
  shardGroups?: string[];
}

/** What a host needs to declare the service that runs the pool. */
export interface PoolNodes<Network, Gateway extends PoolGateway = PoolGateway> {
  /** What the host declared for the gateway (e.g. a load balancer to register with). */
  readonly gateway: Gateway;
  readonly database: DatabaseShape;
  readonly network: Network;
  readonly pool: Pool;
  /** The pool's name, a DNS label. */
  readonly name: string;
  /**
   * The bundled program: a directory holding `runner.mjs` with a
   * `Dockerfile`, and a hash of its
   * contents, which changes whenever the program does.
   */
  readonly program: Output.Output<{
    readonly dir: string;
    readonly hash: string;
  }>;
  /** Environment every runner needs, as plain strings. */
  readonly environment: Output.Output<Record<string, string>>;
}

/** What a host binds onto each entity so callers can reach the gateway. */
export interface PoolGateway {
  readonly url: Input<string>;
}

const output = <T>(value: Input<T>): Output.Output<T> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<T>;

/** The Dockerfile every host builds the runner image from. */
export const RUNNER_DOCKERFILE = `FROM node:26-slim
WORKDIR /app
COPY *.mjs /app/
ENV NODE_ENV=production
EXPOSE ${RUNNER_PORT} ${GATEWAY_PORT}
ENTRYPOINT ["node", "/app/runner.mjs"]
`;

/**
 * A pool Layer: `network` narrows the database's network to the one this
 * host can join; `gateway` names where callers reach the pool;
 * `nodes` declares the service that runs them.
 */
export const makePoolLayer = <Network, Req, Gateway extends PoolGateway = PoolGateway>(options: {
  readonly label: string;
  readonly id: string;
  readonly settings: PoolSettings;
  readonly network: (database: DatabaseShape) => Network | undefined;
  readonly expected: string;
  /** The longest runner name the host accepts. @default 63 */
  readonly nameLength?: number;
  /** The runner image's Dockerfile, when the host needs more than {@link RUNNER_DOCKERFILE}. */
  readonly dockerfile?: string;
  /** Where callers reach the gateway, declaring what it needs; before the pool's service. */
  readonly gateway: (name: string, network: Network) => Effect.Effect<Gateway, never, Req>;
  readonly nodes: (nodes: PoolNodes<Network, Gateway>) => Effect.Effect<void, never, Req>;
}): Layer.Layer<PoolHost, never, Database | Stack | Providers | Req> =>
  Layer.effect(
    PoolHost,
    Effect.gen(function* () {
      const database = yield* Database;
      // What was provided to the pool, like an entity's RPC middleware,
      // goes with every class they host.
      const services = yield* Effect.context<never>();
      const self = Option.getOrUndefined(yield* Effect.serviceOption(Self));
      const hostsSelf = self !== undefined && HOSTED_TYPES.has(self.Type);
      if (globalThis.__ALCHEMY_RUNTIME__) {
        if (hostsSelf) yield* (self as unknown as HostedClass).provideServices(services);
        return {
          host: (hosted) => hosted.provideServices(services),
          deployExternal: () => Effect.void,
        } satisfies PoolHost["Service"];
      }
      const network = options.network(database);
      if (network === undefined) {
        return yield* Effect.die(
          new DatabaseNetworkMismatch({
            message: `${options.label} runs runners on ${options.expected}, and its database is not on one.`,
          }),
        );
      }
      // Named up front, so an entity knows its pool without depending on
      // the pool resource, whose bindings carry every entity's env.
      const name = options.settings.name ?? (yield* stackDnsLabel(options.id, options.nameLength));
      // A shard group only has to be unique within its database, and must
      // never be one an external program uses (usually `default`). Effect
      // Cluster stores `group:shard` in a 50-character column, so keep it short.
      const group = `alchemy:${yield* shortLabel(options.id, 32)}`;
      const gateway = yield* options.gateway(name, network);
      const context = yield* Effect.context<Stack | Providers | Req>();

      /** Put `hosted` on the pool, bind the gateway onto `resource`, and declare the pool. */
      const deploy = (hosted: PoolEntity, env: Record<string, unknown>, resource: Entity) =>
        Effect.gen(function* () {
          const pool = yield* Pool(options.id, { name });
          const token = yield* Random(`${options.id}GatewayToken`, {
            bytes: 32,
          }) as unknown as Effect.Effect<Random, never, Providers>;
          // The hosting runners route the entity to its own shard group.
          yield* pool.bind`${hosted.name}`({
            entities: [hosted],
            env:
              hosted.program === undefined ? { ...env, [shardGroupKey(hosted.name)]: group } : env,
          });
          // Alchemy entities live in the pool's own shard group; an
          // external program keeps the groups its entities use.
          const groups =
            hosted.program === undefined ? [group] : (options.settings.shardGroups ?? ["default"]);
          yield* database.shardGroups.bind`${name}`({ groups });
          // What callers need to reach the entity through the gateway.
          yield* resource.bind`Pool`({
            pool: group,
            gateway: gateway.url,
            token: token.text,
          });
          const stack = yield* Stack;
          yield* options.nodes({
            gateway,
            database,
            network,
            pool,
            name,
            program: yield* bundleProgram(
              options.id,
              pool,
              options.dockerfile ?? RUNNER_DOCKERFILE,
            ),
            environment: Output.all(
              pool.env,
              output(database.url),
              token.text,
              database.shardGroups.groups,
            ).pipe(
              Output.map(([values, url, tokenText, allGroups]) => ({
                ...Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [key, String(value)]),
                ),
                ALCHEMY_STACK_NAME: stack.name,
                ALCHEMY_STAGE: stack.stage,
                ALCHEMY_PHASE: "runtime",
                CLUSTER_DATABASE_URL: Redacted.value(url),
                CLUSTER_GATEWAY_TOKEN: Redacted.value(tokenText),
                CLUSTER_POOL: name,
                CLUSTER_SHARD_GROUPS: groups.join(","),
                CLUSTER_AVAILABLE_SHARD_GROUPS: allGroups.join(","),
              })),
            ),
          });
        }).pipe(Effect.provide(context));

      const host = (hosted: HostedClass) =>
        Effect.andThen(
          hosted.provideServices(services),
          hosted.registerPool((env) =>
            deploy(
              {
                name: hosted.LogicalId,
                module: hosted.Props.main,
                handler: hosted.Props.handler ?? "default",
              },
              env,
              hosted as unknown as Entity,
            ),
          ),
        );

      // The generic `Self` is the class whose phase is running. When it is
      // not hosted on runners, the pool was given an external entity,
      // which may be declared inside any runtime's Construction phase.
      if (hostsSelf) yield* host(self as unknown as HostedClass);

      return {
        host,
        deployExternal: ({ type, main, handler, program, resource }) =>
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `bind` is typed `any`; what it needs is the providers in `context`
          deploy(
            { name: type, module: main, handler, program },
            {},
            resource,
          ) as Effect.Effect<void>,
      } satisfies PoolHost["Service"];
    }),
  );

const PROGRAM = "virtual:cluster-program";

/** Resolve {@link PROGRAM} to the external program's bundled source, as a string. */
const programPlugin = (source: string | undefined) => [
  {
    name: "cluster-program",
    resolveId: (id: string) => (id === PROGRAM ? `\0${PROGRAM}` : null),
    load: (id: string) =>
      id === `\0${PROGRAM}` ? `export default ${JSON.stringify(source ?? "")};` : null,
  },
];

/** A runner entry beside this module: `runner` (Alchemy entities) or `external-runner`. */
const runnerEntry = (name: "runner" | "external-runner") =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? `./${name}.ts` : `./${name}.js`, import.meta.url),
  );

/**
 * Bundle the runner program and its Dockerfile into a directory of their
 * own, once the pool knows its classes, and resolve to the directory.
 */
const bundleProgram = Effect.fn(function* (id: string, pool: Pool, dockerfile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "cluster", yield* stackDnsLabel(id));
  return Output.mapEffect((entities: PoolEntity[]) =>
    Effect.gen(function* () {
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.makeDirectory(dir, { recursive: true });
      // An external program is bundled on its own and embedded in the
      // runner, which writes it out and runs it as its own process: it reads
      // its settings from its environment when it loads, so it can't share
      // the runner's modules. One file, on every host.
      const program = entities.find((entity) => entity.program !== undefined)?.program;
      let programSource: string | undefined;
      if (program !== undefined) {
        const programDir = path.join(dir, "program");
        yield* Bundle.build(
          {
            input: path.resolve(program),
            platform: "node",
            resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          },
          { dir: programDir, format: "esm", entryFileNames: "program.mjs", codeSplitting: false },
        );
        programSource = yield* fs.readFileString(path.join(programDir, "program.mjs"));
        yield* fs.remove(programDir, { recursive: true });
      }
      const runner = yield* Bundle.build(
        {
          input: runnerEntry(program === undefined ? "runner" : "external-runner"),
          platform: "node",
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          plugins: [...entitiesPlugin(entities), ...programPlugin(programSource)],
        },
        { dir, format: "esm", entryFileNames: "runner.mjs", codeSplitting: false },
      );
      const hashes = [runner.hash, dockerfile];
      yield* fs.writeFileString(path.join(dir, "Dockerfile"), dockerfile);
      const hash = yield* Effect.sync(() =>
        createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 16),
      );
      return { dir, hash };
    }).pipe(Effect.orDie),
  )(pool.entities);
});
