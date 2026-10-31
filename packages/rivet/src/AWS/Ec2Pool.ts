import * as EC2 from "@alchemy.run/aws/EC2";
import type { SecurityGroupId } from "@alchemy.run/aws/EC2/SecurityGroup";
import type { SubnetId } from "@alchemy.run/aws/EC2/Subnet";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { makePoolLayer, RIVETKIT_VERSION, type PoolSettings } from "../internal/PoolHost.ts";
import { nodeEnvironment, poolNetworkOf, resolvePoolNetwork } from "./internal/Pool.ts";

export interface Ec2PoolOptions extends PoolSettings {
  /**
   * Number of nodes, one EC2 instance each.
   * @default 1
   */
  replicas?: number;
  /**
   * EC2 instance type of each node.
   * @default "t3.small"
   */
  instanceType?: string;
  /**
   * IPv4 CIDR block of the pool's own VPC, created when its cluster has no
   * VPC for nodes to join (Rivet Cloud, or a control plane outside AWS).
   * @default "10.43.0.0/16"
   */
  cidrBlock?: string;
}

/**
 * Install RivetKit beside the node program: bun resolves it from
 * `/opt/node_modules`, a parent of the program's directory. The program's
 * service restarts until it is there.
 */
const installRivetKit = `#!/bin/bash
set -euo pipefail
export HOME=/root
for attempt in 1 2 3 4 5; do
  [ -x /root/.bun/bin/bun ] && break
  curl -fsSL https://bun.sh/install | bash && break
  sleep 5
done
mkdir -p /opt
cd /opt
for attempt in 1 2 3 4 5; do
  /root/.bun/bin/bun add rivetkit@${RIVETKIT_VERSION} && break
  sleep 5
done
`;

/**
 * Run a pool's nodes on EC2 instances: a pool on the control plane, and one
 * instance per node running a program that hosts every `Rivet.DurableObject`
 * given this pool. Nodes only connect out to the control plane, so they run
 * in public subnets with no inbound rules: the control plane's VPC with
 * `RivetAWS.Ec2ControlPlane` or `RivetAWS.EcsControlPlane`, and a VPC of the
 * pool's own with any other control plane.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on EC2
 * **Example:** A pool of two instances
 * ```typescript
 * export const Cluster = RivetAWS.EcsControlPlane("Rivet");
 * export const Default = RivetAWS.Ec2Pool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * **Example:** Larger instances
 * ```typescript
 * export const Default = RivetAWS.Ec2Pool("Default", { instanceType: "m7i.large" }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const Ec2Pool = (id: string, options: Ec2PoolOptions = {}) =>
  makePoolLayer({
    label: "RivetAWS.Ec2Pool",
    id,
    settings: options,
    expected: "an AWS VPC",
    network: poolNetworkOf,
    nodes: (nodes) =>
      Effect.gen(function* () {
        const network = yield* resolvePoolNetwork(id, nodes.network, options.cidrBlock);
        const env = nodeEnvironment(nodes);
        const subnets = network.subnetIds;
        for (let i = 0; i < (options.replicas ?? 1); i++) {
          // Every class the pool hosts is bundled into the node program.
          yield* EC2.Instance(`${id}Node${i}`, {
            ...nodes.program,
            imageId: EC2.amazonLinux2023(),
            instanceType: options.instanceType ?? "t3.small",
            // The cluster's network carries plain strings; these are AWS ids.
            subnetId: subnets[i % subnets.length] as Input<SubnetId>,
            securityGroupIds: [network.securityGroupId as Input<SecurityGroupId>],
            associatePublicIpAddress: true,
            userData: installRivetKit,
            env,
          });
        }
      }),
  });
