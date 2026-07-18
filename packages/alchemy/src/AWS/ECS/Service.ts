import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type { Region } from "@distilled.cloud/aws/Region";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { HostRuntimeContext, ServerHost } from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Credentials } from "../Credentials.ts";
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
   * Whether Alchemy should provision a public Application Load Balancer,
   * target group, and listener in front of the service. The service's `url`
   * attribute is populated from the ALB's DNS name.
   * @default false
   */
  loadBalancer?: boolean;

  /**
   * Legacy alias for {@link loadBalancer}.
   * @deprecated use `loadBalancer: true`
   */
  public?: boolean;

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
     * Public URL exposed by the generated Application Load Balancer, when
     * `loadBalancer: true`.
     */
    url?: string;

    /**
     * ARN of the generated load balancer, when `loadBalancer: true`.
     */
    loadBalancerArn?: string;

    /**
     * ARN of the generated target group, when `loadBalancer: true`.
     */
    targetGroupArn?: string;

    /**
     * ARN of the generated listener, when `loadBalancer: true`.
     */
    listenerArn?: string;

    /**
     * Id of the Alchemy-owned security group created for managed ingress
     * (only when `loadBalancer: true` and no `securityGroups` supplied).
     */
    securityGroupId?: string;

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
});

/** The BYO task reference, when the props use the `task:` form. */
const taskRefOf = (props: ServiceProps | undefined) =>
  props !== undefined && "task" in props ? props.task : undefined;

/** Whether the props request Alchemy-managed ALB ingress. */
const wantsManagedIngress = (props: {
  loadBalancer?: boolean;
  public?: boolean;
}) => props.loadBalancer ?? props.public ?? false;

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
        return {
          vpcId: vpc.VpcId,
          subnets: news.subnets ?? subnetIds,
          assignPublicIp: news.assignPublicIp ?? true,
        };
      });

      /**
       * Ensure the Alchemy-owned ingress security group (managed ALB with no
       * user-supplied `securityGroups`): admits the listener port from
       * anywhere and the container port from within the group. Observe-first
       * so re-runs never trip duplicate-rule errors.
       */
      const ensureIngressSecurityGroup = Effect.fn(function* ({
        id,
        vpcId,
        listenerPort,
        containerPort,
        tags,
      }: {
        id: string;
        vpcId: string;
        listenerPort: number;
        containerPort: number;
        tags: Record<string, string>;
      }) {
        const groupName = yield* createPhysicalName({
          id: `${id}-sg`,
          maxLength: 255,
          lowercase: true,
        });

        const existing = yield* ec2.describeSecurityGroups({
          Filters: [
            { Name: "vpc-id", Values: [vpcId] },
            { Name: "group-name", Values: [groupName] },
          ],
        });
        const groupId =
          existing.SecurityGroups?.[0]?.GroupId ??
          (yield* ec2
            .createSecurityGroup({
              GroupName: groupName,
              Description: `Alchemy-managed ingress for ECS service ${id}`,
              VpcId: vpcId,
              TagSpecifications: [
                {
                  ResourceType: "security-group",
                  Tags: createTagsList(tags),
                },
              ],
            })
            .pipe(
              Effect.catchTag("InvalidGroup.Duplicate", () =>
                ec2
                  .describeSecurityGroups({
                    Filters: [
                      { Name: "vpc-id", Values: [vpcId] },
                      { Name: "group-name", Values: [groupName] },
                    ],
                  })
                  .pipe(
                    Effect.map((r) => ({
                      GroupId: r.SecurityGroups?.[0]?.GroupId,
                    })),
                  ),
              ),
              Effect.map((r) => r.GroupId),
            ));
        if (!groupId) {
          return yield* Effect.die(
            new Error(`Failed to resolve security group '${groupName}'`),
          );
        }

        // Authorize only the missing rules (observe-first, so no
        // duplicate-permission errors on re-runs).
        const rules = yield* ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [groupId] }],
        });
        const hasIngress = (port: number) =>
          (rules.SecurityGroupRules ?? []).some(
            (rule) => !rule.IsEgress && rule.FromPort === port,
          );
        if (!hasIngress(listenerPort)) {
          yield* ec2.authorizeSecurityGroupIngress({
            GroupId: groupId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: listenerPort,
                ToPort: listenerPort,
                IpRanges: [
                  { CidrIp: "0.0.0.0/0", Description: "listener ingress" },
                ],
              },
            ],
          });
        }
        if (containerPort !== listenerPort && !hasIngress(containerPort)) {
          yield* ec2.authorizeSecurityGroupIngress({
            GroupId: groupId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: containerPort,
                ToPort: containerPort,
                UserIdGroupPairs: [
                  { GroupId: groupId, Description: "ALB to container" },
                ],
              },
            ],
          });
        }
        return groupId;
      });

      // ── managed ingress (ALB + target group + listener) ───────────────

      const ingressNames = (id: string) =>
        Effect.gen(function* () {
          const loadBalancerName = yield* createPhysicalName({
            id: `${id}-alb`,
            maxLength: 32,
            lowercase: true,
          });
          const targetGroupName = yield* createPhysicalName({
            id: `${id}-tg`,
            maxLength: 32,
            lowercase: true,
          });
          return {
            loadBalancerName,
            targetGroupName,
          };
        });

      const createIngress = Effect.fn(function* ({
        id,
        news,
        network,
        securityGroups,
        containerPort,
      }: {
        id: string;
        news: ServiceProps;
        network: { vpcId: string; subnets: string[] };
        securityGroups: string[] | undefined;
        containerPort: number;
      }) {
        const names = yield* ingressNames(id);
        const tags = {
          ...(yield* createInternalTags(id)),
          ...news.tags,
        };

        const loadBalancer = yield* elbv2.createLoadBalancer({
          Name: names.loadBalancerName,
          Type: "application",
          Scheme: "internet-facing",
          Subnets: network.subnets,
          SecurityGroups: securityGroups,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        });
        const lb = loadBalancer.LoadBalancers?.[0];
        if (!lb?.LoadBalancerArn || !lb.DNSName) {
          return yield* Effect.die(
            new Error("Failed to create ECS service load balancer"),
          );
        }

        const targetGroup = yield* elbv2.createTargetGroup({
          Name: names.targetGroupName,
          VpcId: network.vpcId,
          TargetType: "ip",
          Protocol: "HTTP",
          Port: containerPort,
          HealthCheckPath: news.healthCheckPath ?? "/",
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        });
        const tg = targetGroup.TargetGroups?.[0];
        if (!tg?.TargetGroupArn) {
          return yield* Effect.die(
            new Error("Failed to create ECS service target group"),
          );
        }

        const listener = yield* elbv2.createListener({
          LoadBalancerArn: lb.LoadBalancerArn,
          Port: news.listenerPort ?? (news.certificateArn ? 443 : 80),
          Protocol: news.certificateArn ? "HTTPS" : "HTTP",
          Certificates: news.certificateArn
            ? [{ CertificateArn: news.certificateArn }]
            : undefined,
          DefaultActions: [
            {
              Type: "forward",
              TargetGroupArn: tg.TargetGroupArn,
            },
          ],
        });
        const ls = listener.Listeners?.[0];
        if (!ls?.ListenerArn) {
          return yield* Effect.die(
            new Error("Failed to create ECS service listener"),
          );
        }

        return {
          loadBalancerArn: lb.LoadBalancerArn,
          targetGroupArn: tg.TargetGroupArn,
          listenerArn: ls.ListenerArn,
          url: `${news.certificateArn ? "https" : "http"}://${lb.DNSName}`,
        };
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
      // plus the Alchemy-managed ingress target group (when requested).
      const loadBalancersOf = (
        news: ServiceProps,
        task: { containerName: string; port: number },
        ingress: { targetGroupArn?: string } | undefined,
      ): ecs.LoadBalancer[] | undefined => {
        const managed: ecs.LoadBalancer[] =
          ingress?.targetGroupArn && wantsManagedIngress(news)
            ? [
                {
                  targetGroupArn: ingress.targetGroupArn,
                  containerName: task.containerName,
                  containerPort: task.port,
                },
              ]
            : [];
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

          // Managed ingress security group: only when requested AND the user
          // supplied no securityGroups of their own.
          const ingressRequested = wantsManagedIngress(news);
          const securityGroupId =
            ingressRequested && !news.securityGroups
              ? (output?.securityGroupId ??
                (yield* ensureIngressSecurityGroup({
                  id,
                  vpcId: network.vpcId,
                  listenerPort:
                    news.listenerPort ?? (news.certificateArn ? 443 : 80),
                  containerPort: task.port,
                  tags: desiredTags,
                })))
              : undefined;
          const securityGroups =
            news.securityGroups ??
            (securityGroupId ? [securityGroupId] : undefined);

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

          // Ensure — create if missing. Provision public ingress if
          // requested and not already in `output`. Replacement (e.g. cluster
          // change) is handled by diff returning `{ action: "replace" }`,
          // so within reconcile we trust `output` for ingress identity.
          let ingress:
            | {
                loadBalancerArn?: string;
                targetGroupArn?: string;
                listenerArn?: string;
                url?: string;
              }
            | undefined = output?.targetGroupArn
            ? {
                loadBalancerArn: output.loadBalancerArn,
                targetGroupArn: output.targetGroupArn,
                listenerArn: output.listenerArn,
                url: output.url,
              }
            : undefined;
          if (ingressRequested && !ingress) {
            ingress = yield* createIngress({
              id,
              news,
              network,
              securityGroups,
              containerPort: task.port,
            });
          }

          const ownedAttributes = {
            securityGroupId,
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
              loadBalancers: loadBalancersOf(news, task, ingress),
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
            yield* session.note(service.serviceArn);
            return {
              serviceArn: service.serviceArn as ServiceArn,
              serviceName: service.serviceName!,
              clusterArn: service.clusterArn as ClusterArn,
              taskDefinitionArn: service.taskDefinition!,
              status: service.status ?? "ACTIVE",
              url: ingress?.url,
              loadBalancerArn: ingress?.loadBalancerArn,
              targetGroupArn: ingress?.targetGroupArn,
              listenerArn: ingress?.listenerArn,
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
              loadBalancers: loadBalancersOf(news, task, ingress),
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
            url: ingress?.url,
            loadBalancerArn: ingress?.loadBalancerArn,
            targetGroupArn: ingress?.targetGroupArn,
            listenerArn: ingress?.listenerArn,
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

          if (output.listenerArn) {
            yield* elbv2
              .deleteListener({
                ListenerArn: output.listenerArn,
              })
              .pipe(
                Effect.catchTag("ListenerNotFoundException", () => Effect.void),
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
