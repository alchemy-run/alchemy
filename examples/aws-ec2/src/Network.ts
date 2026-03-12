import { AWS } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

export interface ExampleNetwork {
  network: AWS.EC2.Network;
  publicSubnetId: AWS.EC2.Subnet["subnetId"];
  securityGroupIds: AWS.EC2.SecurityGroup["groupId"][];
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
    });

    const serviceSecurityGroup = yield* AWS.EC2.SecurityGroup(
      "ServiceSecurityGroup",
      {
        vpcId: network.vpcId,
        description: "Security group for the EC2 example instances",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 3000,
            toPort: 3000,
            cidrIpv4: "0.0.0.0/0",
          },
        ],
      },
    );

    return {
      network,
      publicSubnetId: network.publicSubnetIds[0],
      securityGroupIds: [serviceSecurityGroup.groupId],
    } satisfies ExampleNetwork;
  }),
);
