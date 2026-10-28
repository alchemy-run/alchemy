import { AwsAuth } from "@alchemy.run/aws/AuthProvider";
import * as CloudMap from "@alchemy.run/aws/CloudMap";
import * as AwsCredentials from "@alchemy.run/aws/Credentials";
import * as EC2 from "@alchemy.run/aws/EC2";
import * as ECS from "@alchemy.run/aws/ECS";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { Default as DefaultEnvironment } from "@alchemy.run/aws/Environment";
import * as IAM from "@alchemy.run/aws/IAM";
import * as AwsRegion from "@alchemy.run/aws/Region";
import * as S3 from "@alchemy.run/aws/S3";
import * as SQS from "@alchemy.run/aws/SQS";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { toFqn } from "alchemy/FQN";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack, type StackServices } from "alchemy/Stack";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Bootstrap } from "./Bootstrap.ts";
import { CELLD_HEALTH_PATH, CELLD_INTERNAL_PORT, CELLD_PUBLIC_PORT } from "./CelldCli.ts";
import {
  composeEc2Capacity,
  ec2NodeTaskConfiguration,
  resolveEc2NodeSizing,
  RUNSC_RELEASE,
} from "./EcsEc2.ts";
import {
  EcsHostConfigurationError,
  makeEcsDockerfile,
  makeEcsNodeIngress,
  resolveEcsHostConfiguration,
  resolveManagementRouteTables,
  validateEcsHostTransition,
  type EcsHostConfiguration,
} from "./EcsHostConfig.ts";
import { composeEcsPrivateIngress } from "./EcsPrivateIngress.ts";
import { Host, type HostService } from "./Host.ts";
import { FleetManagement } from "./Management.ts";
import {
  FleetManagementEcs,
  MANAGEMENT_PREFIX,
  managementRequestsLifecycleRule,
  type ManagementQueueState,
} from "./ManagementQueue.ts";
import { ManagementRunner, managementStorePolicy } from "./ManagementRunner.ts";
import ManagementTaskLive, { ManagementTask } from "./ManagementTask.ts";

const FLEET_CIDR = "10.61.0.0/16";

export interface EcsFleetOptions {
  /** Compute capacity. EC2 hosts are dedicated to one Celld task each, plus one spare host. @default { type: "fargate" } */
  readonly capacity?:
    | { readonly type: "fargate" }
    | {
        readonly type: "ec2";
        /** Dedicated host instance type, for example `m7i.large`. */
        readonly instanceType: ec2.InstanceType;
        /** Memory reserved for Linux, Docker, and the ECS agent. Must be at least 1024 MiB. @default 1024 */
        readonly reservedMemoryMiB?: number;
      };
  /** Sandbox runtime on dedicated EC2 hosts. Unsupported on Fargate. */
  readonly containerRuntime?: "runsc";
  /**
   * Where the trusted management runner — the only caller of the nodes'
   * private operator listener — runs inside the fleet VPC.
   *
   * - `"task"` — a Fargate task started on demand for each deploy and
   *   stopped after a short idle window. Nothing runs between deploys; the
   *   first management call of a deploy waits for the task to start.
   * - `"service"` — the same task kept running by an ECS service, so no call
   *   waits for a cold start, at the cost of one always-on Fargate task.
   * - `"lambda"` — a VPC Lambda. Calls never wait for a start, but AWS
   *   releases a VPC Lambda's network interfaces slowly, so destroying the
   *   fleet takes around 20 minutes.
   *
   * @default "task"
   */
  readonly management?: "task" | "service" | "lambda";
  /**
   * Seconds an on-demand (`"task"`) runner waits for more work before it
   * stops.
   * @default 300
   */
  readonly managementIdleSeconds?: number;
}

interface EcsHostState {
  readonly vpcId: EC2.VpcId;
  readonly subnetIds: EC2.SubnetId[];
  /** Unprivileged Worker callers attach these groups, never the node groups. */
  readonly securityGroupIds: EC2.SecurityGroupId[];
  readonly nodeSecurityGroupIds: EC2.SecurityGroupId[];
  readonly managementSecurityGroupIds: EC2.SecurityGroupId[];
  readonly managementUrl: string;
  readonly managementFunctionArn?: string;
  readonly managementQueue?: ManagementQueueState;
  readonly managementSubnetIds: EC2.SubnetId[];
  readonly clusterArn: string;
  readonly serviceName: string;
  readonly containerName: string;
  readonly configuration: EcsHostConfiguration;
  readonly autoScalingGroupName?: string;
  readonly hostCount?: number;
  readonly hostSizing?: import("./EcsEc2.ts").Ec2NodeSizing;
  readonly capabilities: {
    readonly containers: boolean;
    readonly sandbox: boolean;
  };
}

/** Compose dedicated ECS capacity with isolated Worker and management listeners. */
export const composeEcsFleet = (
  region: Effect.Effect<string, any>,
  options: EcsFleetOptions,
  describeInstanceType: (
    instanceType: ec2.InstanceType,
  ) => Effect.Effect<ec2.InstanceTypeInfo | undefined, ec2.DescribeInstanceTypesError>,
  describeManagementNetwork: (
    vpcId: string,
    region: string,
  ) => Effect.Effect<
    { routeTables: ec2.RouteTable[]; endpoints: ec2.VpcEndpoint[] },
    ec2.DescribeRouteTablesError | ec2.DescribeVpcEndpointsError | EcsHostConfigurationError
  >,
): HostService["compose"] =>
  Effect.fn(
    function* ({ id, props }) {
      const requested = yield* resolveEcsHostConfiguration(options, props);
      const sizing =
        options.capacity?.type === "ec2"
          ? yield* resolveEc2NodeSizing(
              yield* describeInstanceType(options.capacity.instanceType),
              props,
              options.capacity.reservedMemoryMiB,
            )
          : undefined;
      const configuration: EcsHostConfiguration = {
        ...requested,
        ...(options.containerRuntime === "runsc" ? { runtimeRelease: RUNSC_RELEASE } : {}),
        ...(sizing
          ? {
              architecture: sizing.architecture,
              reservedMemoryMiB: sizing.reservedMemoryMiB,
              memoryMiB: sizing.memoryMiB,
              cpuUnits: sizing.cpuUnits,
            }
          : {}),
      };
      const stack = yield* Stack;
      const regionName = yield* region;
      const state = yield* yield* State;
      const previous = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: toFqn(yield* Namespace.Parent, id),
      });
      if (previous !== undefined && !isActionState(previous)) {
        yield* validateEcsHostTransition(
          previous.attr?.hostState?.configuration ?? previous.props?.hostState?.configuration,
          configuration,
        );
      }
      const dockerfile = makeEcsDockerfile(configuration.image, configuration.capacity);
      const previousNodes = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: toFqn(yield* Namespace.CurrentNamespace, "Nodes"),
      });
      if (
        previousNodes !== undefined &&
        !isActionState(previousNodes) &&
        previousNodes.props?.dockerfile?.content !== dockerfile
      ) {
        yield* validateEcsHostTransition(undefined, configuration);
      }

      // Fleet data is retained by default; `retainStorage: false` deletes the
      // bucket, and everything in it, with the fleet.
      const retainStorage = props.retainStorage ?? true;
      const bucket = yield* S3.Bucket("Bucket", {
        tags: props.tags,
        lifecycleRules: [managementRequestsLifecycleRule],
        ...(retainStorage ? {} : { forceDestroy: true }),
      }).pipe(retainStorage ? RemovalPolicy.retain() : (effect) => effect);
      const bootstrap = yield* Bootstrap("Bootstrap", {
        bucket: {
          uri: Output.interpolate`s3://${bucket.bucketName}`,
          region: regionName,
        },
        runtimeVersion: configuration.runtimeVersion,
      });

      let vpcId: Input<EC2.VpcId>;
      let subnetIds: Input<EC2.SubnetId[]>;
      let managementSubnetIds: Input<EC2.SubnetId[]>;
      const managementMode = options.management ?? "task";
      if (props.vpc !== undefined && managementMode !== "lambda") {
        // A Fargate runner takes a public IP in the node subnets, like the
        // nodes themselves: it needs no private S3 route.
        vpcId = props.vpc.vpcId as EC2.VpcId;
        subnetIds = props.vpc.subnetIds as EC2.SubnetId[];
        managementSubnetIds = subnetIds;
      } else if (props.vpc !== undefined) {
        vpcId = props.vpc.vpcId as EC2.VpcId;
        subnetIds = props.vpc.subnetIds as EC2.SubnetId[];
        const observed = yield* describeManagementNetwork(props.vpc.vpcId, regionName);
        const endpointFqn = toFqn(yield* Namespace.CurrentNamespace, "ManagementS3Endpoint");
        const persistedEndpoint = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: endpointFqn,
        });
        const persistedEndpointId =
          persistedEndpoint && !isActionState(persistedEndpoint)
            ? persistedEndpoint.attr?.vpcEndpointId
            : undefined;
        const routeTableIds = yield* resolveManagementRouteTables({
          subnetIds: props.vpc.subnetIds,
          ...observed,
          ownedEndpointIds: observed.endpoints
            .filter((endpoint) => {
              const tags = Object.fromEntries(
                (endpoint.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
              );
              return (
                endpoint.VpcEndpointId === persistedEndpointId ||
                (tags["alchemy::stack"] === stack.name &&
                  tags["alchemy::stage"] === stack.stage &&
                  tags["alchemy::id"] === "ManagementS3Endpoint" &&
                  tags["celld:management"] === endpointFqn)
              );
            })
            .flatMap((endpoint) => (endpoint.VpcEndpointId ? [endpoint.VpcEndpointId] : [])),
        });
        if (routeTableIds.length > 0) {
          const endpoint = yield* EC2.VpcEndpoint("ManagementS3Endpoint", {
            vpcId,
            serviceName: `com.amazonaws.${regionName}.s3`,
            vpcEndpointType: "Gateway",
            routeTableIds,
            tags: { ...props.tags, "celld:management": endpointFqn },
          });
          managementSubnetIds = endpoint.vpcEndpointId.pipe(
            Output.map(() => props.vpc!.subnetIds as EC2.SubnetId[]),
          );
        } else {
          managementSubnetIds = subnetIds;
        }
      } else {
        const network = yield* EC2.Network("Network", {
          cidrBlock: FLEET_CIDR,
          availabilityZones: 2,
          nat: "none",
          gatewayEndpoints: ["s3"],
          tags: props.tags,
        });
        vpcId = network.vpcId;
        subnetIds = network.publicSubnetIds;
        managementSubnetIds =
          managementMode !== "lambda"
            ? subnetIds
            : network.privateSubnets.map((subnet, index) =>
                Output.all(
                  subnet.subnetId,
                  network.privateRouteAssociations[index]!.associationId,
                  network.gatewayEndpoints[0]!.vpcEndpointId,
                ).pipe(Output.map(([subnetId]) => subnetId)),
              );
      }
      const callers = yield* EC2.SecurityGroup("CallerSecurityGroup", {
        vpcId,
        description: `Celld fleet ${id} Worker callers (no operator access)`,
        tags: props.tags,
      });
      const management = yield* EC2.SecurityGroup("ManagementSecurityGroup", {
        vpcId,
        description: `Celld fleet ${id} trusted private management runner`,
        tags: props.tags,
      });
      const nodes = yield* EC2.SecurityGroup("SecurityGroup", {
        vpcId,
        description: `Celld fleet ${id} nodes`,
        ingress: makeEcsNodeIngress(
          callers.groupId,
          management.groupId,
          props.vpc?.securityGroupIds,
        ),
        tags: props.tags,
      });
      for (const port of [CELLD_PUBLIC_PORT, CELLD_INTERNAL_PORT]) {
        yield* EC2.SecurityGroupRule(`NodeTraffic${port}`, {
          groupId: nodes.groupId,
          type: "ingress",
          ipProtocol: "tcp",
          fromPort: port,
          toPort: port,
          referencedGroupId: nodes.groupId,
          description: "Fleet nodes only",
          tags: props.tags,
        });
      }

      const policy = yield* IAM.Policy("BucketAccess", {
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:ListBucket", "s3:GetBucketLocation"],
              Resource: [bucket.bucketArn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        },
        tags: props.tags,
      });
      const capacity =
        sizing && options.capacity?.type === "ec2"
          ? yield* composeEc2Capacity({
              identity: `${stack.name}/${stack.stage}/${toFqn(yield* Namespace.Parent, id)}`,
              region: regionName,
              instanceType: options.capacity.instanceType,
              sizing,
              runtime: options.containerRuntime,
              subnetIds,
              securityGroupIds: [nodes.groupId],
              tags: props.tags,
            })
          : undefined;
      const cluster = capacity?.cluster ?? (yield* ECS.Cluster("Cluster", { tags: props.tags }));
      const privateIngress = capacity
        ? yield* composeEcsPrivateIngress({
            vpcId,
            subnetIds,
            callerGroupId: callers.groupId,
            managementGroupId: management.groupId,
            nodeGroupId: nodes.groupId,
            existingCallers: props.vpc?.securityGroupIds,
            tags: props.tags,
          })
        : undefined;
      const namespace = capacity
        ? undefined
        : yield* CloudMap.PrivateDnsNamespace("Discovery", {
            name: `${stack.stage}-${id}.celld.internal`.toLowerCase(),
            vpc: vpcId,
            tags: props.tags,
          });
      const discovery = namespace && {
        namespace,
        service: yield* CloudMap.Service("FleetRecord", {
          name: "fleet",
          namespaceId: namespace.namespaceId,
          dnsRecords: [{ type: "A", ttl: "10 seconds" }],
          healthCheckCustomConfig: { failureThreshold: 1 },
          tags: props.tags,
        }),
      };
      const fleetUrl =
        privateIngress?.fleetUrl ??
        Output.interpolate`http://${discovery!.service.serviceName}.${discovery!.namespace.namespaceName}:${String(CELLD_PUBLIC_PORT)}`;
      const managementUrl =
        privateIngress?.managementUrl ??
        Output.interpolate`http://${discovery!.service.serviceName}.${discovery!.namespace.namespaceName}:${String(CELLD_INTERNAL_PORT)}`;
      const instances = props.instances ?? 2;
      const ec2Task = capacity ? ec2NodeTaskConfiguration(options.containerRuntime) : undefined;
      // Public ingress: the node service's managed load balancer, in its own
      // security group that admits only the listener ports. The nodes admit
      // it on the Worker listener alone, never the private 8081 listener.
      const ingressSecurityGroup = props.ingress
        ? yield* EC2.SecurityGroup("IngressSecurityGroup", {
            vpcId,
            description: `Celld fleet ${id} public ingress`,
            ingress: [80, 443].flatMap((port) => [
              { ipProtocol: "tcp", fromPort: port, toPort: port, cidrIpv4: "0.0.0.0/0" },
              { ipProtocol: "tcp", fromPort: port, toPort: port, cidrIpv6: "::/0" },
            ]),
            tags: props.tags,
          })
        : undefined;
      if (ingressSecurityGroup) {
        yield* EC2.SecurityGroupRule("IngressToNodes", {
          groupId: nodes.groupId,
          type: "ingress",
          ipProtocol: "tcp",
          fromPort: CELLD_PUBLIC_PORT,
          toPort: CELLD_PUBLIC_PORT,
          referencedGroupId: ingressSecurityGroup.groupId,
          description: "Public load balancer to the Worker listener only",
          tags: props.tags,
        });
      }
      const ingress = props.ingress === true ? {} : props.ingress;
      const service = yield* ECS.Service("Nodes", {
        cluster,
        dockerfile: { content: dockerfile },
        port: CELLD_PUBLIC_PORT,
        ...(capacity && ec2Task
          ? {
              ...ec2Task,
              capacityProviderStrategy: capacity.capacityProviderStrategy,
              loadBalancers: privateIngress!.loadBalancers,
            }
          : {
              launchType: "FARGATE" as const,
              networkMode: "awsvpc" as const,
              requiresCompatibilities: ["FARGATE" as const],
            }),
        desiredCount: typeof instances === "number" ? instances : undefined,
        scaling:
          typeof instances === "object"
            ? {
                min: instances.min,
                max: instances.max,
                cpuUtilization: instances.targetCpu ?? 60,
              }
            : undefined,
        cpu: sizing?.cpuUnits ?? props.cpu ?? 512,
        memory: sizing?.memoryMiB ?? props.memory ?? 1024,
        runtimePlatform: {
          cpuArchitecture: sizing?.architecture ?? props.cpuArchitecture ?? "ARM64",
          operatingSystemFamily: "LINUX",
        },
        vpcId,
        subnets: subnetIds,
        // With public ingress the managed load balancer shares the service's
        // groups: Fargate tasks keep the node group, the balancer adds the
        // ingress group (EC2 host networking only applies it to the balancer).
        securityGroups: capacity
          ? ingressSecurityGroup && [ingressSecurityGroup.groupId]
          : [nodes.groupId, ...(ingressSecurityGroup ? [ingressSecurityGroup.groupId] : [])],
        loadBalancer: ingress
          ? {
              public: true,
              domain: ingress.domain,
              // With a domain, plain HTTP redirects to its HTTPS listener.
              ...(ingress.domain
                ? {
                    rules: [
                      { listen: "80/http" as const, redirect: "443/https" as const },
                      {
                        listen: "443/https" as const,
                        forward: `${CELLD_PUBLIC_PORT}/http` as const,
                      },
                    ],
                  }
                : {}),
            }
          : undefined,
        healthCheckPath: ingress ? CELLD_HEALTH_PATH : undefined,
        assignPublicIp: capacity ? undefined : true,
        container: ec2Task?.container ?? { stopTimeout: 120 },
        healthCheck: {
          command: [
            "CMD",
            "/alchemy/busybox",
            "wget",
            "-qO-",
            `http://127.0.0.1:${CELLD_PUBLIC_PORT}${CELLD_HEALTH_PATH}`,
          ],
          interval: "10 seconds",
          timeout: "5 seconds",
          retries: 3,
          startPeriod: "60 seconds",
        },
        env: {
          ...ec2Task?.env,
          CELLD_BUCKET: Output.interpolate`s3://${bucket.bucketName}`,
          CELLD_BOOTSTRAP_VERSION: bootstrap.version,
          AWS_REGION: regionName,
        },
        taskRoleManagedPolicyArns: [policy.policyArn],
        serviceRegistries: discovery ? [{ registryArn: discovery.service.serviceArn }] : undefined,
        tags: props.tags,
      });
      const partition = regionName.startsWith("cn-")
        ? "aws-cn"
        : regionName.startsWith("us-gov-")
          ? "aws-us-gov"
          : "aws";
      const minimumNodes = typeof instances === "number" ? instances : instances.min;
      let runnerState: Pick<
        { [K in keyof EcsHostState]: Input<Exclude<EcsHostState[K], undefined>> },
        "managementFunctionArn" | "managementQueue"
      >;
      if (managementMode === "lambda") {
        const runner = yield* ManagementRunner("Management", {
          bucketName: bucket.bucketName,
          minimumNodes,
          partition,
          vpc: {
            subnetIds: managementSubnetIds,
            securityGroupIds: [management.groupId],
          },
        });
        runnerState = { managementFunctionArn: runner.functionArn };
      } else {
        const queue = yield* SQS.Queue("ManagementQueue", {
          visibilityTimeout: "2 minutes",
          messageRetentionPeriod: "5 minutes",
          receiveMessageWaitTime: "20 seconds",
        });
        const task = yield* ManagementTask.pipe(Effect.provide(ManagementTaskLive));
        const managementArn = Output.interpolate`arn:${partition}:s3:::${bucket.bucketName}/${MANAGEMENT_PREFIX}/*`;
        yield* task.bind("CelldManagement", {
          env: {
            CELLD_MANAGEMENT_BUCKET: bucket.bucketName,
            CELLD_MANAGEMENT_MINIMUM_NODES: String(minimumNodes),
            CELLD_MANAGEMENT_QUEUE_URL: queue.queueUrl,
            CELLD_MANAGEMENT_IDLE_SECONDS: String(
              managementMode === "task" ? (options.managementIdleSeconds ?? 300) : 0,
            ),
          },
          policyStatements: [
            ...managementStorePolicy(partition, bucket.bucketName),
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject"],
              Resource: [managementArn],
            },
            {
              Effect: "Allow",
              Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
              Resource: [queue.queueArn],
            },
          ],
        });
        if (managementMode === "service") {
          yield* ECS.Service("ManagementService", {
            cluster,
            task: {
              taskDefinitionArn: task.taskDefinitionArn,
              containerName: task.containerName,
              // The runner serves no traffic; the port only matters to load balancers.
              port: CELLD_PUBLIC_PORT,
            },
            desiredCount: 1,
            launchType: "FARGATE",
            vpcId,
            subnets: subnetIds,
            securityGroups: [management.groupId],
            assignPublicIp: true,
            tags: props.tags,
          });
        }
        runnerState = {
          managementQueue: {
            queueUrl: queue.queueUrl,
            ...(managementMode === "task"
              ? {
                  launch: {
                    clusterArn: cluster.clusterArn,
                    taskDefinitionArn: task.taskDefinitionArn,
                    subnetIds,
                    securityGroupIds: [management.groupId],
                  },
                }
              : {}),
          },
        };
      }
      const hostState: { [K in keyof EcsHostState]: Input<Exclude<EcsHostState[K], undefined>> } = {
        vpcId,
        subnetIds,
        securityGroupIds: [callers.groupId],
        nodeSecurityGroupIds: [nodes.groupId],
        managementSecurityGroupIds: [management.groupId],
        managementSubnetIds,
        ...runnerState,
        managementUrl,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
        containerName: service.containerName.pipe(
          Output.map((name: string | undefined) => name ?? "main"),
        ),
        configuration,
        capabilities: {
          containers: capacity !== undefined,
          sandbox: capacity !== undefined && options.containerRuntime === "runsc",
        },
        ...(capacity && sizing
          ? {
              autoScalingGroupName: capacity.autoScalingGroupName,
              hostCount: capacity.hostCount,
              hostSizing: sizing,
            }
          : {}),
      };
      return {
        bucket: {
          uri: Output.interpolate`s3://${bucket.bucketName}`,
          region: regionName,
        },
        fleetUrl,
        publicUrl: ingress ? service.url : undefined,
        hostState,
      };
    },
    (effect, { id }) => effect.pipe(Namespace.push(id)),
  );

const collectNetworkPages = <A, E>(
  fetch: (token: string | undefined) => Effect.Effect<{ items: A[]; nextToken?: string }, E>,
) =>
  Effect.gen(function* () {
    const items: A[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = yield* fetch(token);
      items.push(...result.items);
      token = result.nextToken;
      if (!token) return items;
    }
    return yield* new EcsHostConfigurationError({
      message:
        "Management network discovery exceeded ten pages; refusing an incomplete S3 route inventory.",
    });
  });

const awsEnvironment = Layer.mergeAll(
  AwsRegion.fromEnvironment,
  AwsCredentials.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);

/**
 * ECS host with Fargate as the default. Workers use port 8080; only nodes
 * and the trusted management runner can access the private 8081 listener.
 * Storage is retained when the fleet is removed. Runtime upgrades within the
 * supported release series, image changes and node resizing roll out as ECS
 * rolling deployments.
 *
 * EC2 uses a dedicated ASG with one task per host and one spare host. Child
 * containers run on the host Docker daemon, outside ECS task accounting;
 * the node's memory budget includes their reservations. Fixed node counts
 * are required rather than task-CPU autoscaling. The S3 bucket is durable;
 * host scratch and child containers are disposable after graceful drain.
 *
 * ### Composing the Host
 * **Example:** Use the default Fargate host
 * ```typescript
 * const providers = Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet());
 * ```
 *
 * ### Hosting the Management Runner
 * Deploys reach the nodes' private operator listener through a runner inside
 * the fleet VPC. By default it is a Fargate task started on demand and
 * stopped when idle; keep it running to skip the first call's cold start.
 *
 * **Example:** Keep the runner running
 * ```typescript
 * const host = Celld.EcsFleet({ management: "service" });
 * ```
 *
 * ### Dedicated EC2 Hosts
 * **Example:** Containers and Sandbox with gVisor
 * ```typescript
 * const host = Celld.EcsFleet({
 *   capacity: { type: "ec2", instanceType: "m7i.large" },
 *   containerRuntime: "runsc",
 * });
 * ```
 *
 * @layer
 * @provides Celld.Host
 * @provides Celld.FleetManagement
 * @product Celld
 */
export const EcsFleet = (
  options: EcsFleetOptions = {},
): Layer.Layer<Host | FleetManagement, never, StackServices> =>
  Layer.mergeAll(
    FleetManagementEcs,
    Layer.effect(
      Host,
      Effect.gen(function* () {
        const credentials = yield* Credentials;
        const region = yield* Region;
        const describeInstanceTypes = yield* ec2.describeInstanceTypes;
        const describeRouteTables = yield* ec2.describeRouteTables;
        const describeVpcEndpoints = yield* ec2.describeVpcEndpoints;
        const storageCredentials: HostService["deployEnv"] = () =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            return {
              AWS_ACCESS_KEY_ID: Redacted.value(resolved.accessKeyId),
              AWS_SECRET_ACCESS_KEY: Redacted.value(resolved.secretAccessKey),
              ...(resolved.sessionToken !== undefined
                ? { AWS_SESSION_TOKEN: Redacted.value(resolved.sessionToken) }
                : {}),
              AWS_REGION: yield* region,
            };
          });
        return {
          compose: composeEcsFleet(
            region,
            options,
            (instanceType) =>
              describeInstanceTypes({ InstanceTypes: [instanceType] }).pipe(
                Effect.map((response) => response.InstanceTypes?.[0]),
              ),
            (vpcId, regionName) =>
              Effect.all({
                routeTables: collectNetworkPages((NextToken) =>
                  describeRouteTables({
                    Filters: [{ Name: "vpc-id", Values: [vpcId] }],
                    NextToken,
                  }).pipe(
                    Effect.map((response) => ({
                      items: response.RouteTables ?? [],
                      nextToken: response.NextToken,
                    })),
                  ),
                ),
                endpoints: collectNetworkPages((NextToken) =>
                  describeVpcEndpoints({
                    Filters: [
                      { Name: "vpc-id", Values: [vpcId] },
                      {
                        Name: "service-name",
                        Values: [`com.amazonaws.${regionName}.s3`],
                      },
                    ],
                    NextToken,
                  }).pipe(
                    Effect.map((response) => ({
                      items: response.VpcEndpoints ?? [],
                      nextToken: response.NextToken,
                    })),
                  ),
                ),
              }),
          ),
          deployEnv: storageCredentials,
          storageCredentials,
          restartNodes: () => Effect.void,
        } satisfies HostService;
      }),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(awsEnvironment, FetchHttpClient.layer)), Layer.orDie);
