import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { HostRuntimeContext, ServerHost } from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Credentials } from "../Credentials.ts";
import {
  SecurityGroup,
  type SecurityGroupId,
  type SecurityGroupRuleData,
} from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { VpcId } from "../EC2/Vpc.ts";
import type { ListenerAction, ListenerRuleCondition } from "../ELBv2/common.ts";
import { Listener } from "../ELBv2/Listener.ts";
import { ListenerRule } from "../ELBv2/ListenerRule.ts";
import { LoadBalancer } from "../ELBv2/LoadBalancer.ts";
import { TargetGroup, type TargetGroupArn } from "../ELBv2/TargetGroup.ts";
import {
  computeStaticSourceHash,
  makeBunBootstrap,
  makeImageSource,
  type BundledImageSource,
  type DockerfileImageSource,
  type ImageSourceLike,
  type RegistryImageSource,
} from "../ECR/ImageSource.ts";
import type { AWSEnvironment, AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { Providers } from "../Providers.ts";
import type { ClusterArn } from "./Cluster.ts";
import {
  attachTaskBindings,
  createContainerRuntimeContext,
  createTaskRoleIfNotExists,
  deleteTaskDefinitionInfrastructure,
  ensureTaskExecutionRole,
  ensureTaskLogGroup,
  registerTaskDefinitionRevision,
  syncTaskDefinitionTags,
  taskImagePlatform,
  type TaskBindingContract,
  type TaskDefinitionConfig,
} from "./Task.ts";

export type ServiceName = string;
export type ServiceArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:service/${string}/${ServiceName}`;

export const isService = (value: any): value is Service => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.ECS.Service"
  );
};

// ───────────────────────────────────────────────────────────────────────────
// Managed load balancer (owned + shared) — types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Listener protocols supported by managed service ingress. Phase 1 covers the
 * ALB protocols; NLB protocols (`tcp` / `udp` / `tls`) slot into this union in
 * a later phase.
 */
export type ServiceListenerProtocol = "http" | "https";

/** A `"80/http"`-style port/protocol spec. */
export type ServiceListenSpec = `${number}/${ServiceListenerProtocol}`;

/**
 * A routing rule for the service's managed load balancer. Conditions are FLAT
 * on the rule (no `conditions: {}` wrapper) and are AND-ed together; a rule
 * with no conditions matches every request (`path: "/*"` on a shared
 * listener, or becomes the owned listener's default action).
 */
export interface ServiceLoadBalancerRule {
  /**
   * Where the rule listens. A `"80/http"`-style string means the service OWNS
   * the listener (and its ALB); an `ELBv2.Listener` reference means the rule
   * attaches to that existing (shared) listener. Omitting it falls back to
   * the config-level `listener` (shared) or the service's default owned
   * listener. Mixing owned strings and shared references within one service
   * is a typed error ({@link MixedListenerOwnership}).
   */
  listen?: ServiceListenSpec | Listener;
  /**
   * Forward matched requests to the container at this port/protocol. A target
   * group is created per distinct `forward` + `container` pair.
   * @default the main container's port
   */
  forward?: ServiceListenSpec;
  /**
   * Redirect matched requests (HTTP 301) to this port/protocol. Mutually
   * exclusive with {@link forward}.
   */
  redirect?: ServiceListenSpec;
  /**
   * Name of the container receiving traffic — the main container by default,
   * or a sidecar's container name.
   */
  container?: string;
  /** Match on the request path (`*` and `?` wildcards). */
  path?: string | string[];
  /** Match on the `Host` header (`*` and `?` wildcards). */
  host?: string | string[];
  /** Match on a named HTTP header. */
  header?: { name: string; values: string[] };
  /** Match on query-string key/value pairs. */
  query?: { key?: string; value: string }[];
  /**
   * The rule's evaluation priority (1–50000, lower first). When omitted, a
   * deterministic priority is derived by hashing the rule's namespaced
   * logical id — stable across deploys and distinct across services. On a
   * live collision the deploy fails with a typed
   * `ListenerRulePriorityInUse` error naming the priority; set an explicit
   * `priority` to resolve it (the engine never probes for free slots).
   */
  priority?: number;
}

/** Object form of the {@link ServicePropsBase.loadBalancer} prop. */
export interface ServiceLoadBalancerConfig {
  /**
   * Default (shared) listener for rules that omit `listen`. Referencing an
   * `ELBv2.Listener` means the service only creates target groups and
   * listener rules — the ALB and listener belong to whoever composed them.
   */
  listener?: Listener;
  /** Routing rules. Defaults to a single catch-all (`path: "/*"`) rule when a `listener` is referenced. */
  rules?: ServiceLoadBalancerRule[];
  /**
   * Owned-only: whether the composed ALB is internet-facing (`true`, the
   * default) or internal (`false`). A typed error on shared listeners.
   */
  public?: boolean;
  // Phase 2 slots: `domain` (Route53 + ACM) and `health` (per-target-group
  // health checks) land here without disturbing this shape.
}

/**
 * @internal Resolved managed-ingress wiring computed by the Service factory's
 * composition step — never set by hand. Carries the composed (or shared)
 * ELBv2 child-resource outputs into the core service provider.
 */
export interface ServiceManagedIngress {
  /** Whether the service owns its ALB or shares a foreign listener. */
  kind: "owned" | "shared";
  /** ARN of the (owned or shared) load balancer, for URL derivation. */
  loadBalancerArn?: string;
  /** ARN of the primary listener. */
  listenerArn?: string;
  /** Port of the primary listener. */
  listenerPort?: number;
  /** Protocol of the primary listener (`HTTP` / `HTTPS`). */
  listenerProtocol?: string;
  /** Id of the composed managed security group, when no `securityGroups` were supplied. */
  securityGroupId?: string;
  /** Target groups to wire into the ECS service definition. */
  targets: {
    /** ARN of the composed target group. */
    targetGroupArn: string;
    /** Container port receiving traffic. Defaults to the main container's port. */
    containerPort?: number;
    /** Container name receiving traffic. Defaults to the main container. */
    container?: string;
  }[];
}

/** Owned `"80/http"` listen strings mixed with shared `ELBv2.Listener` references in one service. */
export class MixedListenerOwnership extends Data.TaggedError(
  "MixedListenerOwnership",
)<{
  readonly serviceId: string;
  readonly message: string;
}> {}

/** A rule declared both `forward` and `redirect` (mutually exclusive). */
export class ServiceRuleActionConflict extends Data.TaggedError(
  "ServiceRuleActionConflict",
)<{
  readonly serviceId: string;
  readonly ruleIndex: number;
  readonly message: string;
}> {}

/** A `listen`/`forward`/`redirect` spec used a protocol outside the supported set. */
export class UnsupportedListenerProtocol extends Data.TaggedError(
  "UnsupportedListenerProtocol",
)<{
  readonly serviceId: string;
  readonly spec: string;
  readonly message: string;
}> {}

/** An owned `https` listener was requested without a `certificateArn`. */
export class MissingListenerCertificate extends Data.TaggedError(
  "MissingListenerCertificate",
)<{
  readonly serviceId: string;
  readonly spec: string;
  readonly message: string;
}> {}

/** An owned-only option (e.g. `public`) was set while sharing a foreign listener. */
export class OwnedOnlyLoadBalancerOption extends Data.TaggedError(
  "OwnedOnlyLoadBalancerOption",
)<{
  readonly serviceId: string;
  readonly option: string;
  readonly message: string;
}> {}

/** A rule has neither its own `listen` nor a config-level default `listener`. */
export class MissingRuleListener extends Data.TaggedError(
  "MissingRuleListener",
)<{
  readonly serviceId: string;
  readonly ruleIndex: number;
  readonly message: string;
}> {}

/**
 * Derive a deterministic listener-rule priority (1–50000) from the rule's
 * namespaced logical id (FNV-1a 32-bit). Stable across deploys for the same
 * id and distinct for distinct ids; on a live `PriorityInUse` collision the
 * deploy fails with a typed error rather than probing for a free slot.
 */
export const deriveRulePriority = (namespacedLogicalId: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < namespacedLogicalId.length; i++) {
    hash ^= namespacedLogicalId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 50000) + 1;
};

export interface ServicePropsBase extends PlatformProps {
  /**
   * ECS cluster that will own the service.
   */
  cluster: ClusterArn | { clusterArn: ClusterArn };

  /**
   * Name of the ECS service.
   * If omitted, a unique name will be generated.
   *
   * Changing this replaces the service (delete-first).
   */
  serviceName?: string;

  /**
   * Desired number of running tasks. Updated in place.
   * @default 1
   */
  desiredCount?: number;

  /**
   * VPC that hosts the service networking and optional public ingress.
   * When omitted (together with {@link subnets}), the account's default VPC
   * is used.
   */
  vpcId?: string;

  /**
   * Subnets used by the service's awsvpc network configuration. Updated in
   * place via `updateService`. When omitted (together with {@link vpcId}),
   * the default VPC's per-AZ default subnets are used.
   */
  subnets?: string[];

  /**
   * Security groups attached to the service ENIs and any Alchemy-managed
   * load balancer. When omitted and {@link loadBalancer} is set, Alchemy
   * provisions (and owns) a security group that admits the listener port
   * from anywhere and the container port from within the group.
   */
  securityGroups?: string[];

  /**
   * Whether the service ENIs should receive public IPs.
   * @default false — but `true` when networking defaulted to the default
   * VPC (public subnets need a public IP to pull images without a NAT).
   */
  assignPublicIp?: boolean;

  /**
   * Launch type for the service. Mutually exclusive with
   * {@link capacityProviderStrategy}. Switching between launch type and
   * capacity-provider strategy replaces the service.
   * @default "FARGATE"
   */
  launchType?: ecs.LaunchType;

  /**
   * Capacity provider strategy for the service (e.g. `FARGATE`/`FARGATE_SPOT`
   * weights, or a custom ASG-backed provider). Mutually exclusive with
   * {@link launchType}. Switching to/from a launch type replaces the service;
   * weight/base changes apply in place.
   */
  capacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];

  /**
   * Load balancer target groups to wire to the service. **User-supplied** —
   * Alchemy does NOT create these. Each entry references an existing ELBv2
   * target group (or CLB) plus the container/port that receives traffic.
   * Updated in place for rolling deployments.
   *
   * For an Alchemy-managed public ALB instead, set {@link loadBalancer} to
   * `true`.
   */
  loadBalancers?: ecs.LoadBalancer[];

  /**
   * Cloud Map service registries (service discovery) to associate with the
   * service.
   */
  serviceRegistries?: ecs.ServiceRegistry[];

  /**
   * Managed load balancing for the service, composed as REAL
   * `AWS.ELBv2.LoadBalancer` / `Listener` / `TargetGroup` / `ListenerRule`
   * child resources under the service's namespace:
   *
   * - `true` — the service OWNS a public ALB with a single HTTP listener
   *   forwarding to the container port. The `url` attribute is populated
   *   from the ALB's DNS name.
   * - an `ELBv2.Listener` reference — the listener (and its ALB) are SHARED:
   *   the service only creates a target group and a catch-all
   *   (`path: "/*"`) listener rule on that listener. Destroying the service
   *   removes its rules and target groups; the shared listener/ALB are never
   *   touched.
   * - an object — `listener` (default shared listener) + `rules` (path/host/
   *   header/query routing, `forward`/`redirect` actions) + `public`
   *   (owned-only; `false` composes an internal ALB). Rules with
   *   `"80/http"`-style `listen` strings make the service own the ALB and
   *   those listeners; `ELBv2.Listener` references share existing ones.
   *   Mixing both in one service is a typed error.
   *
   * Migration note: services deployed before composed ingress recorded their
   * inline-created ALB/TG/listener/security group in the service's own
   * attributes. The first deploy under the composed shape performs a
   * breaking redeploy — new composed resources are created and the legacy
   * inline infrastructure is reaped (deleted) so nothing is stranded.
   * @default false
   */
  loadBalancer?: boolean | Listener | ServiceLoadBalancerConfig;

  /**
   * Legacy alias for {@link loadBalancer}.
   * @deprecated use `loadBalancer: true`
   */
  public?: boolean;

  /**
   * @internal Resolved managed-ingress wiring computed by the Service
   * factory's composition step. Never set by hand.
   */
  ingress?: ServiceManagedIngress;

  /**
   * Listener port for generated public ingress.
   * @default 80 when `certificateArn` is omitted, otherwise 443
   */
  listenerPort?: number;

  /**
   * ACM certificate ARN for HTTPS public ingress.
   * When provided, the generated listener uses HTTPS.
   */
  certificateArn?: string;

  /**
   * Target group health check path for public HTTP services.
   * @default "/"
   */
  healthCheckPath?: string;

  /**
   * Fargate platform version for the service. Updated in place.
   */
  platformVersion?: string;

  /**
   * Raw ECS deployment configuration (rolling update percentages, circuit
   * breaker, deployment strategy, alarms). Updated in place.
   */
  deploymentConfiguration?: ecs.DeploymentConfiguration;

  /**
   * Deployment controller (`ECS`, `CODE_DEPLOY`, `EXTERNAL`). The controller
   * type is immutable — changing it replaces the service.
   */
  deploymentController?: ecs.DeploymentController;

  /**
   * Placement constraints (`distinctInstance` / `memberOf`). Updated in place.
   */
  placementConstraints?: ecs.PlacementConstraint[];

  /**
   * Placement strategy (`random` / `spread` / `binpack`). Updated in place.
   */
  placementStrategy?: ecs.PlacementStrategy[];

  /**
   * Scheduling strategy. `REPLICA` runs and maintains `desiredCount` copies;
   * `DAEMON` runs one task per eligible instance. Immutable — changing it
   * replaces the service.
   * @default "REPLICA"
   */
  schedulingStrategy?: ecs.SchedulingStrategy;

  /**
   * Whether to enable ECS Exec on the service tasks. Updated in place.
   * @default false
   */
  enableExecuteCommand?: boolean;

  /**
   * Whether to enable ECS managed tags. Immutable post-create.
   * @default true
   */
  enableECSManagedTags?: boolean;

  /**
   * How to propagate tags to tasks (`TASK_DEFINITION`, `SERVICE`, `NONE`).
   * Updated in place.
   */
  propagateTags?: ecs.PropagateTags;

  /**
   * Availability zone rebalancing behavior. Updated in place.
   */
  availabilityZoneRebalancing?: ecs.AvailabilityZoneRebalancing;

  /**
   * ECS Service Connect configuration. Updated in place.
   */
  serviceConnectConfiguration?: ecs.ServiceConnectConfiguration;

  /**
   * Service-managed volume configurations. Updated in place.
   */
  volumeConfigurations?: ecs.ServiceVolumeConfiguration[];

  /**
   * IAM role for the ELB integration (only for non-awsvpc / CLB services).
   * Immutable — changing it replaces the service.
   */
  role?: string;

  /**
   * Grace period before ECS starts evaluating target health checks, e.g.
   * `"30 seconds"` or `Duration.seconds(30)`. Rounded to whole seconds on
   * the wire. Updated in place.
   */
  healthCheckGracePeriod?: Duration.Input;

  /**
   * User-defined tags to apply to the ECS service and generated ingress
   * resources. Reconciled in place against observed service tags.
   */
  tags?: Record<string, string>;
}

/**
 * Deploy an existing `AWS.ECS.Task`'s definition as a service (shared
 * image/roles/config; the Service adds `desiredCount` / load balancing /
 * deployment configuration).
 */
export interface TaskReferenceServiceProps extends ServicePropsBase {
  /**
   * Bundled ECS task to run for each service replica: the runtime-facing
   * subset of `AWS.ECS.Task` attributes the service needs to deploy and
   * wire load balancer traffic (a full `Task` satisfies it structurally).
   */
  task: {
    /**
     * Registered task definition ARN to deploy.
     */
    taskDefinitionArn: string;
    /**
     * Container name inside the task definition that should receive traffic.
     */
    containerName: string;
    /**
     * Container port that the service should expose and forward traffic to.
     */
    port: number;
  };
}

/**
 * Image-owning base: the Service synthesizes its own task definition
 * (roles, log group, ECR repository, image) from the shared
 * {@link TaskDefinitionConfig} surface.
 */
export interface ImageOwningServicePropsBase
  extends ServicePropsBase, Omit<TaskDefinitionConfig, "placementConstraints"> {
  /**
   * Task definition placement constraints (`memberOf` expressions) for the
   * synthesized task definition. (`placementConstraints` on the service
   * itself remains the service-level ECS placement constraint list.)
   */
  taskPlacementConstraints?: ecs.TaskDefinitionPlacementConstraint[];
}

/** Bundle an inline Effect program (`main`) into the service's image. */
export interface BundledServiceProps
  extends ImageOwningServicePropsBase, BundledImageSource {}
/** Build the user's own Dockerfile into the service's image. */
export interface DockerfileServiceProps
  extends ImageOwningServicePropsBase, DockerfileImageSource {}
/** Run a pre-built registry image, mirrored into ECR. */
export interface ImageServiceProps
  extends ImageOwningServicePropsBase, RegistryImageSource {}

/**
 * Service props — either reference an existing task definition (`task:`) or
 * own the image via exactly one of `main` / `context` / `image` (the
 * Service then synthesizes its own task definition).
 */
export type ServiceProps =
  | TaskReferenceServiceProps
  | BundledServiceProps
  | DockerfileServiceProps
  | ImageServiceProps;

export interface Service extends Resource<
  "AWS.ECS.Service",
  ServiceProps,
  {
    /**
     * ARN of the ECS service.
     */
    serviceArn: ServiceArn;

    /**
     * Name of the ECS service.
     */
    serviceName: ServiceName;

    /**
     * ARN of the cluster that owns the service.
     */
    clusterArn: ClusterArn;

    /**
     * Task definition revision currently deployed by the service.
     */
    taskDefinitionArn: string;

    /**
     * ECS service status such as `ACTIVE` or `DRAINING`.
     */
    status: string;

    /**
     * URL of the service through its managed ingress. Owned load balancers
     * use the composed ALB's DNS name; shared listeners derive it from the
     * foreign listener's ALB DNS + protocol/port (best-effort — undefined
     * when not derivable).
     */
    url?: string;

    /**
     * ARN of the load balancer serving the service's managed ingress (the
     * composed ALB when owned; the shared listener's ALB otherwise).
     */
    loadBalancerArn?: string;

    /**
     * ARN of the first managed target group, when `loadBalancer` is set.
     */
    targetGroupArn?: string;

    /**
     * ARN of the primary listener, when `loadBalancer` is set.
     */
    listenerArn?: string;

    /**
     * Id of the Alchemy-managed security group composed for managed ingress
     * (only when `loadBalancer` is set and no `securityGroups` supplied).
     */
    securityGroupId?: string;

    /**
     * @internal Marks attrs written by the composed-ingress shape ("owned" |
     * "shared"). Absent on legacy state rows whose ALB/TG/listener were
     * created inline by the provider — the marker gates the migration reap
     * and the legacy delete path.
     */
    ingressKind?: "owned" | "shared";

    /** Family of the synthesized task definition (image-owning form only). */
    taskFamily?: string;
    /** Name of the primary container (image-owning form only). */
    containerName?: string;
    /** Container port receiving traffic (image-owning form only). */
    port?: number;
    /** Image URI the synthesized task definition runs. */
    imageUri?: string;
    /** ECR repository name holding the service's image. */
    repositoryName?: string;
    /** ECR repository URI holding the service's image. */
    repositoryUri?: string;
    /** ARN of the synthesized task role. */
    taskRoleArn?: string;
    /** Name of the synthesized task role. */
    taskRoleName?: string;
    /** ARN of the synthesized execution role. */
    executionRoleArn?: string;
    /** Name of the synthesized execution role. */
    executionRoleName?: string;
    /** CloudWatch log group of the synthesized task definition. */
    logGroupName?: string;
    /** ARN of the CloudWatch log group. */
    logGroupArn?: string;
    /** Content hash of the service's container image. */
    code?: {
      /** Content hash of the service's container image. */
      hash: string;
    };
  },
  TaskBindingContract,
  Providers
> {}

export type ServiceServices =
  | Credentials
  | Region
  | ServerHost
  | AWSEnvironment;

/**
 * The impl shape for an effectful `Service`: a long-running server returning
 * `{ fetch }` (plus optional RPC methods).
 */
export type ServiceShape = Main<ServiceServices>;

export interface ServiceRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.ECS.Service";
}

/**
 * An ECS service: N copies of a container kept alive, optionally behind a
 * load balancer.
 *
 * The service's image comes from one of four sources:
 *
 * - `image` — run a pre-built registry image, mirrored into ECR.
 * - `context` — build your own Dockerfile.
 * - `main` — bundle an inline Effect program (servers return `{ fetch }`).
 * - `task:` — deploy an existing `AWS.ECS.Task`'s definition; the Service
 *   adds `desiredCount` / load balancing / deployment configuration.
 *
 * With any of the first three the Service synthesizes its own task
 * definition (task + execution roles, log group, ECR repository).
 * `loadBalancer: true` wires a public ALB + target group + listener and
 * populates the `url` attribute. When `vpcId`/`subnets` are omitted the
 * account's default VPC (and its per-AZ subnets) is used.
 *
 * Most configuration is updated **in place** via `updateService`
 * (desiredCount, task definition, network, deployment config, placement,
 * exec, load balancers, tags). Only truly-immutable aspects — `serviceName`,
 * `cluster`, launchType↔capacityProviderStrategy switch, `deploymentController`
 * type, `schedulingStrategy`, `enableECSManagedTags`, `role` — replace the
 * service.
 * @resource
 * @section Creating Services
 * @example Remote Image Behind a Load Balancer
 * ```typescript
 * const nginx = yield* Service("Edge", {
 *   cluster,
 *   image: "public.ecr.aws/nginx/nginx:1.27",
 *   port: 80,
 *   desiredCount: 2,
 *   loadBalancer: true,   // ALB + target group + listener wiring
 * });
 * nginx.url; // http://<alb-dns-name>
 * ```
 *
 * @example Run an Existing Task's Definition
 * ```typescript
 * const api = yield* Service("Api", {
 *   cluster,
 *   task: apiTask,        // shared image/roles/config; Service adds
 *   desiredCount: 2,      // desiredCount / LB / deployment config
 *   loadBalancer: true,
 * });
 * ```
 *
 * @example Inline Effect Server
 * ```typescript
 * const api = yield* Service(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000, desiredCount: 2, cpu: 256, memory: 512 },
 *   Effect.gen(function* () {
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
 * );
 * ```
 *
 * @section Shared Load Balancers
 * @example Two Services Sharing One Listener
 * ```typescript
 * // The ALB + listener are stack-level resources owned by neither service.
 * const lb = yield* AWS.ELBv2.LoadBalancer("Alb", {
 *   subnets: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroups: [sg.groupId],
 * });
 * const listener = yield* AWS.ELBv2.Listener("Http", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   port: 80,
 *   defaultActions: [
 *     { type: "fixedResponse", statusCode: "404", messageBody: "no route" },
 *   ],
 * });
 *
 * // Each service composes only its own TargetGroup + ListenerRule on the
 * // shared listener. Destroying one service removes its rule + target
 * // group; the ALB, listener, and the other service are untouched.
 * const api = yield* Service("Api", {
 *   cluster,
 *   image: "my-org/api:latest",
 *   port: 3000,
 *   loadBalancer: { listener, rules: [{ path: "/api/*" }] },
 * });
 * const web = yield* Service("Web", {
 *   cluster,
 *   image: "my-org/web:latest",
 *   port: 8080,
 *   loadBalancer: { listener, rules: [{ path: "/*" }] },
 * });
 * ```
 *
 * @example Catch-All on a Shared Listener
 * ```typescript
 * // A bare listener reference adds a single `path: "/*"` rule.
 * const svc = yield* Service("Svc", {
 *   cluster,
 *   image: "my-org/web:latest",
 *   port: 8080,
 *   loadBalancer: listener,
 * });
 * ```
 *
 * @example Owned ALB with Routing Rules and an HTTP → HTTPS Redirect
 * ```typescript
 * // `"80/http"`-style `listen` strings mean the service OWNS the ALB and
 * // these listeners (mixing them with shared listener references is a
 * // typed error).
 * const svc = yield* Service("Svc", {
 *   cluster,
 *   image: "my-org/web:latest",
 *   port: 8080,
 *   certificateArn,
 *   loadBalancer: {
 *     rules: [
 *       { listen: "80/http", redirect: "443/https" },
 *       { listen: "443/https", forward: "8080/http" },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Load Balancing
 * @example Manual (User-Supplied) Target Group
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [subnet1.subnetId, subnet2.subnetId],
 *   loadBalancers: [
 *     {
 *       targetGroupArn,
 *       containerName: apiTask.containerName,
 *       containerPort: apiTask.port,
 *     },
 *   ],
 * });
 * ```
 *
 * @section Capacity & Placement
 * @example FARGATE_SPOT Capacity Provider Strategy
 * ```typescript
 * const service = yield* Service("WorkerService", {
 *   cluster,
 *   task: workerTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [subnet.subnetId],
 *   capacityProviderStrategy: [
 *     { capacityProvider: "FARGATE_SPOT", weight: 4 },
 *     { capacityProvider: "FARGATE", weight: 1, base: 1 },
 *   ],
 *   placementStrategy: [{ type: "spread", field: "attribute:ecs.availability-zone" }],
 * });
 * ```
 *
 * @section Deployment
 * @example Rolling Update with Circuit Breaker
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [subnet1.subnetId, subnet2.subnetId],
 *   desiredCount: 3,
 *   enableExecuteCommand: true,
 *   deploymentConfiguration: {
 *     minimumHealthyPercent: 100,
 *     maximumPercent: 200,
 *     deploymentCircuitBreaker: { enable: true, rollback: true },
 *   },
 *   healthCheckGracePeriod: "30 seconds",
 * });
 * ```
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("AWS.ECS.Service", {
  createRuntimeContext: createContainerRuntimeContext("AWS.ECS.Service") as (
    id: string,
  ) => ServiceRuntimeContext,
  // Compose the managed load balancer (owned ALB/listeners or shared-listener
  // rules + target groups) as REAL namespaced child resources before the core
  // service resource is declared.
  transformProps: (id, props) => transformServiceProps(id, props),
});

/** The BYO task reference, when the props use the `task:` form. */
const taskRefOf = (props: ServiceProps | undefined) =>
  props !== undefined && "task" in props ? props.task : undefined;

// ───────────────────────────────────────────────────────────────────────────
// Managed load balancer — composition (the StaticSite pattern)
// ───────────────────────────────────────────────────────────────────────────

const isELBv2Listener = (value: unknown): value is Listener =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as { Type?: unknown }).Type === "AWS.ELBv2.Listener";

interface ParsedListen {
  port: number;
  protocol: ServiceListenerProtocol;
}

const parseListenSpec = (serviceId: string, spec: string, kind: string) =>
  Effect.gen(function* () {
    const [portString, protocol] = spec.split("/");
    const port = Number(portString);
    if (
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      (protocol !== "http" && protocol !== "https")
    ) {
      return yield* Effect.fail(
        new UnsupportedListenerProtocol({
          serviceId,
          spec,
          message: `AWS.ECS.Service "${serviceId}": unsupported ${kind} spec '${spec}' — expected "<port>/http" or "<port>/https" (NLB protocols tcp/udp/tls arrive in a later phase)`,
        }),
      );
    }
    return { port, protocol } as ParsedListen;
  });

/**
 * Resolve the account's default VPC and its per-AZ default subnets. Shared by
 * the composition step (target group / security group VPC, owned ALB subnets)
 * and the provider's network resolution.
 */
const lookupDefaultNetwork = Effect.gen(function* () {
  const vpcs = yield* ec2.describeVpcs({
    Filters: [{ Name: "isDefault", Values: ["true"] }],
  });
  const vpc = (vpcs.Vpcs ?? []).find((v) => v.IsDefault);
  if (!vpc?.VpcId) {
    return yield* Effect.die(
      new Error(
        "AWS.ECS.Service: no default VPC in this account/region — pass `vpcId` and `subnets` explicitly",
      ),
    );
  }
  const subnets = yield* ec2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.VpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((s): s is string => s !== undefined);
  if (subnetIds.length === 0) {
    return yield* Effect.die(
      new Error(
        "AWS.ECS.Service: the default VPC has no default subnets — pass `subnets` explicitly",
      ),
    );
  }
  return { vpcId: vpc.VpcId, subnets: subnetIds };
});

const toValuesArray = (value: string | string[] | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** Flat rule conditions → the `ELBv2.ListenerRule` condition shape. */
const ruleConditionsOf = (
  rule: ServiceLoadBalancerRule,
): ListenerRuleCondition[] => {
  const conditions: ListenerRuleCondition[] = [];
  const path = toValuesArray(rule.path);
  if (path) conditions.push({ pathPattern: { values: path } });
  const host = toValuesArray(rule.host);
  if (host) conditions.push({ hostHeader: { values: host } });
  if (rule.header) {
    conditions.push({
      httpHeader: { name: rule.header.name, values: rule.header.values },
    });
  }
  if (rule.query) conditions.push({ queryString: { values: rule.query } });
  return conditions;
};

/**
 * Ingress rules for the managed security group. `dynamicPort` is the main
 * container's port when it is only known as an Output (the `task:` form) —
 * the rule list is then computed at resolve time so ports can be deduped.
 */
const managedSgIngress = (
  staticPorts: number[],
  dynamicPort: number | unknown | undefined,
): SecurityGroupRuleData[] => {
  const rulesOf = (ports: number[]): SecurityGroupRuleData[] =>
    [...new Set(ports)].map((port) => ({
      ipProtocol: "tcp",
      fromPort: port,
      toPort: port,
      cidrIpv4: "0.0.0.0/0",
      description: "Alchemy-managed ECS service ingress",
    }));
  if (dynamicPort === undefined) {
    return rulesOf(staticPorts);
  }
  if (typeof dynamicPort === "number") {
    return rulesOf([...staticPorts, dynamicPort]);
  }
  return Output.map(dynamicPort as Output.Output<number>, (port) =>
    rulesOf([...staticPorts, port]),
  ) as unknown as SecurityGroupRuleData[];
};

/**
 * The `transformProps` hook: when managed load balancing is requested,
 * compose the ELBv2 (and security group) child resources under the service's
 * namespace and rewrite the props to reference their outputs via the
 * internal `ingress` prop. A no-op at runtime and when no `loadBalancer` is
 * requested.
 */
const transformServiceProps = (
  id: string,
  props: ServiceProps,
): Effect.Effect<ServiceProps, unknown, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const lbProp =
      props.loadBalancer !== undefined
        ? props.loadBalancer
        : ((props.public ?? false) as boolean);
    if (lbProp === false || lbProp === undefined) {
      return props;
    }
    return yield* composeManagedIngress(id, props, lbProp).pipe(
      Namespace.push(id),
    );
  });

const composeManagedIngress = (
  id: string,
  props: ServiceProps,
  lbProp: true | Listener | ServiceLoadBalancerConfig,
) =>
  Effect.gen(function* () {
    const config: ServiceLoadBalancerConfig =
      lbProp === true
        ? {}
        : isELBv2Listener(lbProp)
          ? { listener: lbProp }
          : lbProp;
    const rules = config.rules ?? (config.listener !== undefined ? [{}] : []);

    // ── classify ownership ───────────────────────────────────────────────
    const hasSharedRefs =
      config.listener !== undefined ||
      rules.some((rule) => isELBv2Listener(rule.listen));
    const hasOwnedStrings = rules.some(
      (rule) => typeof rule.listen === "string",
    );
    if (hasSharedRefs && hasOwnedStrings) {
      return yield* Effect.fail(
        new MixedListenerOwnership({
          serviceId: id,
          message: `AWS.ECS.Service "${id}": rules mix owned "<port>/<protocol>" listen strings with shared ELBv2.Listener references — a service either owns its ALB (strings only) or attaches rules to shared listeners (references only)`,
        }),
      );
    }
    const owned = !hasSharedRefs;
    if (!owned && config.public !== undefined) {
      return yield* Effect.fail(
        new OwnedOnlyLoadBalancerOption({
          serviceId: id,
          option: "public",
          message: `AWS.ECS.Service "${id}": \`public\` only applies to an owned load balancer — the shared listener's ALB controls its own scheme`,
        }),
      );
    }
    // `true`, a bare `{}`, or an owned config with zero rules: single default
    // listener forwarding to the container port.
    const trueLike = owned && rules.length === 0;

    // ── normalize rules + target-group specs ────────────────────────────
    const byoTask = taskRefOf(props);
    const defaultContainerPort: unknown =
      byoTask !== undefined
        ? byoTask.port
        : ((props as { port?: number }).port ?? 3000);

    interface TgSpec {
      key: string;
      logicalId: string;
      port: unknown;
      protocol: "HTTP" | "HTTPS";
      container: string | undefined;
      forwardPort: number | undefined;
    }
    const tgSpecs = new Map<string, TgSpec>();
    const ensureTgSpec = (
      forward: ParsedListen | undefined,
      container: string | undefined,
    ): string => {
      const key = `${forward ? `${forward.port}/${forward.protocol}` : "default"}|${container ?? ""}`;
      if (!tgSpecs.has(key)) {
        tgSpecs.set(key, {
          key,
          logicalId: [
            "TargetGroup",
            forward ? `${forward.port}-${forward.protocol}` : undefined,
            container,
          ]
            .filter((part): part is string => part !== undefined)
            .join("-"),
          port: forward?.port ?? defaultContainerPort,
          protocol: forward
            ? (forward.protocol.toUpperCase() as "HTTP" | "HTTPS")
            : "HTTP",
          container,
          forwardPort: forward?.port,
        });
      }
      return key;
    };

    type NormalizedAction =
      | { type: "forward"; tgKey: string }
      | { type: "redirect"; port: number; protocol: ServiceListenerProtocol };
    interface NormalizedRule {
      index: number;
      rule: ServiceLoadBalancerRule;
      /** Parsed owned listen spec, shared listener ref, or undefined (default). */
      listen: ParsedListen | Listener | undefined;
      action: NormalizedAction;
      conditions: ListenerRuleCondition[];
    }
    const normalized: NormalizedRule[] = [];
    for (const [index, rule] of rules.entries()) {
      if (rule.forward !== undefined && rule.redirect !== undefined) {
        return yield* Effect.fail(
          new ServiceRuleActionConflict({
            serviceId: id,
            ruleIndex: index,
            message: `AWS.ECS.Service "${id}": rule ${index} sets both \`forward\` and \`redirect\` — they are mutually exclusive`,
          }),
        );
      }
      const listen =
        typeof rule.listen === "string"
          ? yield* parseListenSpec(id, rule.listen, "listen")
          : rule.listen;
      if (!owned && listen === undefined && config.listener === undefined) {
        return yield* Effect.fail(
          new MissingRuleListener({
            serviceId: id,
            ruleIndex: index,
            message: `AWS.ECS.Service "${id}": rule ${index} has no \`listen\` and the config has no default \`listener\``,
          }),
        );
      }
      const action: NormalizedAction =
        rule.redirect !== undefined
          ? {
              type: "redirect",
              ...(yield* parseListenSpec(id, rule.redirect, "redirect")),
            }
          : {
              type: "forward",
              tgKey: ensureTgSpec(
                rule.forward !== undefined
                  ? yield* parseListenSpec(id, rule.forward, "forward")
                  : undefined,
                rule.container,
              ),
            };
      normalized.push({
        index,
        rule,
        listen,
        action,
        conditions: ruleConditionsOf(rule),
      });
    }
    if (trueLike) {
      ensureTgSpec(undefined, undefined);
    }

    // ── owned listener specs ────────────────────────────────────────────
    const defaultOwnedListen: ParsedListen = {
      port: props.listenerPort ?? (props.certificateArn ? 443 : 80),
      protocol: props.certificateArn ? "https" : "http",
    };
    const ownedListenSpecs = new Map<number, ParsedListen>();
    if (owned) {
      if (trueLike || normalized.some((r) => r.listen === undefined)) {
        ownedListenSpecs.set(defaultOwnedListen.port, defaultOwnedListen);
      }
      for (const r of normalized) {
        if (r.listen !== undefined && !isELBv2Listener(r.listen)) {
          const spec = r.listen as ParsedListen;
          const existing = ownedListenSpecs.get(spec.port);
          if (existing !== undefined && existing.protocol !== spec.protocol) {
            return yield* Effect.fail(
              new UnsupportedListenerProtocol({
                serviceId: id,
                spec: `${spec.port}/${spec.protocol}`,
                message: `AWS.ECS.Service "${id}": port ${spec.port} is declared with both "${existing.protocol}" and "${spec.protocol}" — one protocol per listener port`,
              }),
            );
          }
          ownedListenSpecs.set(spec.port, spec);
        }
      }
      for (const spec of ownedListenSpecs.values()) {
        if (spec.protocol === "https" && !props.certificateArn) {
          return yield* Effect.fail(
            new MissingListenerCertificate({
              serviceId: id,
              spec: `${spec.port}/${spec.protocol}`,
              message: `AWS.ECS.Service "${id}": listener "${spec.port}/https" requires \`certificateArn\``,
            }),
          );
        }
      }
    }

    /** The owned listener port a rule attaches to. */
    const ownedPortOf = (r: NormalizedRule): number =>
      r.listen !== undefined && !isELBv2Listener(r.listen)
        ? (r.listen as ParsedListen).port
        : defaultOwnedListen.port;

    // ── network (VPC for TGs + SG, subnets for an owned ALB) ────────────
    const network =
      props.vpcId !== undefined && props.subnets !== undefined
        ? { vpcId: props.vpcId, subnets: props.subnets }
        : yield* lookupDefaultNetwork;

    // ── managed security group ──────────────────────────────────────────
    const staticPorts: number[] = [
      ...(owned ? [...ownedListenSpecs.keys()] : []),
      ...[...tgSpecs.values()].flatMap((spec) =>
        spec.forwardPort !== undefined ? [spec.forwardPort] : [],
      ),
    ];
    const usesDefaultPort = [...tgSpecs.values()].some(
      (spec) => spec.forwardPort === undefined,
    );
    const managedSg = props.securityGroups
      ? undefined
      : yield* SecurityGroup("SecurityGroup", {
          vpcId: network.vpcId as VpcId,
          description: `Alchemy-managed ingress for ECS service ${id}`,
          ingress: managedSgIngress(
            staticPorts,
            usesDefaultPort ? defaultContainerPort : undefined,
          ),
          tags: props.tags,
        });

    // ── target groups (one per distinct forward + container pair) ───────
    const targetGroups = new Map<string, TargetGroup>();
    for (const spec of tgSpecs.values()) {
      targetGroups.set(
        spec.key,
        yield* TargetGroup(spec.logicalId, {
          vpcId: network.vpcId as string,
          port: spec.port as number,
          protocol: spec.protocol,
          targetType: "ip",
          healthCheckPath: props.healthCheckPath ?? "/",
          // Fast-converge defaults: targets go healthy in ~20s instead of
          // the AWS default ~150s, and drain in 30s instead of 300s.
          healthCheckInterval: "10 seconds",
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
          attributes: { "deregistration_delay.timeout_seconds": "30" },
          tags: props.tags,
        }),
      );
    }

    const actionToListenerAction = (action: NormalizedAction): ListenerAction =>
      action.type === "redirect"
        ? {
            type: "redirect",
            statusCode: "HTTP_301",
            protocol: action.protocol.toUpperCase(),
            port: String(action.port),
          }
        : {
            type: "forward",
            targetGroups: [
              {
                targetGroupArn: targetGroups.get(action.tgKey)!
                  .targetGroupArn as unknown as TargetGroupArn,
              },
            ],
          };

    // ── owned ALB + listeners ───────────────────────────────────────────
    let alb: LoadBalancer | undefined;
    const ownedListeners = new Map<number, Listener>();
    /** Rules absorbed into a listener's default action (no ListenerRule). */
    const defaultsTaken = new Set<NormalizedRule>();
    if (owned) {
      alb = yield* LoadBalancer("LoadBalancer", {
        type: "application",
        scheme: config.public === false ? "internal" : "internet-facing",
        subnets: (props.subnets ?? network.subnets) as unknown as SubnetId[],
        securityGroups: (props.securityGroups ?? [
          managedSg!.groupId,
        ]) as unknown as SecurityGroupId[],
        tags: props.tags,
      });
      for (const spec of ownedListenSpecs.values()) {
        // Default action: the first conditionless rule on this listener
        // wins; the `true`-like form forwards to the sole target group;
        // otherwise unmatched requests get a 404.
        const conditionless = normalized.find(
          (r) => r.conditions.length === 0 && ownedPortOf(r) === spec.port,
        );
        if (conditionless) {
          defaultsTaken.add(conditionless);
        }
        const defaultActions: ListenerAction[] = conditionless
          ? [actionToListenerAction(conditionless.action)]
          : trueLike
            ? [
                {
                  type: "forward",
                  targetGroups: [
                    {
                      targetGroupArn: targetGroups.get("default|")!
                        .targetGroupArn as unknown as TargetGroupArn,
                    },
                  ],
                },
              ]
            : [
                {
                  type: "fixedResponse",
                  statusCode: "404",
                  contentType: "text/plain",
                  messageBody: "Not Found",
                },
              ];
        ownedListeners.set(
          spec.port,
          yield* Listener(`Listener-${spec.port}`, {
            loadBalancerArn: alb.loadBalancerArn as any,
            port: spec.port,
            protocol: spec.protocol.toUpperCase() as "HTTP" | "HTTPS",
            certificateArn:
              spec.protocol === "https" ? props.certificateArn : undefined,
            defaultActions,
          }),
        );
      }
    }

    // ── listener rules ──────────────────────────────────────────────────
    const chain = yield* Namespace.CurrentChain;
    const namespacePrefix = [...chain].reverse().join("/");
    for (const r of normalized) {
      if (defaultsTaken.has(r)) {
        continue;
      }
      const ruleId = `Rule-${r.index}`;
      // A conditionless rule still needs at least one ELBv2 condition — use
      // the catch-all path (this is also the bare-listener default rule).
      const conditions =
        r.conditions.length > 0
          ? r.conditions
          : [{ pathPattern: { values: ["/*"] } }];
      const ruleListener = owned
        ? ownedListeners.get(ownedPortOf(r))!
        : isELBv2Listener(r.listen)
          ? r.listen
          : config.listener!;
      const priority =
        r.rule.priority ?? deriveRulePriority(`${namespacePrefix}/${ruleId}`);
      yield* ListenerRule(ruleId, {
        listenerArn: ruleListener.listenerArn as any,
        priority,
        conditions,
        actions: [actionToListenerAction(r.action)],
        tags: props.tags,
      });
    }

    // ── primary listener (attrs + URL derivation) ───────────────────────
    const primary = owned
      ? (() => {
          const spec =
            ownedListenSpecs.get(defaultOwnedListen.port) ??
            [...ownedListenSpecs.values()][0];
          const listener = ownedListeners.get(spec.port)!;
          return {
            listenerArn: listener.listenerArn,
            loadBalancerArn: alb!.loadBalancerArn,
            port: spec.port as unknown,
            protocol: spec.protocol.toUpperCase() as unknown,
          };
        })()
      : (() => {
          const ref =
            config.listener ??
            (normalized.map((r) => r.listen).find(isELBv2Listener) as Listener);
          return {
            listenerArn: ref.listenerArn,
            loadBalancerArn: ref.loadBalancerArn,
            port: ref.port as unknown,
            protocol: ref.protocol as unknown,
          };
        })();

    const ingress: ServiceManagedIngress = {
      kind: owned ? "owned" : "shared",
      loadBalancerArn: primary.loadBalancerArn as unknown as string,
      listenerArn: primary.listenerArn as unknown as string,
      listenerPort: primary.port as number,
      listenerProtocol: primary.protocol as string,
      securityGroupId: managedSg?.groupId as unknown as string | undefined,
      targets: [...tgSpecs.values()].map((spec) => ({
        targetGroupArn: targetGroups.get(spec.key)!
          .targetGroupArn as unknown as string,
        containerPort: spec.forwardPort,
        container: spec.container,
      })),
    };

    return {
      ...props,
      loadBalancer: undefined,
      public: undefined,
      ingress,
    } as ServiceProps;
  });

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const imageSource = yield* makeImageSource;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      // Derive the cluster ARN from either form of the `cluster` prop. May
      // legitimately receive `undefined`: a `creating` state row persisted
      // before upstream Outputs resolved can't round-trip an Output-valued
      // `cluster` (it deserializes as `undefined`), and recovery paths hand
      // those props back as `olds`.
      const clusterArnOf = (
        cluster: ServiceProps["cluster"] | ClusterArn | undefined,
      ): ClusterArn | undefined =>
        typeof cluster === "string"
          ? (cluster as ClusterArn)
          : typeof (cluster as { clusterArn?: unknown } | undefined)
                ?.clusterArn === "string"
            ? ((cluster as { clusterArn: string }).clusterArn as ClusterArn)
            : undefined;
      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({ key, value }));

      const toServiceName = (
        id: string,
        props: { serviceName?: string } = {},
      ) =>
        props.serviceName
          ? Effect.succeed(props.serviceName)
          : createPhysicalName({
              id,
              maxLength: 255,
              lowercase: true,
            });

      // ── networking ────────────────────────────────────────────────────

      /**
       * Resolve the VPC + subnets the service runs in. Explicit props win;
       * otherwise fall back to the account's default VPC and its per-AZ
       * default subnets (public — so `assignPublicIp` then defaults to true
       * to allow image pulls without a NAT).
       */
      const resolveNetwork = Effect.fn(function* (news: {
        vpcId?: string;
        subnets?: string[];
        assignPublicIp?: boolean;
      }) {
        if (news.vpcId !== undefined && news.subnets !== undefined) {
          return {
            vpcId: news.vpcId,
            subnets: news.subnets,
            assignPublicIp: news.assignPublicIp ?? false,
          };
        }
        const network = yield* lookupDefaultNetwork;
        return {
          vpcId: network.vpcId,
          subnets: news.subnets ?? network.subnets,
          assignPublicIp: news.assignPublicIp ?? true,
        };
      });

      // ── managed ingress (composed ELBv2 resources) ────────────────────

      /**
       * Best-effort public URL for managed ingress: resolve the (owned or
       * shared) load balancer's DNS name and combine it with the primary
       * listener's protocol/port. Returns undefined when not derivable.
       */
      const deriveIngressUrl = Effect.fn(function* (
        ingress: ServiceManagedIngress | undefined,
      ) {
        if (!ingress?.loadBalancerArn) {
          return undefined;
        }
        const described = yield* elbv2
          .describeLoadBalancers({
            LoadBalancerArns: [ingress.loadBalancerArn],
          })
          .pipe(
            Effect.catchTag("LoadBalancerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const dnsName = described?.LoadBalancers?.[0]?.DNSName;
        if (!dnsName) {
          return undefined;
        }
        const protocol = (ingress.listenerProtocol ?? "HTTP").toLowerCase();
        const port = ingress.listenerPort;
        const isDefaultPort =
          port === undefined ||
          (protocol === "http" && port === 80) ||
          (protocol === "https" && port === 443);
        return `${protocol}://${dnsName}${isDefaultPort ? "" : `:${port}`}`;
      });

      /**
       * Reap the ALB/TG/listener/security group that the pre-composition
       * provider created INLINE and recorded in the service's own attributes.
       * Those legacy state rows carry the ingress ARNs with no `ingressKind`
       * marker; the composed shape stamps the marker and owns its ingress as
       * real child resources (deleted by the engine, never here). Reaping on
       * the first reconcile under the new shape keeps the breaking redeploy
       * from stranding the old inline infrastructure.
       */
      const reapLegacyIngress = Effect.fn(function* ({
        output,
        session,
      }: {
        output: Service["Attributes"] | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        if (!output || output.ingressKind !== undefined) {
          return;
        }
        if (
          !output.listenerArn &&
          !output.targetGroupArn &&
          !output.loadBalancerArn &&
          !output.securityGroupId
        ) {
          return;
        }
        yield* session.note(
          "Migrating to composed load balancer resources — deleting the legacy inline ALB/TG/listener",
        );
        if (output.listenerArn) {
          yield* elbv2
            .deleteListener({ ListenerArn: output.listenerArn })
            .pipe(
              Effect.catchTag("ListenerNotFoundException", () => Effect.void),
            );
        }
        if (output.targetGroupArn) {
          yield* elbv2
            .deleteTargetGroup({ TargetGroupArn: output.targetGroupArn })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.max([
                  Schedule.spaced("3 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
              Effect.catch(() => Effect.void),
            );
        }
        if (output.loadBalancerArn) {
          yield* elbv2
            .deleteLoadBalancer({ LoadBalancerArn: output.loadBalancerArn })
            .pipe(
              Effect.catchTag(
                "LoadBalancerNotFoundException",
                () => Effect.void,
              ),
            );
        }
        if (output.securityGroupId) {
          // The old ALB/service ENIs release the group asynchronously; retry
          // bounded, then give up with a note rather than fail the migration
          // deploy.
          yield* ec2
            .deleteSecurityGroup({ GroupId: output.securityGroupId })
            .pipe(
              Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "DependencyViolation",
                schedule: Schedule.max([
                  Schedule.spaced("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
              Effect.catchTag("DependencyViolation", () =>
                session.note(
                  "Legacy ingress security group still has attached ENIs; leaving it to release asynchronously",
                ),
              ),
            );
        }
      });

      // ── task definition synthesis (image-owning forms) ────────────────

      /**
       * Synthesize (or roll) the service-owned task definition from the
       * image source + `TaskDefinitionConfig` surface. Mirrors the
       * `AWS.ECS.Task` reconcile flow.
       */
      const synthesizeTaskDefinition = Effect.fn(function* ({
        id,
        news,
        output,
        bindings,
        tags,
        session,
      }: {
        id: string;
        news: BundledServiceProps | DockerfileServiceProps | ImageServiceProps;
        output: Service["Attributes"] | undefined;
        bindings: Parameters<typeof attachTaskBindings>[0]["bindings"];
        tags: Record<string, string>;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const family =
          output?.taskFamily ??
          (yield* createPhysicalName({
            id: `${id}-task`,
            maxLength: 255,
            lowercase: true,
          }));
        const taskRoleName =
          output?.taskRoleName ??
          (yield* createPhysicalName({
            id: `${id}-task-role`,
            maxLength: 64,
          }));
        const executionRoleName =
          output?.executionRoleName ??
          (yield* createPhysicalName({
            id: `${id}-execution-role`,
            maxLength: 64,
          }));
        const taskPolicyName = yield* createPhysicalName({
          id: `${id}-task-policy`,
          maxLength: 128,
        });
        const repositoryName =
          output?.repositoryName ??
          (yield* createPhysicalName({
            id: `${id}-repo`,
            maxLength: 256,
            lowercase: true,
          }));
        const logGroupName =
          output?.logGroupName ??
          (yield* createPhysicalName({
            id: `${id}-logs`,
            maxLength: 512,
            lowercase: true,
          }));

        const taskRoleArn =
          output?.taskRoleArn ??
          (yield* createTaskRoleIfNotExists({ id, roleName: taskRoleName }));
        const executionRoleArn =
          output?.executionRoleArn ??
          (yield* ensureTaskExecutionRole({
            id,
            roleName: executionRoleName,
            managedPolicyArns: news.executionRoleManagedPolicyArns,
          }));

        const {
          env: bindingEnv,
          volumes: bindingVolumes,
          mountPoints: bindingMountPoints,
        } = yield* attachTaskBindings({
          roleName: taskRoleName,
          policyName: taskPolicyName,
          bindings,
        });

        const logGroupArn =
          output?.logGroupArn ??
          (yield* ensureTaskLogGroup({ id, logGroupName }));

        const source = news as ImageSourceLike;
        const resolved = yield* imageSource.resolve({
          id,
          source,
          repositoryName,
          repositoryUri:
            output?.repositoryUri && output.repositoryName === repositoryName
              ? output.repositoryUri
              : undefined,
          tags,
          platform: taskImagePlatform(news.runtimePlatform),
          port: news.port,
          isExternal: news.isExternal,
          bootstrap: makeBunBootstrap(source.handler ?? "default"),
          session,
        });

        const taskDefinition = yield* registerTaskDefinitionRevision({
          props: {
            ...news,
            placementConstraints: news.taskPlacementConstraints,
            env: {
              ...bindingEnv,
              ...alchemyEnv,
              ...news.env,
            },
          },
          family,
          imageUri: resolved.imageUri,
          taskRoleArn,
          executionRoleArn,
          logGroupName,
          tags,
          bindingVolumes,
          bindingMountPoints,
        });

        yield* syncTaskDefinitionTags({
          revisionArn: taskDefinition.taskDefinitionArn!,
          tags,
        });

        const containerName =
          taskDefinition.containerDefinitions?.[0]?.name ?? family;
        return {
          taskDefinitionArn: taskDefinition.taskDefinitionArn!,
          taskFamily: family,
          containerName,
          port: news.port ?? 3000,
          imageUri: resolved.imageUri,
          repositoryName: resolved.repositoryName,
          repositoryUri: resolved.repositoryUri,
          taskRoleArn,
          taskRoleName,
          executionRoleArn,
          executionRoleName,
          logGroupName,
          logGroupArn,
          code: { hash: resolved.codeHash },
        };
      });

      const networkConfigurationOf = (
        network: {
          subnets: string[];
          assignPublicIp: boolean;
        },
        securityGroups: string[] | undefined,
      ) => ({
        awsvpcConfiguration: {
          subnets: network.subnets,
          securityGroups,
          assignPublicIp: (network.assignPublicIp ? "ENABLED" : "DISABLED") as
            | "ENABLED"
            | "DISABLED",
        },
      });

      // load balancers passed to create/update: explicit user-supplied list
      // plus the composed managed-ingress target groups.
      const loadBalancersOf = (
        news: ServiceProps,
        task: { containerName: string; port: number },
      ): ecs.LoadBalancer[] | undefined => {
        const managed: ecs.LoadBalancer[] = (news.ingress?.targets ?? []).map(
          (target) => ({
            targetGroupArn: target.targetGroupArn,
            containerName: target.container ?? task.containerName,
            containerPort: target.containerPort ?? task.port,
          }),
        );
        const all = [...(news.loadBalancers ?? []), ...managed];
        return all.length > 0 ? all : undefined;
      };

      // In-place mutable fields shared by createService and updateService.
      const mutableInput = (
        news: ServiceProps,
        task: { taskDefinitionArn: string },
        network: { subnets: string[]; assignPublicIp: boolean },
        securityGroups: string[] | undefined,
      ) => ({
        taskDefinition: task.taskDefinitionArn,
        desiredCount: news.desiredCount ?? 1,
        platformVersion: news.platformVersion,
        deploymentConfiguration: news.deploymentConfiguration,
        healthCheckGracePeriodSeconds: toWireSeconds(
          news.healthCheckGracePeriod,
        ),
        networkConfiguration: networkConfigurationOf(network, securityGroups),
        capacityProviderStrategy: news.capacityProviderStrategy,
        placementConstraints: news.placementConstraints,
        placementStrategy: news.placementStrategy,
        enableExecuteCommand: news.enableExecuteCommand,
        propagateTags: news.propagateTags,
        availabilityZoneRebalancing: news.availabilityZoneRebalancing,
        serviceConnectConfiguration: news.serviceConnectConfiguration,
        volumeConfigurations: news.volumeConfigurations,
        // launchType and capacityProviderStrategy are mutually exclusive;
        // only send launchType when no strategy is provided.
        launchType: news.capacityProviderStrategy
          ? undefined
          : (news.launchType ?? "FARGATE"),
      });

      return {
        stables: ["serviceArn", "serviceName", "clusterArn"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          // serviceName change → delete-first replace (name is the identity).
          if (
            (yield* toServiceName(id, olds ?? {})) !==
            (yield* toServiceName(id, news ?? {}))
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // cluster change → replace (a service can't move clusters). Only
          // when both sides are known — a half-created state row may have
          // lost an Output-valued `cluster` (see `clusterArnOf`), and an
          // unknown old cluster must fall through to the create/update
          // recovery path rather than force a replacement.
          const oldClusterArn = clusterArnOf(olds?.cluster);
          const newClusterArn = clusterArnOf(news.cluster);
          if (
            oldClusterArn !== undefined &&
            newClusterArn !== undefined &&
            oldClusterArn !== newClusterArn
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // Truly-immutable post-create fields. Everything else (desiredCount,
          // taskDefinition, network, deployment config, placement, loadBalancers,
          // exec, tags, …) is applied in place by `updateService`.
          if (
            olds !== undefined &&
            !deepEqual(
              {
                // launchType ↔ capacityProviderStrategy switch is immutable.
                usesStrategy: !!olds.capacityProviderStrategy,
                schedulingStrategy: olds.schedulingStrategy ?? "REPLICA",
                deploymentControllerType:
                  olds.deploymentController?.type ?? "ECS",
                enableECSManagedTags: olds.enableECSManagedTags ?? true,
                role: olds.role,
              },
              {
                usesStrategy: !!news.capacityProviderStrategy,
                schedulingStrategy: news.schedulingStrategy ?? "REPLICA",
                deploymentControllerType:
                  news.deploymentController?.type ?? "ECS",
                enableECSManagedTags: news.enableECSManagedTags ?? true,
                role: news.role,
              },
            )
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // Content drift for image-owning `context`/`image` sources: props
          // don't change when the files under `context` do, so surface hash
          // drift as an update. (`main` sources hash from the bundle output
          // inside reconcile.)
          if (output?.code && taskRefOf(news) === undefined) {
            const hash = yield* computeStaticSourceHash(
              news as ImageSourceLike,
              taskImagePlatform(
                (news as ImageOwningServicePropsBase).runtimePlatform,
              ),
            );
            if (hash !== undefined && hash !== output.code.hash) {
              return { action: "update" } as const;
            }
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterArn = output?.clusterArn ?? clusterArnOf(olds?.cluster);
          if (clusterArn === undefined) {
            // No attributes and no recoverable cluster from the persisted
            // props (an Output-valued `cluster` doesn't survive a
            // `creating`-state round-trip). We can't locate the service, so
            // report "not found" — the engine re-drives the create and
            // reconcile converges on any half-created service by name.
            return undefined;
          }
          const serviceName =
            output?.serviceName ?? (yield* toServiceName(id, olds ?? {}));
          const described = yield* ecs
            .describeServices({
              cluster: clusterArn,
              services: [serviceName],
              include: ["TAGS"],
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const service = described?.services?.[0];
          if (!service?.serviceArn) {
            return undefined;
          }
          return {
            ...output!,
            serviceArn: service.serviceArn as ServiceArn,
            serviceName: service.serviceName!,
            clusterArn: service.clusterArn as ClusterArn,
            taskDefinitionArn: service.taskDefinition!,
            status: service.status ?? "ACTIVE",
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // ECS services are scoped to a cluster, so enumerate every cluster
            // first, then list services per cluster, then hydrate via
            // describeServices (which accepts up to 10 services per call).
            const clusterArns = yield* ecs.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusterArns ?? []),
              ),
            );

            const perCluster = yield* Effect.forEach(
              clusterArns,
              (clusterArn) =>
                Effect.gen(function* () {
                  const serviceArns = yield* ecs.listServices
                    .pages({ cluster: clusterArn })
                    .pipe(
                      Stream.runCollect,
                      Effect.map((chunk) =>
                        Array.from(chunk).flatMap(
                          (page) => page.serviceArns ?? [],
                        ),
                      ),
                      Effect.catchTag("ClusterNotFoundException", () =>
                        Effect.succeed([] as string[]),
                      ),
                    );
                  if (serviceArns.length === 0) {
                    return [] as Service["Attributes"][];
                  }

                  const batches: string[][] = [];
                  for (let i = 0; i < serviceArns.length; i += 10) {
                    batches.push(serviceArns.slice(i, i + 10));
                  }

                  const described = yield* Effect.forEach(
                    batches,
                    (services) =>
                      ecs
                        .describeServices({ cluster: clusterArn, services })
                        .pipe(
                          Effect.map((res) => res.services ?? []),
                          Effect.catchTag("ClusterNotFoundException", () =>
                            Effect.succeed([] as ecs.Service[]),
                          ),
                        ),
                    { concurrency: 4 },
                  );

                  return described.flat().flatMap((service) =>
                    service.serviceArn && service.status !== "INACTIVE"
                      ? [
                          {
                            serviceArn: service.serviceArn as ServiceArn,
                            serviceName: service.serviceName!,
                            clusterArn: service.clusterArn as ClusterArn,
                            taskDefinitionArn: service.taskDefinition!,
                            status: service.status ?? "ACTIVE",
                          } satisfies Service["Attributes"],
                        ]
                      : [],
                  );
                }),
              { concurrency: 5 },
            );

            return perCluster.flat();
          }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const serviceName = yield* toServiceName(id, news);
          const clusterArn = clusterArnOf(news.cluster) as ClusterArn;
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Resolve the task definition: BYO reference, or synthesize the
          // service-owned definition from the image source.
          const byoTask = taskRefOf(news);
          const owned =
            byoTask === undefined
              ? yield* synthesizeTaskDefinition({
                  id,
                  news: news as
                    | BundledServiceProps
                    | DockerfileServiceProps
                    | ImageServiceProps,
                  output,
                  bindings,
                  tags: desiredTags,
                  session,
                })
              : undefined;
          const task = byoTask ?? {
            taskDefinitionArn: owned!.taskDefinitionArn,
            containerName: owned!.containerName,
            port: owned!.port,
          };

          // Resolve networking (explicit props or the default VPC).
          const network = yield* resolveNetwork(news);

          // Managed ingress: the composed child-resource outputs arrive via
          // the internal `ingress` prop (written by the factory's
          // composition step). The managed security group — when composed —
          // is attached to the service ENIs as well.
          const ingress = news.ingress;
          const securityGroups =
            news.securityGroups ??
            (ingress?.securityGroupId ? [ingress.securityGroupId] : undefined);

          // Observe — describe service in target cluster. The cluster may
          // not yet exist on first reconcile, so we tolerate
          // `ClusterNotFoundException`.
          const described = yield* ecs
            .describeServices({
              cluster: clusterArn,
              services: [serviceName],
              include: ["TAGS"],
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const observed = described?.services?.find(
            (s) =>
              s.serviceName === serviceName &&
              s.status !== "INACTIVE" &&
              s.status !== "DRAINING",
          );

          // Managed-ingress attributes: derived from the composed (or
          // shared) child-resource outputs; the URL comes from the load
          // balancer's DNS name (best-effort).
          const ingressAttrs = {
            url: yield* deriveIngressUrl(ingress),
            loadBalancerArn: ingress?.loadBalancerArn,
            targetGroupArn: ingress?.targets[0]?.targetGroupArn,
            listenerArn: ingress?.listenerArn,
            securityGroupId: ingress?.securityGroupId,
            ingressKind: ingress?.kind,
          };

          const ownedAttributes = {
            taskFamily: owned?.taskFamily,
            containerName: owned?.containerName,
            port: owned?.port,
            imageUri: owned?.imageUri,
            repositoryName: owned?.repositoryName,
            repositoryUri: owned?.repositoryUri,
            taskRoleArn: owned?.taskRoleArn,
            taskRoleName: owned?.taskRoleName,
            executionRoleArn: owned?.executionRoleArn,
            executionRoleName: owned?.executionRoleName,
            logGroupName: owned?.logGroupName,
            logGroupArn: owned?.logGroupArn,
            code: owned?.code,
          };

          if (!observed?.serviceArn) {
            const created = yield* ecs.createService({
              ...mutableInput(news, task, network, securityGroups),
              serviceName,
              cluster: clusterArn,
              loadBalancers: loadBalancersOf(news, task),
              serviceRegistries: news.serviceRegistries,
              deploymentController: news.deploymentController,
              schedulingStrategy: news.schedulingStrategy,
              role: news.role,
              tags: toEcsTags(desiredTags),
              enableECSManagedTags: news.enableECSManagedTags ?? true,
            });
            const service = created.service;
            if (!service?.serviceArn) {
              return yield* Effect.die(
                new Error("createService returned no service"),
              );
            }
            // Legacy inline ingress recorded in prior attrs (service itself
            // was missing — e.g. recreated) is stale now: reap it.
            yield* reapLegacyIngress({ output, session });
            yield* session.note(service.serviceArn);
            return {
              serviceArn: service.serviceArn as ServiceArn,
              serviceName: service.serviceName!,
              clusterArn: service.clusterArn as ClusterArn,
              taskDefinitionArn: service.taskDefinition!,
              status: service.status ?? "ACTIVE",
              ...ingressAttrs,
              ...ownedAttributes,
            };
          }

          // Sync — apply in-place mutable fields via updateService. Force a new
          // deployment so a changed task definition (same revision-less ARN) or
          // load-balancer wiring rolls out.
          const updated = yield* ecs
            .updateService({
              ...mutableInput(news, task, network, securityGroups),
              service: serviceName,
              cluster: clusterArn,
              // `undefined` means "leave unchanged" on the wire, so pass an
              // explicit empty list to DETACH when a previously-managed
              // target group is no longer desired.
              loadBalancers:
                loadBalancersOf(news, task) ??
                (output?.targetGroupArn !== undefined ? [] : undefined),
              enableExecuteCommand: news.enableExecuteCommand,
              forceNewDeployment: true,
            })
            .pipe(
              // The service may still be transitioning (e.g. a prior
              // deployment settling). updateService rejects with
              // ServiceNotActiveException until it returns to ACTIVE — retry
              // bounded.
              Effect.retry({
                while: (e) => e._tag === "ServiceNotActiveException",
                schedule: Schedule.max([
                  Schedule.spaced("5 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
            );
          const service = updated.service;

          // Sync tags — diff observed service tags against desired.
          const observedTags = Object.fromEntries(
            (observed.tags ?? [])
              .filter(
                (t): t is { key: string; value: string } =>
                  typeof t.key === "string" && typeof t.value === "string",
              )
              .map((t) => [t.key, t.value]),
          );
          const { removed: removedTags, upsert: upsertTags } = diffTags(
            observedTags,
            desiredTags,
          );
          if (upsertTags.length > 0) {
            yield* ecs.tagResource({
              resourceArn: observed.serviceArn,
              tags: upsertTags.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removedTags.length > 0) {
            yield* ecs.untagResource({
              resourceArn: observed.serviceArn,
              tagKeys: removedTags,
            });
          }

          // First reconcile under the composed shape: the service now points
          // at the composed target groups, so the legacy inline ingress can
          // be reaped without dropping traffic wiring.
          yield* reapLegacyIngress({ output, session });

          yield* session.note(observed.serviceArn);
          return {
            serviceArn: observed.serviceArn as ServiceArn,
            serviceName: observed.serviceName!,
            clusterArn: observed.clusterArn as ClusterArn,
            taskDefinitionArn:
              service?.taskDefinition ??
              observed.taskDefinition ??
              output?.taskDefinitionArn ??
              "",
            status: service?.status ?? observed.status ?? "ACTIVE",
            ...ingressAttrs,
            ...ownedAttributes,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          // Scale to zero first so `deleteService` has no running tasks to
          // drain. If the service is mid-transition (`ServiceNotActiveException`)
          // we skip the scale-down — `deleteService({ force: true })` below
          // tears it down regardless.
          yield* ecs
            .updateService({
              cluster: output.clusterArn,
              service: output.serviceName,
              desiredCount: 0,
            })
            .pipe(
              Effect.catchTag("ServiceNotFoundException", () => Effect.void),
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
              Effect.catchTag("ServiceNotActiveException", () => Effect.void),
            );

          yield* ecs
            .deleteService({
              cluster: output.clusterArn,
              service: output.serviceName,
              force: true,
            })
            .pipe(
              Effect.catchTag("ServiceNotFoundException", () => Effect.void),
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );

          // Inline ingress teardown applies ONLY to legacy state rows (no
          // `ingressKind` marker) whose ALB/TG/listener/SG were created
          // inline by the pre-composition provider. Composed ingress is made
          // of real child resources the engine deletes itself — and in the
          // shared form the listener/ALB recorded here belong to someone
          // else entirely and must never be touched.
          if (output.ingressKind === undefined) {
            if (output.listenerArn) {
              yield* elbv2
                .deleteListener({
                  ListenerArn: output.listenerArn,
                })
                .pipe(
                  Effect.catchTag(
                    "ListenerNotFoundException",
                    () => Effect.void,
                  ),
                );
            }
            if (output.targetGroupArn) {
              yield* elbv2
                .deleteTargetGroup({
                  TargetGroupArn: output.targetGroupArn,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            if (output.loadBalancerArn) {
              yield* elbv2
                .deleteLoadBalancer({
                  LoadBalancerArn: output.loadBalancerArn,
                })
                .pipe(
                  Effect.catchTag(
                    "LoadBalancerNotFoundException",
                    () => Effect.void,
                  ),
                );
            }

            // Owned ingress security group: the ALB/service ENIs release it
            // asynchronously, so retry the dependency violation, bounded.
            if (output.securityGroupId) {
              yield* ec2
                .deleteSecurityGroup({
                  GroupId: output.securityGroupId,
                })
                .pipe(
                  Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
                  Effect.retry({
                    while: (e) => e._tag === "DependencyViolation",
                    schedule: Schedule.max([
                      Schedule.spaced("5 seconds"),
                      Schedule.recurs(24),
                    ]).pipe(
                      Schedule.tap(() =>
                        session.note(
                          "Waiting for ENIs to release the ingress security group...",
                        ),
                      ),
                    ),
                  }),
                );
            }
          }

          // Synthesized task definition infrastructure (image-owning form).
          if (
            output.taskFamily &&
            output.repositoryName &&
            output.logGroupName &&
            output.taskRoleName &&
            output.executionRoleName
          ) {
            yield* deleteTaskDefinitionInfrastructure({
              taskDefinitionArn: output.taskDefinitionArn,
              repositoryName: output.repositoryName,
              logGroupName: output.logGroupName,
              taskRoleName: output.taskRoleName,
              executionRoleName: output.executionRoleName,
            });
          }
        }),
      };
    }),
  );
