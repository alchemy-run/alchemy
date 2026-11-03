/**
 * What the AWS runners share: the database's VPC, and a load balancer that
 * serves each pool's gateway to callers anywhere.
 *
 * @internal
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { ClusterNetwork, DatabaseShape } from "../../Database.ts";
import { GATEWAY_PORT } from "../../internal/Gateway.ts";

export type AwsNetwork = Extract<ClusterNetwork, { kind: "aws" }>;

export const awsNetworkOf = (database: DatabaseShape): AwsNetwork | undefined =>
  database.network?.kind === "aws" ? database.network : undefined;

/**
 * An internet-facing load balancer in front of the pool's gateway. It is
 * declared before the pool, so the gateway's URL never depends on it.
 */
export const makeAwsGateway = Effect.fn(function* (
  id: string,
  network: AwsNetwork,
  targetType: "ip" | "instance",
) {
  // The database's network, as the EC2 identifiers it holds.
  const vpcId = network.vpcId as Input<EC2.VpcId>;
  const subnetIds = network.subnetIds as Input<EC2.SubnetId>[];
  const balancerGroup = yield* EC2.SecurityGroup(`${id}GatewayBalancerGroup`, {
    vpcId,
    description: "Effect Cluster gateway load balancer",
    ingress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" }],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  // Runners take gateway traffic only from their load balancer.
  const gatewayGroup = yield* EC2.SecurityGroup(`${id}GatewayGroup`, {
    vpcId,
    description: "Effect Cluster gateway",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: GATEWAY_PORT,
        toPort: GATEWAY_PORT,
        referencedGroupId: balancerGroup.groupId,
      },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const targets = yield* ELBv2.TargetGroup(`${id}Gateway`, {
    vpcId,
    port: GATEWAY_PORT,
    protocol: "HTTP",
    targetType,
    healthCheckPath: "/health",
    matcher: { HttpCode: "200" },
  });
  const balancer = yield* ELBv2.LoadBalancer(`${id}GatewayBalancer`, {
    type: "application",
    scheme: "internet-facing",
    subnets: subnetIds,
    securityGroups: [balancerGroup.groupId],
    // Streaming calls stay open.
    attributes: { "idle_timeout.timeout_seconds": "3600" },
  });
  const listener = yield* ELBv2.Listener(`${id}GatewayListener`, {
    loadBalancerArn: balancer.loadBalancerArn,
    port: 80,
    protocol: "HTTP",
    targetGroupArn: targets.targetGroupArn,
  });
  return {
    // Ordered after the listener, so callers use it once it serves.
    url: Output.all(balancer.dnsName, listener.listenerArn).pipe(
      Output.map(([dns]) => `http://${dns}`),
    ),
    targetGroupArn: targets.targetGroupArn,
    securityGroupId: gatewayGroup.groupId,
  };
});
