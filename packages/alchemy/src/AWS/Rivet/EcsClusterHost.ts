/**
 * The `aws-ecs` Rivet {@link ClusterHost}: the Rivet **engine** (the actor
 * orchestrator) runs as a single ECS Fargate service, reachable inside the
 * VPC through Cloud Map DNS.
 *
 * The slim topology keeps the standing cost to the Fargate task alone:
 *
 * - **Network** — a dedicated VPC with public subnets; the task gets a
 *   public IP for egress (image pull, CloudWatch logs) while the security
 *   group only admits the engine's own ports from inside the VPC. No NAT,
 *   no load balancer. Bring your own network via the host's `vpc` option.
 * - **Discovery** — a Cloud Map private DNS namespace; the engine URL is
 *   `http://engine.{namespace}:6420` (guard) with the api-peer service on
 *   `:6421`. Runners and clients reach it from inside the VPC.
 * - **Engine** — the pinned `rivetdev/engine` image on Fargate, configured
 *   entirely through `RIVET__*` environment variables (see the
 *   configuration note below).
 *
 * ### Storage
 *
 * The default backend is the engine's built-in single-node RocksDB store
 * (`RIVET__FILE_SYSTEM__PATH=/data`) on the task's **ephemeral** Fargate
 * storage. Two consequences, both deliberate for a v1:
 *
 * 1. **State does not survive task replacement.** Every redeploy, task
 *    restart, or Fargate host recycle starts from an empty store. Actor
 *    state is lost.
 * 2. **RocksDB is single-node**, so `instances` must stay `1`. ECS is
 *    configured to stop the old task before starting the new one, so two
 *    engines never run at once.
 *
 * Set the host's `postgresUrl` option to point at a managed PostgreSQL
 * (RDS, Aurora, Neon, …) for durable, multi-node-capable storage; that
 * emits `RIVET__POSTGRES__URL` instead and lifts the `instances` cap.
 *
 * ### Configuration: nested env, not a baked config file
 *
 * The engine loads config through the Rust `config` crate with
 * `Environment::with_prefix("RIVET").try_parsing(true).separator("__")`, and
 * its `Root` struct is explicitly designed to be fully env-addressable (the
 * `datacenters` map exists instead of a list *because* config-rs cannot
 * build arbitrary lists from the environment). So the whole topology is
 * expressed as nested env vars and no derived image is needed — the
 * upstream multi-arch image is mirrored verbatim.
 *
 * Two engine defaults must be overridden explicitly:
 *
 * - **Bind address.** Guard and api-peer default to `::`; on an IPv4-only
 *   awsvpc ENI we pin them to `0.0.0.0`.
 * - **Shutdown durations.** They default to 10 minutes, while Fargate's max
 *   container `stopTimeout` is 120s — the engine would be SIGKILLed
 *   mid-drain on every deploy. Guard drains for 100s, force-exit at 110s,
 *   inside a 120s `stopTimeout`. The engine validates
 *   `force >= max(guard, worker)`, so the two move together.
 */
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Random } from "../../Random.ts";
import {
  ClusterHost,
  type ClusterHostComposeOptions,
  type ClusterHostService,
} from "../../Rivet/ClusterHost.ts";
import { Stack } from "../../Stack.ts";
import * as CloudMap from "../CloudMap/index.ts";
import * as EC2 from "../EC2/index.ts";
import * as ECS from "../ECS/index.ts";

declare module "../../Rivet/ClusterHost.ts" {
  interface ClusterHostOptionsRegistry {
    "aws-ecs": {
      /**
       * Bring your own network: subnets the engine task (and VPC-attached
       * callers) run in, plus the security group(s) admitting engine
       * traffic on ports 6420/6421. When omitted a dedicated VPC is
       * composed.
       */
      vpc?: {
        vpcId: string;
        subnetIds: string[];
        securityGroupIds: string[];
      };
      /**
       * PostgreSQL connection URL for durable, multi-node-capable storage
       * (`RIVET__POSTGRES__URL`). When omitted the engine uses its built-in
       * single-node RocksDB store on the task's ephemeral disk, and
       * `instances` must stay `1`.
       */
      postgresUrl?: string;
      /**
       * Public origin clients use to reach this datacenter
       * (`topology.datacenters.default.public_url`). Defaults to the
       * VPC-internal Cloud Map URL — set this when the engine is fronted by
       * a load balancer or a public domain.
       */
      publicUrl?: string;
      /** Fargate task CPU units. @default 1024 */
      cpu?: number;
      /** Fargate task memory (MiB). @default 2048 */
      memory?: number;
    };
  }
}

/** Rivet engine version the host pins when the Cluster declares none. */
export const DEFAULT_RIVET_VERSION = "2.3.10";

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

const composeEcsCluster = ({ id, props }: ClusterHostComposeOptions) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const options = (props.host ?? {}) as {
      vpc?: { vpcId: string; subnetIds: string[]; securityGroupIds: string[] };
      postgresUrl?: string;
      publicUrl?: string;
      cpu?: number;
      memory?: number;
    };
    const image =
      props.image ??
      `rivetdev/engine:${props.rivetVersion ?? DEFAULT_RIVET_VERSION}`;
    const instances = props.instances ?? 1;

    if (options.postgresUrl === undefined && instances > 1) {
      return yield* Effect.die(
        new Error(
          `Rivet cluster '${id}' requests ${instances} engine nodes, but the ` +
            "default RocksDB storage backend is single-node. Set the host's " +
            "`postgresUrl` option to run more than one engine node.",
        ),
      );
    }

    const secret = yield* Random("AdminToken", { bytes: 32 });

    let vpcId: Input<string>;
    let subnetIds: Input<string[]>;
    let securityGroupIds: Input<string[]>;
    if (options.vpc !== undefined) {
      vpcId = options.vpc.vpcId;
      subnetIds = options.vpc.subnetIds;
      securityGroupIds = options.vpc.securityGroupIds;
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
      [`${dc}__PUBLIC_URL`]: options.publicUrl ?? endpoint,
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
      cpu: options.cpu ?? 1024,
      memory: options.memory ?? 2048,
      runtimePlatform: {
        cpuArchitecture: process.arch === "arm64" ? "ARM64" : "X86_64",
        operatingSystemFamily: "LINUX",
      },
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
        ...(options.postgresUrl !== undefined
          ? { RIVET__POSTGRES__URL: options.postgresUrl }
          : { RIVET__FILE_SYSTEM__PATH: FILE_SYSTEM_PATH }),
      },
      container: {
        // Give the engine its full 110s force-shutdown budget before ECS
        // escalates to SIGKILL.
        stopTimeout: STOP_TIMEOUT_SECONDS,
      },
      deploymentConfiguration:
        options.postgresUrl === undefined
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
      vpc: { subnetIds, securityGroupIds },
      hostState: {
        subnetIds,
        securityGroupIds,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
      },
    };
  }).pipe(Namespace.push(id));

/**
 * The `aws-ecs` {@link ClusterHost} layer. Registered by `AWS.providers()`;
 * compose a stack with `Layer.mergeAll(AWS.providers(), Rivet.providers())`
 * and the host resolves automatically.
 */
export const EcsClusterHost = (): Layer.Layer<ClusterHost<"aws-ecs">> =>
  Layer.effect(
    ClusterHost("aws-ecs"),
    Effect.gen(function* () {
      // Captured at layer build (inside `AWS.providers()`'s composition) so
      // `restartNodes` works from the host-agnostic Rivet provider context,
      // which carries no AWS services.
      const updateService = yield* ecs.updateService;

      return {
        kind: "Rivet.ClusterHost" as const,

        compose: composeEcsCluster,

        callerBinding: ({ target }) =>
          Effect.succeed({
            vpc: {
              subnetIds: target.hostState.pipe(
                Output.map((state: any) => state?.subnetIds ?? []),
              ),
              securityGroupIds: target.hostState.pipe(
                Output.map((state: any) => state?.securityGroupIds ?? []),
              ),
            },
          }),

        restartNodes: ({ news }) =>
          Effect.gen(function* () {
            const state = news.hostState as
              | { clusterArn?: string; serviceName?: string }
              | undefined;
            if (
              state?.clusterArn === undefined ||
              state.serviceName === undefined
            ) {
              return;
            }
            // Roll the engine so it reloads its configuration at startup.
            yield* updateService({
              cluster: state.clusterArn,
              service: state.serviceName,
              forceNewDeployment: true,
            });
          }),
      } satisfies ClusterHostService;
    }),
  ) as Layer.Layer<ClusterHost<"aws-ecs">>;
