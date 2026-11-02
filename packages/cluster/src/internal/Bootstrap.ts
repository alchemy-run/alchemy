/**
 * A runner's program: build each entity class's Construction phase, then
 * run every class's instances on Effect Cluster's HTTP runner, with runner
 * registration, shard locks and persisted messages in the cluster's
 * database, and serve the gateway callers reach the entities through.
 *
 * @internal
 */
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { NodeClusterHttp, NodeHttpServer, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  entrypointTag,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import { RunnerAddress } from "effect/cluster";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
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
    const entityLayers = hosted.map((entry) =>
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
      },
    }).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(env("CLUSTER_DATABASE_URL")!) })));
    const gateway = gatewayLayer(
      hosted.map((entry) => entry.entity),
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
