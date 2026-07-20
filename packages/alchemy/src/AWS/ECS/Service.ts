import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { ClusterArn } from "./Cluster.ts";

export type ServiceName = string;
export type ServiceArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:service/${string}/${ServiceName}`;

export interface ServiceProps {
  /**
   * ECS cluster that will own the service.
   */
  cluster: Input<ClusterArn> | { clusterArn: Input<ClusterArn> };

  /**
   * Bundled ECS task to run for each service replica.
   *
   * This is the runtime-facing subset of `AWS.ECS.Task` attributes that the
   * service needs in order to deploy and wire load balancer traffic.
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
   */
  vpcId: string;

  /**
   * Subnets used by the service's awsvpc network configuration. Updated in
   * place via `updateService`.
   */
  subnets: string[];

  /**
   * Security groups attached to the service ENIs and, when `public: true`, the
   * generated Application Load Balancer. Updated in place.
   */
  securityGroups?: string[];

  /**
   * Whether the service ENIs should receive public IPs. Updated in place.
   * @default false
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
   * For an Alchemy-managed public ALB instead, set {@link public} to `true`.
   */
  loadBalancers?: ecs.LoadBalancer[];

  /**
   * Cloud Map service registries (service discovery) to associate with the
   * service.
   */
  serviceRegistries?: ecs.ServiceRegistry[];

  /**
   * Whether Alchemy should provision a public Application Load Balancer and
   * listener in front of the service. When set, the generated target group is
   * appended to {@link loadBalancers}.
   * @default false
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
     * `public: true`.
     */
    url?: string;

    /**
     * ARN of the generated load balancer, when `public: true`.
     */
    loadBalancerArn?: string;

    /**
     * ARN of the generated target group, when `public: true`.
     */
    targetGroupArn?: string;

    /**
     * ARN of the generated listener, when `public: true`.
     */
    listenerArn?: string;
  },
  never,
  Providers
> {}

/**
 * An ECS service for running long-lived tasks.
 *
 * `Service` keeps a registered task definition running with awsvpc networking.
 * Load balancing is **explicit**: pass user-supplied `loadBalancers` target
 * groups, or set `public: true` to have Alchemy provision a public ALB +
 * listener + target group as a convenience. Launch behavior is controlled via
 * `launchType` (default `FARGATE`) or a `capacityProviderStrategy`.
 *
 * Most configuration is updated **in place** via `updateService`
 * (desiredCount, task definition, network, deployment config, placement,
 * exec, load balancers, tags). Only truly-immutable aspects — `serviceName`,
 * `cluster`, launchType↔capacityProviderStrategy switch, `deploymentController`
 * type, `schedulingStrategy`, `enableECSManagedTags`, `role` — replace the
 * service.
 * @resource
 * @section Creating Services
 * @example Internal Service
 * ```typescript
 * const service = yield* Service("WorkerService", {
 *   cluster,
 *   task: workerTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [privateSubnet1.subnetId, privateSubnet2.subnetId],
 *   securityGroups: [workerSecurityGroup.groupId],
 *   desiredCount: 2,
 * });
 * ```
 *
 * @example Public HTTP Service (Alchemy-managed ALB)
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [publicSubnet1.subnetId, publicSubnet2.subnetId],
 *   securityGroups: [serviceSecurityGroup.groupId],
 *   public: true,
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
export const Service = Resource<Service>("AWS.ECS.Service");

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
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
      }: {
        id: string;
        news: ServiceProps;
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
          Subnets: news.subnets,
          SecurityGroups: news.securityGroups,
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
          VpcId: news.vpcId,
          TargetType: "ip",
          Protocol: "HTTP",
          Port: news.task.port ?? 3000,
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

      const networkConfigurationOf = (news: ServiceProps) => ({
        awsvpcConfiguration: {
          subnets: news.subnets,
          securityGroups: news.securityGroups,
          assignPublicIp: (news.assignPublicIp ? "ENABLED" : "DISABLED") as
            | "ENABLED"
            | "DISABLED",
        },
      });

      // load balancers passed to create/update: explicit user-supplied list
      // plus the Alchemy-managed ingress target group (when `public: true`).
      const loadBalancersOf = (
        news: ServiceProps,
        ingress: { targetGroupArn?: string } | undefined,
      ): ecs.LoadBalancer[] | undefined => {
        const managed: ecs.LoadBalancer[] =
          ingress?.targetGroupArn && news.public
            ? [
                {
                  targetGroupArn: ingress.targetGroupArn,
                  containerName: news.task.containerName,
                  containerPort: news.task.port ?? 3000,
                },
              ]
            : [];
        const all = [...(news.loadBalancers ?? []), ...managed];
        return all.length > 0 ? all : undefined;
      };

      // In-place mutable fields shared by createService and updateService.
      const mutableInput = (news: ServiceProps) => ({
        taskDefinition: news.task.taskDefinitionArn,
        desiredCount: news.desiredCount ?? 1,
        platformVersion: news.platformVersion,
        deploymentConfiguration: news.deploymentConfiguration,
        healthCheckGracePeriodSeconds: toWireSeconds(
          news.healthCheckGracePeriod,
        ),
        networkConfiguration: networkConfigurationOf(news),
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
        diff: Effect.fn(function* ({ id, olds, news }) {
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
          const oldClusterArn = clusterArnOf(olds.cluster);
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
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const serviceName = yield* toServiceName(id, news);
          const clusterArn = clusterArnOf(news.cluster) as ClusterArn;
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

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

          if (!observed?.serviceArn) {
            // Provision Alchemy-managed ALB ingress only when requested.
            if (news.public && !ingress) {
              ingress = yield* createIngress({ id, news });
            }

            const created = yield* ecs.createService({
              ...mutableInput(news),
              serviceName,
              cluster: clusterArn,
              loadBalancers: loadBalancersOf(news, ingress),
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
            };
          }

          // Sync — apply in-place mutable fields via updateService. Force a new
          // deployment so a changed task definition (same revision-less ARN) or
          // load-balancer wiring rolls out.
          const updated = yield* ecs
            .updateService({
              ...mutableInput(news),
              service: serviceName,
              cluster: clusterArn,
              loadBalancers: loadBalancersOf(news, ingress),
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
          };
        }),
        delete: Effect.fn(function* ({ output }) {
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
        }),
      };
    }),
  );
