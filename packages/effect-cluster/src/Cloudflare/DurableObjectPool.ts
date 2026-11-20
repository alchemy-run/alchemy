import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Worker as CloudflareWorker } from "@alchemy.run/cloudflare/Workers";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { Self } from "alchemy/Self";
import type { Stack } from "alchemy/Stack";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { Entity } from "../Entity.ts";
import { registerRouteBinder, routeType } from "../internal/Gateway.ts";
import type { HostedClass } from "../internal/HostedRuntime.ts";
import { HOSTED_TYPES, stackDnsLabel } from "../internal/Naming.ts";
import { PoolHost } from "../internal/PoolHostService.ts";
import { Pool as PoolResource, type PoolEntity } from "../Pool.ts";
import type { Providers } from "../Providers.ts";
import { poolWorker } from "./PoolWorker.ts";

// A Worker that calls a class this pool hosts gets a service binding to
// the pool's Worker: Workers can't fetch another Worker's workers.dev URL.
registerRouteBinder((key, worker) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const caller = Option.getOrUndefined(
      yield* Effect.serviceOption(
        (CloudflareWorker as unknown as { Self: Context.Key<CloudflareWorker, CloudflareWorker> })
          .Self,
      ),
    );
    if (caller === undefined) return;
    yield* caller.bind`${key}`({
      bindings: [{ type: "service", name: key, service: worker as string }],
    });
  }),
);

export interface DurableObjectPoolOptions {
  /**
   * The name the pool is known by, used for its Worker's entry.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
}

/** An external program needs runners that run Node, which Workers don't. */
export class ExternalProgramOnWorkers extends Data.TaggedError("Cluster.ExternalProgramOnWorkers")<{
  readonly message: string;
}> {}

/**
 * Write the Worker's entry module: it imports every class the pool hosts
 * and default-exports the pool Worker with them, so the Worker's own
 * bundler bundles them all.
 */
const writeEntry = Effect.fn(function* (id: string, workerId: string, pool: PoolResource) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "cluster", yield* stackDnsLabel(id));
  return Output.mapEffect((entities: PoolEntity[]) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = path.join(dir, "worker.ts");
      const source = [
        `import { poolWorker } from "@alchemy.run/effect-cluster/Cloudflare/PoolWorker";`,
        ...entities.map(
          (entity, i) =>
            `import { ${entity.handler} as e${i} } from ${JSON.stringify(
              entity.module.startsWith("file:") ? new URL(entity.module).pathname : entity.module,
            )};`,
        ),
        `export default poolWorker(${JSON.stringify(workerId)}, undefined, [${entities
          .map((entity, i) => `{ name: ${JSON.stringify(entity.name)}, value: e${i} }`)
          .join(", ")}]);`,
        "",
      ].join("\n");
      yield* fs.writeFileString(file, source);
      return file;
    }).pipe(Effect.orDie),
  )(pool.entities);
});

/**
 * Run an Effect Cluster on Cloudflare: one Worker that hosts every class
 * given this pool on Durable Objects. Each entity instance is a Durable
 * Object named by its type and id, so there are no shards, no runners to
 * place it on, and no database: the object's own SQLite holds its persisted
 * messages. Each workflow execution is a Durable Object too, and each
 * singleton and cron one that its alarm keeps awake.
 *
 * Callers anywhere reach the entities through the Worker's gateway; inside
 * the Worker, one entity calls another's object directly.
 *
 * ### Running entities on Cloudflare
 * **Example:** Runners on Durable Objects
 * ```typescript
 * export const Default = ClusterCloudflare.DurableObjectPool("Default");
 * ```
 *
 * @primitive
 */
export const DurableObjectPool = (
  id: string,
  options: DurableObjectPoolOptions = {},
): Layer.Layer<PoolHost, never, Stack | Providers | Cloudflare.Providers> =>
  Layer.effect(
    PoolHost,
    Effect.gen(function* () {
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
      const name = options.name ?? (yield* stackDnsLabel(id));
      const workerId = `${id}Pool`;
      const context = yield* Effect.context<Stack | Providers | Cloudflare.Providers>();

      /** Put `hosted` on the pool, and bind the gateway onto `resource`. */
      const deploy = Effect.fn(function* (
        hosted: PoolEntity,
        env: Record<string, unknown>,
        resource: Entity,
      ) {
        const pool = yield* PoolResource(id, { name });
        const token = yield* Random(`${id}GatewayToken`, {
          bytes: 32,
        }) as unknown as Effect.Effect<Random, never, Providers>;
        yield* pool.bind`${hosted.name}`({ entities: [hosted], env });
        const worker = yield* poolWorker(
          workerId,
          {
            main: (yield* writeEntry(id, workerId, pool)) as unknown as string,
            compatibility: { flags: ["nodejs_compat"] },
            env: {
              // The classes' own environment, which only the deploy knows
              // the keys of: one secret, unpacked when the Worker starts.
              CLUSTER_ENV: pool.env.pipe(
                Output.map((values) => Redacted.make(JSON.stringify(values))),
              ),
              CLUSTER_POOL: name,
              CLUSTER_GATEWAY_TOKEN: token.text,
            } as unknown as Record<string, string>,
          },
          [],
        );
        // Callers that are Workers reach the gateway through a service binding.
        routeType(hosted.name, worker.workerName);
        // What callers need to reach the entity through the gateway.
        yield* resource.bind`Pool`({
          pool: name,
          gateway: worker.url as unknown as string,
          token: token.text,
        });
      }, Effect.provide(context));

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

      if (hostsSelf) yield* host(self as unknown as HostedClass);

      return {
        host,
        deployExternal: ({ type }) =>
          Effect.die(
            new ExternalProgramOnWorkers({
              message:
                `Cluster.Entity '${type}' runs an existing Effect Cluster program, which needs Node: ` +
                `give it a pool on another host, like ClusterDocker.SwarmPool or ClusterAWS.EcsPool.`,
            }),
          ),
      } satisfies PoolHost["Service"];
    }),
  );
