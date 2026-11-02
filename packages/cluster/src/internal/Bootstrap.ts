/**
 * A runner's program: build each entity class's Construction phase, then
 * run every class's instances on Effect Cluster's HTTP runner, with runner
 * registration, shard locks and persisted messages in the cluster's
 * database, and serve the gateway callers reach the entities through.
 *
 * @internal
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { NodeClusterHttp, NodeHttpServer, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  entrypointTag,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import { ClusterSchema, RunnerAddress } from "effect/cluster";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  EntityHasNoRunners,
  PlatformDeclaration,
  type EntityRuntimeContext,
  type HostedEntity,
} from "../Entity.ts";
import { GATEWAY_PORT, RUNNER_PORT, gatewayLayer } from "./Gateway.ts";

const env = (name: string) => process.env[name];

/**
 * The address other runners reach this one at: an explicit
 * `CLUSTER_RUNNER_HOST`, else the local address that
 * `CLUSTER_PEERS` (a DNS name every runner resolves to) lists,
 * else the first non-internal IPv4 address.
 */
const runnerHost = Effect.gen(function* () {
  const explicit = env("CLUSTER_RUNNER_HOST");
  if (explicit) return explicit;
  const local = Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && !iface.internal)
    .map((iface) => iface!.address);
  const peers = env("CLUSTER_PEERS");
  if (peers) {
    const resolved = yield* Effect.tryPromise(() => lookup(peers, { all: true })).pipe(
      Effect.map((addresses) => addresses.map((address) => address.address)),
      Effect.orElseSucceed((): string[] => []),
    );
    const mine = resolved.find((address) => local.includes(address));
    if (mine) return mine;
  }
  return local.find((address) => !address.includes(":")) ?? "127.0.0.1";
});

/**
 * Run an existing Effect Cluster program as it is, as its own process
 * (`program.mjs`), with the gateway beside it. The program reads its
 * settings the way Effect Cluster programs do, from its environment:
 * `HOST` and `PORT` for the runner's address, `ASSIGNED_SHARD_GROUPS` and
 * `AVAILABLE_SHARD_GROUPS` (`ShardingConfig.layerFromEnv`), and
 * `DATABASE_URL`. The gateway joins the cluster as a client and routes
 * callers to the program's entities.
 */
export const runExternal = (definitions: ReadonlyArray<unknown>): Promise<void> =>
  runProcess(
    "Effect Cluster runner",
    Effect.gen(function* () {
      const host = yield* runnerHost;
      const programEnv = {
        ...process.env,
        HOST: host,
        PORT: String(RUNNER_PORT),
        LISTEN_HOST: "0.0.0.0",
        DATABASE_URL: env("DATABASE_URL") ?? env("CLUSTER_DATABASE_URL"),
        ASSIGNED_SHARD_GROUPS: env("CLUSTER_SHARD_GROUPS"),
        AVAILABLE_SHARD_GROUPS: env("CLUSTER_AVAILABLE_SHARD_GROUPS"),
      };
      yield* Effect.logInfo(`Effect Cluster runner ${host}:${RUNNER_PORT}: external program`);
      // The program owns this runner: if it stops, so does the runner.
      const child = yield* Effect.sync(() =>
        spawn(process.execPath, [fileURLToPath(new URL("./program.mjs", import.meta.url))], {
          env: programEnv,
          stdio: "inherit",
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGTERM")));
      const exited = Effect.callback<never, ExternalProgramExited>((resume) => {
        child.once("exit", (code) => resume(Effect.fail(new ExternalProgramExited({ code }))));
      });

      const entities = definitions.map((definition) => definition as HostedEntity["entity"]);
      const cluster = NodeClusterHttp.layer({
        transport: "http",
        storage: "sql",
        clientOnly: true,
        shardingConfig: shardGroupsConfig(),
      }).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(env("CLUSTER_DATABASE_URL")!) })));
      const gateway = gatewayLayer(entities, env("CLUSTER_GATEWAY_TOKEN") ?? "").pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port: GATEWAY_PORT })),
      );
      return yield* Effect.raceFirst(Layer.launch(gateway.pipe(Layer.provide(cluster))), exited);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)) as Effect.Effect<
      never,
      unknown,
      never
    >,
  );

/** The external program a runner runs stopped, so the runner stops too. */
export class ExternalProgramExited extends Data.TaggedError("Cluster.ExternalProgramExited")<{
  readonly code: number | null;
}> {}

/** The shard groups these runners serve, and every group in the cluster. */
const shardGroupsConfig = () => {
  const list = (name: string) =>
    (env(name) ?? "")
      .split(",")
      .map((group) => group.trim())
      .filter((group) => group.length > 0);
  const assigned = list("CLUSTER_SHARD_GROUPS");
  const available = list("CLUSTER_AVAILABLE_SHARD_GROUPS");
  return {
    ...(assigned.length > 0 ? { assignedShardGroups: assigned } : {}),
    ...(available.length > 0 ? { availableShardGroups: available } : {}),
  };
};

/** Build each class's Construction phase, then run the runner until it is stopped. */
export const bootstrap = (entrypoints: ReadonlyArray<unknown>): Promise<void> => {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  ).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
  );

  const program = Effect.gen(function* () {
    const hosted: HostedEntity[] = [];
    for (const entrypoint of entrypoints) {
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ??
        entrypoint;
      const context = yield* Layer.build(entrypointLayer(declaration));
      const runtime = Context.get(context, entrypointTag).RuntimeContext as EntityRuntimeContext;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new EntityHasNoRunners({
            message: `Cluster.Entity '${runtime.id}' did not finish its Construction phase.`,
          }),
        );
      }
      hosted.push(built);
    }

    const host = yield* runnerHost;
    const group = env("CLUSTER_SHARD_GROUPS") ?? "default";
    // Every hosted entity lives in these runners' own shard group.
    const placed = hosted.map((entry) => ({
      ...entry,
      entity: entry.entity.annotate(ClusterSchema.ShardGroup, () => group),
    }));
    const entityLayers = placed.map((entry) =>
      entry.entity.toLayer(
        // The instance phase runs with the services its Construction phase had.
        Effect.provide(entry.instance, entry.context) as Effect.Effect<any, never, any>,
        {
          maxIdleTime: entry.options.maxIdleTime,
          concurrency: entry.options.concurrency,
        },
      ),
    );
    const cluster = NodeClusterHttp.layer({
      transport: "http",
      storage: "sql",
      shardingConfig: {
        runnerAddress: Option.some(RunnerAddress.make(host, RUNNER_PORT)),
        runnerListenAddress: Option.some(RunnerAddress.make("0.0.0.0", RUNNER_PORT)),
        ...shardGroupsConfig(),
      },
    }).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(env("CLUSTER_DATABASE_URL")!) })));
    const gateway = gatewayLayer(
      placed.map((entry) => entry.entity),
      env("CLUSTER_GATEWAY_TOKEN") ?? "",
    ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: GATEWAY_PORT })));

    yield* Effect.logInfo(
      `Effect Cluster runner ${host}:${RUNNER_PORT}: ${hosted.map((entry) => entry.entity.type).join(", ")}`,
    );
    return yield* Layer.launch(
      Layer.mergeAll(...(entityLayers as [Layer.Layer<never>]), gateway).pipe(
        Layer.provide(cluster),
      ),
    );
  }).pipe(Effect.provide(platform), Effect.scoped);

  return runProcess("Effect Cluster runner", program as Effect.Effect<never, unknown, never>);
};
