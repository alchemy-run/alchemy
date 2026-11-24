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
import { NodeClusterHttp, NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { RuntimeConfigProviderLive } from "alchemy/Runtime";
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
  Runner,
  RunnerAddress,
  Runners,
  RunnerStorage,
  ShardingConfig,
  Singleton,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/cluster";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { Rpc, RpcGroup } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import type { Workflow as EffectWorkflow } from "effect/workflow";
import type { HostedCron } from "../Cron.ts";
import { databaseMaxConnections } from "../Database.ts";
import { PlatformDeclaration, type HostedEntity } from "../Entity.ts";
import { RunnerHost } from "../Host.ts";
import type { HostedSingleton } from "../Singleton.ts";
import type { HostedWorkflow } from "../Workflow.ts";
import { GATEWAY_PORT, RUNNER_PORT, gatewayLayer } from "./Gateway.ts";
import { HasNoPool, type HostedRuntimeContext } from "./HostedRuntime.ts";
import { loadSecretEnv } from "./SecretEnv.ts";

const env = (name: string) => process.env[name];

/**
 * The runner's client to the cluster's database: `CLUSTER_DATABASE_URL`,
 * holding at most the pool's `databaseConnections`.
 */
const clusterDatabase = Layer.unwrap(
  Effect.map(databaseMaxConnections, (maxConnections) =>
    PgClient.layer({ url: Redacted.make(env("CLUSTER_DATABASE_URL")!), maxConnections }),
  ),
);

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
 * Run an existing Effect Cluster program as it is, as its own process, with
 * the gateway beside it. The program reads its settings the way Effect
 * Cluster programs do, from its environment, when it loads: `HOST` and
 * `PORT` for the runner's address, `ASSIGNED_SHARD_GROUPS` and
 * `AVAILABLE_SHARD_GROUPS` (`ShardingConfig.layerFromEnv`), and
 * `DATABASE_URL`. The gateway joins the cluster as a client and routes
 * callers to the program's entities.
 */
export const runExternal = (
  definitions: ReadonlyArray<{ readonly name: string; readonly value: unknown }>,
  programSource: string,
): Promise<void> =>
  runProcess(
    "Effect Cluster runner",
    Effect.gen(function* () {
      yield* Effect.sync(loadSecretEnv);
      const host = yield* runnerHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The program ships inside the runner; write it out to run it.
      const programDir = yield* fs.makeTempDirectoryScoped({ prefix: "cluster-program-" });
      const programFile = path.join(programDir, "program.mjs");
      yield* fs.writeFileString(programFile, programSource);
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
        spawn(process.execPath, [programFile], { env: programEnv, stdio: "inherit" }),
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
      }).pipe(Layer.provide(clusterDatabase));
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

/** How often the pool checks that its runners are reachable. */
const RUNNER_HEALTH_CHECK_INTERVAL = Duration.seconds(5);

/**
 * Effect Cluster's own runner health check is a singleton in the `default`
 * shard group, which no pool serves (an external program's entities live
 * there), so it never runs: a runner that crashed kept its shards until its
 * registration expired, 35 seconds later. The pool runs the check itself,
 * on every runner and without a singleton, so the crash of the runner doing
 * it can't stall it either:
 *
 * - Every runner orders the pool's registered runners by address. The first
 *   one that answers a ping is the checker: it pings every runner, marks one
 *   that doesn't answer unhealthy (which takes its shards off it) and one
 *   that answers again healthy. The last healthy runner is never marked.
 * - Every other runner pings the runners before it, in order, and stops at
 *   the first that answers. Only when none does, as when the checker itself
 *   crashed, does it check the pool.
 *
 * So a pool of n runners pings about 2(n - 1) times and reads its runners n
 * times per interval, and a crashed checker is replaced at the next one.
 */
const runnerHealthCheck = (group: string, self: RunnerAddress.RunnerAddress) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const storage = yield* RunnerStorage.RunnerStorage;
      const runners = yield* Runners.Runners;
      const key = (address: RunnerAddress.RunnerAddress) => `${address.host}:${address.port}`;
      const isAlive = (address: RunnerAddress.RunnerAddress) =>
        key(address) === key(self)
          ? Effect.succeed(true)
          : runners
              .ping(address)
              .pipe(
                Effect.timeout("3 seconds"),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 3 }),
                Effect.isSuccess,
              );
      /** Mark every runner of the pool by whether it answers. */
      const checkAll = (
        registered: ReadonlyArray<readonly [Runner.Runner, boolean]>,
        answers: (address: RunnerAddress.RunnerAddress) => Effect.Effect<boolean>,
      ) =>
        Effect.gen(function* () {
          let healthy = registered.filter(([, isHealthy]) => isHealthy).length;
          yield* Effect.forEach(
            registered,
            ([runner, isHealthy]) =>
              Effect.flatMap(answers(runner.address), (alive) => {
                if (alive === isHealthy || (!alive && healthy <= 1)) return Effect.void;
                healthy += alive ? 1 : -1;
                return Effect.logInfo(
                  `Effect Cluster runner ${key(runner.address)} is ${alive ? "reachable again" : "unreachable"}`,
                ).pipe(Effect.andThen(storage.setRunnerHealth(runner.address, alive)));
              }),
            { concurrency: 10, discard: true },
          );
        });
      /** Whether a runner before this one in the order answers: then it checks. */
      const anEarlierAnswers = (
        earlier: ReadonlyArray<Runner.Runner>,
        answers: (address: RunnerAddress.RunnerAddress) => Effect.Effect<boolean>,
      ): Effect.Effect<boolean> =>
        earlier.length === 0
          ? Effect.succeed(false)
          : Effect.flatMap(answers(earlier[0]!.address), (alive) =>
              alive ? Effect.succeed(true) : anEarlierAnswers(earlier.slice(1), answers),
            );
      const check = Effect.gen(function* () {
        const registered = (yield* storage.getRunners)
          .filter(([runner]) => runner.groups.includes(group))
          .toSorted(([a], [b]) => key(a.address).localeCompare(key(b.address)));
        const earlier = registered
          .filter(([runner]) => key(runner.address).localeCompare(key(self)) < 0)
          .map(([runner]) => runner);
        // Each runner is pinged once per check: a crashed runner before this
        // one, found not to answer, is marked without waiting for it again.
        const answered = new Map<string, boolean>();
        const answers = (address: RunnerAddress.RunnerAddress) => {
          const known = answered.get(key(address));
          return known !== undefined
            ? Effect.succeed(known)
            : Effect.tap(isAlive(address), (alive) =>
                Effect.sync(() => answered.set(key(address), alive)),
              );
        };
        if (yield* anEarlierAnswers(earlier, answers)) return;
        yield* checkAll(registered, answers);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Runner health check failed", cause)));
      yield* check.pipe(
        Effect.andThen(Effect.sleep(RUNNER_HEALTH_CHECK_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );

/** The shard groups this pool serves, and every group in the cluster. */
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
  ).pipe(Layer.provideMerge(stackFromEnv), Layer.provideMerge(RuntimeConfigProviderLive));

  const program = Effect.gen(function* () {
    type Hosted = HostedEntity | HostedWorkflow | HostedSingleton | HostedCron;
    // Every class this runner hosts, and the Layers to launch beside them:
    // its exported classes, and the entities Layers host themselves.
    const hostedRef = yield* Ref.make<ReadonlyArray<Hosted>>([]);
    const launchedRef = yield* Ref.make<ReadonlyArray<Layer.Layer<never, never, any>>>([]);
    const add = (built: Hosted) =>
      Ref.update(hostedRef, (all) =>
        built.kind === "entity" &&
        all.some((other) => other.kind === "entity" && other.entity.type === built.entity.type)
          ? all
          : [...all, built],
      );
    const runner = RunnerHost.of({
      host: (entity, layer) =>
        Effect.andThen(
          add(entity),
          Ref.update(launchedRef, (all) => [...all, layer]),
        ),
    });
    for (const entrypoint of entrypoints) {
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ??
        entrypoint;
      const context = yield* Layer.build(entrypointLayer(declaration)).pipe(
        Effect.provideService(RunnerHost, runner),
      );
      // A Layer that hosts its entities itself (a Domain model's) provides
      // none: it handed them to `RunnerHost`.
      const self = Context.getOption(context, entrypointTag);
      if (Option.isNone(self)) continue;
      const runtime = self.value.RuntimeContext as HostedRuntimeContext<Hosted>;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new HasNoPool({
            message: `${runtime.Type} '${runtime.id}' did not finish its Construction phase.`,
          }),
        );
      }
      yield* add(built);
    }
    const hosted = yield* Ref.get(hostedRef);
    const launched = yield* Ref.get(launchedRef);

    const host = yield* runnerHost;
    const group = env("CLUSTER_SHARD_GROUPS") ?? "default";
    // Every hosted entity lives in this pool's own shard group.
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
            mailboxCapacity: entry.options.mailboxCapacity,
            disableFatalDefects: entry.options.disableFatalDefects,
          },
        )
        // So does the entity itself: its RPCs' middleware is provided to its Layer.
        .pipe(Layer.provide(Layer.succeedContext(entry.context))),
    );
    const shardingConfig = {
      runnerAddress: Option.some(RunnerAddress.make(host, RUNNER_PORT)),
      // Fly's private network is IPv6 only.
      runnerListenAddress: Option.some(
        RunnerAddress.make(env("CLUSTER_LISTEN_HOST") ?? "0.0.0.0", RUNNER_PORT),
      ),
      runnerHealthCheckInterval: RUNNER_HEALTH_CHECK_INTERVAL,
      ...shardGroupsConfig(),
    };
    // The SQL storage Effect Cluster's `sql` option builds, built here so the
    // runner health check below can mark runners in it.
    const storage = Layer.mergeAll(
      SqlMessageStorage.layer.pipe(Layer.provide(NodeCrypto.layerDigest)),
      Layer.orDie(SqlRunnerStorage.layer),
    ).pipe(
      Layer.provide(ShardingConfig.layerFromEnv(shardingConfig)),
      Layer.provide(clusterDatabase),
    );
    const cluster = NodeClusterHttp.layer({
      transport: "http",
      storage: "byo",
      shardingConfig,
    }).pipe(Layer.provideMerge(storage));
    // Singletons and crons run in this pool's shard group too, each with
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
        // What the classes' Construction phases handed the runner.
        ...launched,
        gateway,
        runnerHealthCheck(group, RunnerAddress.make(host, RUNNER_PORT)),
      ).pipe(
        // Workflows run on Effect Cluster's own engine, over the cluster.
        Layer.provide(ClusterWorkflowEngine.layer),
        Layer.provide(cluster),
      ),
    );
  }).pipe(Effect.provide(platform), Effect.scoped);

  return runProcess(
    "Effect Cluster runner",
    Effect.andThen(Effect.sync(loadSecretEnv), program) as Effect.Effect<never, unknown, never>,
  );
};
