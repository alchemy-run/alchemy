import { AWS } from "alchemy-effect";
import type { Output } from "alchemy-effect/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

export interface ExampleNetwork {
  network: AWS.EC2.Network;
  publicSubnetIds: Output<AWS.EC2.SubnetId>[];
  privateSubnetIds: Output<AWS.EC2.SubnetId>[];
  albSecurityGroupId: Output<AWS.EC2.SecurityGroupId>;
  nlbSecurityGroupId: Output<AWS.EC2.SecurityGroupId>;
  appSecurityGroupId: Output<AWS.EC2.SecurityGroupId>;
}

export class Network extends ServiceMap.Service<Network, ExampleNetwork>()(
  "Network",
) {}

export const NetworkLive = Layer.effect(
  Network,
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
      nat: "single",
    });

    const albSecurityGroup = yield* AWS.EC2.SecurityGroup("AlbSecurityGroup", {
      vpcId: network.vpcId,
      description: "Security group for the example ALB",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    });

    const nlbSecurityGroup = yield* AWS.EC2.SecurityGroup("NlbSecurityGroup", {
      vpcId: network.vpcId,
      description: "Security group for the example NLB",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    });

    const appSecurityGroup = yield* AWS.EC2.SecurityGroup("AppSecurityGroup", {
      vpcId: network.vpcId,
      description: "Security group for the autoscaled EC2 application fleet",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          referencedGroupId: albSecurityGroup.groupId,
        },
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          referencedGroupId: nlbSecurityGroup.groupId,
        },
      ],
    });

    return {
      network,
      publicSubnetIds: network.publicSubnetIds,
      privateSubnetIds: network.privateSubnetIds,
      albSecurityGroupId: albSecurityGroup.groupId,
      nlbSecurityGroupId: nlbSecurityGroup.groupId,
      appSecurityGroupId: appSecurityGroup.groupId,
    };
  }),
);
