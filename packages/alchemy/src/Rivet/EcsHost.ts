import * as ecs from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as CloudMap from "../AWS/CloudMap/index.ts";
import * as EC2 from "../AWS/EC2/index.ts";
import {
  makeImageSource,
  type BundledImageSource,
} from "../AWS/ECR/ImageSource.ts";
import * as ECS from "../AWS/ECS/index.ts";
import { waitForServiceConvergence } from "../AWS/ECS/Service.ts";
import {
  createTaskRoleIfNotExists,
  deleteTaskDefinitionInfrastructure,
  ensureTaskExecutionRole,
  ensureTaskLogGroup,
  reapSupersededTaskDefinitionRevision,
  registerTaskDefinitionRevision,
} from "../AWS/ECS/Task.ts";
import type { Input } from "../Input.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Random } from "../Random.ts";
import { Stack } from "../Stack.ts";
import { diffTags } from "../Tags.ts";
import {
  DEFAULT_CPU_ARCHITECTURE,
  Host,
  type CpuArchitecture,
  type HostComposeOptions,
  type HostComposeResult,
  type HostService,
  type RunnerDeployOptions,
  type RunnerSource,
} from "./Host.ts";

/** More than one engine node was requested on the single-node RocksDB backend. */
export class RivetSingleNodeStorage extends Data.TaggedError(
  "RivetSingleNodeStorage",
)<{
  readonly clusterId: string;
  readonly message: string;
}> {}

/** A worker's cluster host state lacks the compute/network the runner needs. */
export class RivetHostStateIncomplete extends Data.TaggedError(
  "RivetHostStateIncomplete",
)<{
  readonly workerId: string;
  readonly message: string;
}> {}

/** Rivet engine version the host pins when the Cluster declares none. */
export const DEFAULT_RIVET_VERSION = "2.3.10";

/** The rivetkit release installed into the runner image. */
export const DEFAULT_RIVETKIT_VERSION = "2.3.10";

/** HTTP/WebSocket routing layer — the engine's public surface. */
const GUARD_PORT = 6420;
/** Private api-peer service — engine-to-engine, and `/health`. */
const API_PEER_PORT = 6421;
const ENGINE_CIDR = "10.62.0.0/16";
/** Where the built-in RocksDB store lives inside the container. */
const FILE_SYSTEM_PATH = "/data";
/**
 * Single-datacenter topology. `datacenter_label` appears twice by design:
 * once on the topology (which datacenter *this* process is) and once on the
 * datacenter entry itself.
 */
const DATACENTER_NAME = "default";
const DATACENTER_LABEL = 1;
/**
 * Fargate caps `stopTimeout` at 120s. Guard drains inside that budget and
 * the engine force-exits before ECS escalates to SIGKILL.
 */
const GUARD_SHUTDOWN_SECONDS = 100;
const FORCE_SHUTDOWN_SECONDS = 110;
const STOP_TIMEOUT_SECONDS = 120;

/**
 * rivetkit's drain window must fit inside Fargate's 120s `stopTimeout`
 * ceiling — same budget the engine itself runs with.
 */
const RUNNER_STOP_TIMEOUT_SECONDS = 120;

/**
 * rivetkit ships wasm/napi engine sidecars (`@rivetkit/rivetkit-wasm`,
 * `@rivetkit/rivetkit-napi`) that cannot be bundled — the runner keeps
 * `rivetkit` external and the image environment installs it with `bun add`
 * (its transitive deps included).
 */
const RIVETKIT_EXTERNAL = /^rivetkit(\/|$)|^@rivetkit\//;

/** The image platform docker builds for a task architecture. */
const imagePlatform = (cpuArchitecture: CpuArchitecture | undefined) =>
  (cpuArchitecture ?? DEFAULT_CPU_ARCHITECTURE) === "ARM64"
    ? "linux/arm64"
    : "linux/amd64";

const runtimePlatform = (
  cpuArchitecture: CpuArchitecture | undefined,
): ecs.RuntimePlatform => ({
  cpuArchitecture: cpuArchitecture ?? DEFAULT_CPU_ARCHITECTURE,
  operatingSystemFamily: "LINUX",
});

/** The shape of a cluster's host state as this host composes it. */
interface EcsHostState {
  readonly clusterArn?: string;
  readonly serviceName?: string;
  readonly subnetIds?: string[];
  readonly securityGroupIds?: string[];
}

// ── Engine: compose ─────────────────────────────────────────────────────

const composeEcsCluster = ({
  id,
  props,
}: HostComposeOptions): Effect.Effect<HostComposeResult, any, any> =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const image =
      props.image ??
      `rivetdev/engine:${props.rivetVersion ?? DEFAULT_RIVET_VERSION}`;
    const instances = props.instances ?? 1;

    if (props.postgresUrl === undefined && instances > 1) {
      return yield* Effect.fail(
        new RivetSingleNodeStorage({
          clusterId: id,
          message:
            `Rivet cluster '${id}' requests ${instances} engine nodes, but the ` +
            "default RocksDB storage backend is single-node. Set `postgresUrl` " +
            "to run more than one engine node.",
        }),
      );
    }

    const secret = yield* Random("AdminToken", { bytes: 32 });

    let vpcId: Input<string>;
    let subnetIds: Input<string[]>;
    let securityGroupIds: Input<string[]>;
    if (props.vpc !== undefined) {
      vpcId = props.vpc.vpcId;
      subnetIds = props.vpc.subnetIds;
      securityGroupIds = props.vpc.securityGroupIds;
    } else {
      const network = yield* EC2.Network("Network", {
        cidrBlock: ENGINE_CIDR,
        availabilityZones: 2,
        nat: "none",
        tags: props.tags,
      });
      vpcId = network.vpcId;
      subnetIds = network.publicSubnetIds;
      // NOTE: security group and rule descriptions are ASCII-only and reject
      // apostrophes and em-dashes.
      const securityGroup = yield* EC2.SecurityGroup("SecurityGroup", {
        vpcId: network.vpcId,
        description: `Rivet engine ${id} nodes and VPC attached callers`,
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: GUARD_PORT,
            toPort: GUARD_PORT,
            cidrIpv4: ENGINE_CIDR,
            description: "guard HTTP and WebSocket (VPC internal)",
          },
          {
            ipProtocol: "tcp",
            fromPort: API_PEER_PORT,
            toPort: API_PEER_PORT,
            cidrIpv4: ENGINE_CIDR,
            description: "api-peer and health (VPC internal)",
          },
        ],
        tags: props.tags,
      });
      securityGroupIds = [securityGroup.groupId];
    }

    const dnsNamespace = yield* CloudMap.PrivateDnsNamespace("Discovery", {
      name: `${stack.stage}-${id}.rivet.internal`.toLowerCase(),
      vpc: vpcId,
      tags: props.tags,
    });
    const discovery = yield* CloudMap.Service("EngineRecord", {
      name: "engine",
      namespaceId: dnsNamespace.namespaceId,
      dnsRecords: [{ type: "A", ttl: "10 seconds" }],
      healthCheckCustomConfig: { failureThreshold: 1 },
      tags: props.tags,
    });

    const host = Output.interpolate`${discovery.serviceName}.${dnsNamespace.namespaceName}`;
    const endpoint = Output.interpolate`http://${host}:${String(GUARD_PORT)}`;
    const peerUrl = Output.interpolate`http://${host}:${String(API_PEER_PORT)}`;

    // Single-datacenter topology, addressed as a nested env tree. config-rs
    // lowercases every key, so the `DEFAULT` segment becomes the map key
    // `default` — which is also the datacenter's name. `name` must NOT be
    // set on the entry: the engine derives it from the key and errors when
    // both are present.
    const dc = `RIVET__TOPOLOGY__DATACENTERS__${DATACENTER_NAME.toUpperCase()}`;
    const topologyEnv = {
      RIVET__TOPOLOGY__DATACENTER_LABEL: String(DATACENTER_LABEL),
      [`${dc}__DATACENTER_LABEL`]: String(DATACENTER_LABEL),
      [`${dc}__IS_LEADER`]: "true",
      [`${dc}__PEER_URL`]: peerUrl,
      [`${dc}__PUBLIC_URL`]: props.publicUrl ?? endpoint,
    };

    const cluster = yield* ECS.Cluster("Cluster", { tags: props.tags });

    const service = yield* ECS.Service("Engine", {
      cluster,
      // Mirrored verbatim from the upstream multi-arch image — the platform
      // to pull is derived from `runtimePlatform` below.
      image,
      port: GUARD_PORT,
      desiredCount: instances,
      // The engine's production guidance is at least 1 vCPU / 2 GB.
      cpu: props.cpu ?? 1024,
      memory: props.memory ?? 2048,
      runtimePlatform: runtimePlatform(props.cpuArchitecture),
      vpcId,
      subnets: subnetIds,
      securityGroups: securityGroupIds,
      // Egress-only public IP (image pull, CloudWatch logs) — the security
      // group admits nothing from outside the VPC.
      assignPublicIp: true,
      env: {
        // The engine reads its admin token as a plain string, so the
        // Redacted wrapper is unwrapped here rather than marker-packed.
        RIVET__AUTH__ADMIN_TOKEN: secret.text.pipe(
          Output.map((token: Redacted.Redacted<string>) =>
            Redacted.value(token),
          ),
        ),
        // The engine binds `::` by default; awsvpc ENIs are IPv4-only.
        RIVET__GUARD__HOST: "0.0.0.0",
        RIVET__API_PEER__HOST: "0.0.0.0",
        // Fit the drain inside Fargate's 120s `stopTimeout` ceiling; the
        // engine rejects `force < guard` at config load.
        RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: String(GUARD_SHUTDOWN_SECONDS),
        RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: String(FORCE_SHUTDOWN_SECONDS),
        ...topologyEnv,
        ...(props.postgresUrl !== undefined
          ? { RIVET__POSTGRES__URL: props.postgresUrl }
          : { RIVET__FILE_SYSTEM__PATH: FILE_SYSTEM_PATH }),
      },
      container: {
        // Give the engine its full 110s force-shutdown budget before ECS
        // escalates to SIGKILL.
        stopTimeout: STOP_TIMEOUT_SECONDS,
      },
      deploymentConfiguration:
        props.postgresUrl === undefined
          ? // RocksDB is single-writer: stop the old task before starting
            // the replacement rather than ECS's default overlap.
            { maximumPercent: 100, minimumHealthyPercent: 0 }
          : undefined,
      serviceRegistries: [
        { registryArn: discovery.serviceArn as unknown as string },
      ],
      tags: props.tags,
    });

    return {
      endpoint,
      adminToken: secret.text,
      hostState: {
        subnetIds,
        securityGroupIds,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
      },
    } satisfies HostComposeResult;
  }).pipe(Namespace.push(id));

// ── Runner: deploy / hash / delete ──────────────────────────────────────

const environmentDockerfile = (source: RunnerSource): string =>
  [
    `FROM ${source.image ?? "oven/bun:1"}`,
    "WORKDIR /app",
    `RUN bun add rivetkit@${source.rivetkitVersion ?? DEFAULT_RIVETKIT_VERSION} ws eventsource`,
  ].join("\n");

const toBundledSource = (source: RunnerSource): BundledImageSource => {
  const build = (source.build ?? {}) as NonNullable<
    BundledImageSource["build"]
  >;
  return {
    main: source.main,
    dockerfile: { content: environmentDockerfile(source) },
    build: {
      ...build,
      input: {
        ...build.input,
        external: [
          RIVETKIT_EXTERNAL,
          ...((build.input?.external as (string | RegExp)[] | undefined) ?? []),
        ],
      },
    },
  };
};

/** Converge the runner service's tags on the observed cloud tags. */
const syncServiceTags = Effect.fn(function* ({
  serviceArn,
  observed,
  desired,
}: {
  serviceArn: string;
  observed: readonly ecs.Tag[] | undefined;
  desired: Record<string, string>;
}) {
  const oldTags = Object.fromEntries(
    (observed ?? []).flatMap((tag) =>
      tag.key !== undefined && tag.value !== undefined
        ? [[tag.key, tag.value]]
        : [],
    ),
  );
  const { removed, upsert } = diffTags(oldTags, desired);
  if (removed.length > 0) {
    yield* ecs.untagResource({ resourceArn: serviceArn, tagKeys: removed });
  }
  if (upsert.length > 0) {
    yield* ecs.tagResource({
      resourceArn: serviceArn,
      tags: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
    });
  }
});

const deployRunner = (options: RunnerDeployOptions) =>
  Effect.gen(function* () {
    const { id, names, source, env, bootstrap, output, session } = options;
    const imageSource = yield* makeImageSource;

    const state = (options.hostState ?? {}) as EcsHostState;
    if (
      state.clusterArn === undefined ||
      state.subnetIds === undefined ||
      state.securityGroupIds === undefined
    ) {
      return yield* Effect.fail(
        new RivetHostStateIncomplete({
          workerId: id,
          message:
            `Rivet runner '${id}' has no usable cluster host state — the ` +
            "ECS host composes clusterArn, subnetIds, and securityGroupIds " +
            "on the cluster; redeploy the cluster first.",
        }),
      );
    }
    const hostState = state as Required<EcsHostState>;

    // Bundle `main` behind the generated runner entry, build the image,
    // and push it to the managed ECR repository (content-addressed — a
    // re-run with unchanged content skips the build).
    const resolved = yield* imageSource.resolve({
      id,
      source: toBundledSource(source),
      repositoryName: names.repositoryName,
      repositoryUri: output?.repositoryUri,
      tags: options.tags,
      platform: imagePlatform(source.cpuArchitecture),
      bootstrap,
      session,
    });

    const taskRoleArn = yield* createTaskRoleIfNotExists({
      id,
      roleName: names.taskRoleName,
    });
    const executionRoleArn = yield* ensureTaskExecutionRole({
      id,
      roleName: names.executionRoleName,
    });
    yield* ensureTaskLogGroup({ id, logGroupName: names.logGroupName });

    const taskDefinition = yield* registerTaskDefinitionRevision({
      props: {
        env,
        cpu: source.cpu ?? 512,
        memory: source.memory ?? 1024,
        runtimePlatform: runtimePlatform(source.cpuArchitecture),
        container: {
          // Give rivetkit's actor drain its full budget before ECS
          // escalates to SIGKILL.
          stopTimeout: RUNNER_STOP_TIMEOUT_SECONDS,
        },
      },
      family: names.taskFamily,
      imageUri: resolved.imageUri,
      taskRoleArn,
      executionRoleArn,
      logGroupName: names.logGroupName,
      tags: options.tags,
    });
    const taskDefinitionArn = taskDefinition.taskDefinitionArn!;

    // Observe the service; create when missing, roll onto the new revision
    // otherwise. ECS's default deployment overlap (200%/100%) plus the
    // strictly-increasing RIVET_ENVOY_VERSION drains actors from the old
    // runner generation onto the new one.
    const desiredCount = source.desiredCount ?? 1;
    const described = yield* ecs.describeServices({
      cluster: hostState.clusterArn,
      services: [names.serviceName],
      include: ["TAGS"],
    });
    const existing = described.services?.find(
      (service) => service.status !== "INACTIVE",
    );

    const update = ecs.updateService({
      cluster: hostState.clusterArn,
      service: names.serviceName,
      taskDefinition: taskDefinitionArn,
      desiredCount,
    });

    if (existing === undefined) {
      yield* session.note(`Creating ECS runner service ${names.serviceName}`);
      yield* ecs
        .createService({
          cluster: hostState.clusterArn,
          serviceName: names.serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: hostState.subnetIds,
              securityGroups: hostState.securityGroupIds,
              // Egress-only public IP (image pull, CloudWatch logs, the
              // outbound engine tunnel) — the security group admits
              // nothing from outside the VPC.
              assignPublicIp: "ENABLED",
            },
          },
          tags: Object.entries(options.tags).map(([key, value]) => ({
            key,
            value,
          })),
          enableECSManagedTags: true,
        })
        .pipe(
          // "Creation of service was not idempotent" — a crash-rerun or
          // concurrent race left the service in place; converge via update.
          Effect.catchTag("InvalidParameterException", () => update),
        );
    } else {
      yield* session.note(`Rolling ECS runner service ${names.serviceName}`);
      yield* update;
      if (existing.serviceArn !== undefined) {
        yield* syncServiceTags({
          serviceArn: existing.serviceArn,
          observed: existing.tags,
          desired: options.tags,
        });
      }
    }

    // Deploy is not done until the new runner generation is actually
    // running: the generated entry exits nonzero unless its envoy registers
    // with the engine (startAndWait), so a runner that cannot reach or
    // register with the engine crash-loops and this wait surfaces the fault
    // instead of reporting success while the gateway 400s.
    yield* session.note(
      `Waiting for ECS runner service ${names.serviceName} to stabilize`,
    );
    yield* waitForServiceConvergence({
      clusterArn: hostState.clusterArn,
      serviceName: names.serviceName,
      expectedTaskDefinitionArn: taskDefinitionArn,
      mode: "stable",
    });

    yield* reapSupersededTaskDefinitionRevision({
      previousArn: output?.taskDefinitionArn,
      nextArn: taskDefinitionArn,
    });

    return {
      codeHash: resolved.codeHash,
      runnerState: {
        clusterArn: hostState.clusterArn,
        serviceName: names.serviceName,
        taskDefinitionArn,
        taskFamily: names.taskFamily,
        repositoryName: resolved.repositoryName,
        repositoryUri: resolved.repositoryUri,
        logGroupName: names.logGroupName,
        taskRoleName: names.taskRoleName,
        executionRoleName: names.executionRoleName,
      },
    };
  });

const runnerCodeHash = (options: {
  readonly source: RunnerSource;
  readonly bootstrap: (importPath: string) => string;
}) =>
  Effect.gen(function* () {
    const imageSource = yield* makeImageSource;
    return yield* imageSource.hash({
      source: toBundledSource(options.source),
      platform: imagePlatform(options.source.cpuArchitecture),
      bootstrap: options.bootstrap,
    });
  });

const deleteRunner = ({ output }: { output: Record<string, any> }) =>
  Effect.gen(function* () {
    const state = output as {
      clusterArn?: string;
      serviceName?: string;
      taskDefinitionArn?: string;
      taskFamily?: string;
      repositoryName?: string;
      logGroupName?: string;
      taskRoleName?: string;
      executionRoleName?: string;
    };

    if (state.clusterArn !== undefined && state.serviceName !== undefined) {
      yield* ecs
        .updateService({
          cluster: state.clusterArn,
          service: state.serviceName,
          desiredCount: 0,
        })
        .pipe(
          Effect.retry({
            while: (error): boolean =>
              error._tag === "ServiceNotActiveException",
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
          }),
          Effect.catchTag(
            [
              "ServiceNotFoundException",
              "ClusterNotFoundException",
              "ServiceNotActiveException",
            ],
            () => Effect.void,
          ),
        );
      yield* ecs
        .deleteService({
          cluster: state.clusterArn,
          service: state.serviceName,
          force: true,
        })
        .pipe(
          Effect.catchTag(
            ["ServiceNotFoundException", "ClusterNotFoundException"],
            () => Effect.void,
          ),
        );
    }

    if (
      state.taskDefinitionArn !== undefined &&
      state.repositoryName !== undefined &&
      state.logGroupName !== undefined &&
      state.taskRoleName !== undefined &&
      state.executionRoleName !== undefined
    ) {
      yield* deleteTaskDefinitionInfrastructure({
        taskDefinitionArn: state.taskDefinitionArn,
        taskFamily: state.taskFamily,
        repositoryName: state.repositoryName,
        logGroupName: state.logGroupName,
        taskRoleName: state.taskRoleName,
        executionRoleName: state.executionRoleName,
      });
    }
  });

/**
 * The AWS ECS implementation of `Rivet.Host`: the Rivet **engine** runs as
 * an ECS Fargate service reachable inside its VPC through Cloud Map DNS,
 * and each `Rivet.Worker`'s **runner** runs as a second Fargate service in
 * the same cluster with no inbound ports.
 *
 * The slim topology keeps the standing cost to the Fargate tasks alone:
 *
 * - **Network** — a dedicated VPC with public subnets; tasks get a public
 *   IP for egress (image pull, CloudWatch logs) while the security group
 *   only admits the engine's own ports from inside the VPC. No NAT, no
 *   load balancer, no ingress — the Rivet gateway enforces no caller
 *   token, so the VPC is the caller boundary. Bring your own network via
 *   the Cluster's `vpc` prop.
 * - **Discovery** — a Cloud Map private DNS namespace; the engine URL is
 *   `http://engine.{namespace}:6420` (guard) with the api-peer service on
 *   `:6421`. Runners and clients reach it from inside the VPC.
 * - **Engine** — the pinned `rivetdev/engine` image on Fargate, configured
 *   entirely through `RIVET__*` environment variables. The default backend
 *   is the engine's built-in single-node RocksDB store on the task's
 *   **ephemeral** storage: state does not survive task replacement and
 *   `instances` must stay `1`. Set the Cluster's `postgresUrl` for durable,
 *   multi-node-capable storage.
 * - **Runner** — the worker's `main` bundled (rolldown, bun platform) with
 *   the generated runner entry, layered onto `oven/bun`, pushed to a
 *   managed ECR repository, and run as a Fargate service that opens an
 *   outbound WebSocket to the engine's guard service.
 *
 * ### Composing the host
 * **Example:** Stack providers
 * ```typescript
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 *
 * @layer
 * @provides Rivet.Host
 * @product Rivet
 */
export const Ecs = (): Layer.Layer<Host> =>
  Layer.succeed(Host, {
    compose: composeEcsCluster,
    deployRunner,
    runnerCodeHash,
    deleteRunner,
  } satisfies HostService);
