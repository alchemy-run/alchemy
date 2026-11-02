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
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Database, type DatabaseShape } from "../Database.ts";
import { EntityTypeId, type Entity, type EntityRuntimeContext } from "../Entity.ts";
import type { Providers } from "../Providers.ts";
import { Runners, type RunnersEntity } from "../Runners.ts";
import { GATEWAY_PORT, RUNNER_PORT } from "./Gateway.ts";

const VIRTUAL = "virtual:effect-cluster-entities";

/** Resolve {@link VIRTUAL} to a module that imports every class the runners host. */
const entitiesPlugin = (entities: ReadonlyArray<RunnersEntity>) => {
  const source = [
    ...entities.map(
      (entity, i) =>
        `import { ${entity.handler} as e${i} } from ${JSON.stringify(
          entity.module.startsWith("file:") ? fileURLToPath(entity.module) : entity.module,
        )};`,
    ),
    `export default [${entities.map((_, i) => `e${i}`).join(", ")}];`,
  ].join("\n");
  return [
    {
      name: "effect-cluster-entities",
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

/** A runners Layer was provided to something other than an entity's Effect. */
export class RunnersOutsideEntity extends Data.TaggedError("EffectCluster.RunnersOutsideEntity")<{
  readonly message: string;
}> {}

/** The runners were given a database whose network they cannot join. */
export class DatabaseNetworkMismatch extends Data.TaggedError(
  "EffectCluster.DatabaseNetworkMismatch",
)<{
  readonly message: string;
}> {}

export interface RunnersSettings {
  /**
   * The name the runners are known by.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
}

/** What a host needs to declare the service that runs the runners. */
export interface RunnersNodes<Network> {
  readonly database: DatabaseShape;
  readonly network: Network;
  readonly runners: Runners;
  /** The runners' name, a DNS label. */
  readonly name: string;
  /** The directory holding the bundled program (`runner.mjs`) and a `Dockerfile`. */
  readonly program: Output.Output<string>;
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
COPY runner.mjs /app/runner.mjs
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
}): Layer.Layer<never, never, Database | Self | Stack | Providers | Req> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const database = yield* Database;
      if (globalThis.__ALCHEMY_RUNTIME__) return;
      const self = yield* Self;
      if (self.Type !== EntityTypeId) {
        return yield* Effect.die(
          new RunnersOutsideEntity({
            message: `${options.label}("${options.id}") was provided to ${self.Type} '${self.LogicalId}', not an EffectCluster.Entity.`,
          }),
        );
      }
      const entity = self as unknown as Entity & EntityRuntimeContext;
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
      const gateway = options.gateway(name);
      const context = yield* Effect.context<Stack | Providers | Req>();

      yield* entity.registerRunners((env) =>
        Effect.gen(function* () {
          const runners = yield* Runners(options.id, { name });
          const token = yield* Random(`${options.id}GatewayToken`, {
            bytes: 32,
          }) as unknown as Effect.Effect<Random, never, Providers>;
          yield* runners.bind`${entity.LogicalId}`({
            entities: [
              {
                name: entity.LogicalId,
                module: entity.Props.main,
                handler: entity.Props.handler ?? "default",
              },
            ],
            env,
          });
          // What callers need to reach the entity through the gateway.
          yield* entity.bind`Runners`({ runners: name, gateway: gateway.url, token: token.text });
          const stack = yield* Stack;
          yield* options.nodes({
            database,
            network,
            runners,
            name,
            program: yield* bundleRunners(options.id, runners),
            environment: Output.all(runners.env, output(database.url), token.text).pipe(
              Output.map(([env, url, tokenText]) => ({
                ...Object.fromEntries(
                  Object.entries(env).map(([key, value]) => [key, String(value)]),
                ),
                ALCHEMY_STACK_NAME: stack.name,
                ALCHEMY_STAGE: stack.stage,
                ALCHEMY_PHASE: "runtime",
                EFFECT_CLUSTER_DATABASE_URL: Redacted.value(url),
                EFFECT_CLUSTER_GATEWAY_TOKEN: Redacted.value(tokenText),
                EFFECT_CLUSTER_RUNNERS: name,
              })),
            ),
          });
        }).pipe(Effect.provide(context)),
      );
    }),
  );

/** The runner entry, which imports the runners' classes from {@link VIRTUAL}. */
const runnerEntry = () =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./runner.ts" : "./runner.js", import.meta.url),
  );

/**
 * Bundle the runner program and its Dockerfile into a directory of their
 * own, once the runners know their classes, and resolve to the directory.
 */
const bundleRunners = Effect.fn(function* (id: string, runners: Runners) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "effect-cluster", yield* stackDnsLabel(id));
  return Output.mapEffect((entities: RunnersEntity[]) =>
    Effect.gen(function* () {
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* Bundle.build(
        {
          input: runnerEntry(),
          platform: "node",
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          plugins: entitiesPlugin(entities),
        },
        { dir, format: "esm", entryFileNames: "runner.mjs", codeSplitting: false },
      );
      yield* fs.writeFileString(path.join(dir, "Dockerfile"), RUNNER_DOCKERFILE);
      return dir;
    }).pipe(Effect.orDie),
  )(runners.entities);
});
