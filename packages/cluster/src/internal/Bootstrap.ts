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
import {
  ClusterCron,
  ClusterSchema,
  ClusterWorkflowEngine,
  Entity as EffectEntity,
  RunnerAddress,
  Singleton,
} from "effect/cluster";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Rpc, RpcGroup } from "effect/rpc";
import type { Workflow as EffectWorkflow } from "effect/workflow";
import type { HostedCron } from "../Cron.ts";
import { PlatformDeclaration, type HostedEntity } from "../Entity.ts";
import type { HostedSingleton } from "../Singleton.ts";
import type { HostedWorkflow } from "../Workflow.ts";
import { GATEWAY_PORT, RUNNER_PORT, gatewayLayer } from "./Gateway.ts";
import { HasNoRunners, type HostedRuntimeContext } from "./HostedRuntime.ts";

const env = (name: string) => process.env[name];

/** Whether an IPv4 address is in a CIDR range (`10.46.0.0/16`). */
const inIpv4Range = (address: string, range: string) => {
  const [base, bits] = range.split("/");
  const toNumber = (ip: string) =>
    ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address) || base === undefined) return false;
  const size = 2 ** (32 - Number(bits ?? 32));
  return Math.floor(toNumber(address) / size) === Math.floor(toNumber(base) / size);
};

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
    .map((iface) => iface!.address)
    // Link-local addresses (an agent's, a metadata endpoint's) aren't reachable.
    .filter((address) => !address.startsWith("169.254.") && !address.startsWith("fe80:"));
  // On a private network with a known range, the address in it.
  const range = env("CLUSTER_RUNNER_NETWORK");
  if (range) {
    const inRange = local.find((address) => inIpv4Range(address, range));
    if (inRange) return inRange;
  }
  // On Fly, the Machine's name on the App's private network.
  const flyMachine = env("FLY_MACHINE_ID");
  const flyApp = env("FLY_APP_NAME");
  if (flyMachine && flyApp) return `${flyMachine}.vm.${flyApp}.internal`;
  // On ECS, the task's own address in its VPC.
  const ecsMetadata = env("ECS_CONTAINER_METADATA_URI_V4");
  if (ecsMetadata) {
    const address = yield* HttpClient.get(ecsMetadata).pipe(
      Effect.flatMap((response) => response.json),
      Effect.map(
        (metadata) =>
          (metadata as { Networks?: Array<{ IPv4Addresses?: string[] }> }).Networks?.[0]
            ?.IPv4Addresses?.[0],
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (address) return address;
  }
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
export const runExternal = (
  definitions: ReadonlyArray<{ readonly name: string; readonly value: unknown }>,
): Promise<void> =>
  runProcess(
    "Effect Cluster runner",
    Effect.gen(function* () {
      const host = yield* runnerHost;
      const programEnv = {
        ...process.env,
        HOST: host,
        PORT: String(RUNNER_PORT),
        LISTEN_HOST: env("CLUSTER_LISTEN_HOST") ?? "0.0.0.0",
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

      // Each definition is the entity's schema (an `RpcGroup`) or an Effect
      // Cluster entity, as the external declaration's `main` exports it.
      const entities = definitions.map(({ name, value }) =>
        EffectEntity.isEntity(value)
          ? (value as HostedEntity["entity"])
          : EffectEntity.fromRpcGroup(name, value as RpcGroup.RpcGroup<Rpc.Any>),
      );
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
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    ) as Effect.Effect<never, unknown, never>,
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
export const bootstrap = (
  definitions: ReadonlyArray<{ readonly name: string; readonly value: unknown }>,
): Promise<void> => {
  const entrypoints = definitions.map((definition) => definition.value);
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
    const hosted: Array<HostedEntity | HostedWorkflow | HostedSingleton | HostedCron> = [];
    for (const entrypoint of entrypoints) {
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ??
        entrypoint;
      const context = yield* Layer.build(entrypointLayer(declaration));
      const runtime = Context.get(context, entrypointTag).RuntimeContext as HostedRuntimeContext<
        HostedEntity | HostedWorkflow | HostedSingleton | HostedCron
      >;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new HasNoRunners({
            message: `${runtime.Type} '${runtime.id}' did not finish its Construction phase.`,
          }),
        );
      }
      hosted.push(built);
    }

    const host = yield* runnerHost;
    const group = env("CLUSTER_SHARD_GROUPS") ?? "default";
    // Every hosted entity lives in these runners' own shard group.
    const placed = hosted
      .filter((entry): entry is HostedEntity => entry.kind === "entity")
      .map((entry) => ({
        ...entry,
        entity: entry.entity.annotate(ClusterSchema.ShardGroup, () => group),
      }));
    const workflows = hosted.filter((entry): entry is HostedWorkflow => entry.kind === "workflow");
    // Each workflow runs its handler with the services its Construction phase had.
    const workflowLayers = workflows.map((entry) =>
      (entry.workflow as EffectWorkflow.Workflow<string, any, any, any>).toLayer(
        (payload, executionId) =>
          Effect.provide(entry.execute(payload, executionId), entry.context) as Effect.Effect<
            any,
            any,
            never
          >,
      ),
    );
    const entityLayers = placed.map((entry) =>
      entry.entity
        .toLayer(
          // The instance phase runs with the services its Construction phase had.
          Effect.provide(entry.instance, entry.context) as Effect.Effect<any, never, any>,
          {
            maxIdleTime: entry.options.maxIdleTime,
            concurrency: entry.options.concurrency,
          },
        )
        // So does the entity itself: its RPCs' middleware is provided to its Layer.
        .pipe(Layer.provide(Layer.succeedContext(entry.context))),
    );
    const cluster = NodeClusterHttp.layer({
      transport: "http",
      storage: "sql",
      shardingConfig: {
        runnerAddress: Option.some(RunnerAddress.make(host, RUNNER_PORT)),
        // Fly's private network is IPv6 only.
        runnerListenAddress: Option.some(
          RunnerAddress.make(env("CLUSTER_LISTEN_HOST") ?? "0.0.0.0", RUNNER_PORT),
        ),
        ...shardGroupsConfig(),
      },
    }).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(env("CLUSTER_DATABASE_URL")!) })));
    // Singletons and crons run in these runners' shard group too, each with
    // the services its Construction phase had.
    const scheduled = hosted.flatMap((entry) =>
      entry.kind === "singleton"
        ? [
            Singleton.make(entry.name, Effect.provide(entry.run, entry.context), {
              shardGroup: group,
            }),
          ]
        : entry.kind === "cron"
          ? [
              ClusterCron.make({
                name: entry.name,
                cron: entry.cron,
                execute: Effect.provide(entry.run, entry.context),
                shardGroup: group,
                ...entry.options,
              }),
            ]
          : [],
    );
    const gateway = gatewayLayer(
      placed.map((entry) => entry.entity),
      env("CLUSTER_GATEWAY_TOKEN") ?? "",
      new Map(workflows.map((entry) => [entry.workflow._tag, entry.workflow])),
    ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: GATEWAY_PORT })));

    yield* Effect.logInfo(
      `Effect Cluster runner ${host}:${RUNNER_PORT}: ${hosted
        .map((entry) =>
          entry.kind === "entity"
            ? entry.entity.type
            : entry.kind === "workflow"
              ? entry.workflow._tag
              : `${entry.kind} ${entry.name}`,
        )
        .join(", ")}`,
    );
    return yield* Layer.launch(
      Layer.mergeAll(
        ...(entityLayers as [Layer.Layer<never>]),
        ...(workflowLayers as Layer.Layer<never, never, any>[]),
        ...(scheduled as Layer.Layer<never, never, any>[]),
        gateway,
      ).pipe(
        // Workflows run on Effect Cluster's own engine, over the cluster.
        Layer.provide(ClusterWorkflowEngine.layer),
        Layer.provide(cluster),
      ),
    );
  }).pipe(Effect.provide(platform), Effect.scoped);

  return runProcess("Effect Cluster runner", program as Effect.Effect<never, unknown, never>);
};
