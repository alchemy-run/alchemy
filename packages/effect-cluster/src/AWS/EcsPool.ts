import * as ECS from "@alchemy.run/aws/ECS";
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
import { awsNetworkOf, makeAwsGateway } from "./internal/Gateway.ts";

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
}

/**
 * Run a pool of Effect Cluster runners on ECS Fargate: an ECS service whose tasks
 * host every class given this pool, in the database's VPC, behind a
 * load balancer that serves their gateway to callers anywhere. Requires a
 * database in an AWS VPC — `ClusterAWS.Database`.
 *
 * Runners reach each other and the database through the cluster's runner
 * security group; the load balancer only reaches the gateway, which checks
 * every call's token.
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
    gateway: (_name, network) => makeAwsGateway(id, network, "ip"),
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
          assignPublicIp: true,
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
