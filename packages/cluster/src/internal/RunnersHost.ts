/**
 * What every runners Layer shares, whatever runs its runners: register the
 * entity whose Construction phase is running with the runners resource, bind
 * what callers need onto the entity, and bundle every class the runners host
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
import { EntityTypeId, shardGroupKey, type Entity, type EntityRuntimeContext } from "../Entity.ts";
import type { Providers } from "../Providers.ts";
import { Runners, type RunnersEntity } from "../Runners.ts";
import { GATEWAY_PORT, RUNNER_PORT } from "./Gateway.ts";
import { RunnersHost } from "./RunnersHostService.ts";

const VIRTUAL = "virtual:cluster-entities";

/** Resolve {@link VIRTUAL} to a module that imports every class the runners host. */
const entitiesPlugin = (entities: ReadonlyArray<RunnersEntity>) => {
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

/**
 * `${stack}-${stage}-${id}` as a lowercase DNS label of at most `max`
 * characters. A longer one keeps its start and ends in a hash of the whole.
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

/** `id` as a lowercase label of at most `max` characters, ending in a hash when shortened. */
const shortLabel = Effect.fn(function* (id: string, max: number) {
  const label = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (label.length <= max) return label;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(label).digest("hex").slice(0, 8),
  );
  return `${label.slice(0, max - 9).replace(/-+$/, "")}-${hash}`;
});

/** The runners were given a database whose network they cannot join. */
export class DatabaseNetworkMismatch extends Data.TaggedError("Cluster.DatabaseNetworkMismatch")<{
  readonly message: string;
}> {}

export interface RunnersSettings {
  /**
   * The name the runners are known by. It is also the shard group the
   * entities they host are placed in.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
  /**
   * The shard groups an external program's entities use, which these
   * runners serve. Entities declared with Alchemy always use the runners'
   * own group.
   * @default ["default"]
   */
  shardGroups?: string[];
}

/** What a host needs to declare the service that runs the runners. */
export interface RunnersNodes<Network> {
  readonly database: DatabaseShape;
  readonly network: Network;
  readonly runners: Runners;
  /** The runners' name, a DNS label. */
  readonly name: string;
  /**
   * The bundled program: a directory holding `runner.mjs` (and an external
   * program's `program.mjs`) with a `Dockerfile`, and a hash of its
   * contents, which changes whenever the program does.
   */
  readonly program: Output.Output<{ readonly dir: string; readonly hash: string }>;
  /** Environment every runner needs, as plain strings. */
  readonly environment: Output.Output<Record<string, string>>;
}

/** What a host binds onto each entity so callers can reach the gateway. */
export interface RunnersGateway {
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
 * A runners Layer: `network` narrows the database's network to the one this
 * host can join; `gateway` names where callers reach the runners;
 * `nodes` declares the service that runs them.
 */
export const makeRunnersLayer = <Network, Req>(options: {
  readonly label: string;
  readonly id: string;
  readonly settings: RunnersSettings;
  readonly network: (database: DatabaseShape) => Network | undefined;
  readonly expected: string;
  readonly gateway: (name: string) => RunnersGateway;
  readonly nodes: (nodes: RunnersNodes<Network>) => Effect.Effect<void, never, Req>;
}): Layer.Layer<RunnersHost, never, Database | Stack | Providers | Req> =>
  Layer.effect(
    RunnersHost,
    Effect.gen(function* () {
      const database = yield* Database;
      const noop: RunnersHost["Service"] = { deployExternal: () => Effect.void };
      if (globalThis.__ALCHEMY_RUNTIME__) return noop;
      const network = options.network(database);
      if (network === undefined) {
        return yield* Effect.die(
          new DatabaseNetworkMismatch({
            message: `${options.label} runs runners on ${options.expected}, and its database is not on one.`,
          }),
        );
      }
      // Named up front, so an entity knows its runners without depending on
      // the runners resource, whose bindings carry every entity's env.
      const name = options.settings.name ?? (yield* stackDnsLabel(options.id));
      // A shard group only has to be unique within its database, and must
      // never be one an external program uses (usually `default`). Effect
      // Cluster stores `group:shard` in a 50-character column, so keep it short.
      const group = `alchemy:${yield* shortLabel(options.id, 32)}`;
      const gateway = options.gateway(name);
      const context = yield* Effect.context<Stack | Providers | Req>();

      /** Put `hosted` on the runners, bind the gateway onto `resource`, and declare the runners. */
      const deploy = (hosted: RunnersEntity, env: Record<string, unknown>, resource: Entity) =>
        Effect.gen(function* () {
          const runners = yield* Runners(options.id, { name });
          const token = yield* Random(`${options.id}GatewayToken`, {
            bytes: 32,
          }) as unknown as Effect.Effect<Random, never, Providers>;
          // The hosting runners route the entity to its own shard group.
          yield* runners.bind`${hosted.name}`({
            entities: [hosted],
            env:
              hosted.program === undefined ? { ...env, [shardGroupKey(hosted.name)]: group } : env,
          });
          // Alchemy entities live in the runners' own shard group; an
          // external program keeps the groups its entities use.
          const groups =
            hosted.program === undefined ? [group] : (options.settings.shardGroups ?? ["default"]);
          yield* database.shardGroups.bind`${name}`({ groups });
          // What callers need to reach the entity through the gateway.
          yield* resource.bind`Runners`({
            runners: group,
            gateway: gateway.url,
            token: token.text,
          });
          const stack = yield* Stack;
          yield* options.nodes({
            database,
            network,
            runners,
            name,
            program: yield* bundleRunners(options.id, runners),
            environment: Output.all(
              runners.env,
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
                CLUSTER_RUNNERS: name,
                CLUSTER_SHARD_GROUPS: groups.join(","),
                CLUSTER_AVAILABLE_SHARD_GROUPS: allGroups.join(","),
              })),
            ),
          });
        }).pipe(Effect.provide(context));

      // The generic `Self` is the class whose phase is running. When it is
      // not an entity, the runners were given an external entity, which may
      // be declared inside any runtime's Construction phase.
      const self = Option.getOrUndefined(yield* Effect.serviceOption(Self));
      if (self !== undefined && self.Type === EntityTypeId) {
        const entity = self as unknown as Entity & EntityRuntimeContext;
        yield* entity.registerRunners((env) =>
          deploy(
            {
              name: entity.LogicalId,
              module: entity.Props.main,
              handler: entity.Props.handler ?? "default",
            },
            env,
            entity,
          ),
        );
      }

      return {
        deployExternal: ({ type, main, handler, program, resource }) =>
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `bind` is typed `any`; what it needs is the providers in `context`
          deploy(
            { name: type, module: main, handler, program },
            {},
            resource,
          ) as Effect.Effect<void>,
      } satisfies RunnersHost["Service"];
    }),
  );

/** A runner entry beside this module: `runner` (Alchemy entities) or `external-runner`. */
const runnerEntry = (name: "runner" | "external-runner") =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? `./${name}.ts` : `./${name}.js`, import.meta.url),
  );

/**
 * Bundle the runner program and its Dockerfile into a directory of their
 * own, once the runners know their classes, and resolve to the directory.
 */
const bundleRunners = Effect.fn(function* (id: string, runners: Runners) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "cluster", yield* stackDnsLabel(id));
  return Output.mapEffect((entities: RunnersEntity[]) =>
    Effect.gen(function* () {
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.makeDirectory(dir, { recursive: true });
      // An external program is bundled on its own and run as its own
      // process (`program.mjs`), with the gateway beside it.
      const program = entities.find((entity) => entity.program !== undefined)?.program;
      const hashes: string[] = [];
      if (program !== undefined) {
        const external = yield* Bundle.build(
          {
            input: path.resolve(program),
            platform: "node",
            resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          },
          { dir, format: "esm", entryFileNames: "program.mjs", codeSplitting: false },
        );
        hashes.push(external.hash);
      }
      const runner = yield* Bundle.build(
        {
          input: runnerEntry(program === undefined ? "runner" : "external-runner"),
          platform: "node",
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          plugins: entitiesPlugin(entities),
        },
        { dir, format: "esm", entryFileNames: "runner.mjs", codeSplitting: false },
      );
      hashes.push(runner.hash, RUNNER_DOCKERFILE);
      yield* fs.writeFileString(path.join(dir, "Dockerfile"), RUNNER_DOCKERFILE);
      const hash = yield* Effect.sync(() =>
        createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 16),
      );
      return { dir, hash };
    }).pipe(Effect.orDie),
  )(runners.entities);
});
