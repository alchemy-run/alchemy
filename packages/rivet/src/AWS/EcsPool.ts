import * as EC2 from "@alchemy.run/aws/EC2";
import * as ECS from "@alchemy.run/aws/ECS";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makePoolLayer, NODE_DOCKERFILE, type PoolSettings } from "../internal/PoolHost.ts";

/** A cluster value as an Output, whether it is one already or a plain value. */
const output = <T>(value: Input<T>): Output.Output<T> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<T>;

/** The cluster has no VPC for nodes to join. */
const ownNetwork = { kind: "own" } as const;

/** A VPC of the pool's own: public subnets, so nodes reach the control plane without NAT. */
const poolNetwork = Effect.fn(function* (id: string, options: EcsPoolOptions) {
  const network = yield* EC2.Network(`${id}Network`, {
    cidrBlock: options.cidrBlock ?? "10.43.0.0/16",
    availabilityZones: 2,
  });
  const group = yield* EC2.SecurityGroup(`${id}NodeGroup`, {
    vpcId: network.vpcId,
    description: "Rivet nodes",
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  return {
    vpcId: network.vpcId,
    subnetIds: network.publicSubnetIds,
    securityGroupId: group.groupId,
  };
});

export interface EcsPoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * CPU units of each node (1024 = 1 vCPU).
   * @default 512
   */
  cpu?: number;
  /**
   * Memory of each node, in MiB.
   * @default 1024
   */
  memory?: number;
  /**
   * CPU architecture of the nodes. Images are built for it on the deploying
   * machine, so match it to that machine to skip emulation.
   * @default "X86_64"
   */
  architecture?: "X86_64" | "ARM64";
  /**
   * IPv4 CIDR block of the pool's own VPC, created when its cluster has no
   * VPC for nodes to join (Rivet Cloud, or a control plane outside AWS).
   * @default "10.43.0.0/16"
   */
  cidrBlock?: string;
}

/**
 * Run a pool's nodes on ECS Fargate: a pool on the control plane, and an
 * ECS service whose tasks host every `Rivet.DurableObject` given this pool.
 * Nodes only connect out to the control plane, so they run in public
 * subnets with no load balancer and no inbound rules: the control plane's
 * VPC with `RivetAWS.ControlPlane`, and a VPC of the pool's own with any
 * other control plane (`RivetCloud.ControlPlane`, `Rivet.ControlPlane`).
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on ECS
 * **Example:** A pool of two nodes
 * ```typescript
 * export const Cluster = RivetAWS.ControlPlane("Rivet");
 * export const Default = RivetAWS.EcsPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * **Example:** Larger Graviton nodes
 * ```typescript
 * export const Default = RivetAWS.EcsPool("Default", {
 *   cpu: 2048,
 *   memory: 4096,
 *   architecture: "ARM64",
 * }).pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const EcsPool = (id: string, options: EcsPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetAWS.EcsPool",
    id,
    settings: options,
    expected: "an AWS VPC",
    // Nodes join the control plane's VPC when it has one, and a VPC of the
    // pool's own otherwise (Rivet Cloud, or a control plane elsewhere).
    network: (cluster) => (cluster.network?.kind === "aws" ? cluster.network : ownNetwork),
    nodes: ({ network: clusterNetwork, pool, program, environment }) =>
      Effect.gen(function* () {
        const network =
          clusterNetwork.kind === "own" ? yield* poolNetwork(id, options) : clusterNetwork;
        const cluster = yield* ECS.Cluster(`${id}Cluster`, {});
        // Every class the pool hosts is bundled into its node image.
        yield* ECS.Service(`${id}Nodes`, {
          ...program,
          cluster,
          dockerfile: { content: NODE_DOCKERFILE },
          desiredCount: options.replicas ?? 1,
          cpu: options.cpu ?? 512,
          memory: options.memory ?? 1024,
          runtimePlatform: {
            cpuArchitecture: options.architecture ?? "X86_64",
            operatingSystemFamily: "LINUX",
          },
          vpcId: network.vpcId,
          subnets: [...network.subnetIds],
          securityGroups: [network.securityGroupId],
          assignPublicIp: true,
          // Task environment values are plain strings.
          env: Output.all(
            pool.env,
            output(environment.RIVET_ENDPOINT),
            output(environment.RIVET_TOKEN),
            output(environment.RIVET_NAMESPACE),
            environment.RIVET_POOL,
          ).pipe(
            Output.map(([env, endpoint, token, namespace, poolName]) => ({
              ...env,
              RIVET_ENDPOINT: endpoint,
              RIVET_TOKEN: Redacted.value(token),
              RIVET_NAMESPACE: namespace,
              RIVET_POOL: poolName,
            })),
          ),
        });
      }),
  });
