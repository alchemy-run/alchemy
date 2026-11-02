import * as ECS from "@alchemy.run/aws/ECS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT, RUNNER_PORT } from "../internal/Gateway.ts";
import { makeRunnersLayer, type RunnersSettings } from "../internal/RunnersHost.ts";
import { awsNetworkOf, makeAwsGateway } from "./internal/Gateway.ts";

export interface EcsRunnersOptions extends RunnersSettings {
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
   * CPU architecture of the runners. The image is built for it on the
   * deploying machine.
   * @default "X86_64"
   */
  architecture?: "X86_64" | "ARM64";
}

/**
 * Run an Effect Cluster's runners on ECS Fargate: an ECS service whose tasks
 * host every class given these runners, in the database's VPC, behind a
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
 * export const Default = ClusterAWS.EcsRunners("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * **Example:** Larger Graviton runners
 * ```typescript
 * export const Default = ClusterAWS.EcsRunners("Default", {
 *   cpu: 2048,
 *   memory: 4096,
 *   architecture: "ARM64",
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const EcsRunners = (id: string, options: EcsRunnersOptions = {}) =>
  makeRunnersLayer({
    label: "ClusterAWS.EcsRunners",
    id,
    settings: options,
    expected: "an AWS VPC (ClusterAWS.Database)",
    network: awsNetworkOf,
    gateway: (_name, network) => makeAwsGateway(id, network, "ip"),
    nodes: ({ network, gateway, program, environment }) =>
      Effect.gen(function* () {
        const cluster = yield* ECS.Cluster(`${id}Cluster`, {});
        yield* ECS.Service(`${id}Runners`, {
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
