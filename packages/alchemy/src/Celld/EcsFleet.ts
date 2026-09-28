import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { AwsAuth } from "../AWS/AuthProvider.ts";
import * as CloudMap from "../AWS/CloudMap/index.ts";
import * as AwsCredentials from "../AWS/Credentials.ts";
import * as EC2 from "../AWS/EC2/index.ts";
import * as ECS from "../AWS/ECS/index.ts";
import * as Endpoint from "../AWS/Endpoint.ts";
import { Default as DefaultEnvironment } from "../AWS/Environment.ts";
import * as IAM from "../AWS/IAM/index.ts";
import * as AwsRegion from "../AWS/Region.ts";
import * as S3 from "../AWS/S3/index.ts";
import { toFqn } from "../FQN.ts";
import type { Input } from "../Input.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import * as RemovalPolicy from "../RemovalPolicy.ts";
import { Stack, type StackServices } from "../Stack.ts";
import { isActionState, State } from "../State/State.ts";
import { Bootstrap } from "./Bootstrap.ts";
import {
  CELLD_HEALTH_PATH,
  CELLD_INTERNAL_PORT,
  CELLD_PUBLIC_PORT,
} from "./CelldCli.ts";
import {
  EcsHostConfigurationError,
  makeEcsDockerfile,
  makeEcsNodeIngress,
  resolveEcsHostConfiguration,
  resolveManagementRouteTables,
  validateEcsHostTransition,
  type EcsHostConfiguration,
} from "./EcsHostConfig.ts";
import { Host, type HostService } from "./Host.ts";
import {
  composeEc2Capacity,
  ec2NodeTaskConfiguration,
  resolveEc2NodeSizing,
  RUNSC_RELEASE,
} from "./EcsEc2.ts";
import { composeEcsPrivateIngress } from "./EcsPrivateIngress.ts";
import { FleetManagement } from "./Management.ts";
import { FleetManagementLambda, ManagementRunner } from "./ManagementRunner.ts";

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
}

interface EcsHostState {
  readonly vpcId: EC2.VpcId;
  readonly subnetIds: EC2.SubnetId[];
  /** Unprivileged Worker callers attach these groups, never the node groups. */
  readonly securityGroupIds: EC2.SecurityGroupId[];
  readonly nodeSecurityGroupIds: EC2.SecurityGroupId[];
  readonly managementSecurityGroupIds: EC2.SecurityGroupId[];
  readonly managementUrl: string;
  readonly managementFunctionArn: string;
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
  region: Effect.Effect<string>,
  options: EcsFleetOptions,
  describeInstanceType: (
    instanceType: ec2.InstanceType,
  ) => Effect.Effect<
    ec2.InstanceTypeInfo | undefined,
    ec2.DescribeInstanceTypesError
  >,
  describeManagementNetwork: (
    vpcId: string,
    region: string,
  ) => Effect.Effect<
    { routeTables: ec2.RouteTable[]; endpoints: ec2.VpcEndpoint[] },
    | ec2.DescribeRouteTablesError
    | ec2.DescribeVpcEndpointsError
    | EcsHostConfigurationError
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
        ...(options.containerRuntime === "runsc"
          ? { runtimeRelease: RUNSC_RELEASE }
          : {}),
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
          previous.attr?.hostState?.configuration ??
            previous.props?.hostState?.configuration,
          configuration,
        );
      }
      const dockerfile = makeEcsDockerfile(
        configuration.image,
        configuration.capacity,
      );
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

      const bucket = yield* S3.Bucket("Bucket", {
        tags: props.tags,
      }).pipe(RemovalPolicy.retain());
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
      if (props.vpc !== undefined) {
        vpcId = props.vpc.vpcId as EC2.VpcId;
        subnetIds = props.vpc.subnetIds as EC2.SubnetId[];
        const observed = yield* describeManagementNetwork(
          props.vpc.vpcId,
          regionName,
        );
        const endpointFqn = toFqn(
          yield* Namespace.CurrentNamespace,
          "ManagementS3Endpoint",
        );
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
            .flatMap((endpoint) =>
              endpoint.VpcEndpointId ? [endpoint.VpcEndpointId] : [],
            ),
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
        managementSubnetIds = network.privateSubnets.map((subnet, index) =>
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
      const cluster =
        capacity?.cluster ??
        (yield* ECS.Cluster("Cluster", { tags: props.tags }));
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
      const discovery = capacity
        ? undefined
        : yield* Effect.gen(function* () {
            const namespace = yield* CloudMap.PrivateDnsNamespace("Discovery", {
              name: `${stack.stage}-${id}.celld.internal`.toLowerCase(),
              vpc: vpcId,
              tags: props.tags,
            });
            const service = yield* CloudMap.Service("FleetRecord", {
              name: "fleet",
              namespaceId: namespace.namespaceId,
              dnsRecords: [{ type: "A", ttl: "10 seconds" }],
              healthCheckCustomConfig: { failureThreshold: 1 },
              tags: props.tags,
            });
            return { namespace, service };
          });
      const fleetUrl =
        privateIngress?.fleetUrl ??
        Output.interpolate`http://${discovery!.service.serviceName}.${discovery!.namespace.namespaceName}:${String(CELLD_PUBLIC_PORT)}`;
      const managementUrl =
        privateIngress?.managementUrl ??
        Output.interpolate`http://${discovery!.service.serviceName}.${discovery!.namespace.namespaceName}:${String(CELLD_INTERNAL_PORT)}`;
      const instances = props.instances ?? 2;
      const ec2Task = capacity
        ? ec2NodeTaskConfiguration(options.containerRuntime)
        : undefined;
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
          cpuArchitecture:
            sizing?.architecture ?? props.cpuArchitecture ?? "ARM64",
          operatingSystemFamily: "LINUX",
        },
        vpcId,
        subnets: subnetIds,
        securityGroups: capacity ? undefined : [nodes.groupId],
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
        serviceRegistries: discovery
          ? [{ registryArn: discovery.service.serviceArn }]
          : undefined,
        tags: props.tags,
      });
      const runner = yield* ManagementRunner("Management", {
        bucketName: bucket.bucketName,
        minimumNodes: typeof instances === "number" ? instances : instances.min,
        partition: regionName.startsWith("cn-")
          ? "aws-cn"
          : regionName.startsWith("us-gov-")
            ? "aws-us-gov"
            : "aws",
        vpc: {
          subnetIds: managementSubnetIds,
          securityGroupIds: [management.groupId],
        },
      });
      const hostState: { [K in keyof EcsHostState]: Input<EcsHostState[K]> } = {
        vpcId,
        subnetIds,
        securityGroupIds: [callers.groupId],
        nodeSecurityGroupIds: [nodes.groupId],
        managementSecurityGroupIds: [management.groupId],
        managementSubnetIds,
        managementFunctionArn: runner.functionArn,
        managementUrl,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
        containerName: service.containerName.pipe(
          Output.map((name: string | undefined) => name ?? "main"),
        ),
        configuration,
        capabilities: {
          containers: capacity !== undefined,
          sandbox:
            capacity !== undefined && options.containerRuntime === "runsc",
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
        hostState,
      };
    },
    (effect, { id }) => effect.pipe(Namespace.push(id)),
  );

const composeEcsFleetIngress: HostService["ingress"] = Effect.fn(function* ({
  fleet,
  domain,
}) {
  const state = fleet.hostState as unknown as Output.Output<EcsHostState>;
  const field = <K extends keyof EcsHostState>(key: K) =>
    state.pipe(Output.map((s: EcsHostState) => s[key]));
  const ingress = yield* ECS.ServiceIngress("Ingress", {
    network: { vpcId: field("vpcId"), subnetIds: field("subnetIds") },
    service: {
      clusterArn: field("clusterArn"),
      serviceName: field("serviceName"),
      containerName: field("containerName"),
    },
    networkMode: field("configuration").pipe(
      Output.map((configuration) =>
        configuration.capacity === "ec2" ? "host" : "awsvpc",
      ),
    ),
    port: CELLD_PUBLIC_PORT,
    healthCheck: { path: CELLD_HEALTH_PATH },
    domain,
    tags: fleet.Props?.tags,
  });
  yield* EC2.SecurityGroupRule("IngressToNodes", {
    groupId: field("nodeSecurityGroupIds").pipe(
      Output.map((groups) => groups[0]!),
    ),
    type: "ingress",
    ipProtocol: "tcp",
    fromPort: CELLD_PUBLIC_PORT,
    toPort: CELLD_PUBLIC_PORT,
    referencedGroupId: ingress.securityGroup.groupId,
    description: "Public ALB to Worker listener only",
    tags: fleet.Props?.tags,
  });
  return {
    url: ingress.url,
    dnsName: ingress.dnsName,
    validationRecords: ingress.validationRecords,
  };
});

const collectNetworkPages = <A, E>(
  fetch: (
    token: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextToken?: string }, E>,
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
 * Storage is retained when the fleet is removed. Runtime upgrades require
 * a stopped-fleet maintenance procedure.
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
    FleetManagementLambda,
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
          ingress: composeEcsFleetIngress,
          deployEnv: storageCredentials,
          storageCredentials,
          restartNodes: () => Effect.void,
        } satisfies HostService;
      }),
    ),
  ).pipe(
    Layer.provide(Layer.mergeAll(awsEnvironment, FetchHttpClient.layer)),
    Layer.orDie,
  );
