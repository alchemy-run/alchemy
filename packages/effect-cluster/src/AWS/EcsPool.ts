import * as EC2 from "@alchemy.run/aws/EC2";
import type { SecurityGroup } from "@alchemy.run/aws/EC2/SecurityGroup";
import * as ECS from "@alchemy.run/aws/ECS";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT, RUNNER_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, RUNNER_DOCKERFILE, type PoolSettings } from "../internal/PoolHost.ts";

/** Where AWS publishes the certificate authorities of every RDS region. */
const RDS_CA_BUNDLE = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";

const RDS_RUNNER_DOCKERFILE = RUNNER_DOCKERFILE.replace(
  "ENV NODE_ENV=production",
  `ENV NODE_ENV=production
ADD ${RDS_CA_BUNDLE} /etc/ssl/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-ca.pem`,
);
import type { Gateway } from "./Gateway.ts";
import { awsNetworkOf, makeAwsGateway } from "./internal/Gateway.ts";
import { resolveNetwork, resolveResource } from "./internal/Network.ts";
import type { NetworkInput, ResourceInput } from "./Network.ts";

export interface EcsPoolOptions extends PoolSettings {
  /**
   * Number of runners.
   * @default 2
   */
  replicas?: number;
  /**
   * CPU units of each runner (1024 = 1 vCPU).
   * @default 512
   */
  cpu?: number;
  /**
   * Memory of each runner, in MiB.
   * @default 1024
   */
  memory?: number;
  /**
   * CPU architecture of the pool. The image is built for it on the
   * deploying machine.
   * @default "X86_64"
   */
  architecture?: "X86_64" | "ARM64";
  /**
   * Where callers reach the pool: `ClusterAWS.LoadBalancerGateway(…)` or
   * `ClusterAWS.CloudFrontGateway(…)`.
   * @default ClusterAWS.LoadBalancerGateway(): internet-facing, plain HTTP
   */
  gateway?: Gateway;
  /**
   * The VPC runners run in when the database is in none, such as
   * `Cluster.Database.fromUrl`. Ignored when the database is in a VPC.
   */
  network?: NetworkInput;
  /**
   * With a `network`, the security group every runner joins. It must reach
   * the database and let runners reach each other on port 34431. When
   * omitted, the pool creates one that does the second.
   */
  securityGroup?: ResourceInput<SecurityGroup>;
}

/** A security group for a pool's runners, which reach each other on the runner port. */
const runnersGroup = Effect.fn(function* (id: string, vpcId: Input<EC2.VpcId>) {
  const runners = yield* EC2.SecurityGroup(`${id}RunnersGroup`, {
    vpcId,
    description: "Effect Cluster runners",
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  // Runners send each other messages for the shards they own.
  yield* EC2.SecurityGroupRule(`${id}RunnerPeers`, {
    groupId: runners.groupId,
    type: "ingress",
    ipProtocol: "tcp",
    fromPort: RUNNER_PORT,
    toPort: RUNNER_PORT,
    referencedGroupId: runners.groupId,
  });
  return runners;
});

/**
 * Run a pool of Effect Cluster runners on ECS Fargate: an ECS service whose tasks
 * host every class given this pool, in the database's VPC, behind the
 * gateway its callers reach it through. With a database in no VPC
 * (`Cluster.Database.fromUrl`), give the pool its `network`.
 *
 * Runners reach each other and the database through the cluster's runner
 * security group; the gateway's load balancer only reaches the gateway, which
 * checks every call's token.
 *
 * ### Running on ECS
 * **Example:** Two runners on Fargate
 * ```typescript
 * export const Database = ClusterAWS.Database("Cluster");
 * export const Default = ClusterAWS.EcsPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * **Example:** Larger Graviton runners
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   cpu: 2048,
 *   memory: 4096,
 *   architecture: "ARM64",
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * ### Choosing the gateway
 * Without a `gateway`, an internet-facing load balancer serves plain HTTP.
 *
 * **Example:** HTTPS on your domain
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.LoadBalancerGateway({ domain: "cluster.example.com" }),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * **Example:** HTTPS without a domain, through CloudFront
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.CloudFrontGateway(),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * **Example:** Only callers inside the VPC
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.LoadBalancerGateway({ scheme: "internal" }),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * ### Running beside a database by URL
 * **Example:** Runners in a VPC another stack owns
 * ```typescript
 * export const Database = Cluster.Database.fromUrl(Config.redacted("DATABASE_URL"));
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   network: {
 *     vpc: EC2.Vpc.ref("AppVpc", { stack: "network" }),
 *     subnets: [
 *       EC2.Subnet.ref("PrivateSubnetA", { stack: "network" }),
 *       EC2.Subnet.ref("PrivateSubnetB", { stack: "network" }),
 *     ],
 *   },
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const EcsPool = (id: string, options: EcsPoolOptions = {}) =>
  makePoolLayer({
    label: "ClusterAWS.EcsPool",
    id,
    settings: options,
    expected: "an AWS VPC (ClusterAWS.Database)",
    // The runner image trusts the RDS certificate authority, so runners
    // verify the database's certificate.
    dockerfile: RDS_RUNNER_DOCKERFILE,
    network: awsNetworkOf,
    ownNetwork: Effect.gen(function* () {
      if (options.network === undefined) return undefined;
      const network = yield* resolveNetwork(options.network);
      const runners =
        options.securityGroup === undefined
          ? yield* runnersGroup(id, network.vpcId)
          : yield* resolveResource(options.securityGroup);
      return {
        kind: "aws" as const,
        vpcId: network.vpcId,
        subnetIds: network.subnetIds,
        securityGroupId: runners.groupId,
        cidrBlock: network.cidrBlock,
        assignPublicIp: network.assignPublicIp,
      };
    }),
    gateway: (_name, network) => makeAwsGateway(id, network, "ip", options.gateway),
    nodes: ({ network, gateway, program, environment }) =>
      Effect.gen(function* () {
        const cluster = yield* ECS.Cluster(`${id}Cluster`, {});
        yield* ECS.Service(`${id}Pool`, {
          cluster,
          context: program.pipe(Output.map((p) => p.dir)) as unknown as string,
          // Other runners reach the runner port; the load balancer, the gateway.
          container: {
            name: "runner",
            portMappings: [
              { containerPort: RUNNER_PORT, hostPort: RUNNER_PORT, protocol: "tcp" },
              { containerPort: GATEWAY_PORT, hostPort: GATEWAY_PORT, protocol: "tcp" },
            ],
          },
          desiredCount: options.replicas ?? 2,
          cpu: options.cpu ?? 512,
          memory: options.memory ?? 1024,
          runtimePlatform: {
            cpuArchitecture: options.architecture ?? "X86_64",
            operatingSystemFamily: "LINUX",
          },
          vpcId: network.vpcId,
          subnets: [...network.subnetIds],
          securityGroups: [network.securityGroupId, gateway.securityGroupId],
          assignPublicIp: network.assignPublicIp,
          loadBalancers: [
            {
              targetGroupArn: gateway.targetGroupArn as unknown as string,
              containerName: "runner",
              containerPort: GATEWAY_PORT,
            },
          ],
          env: environment as unknown as Record<string, string>,
        });
      }),
  });
