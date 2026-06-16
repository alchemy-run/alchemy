import * as AWS from "@/AWS";
import { InternetGateway, SecurityGroup, Subnet, Vpc } from "@/AWS/EC2";
import { Listener, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test for a load-balancer-scoped resource. A Listener
// belongs to a LoadBalancer (describeListeners requires a LoadBalancerArn), so
// `list()` enumerates every load balancer first and then every listener per
// LB. We deploy a VPC + Subnets (two AZs, required for an application LB) +
// LoadBalancer + TargetGroup + Listener, resolve the provider with the typed
// `findProvider` helper, call `list()`, and assert the deployed listener
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const availableAzs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
        [];
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListVpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });

          const internetGateway = yield* InternetGateway("ListIgw", {
            vpcId: vpc.vpcId,
          });

          const subnet1 = yield* Subnet("ListSubnet1", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az1,
          });

          const subnet2 = yield* Subnet("ListSubnet2", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.2.0/24",
            availabilityZone: az2,
          });

          const securityGroup = yield* SecurityGroup("ListLbSg", {
            vpcId: vpc.vpcId,
            description: "Listener list test security group",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "Allow HTTP",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "Allow all outbound",
              },
            ],
          });

          const loadBalancer = yield* LoadBalancer("ListLoadBalancer", {
            type: "application",
            scheme: "internal",
            subnets: [subnet1.subnetId, subnet2.subnetId],
            securityGroups: [securityGroup.groupId],
          });

          const targetGroup = yield* TargetGroup("ListTargetGroup", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });

          const listener = yield* Listener("ListListener", {
            loadBalancerArn: loadBalancer.loadBalancerArn,
            targetGroupArn: targetGroup.targetGroupArn,
            port: 80,
            protocol: "HTTP",
          });

          return { listener, internetGateway };
        }),
      );

      expect(deployed.listener.listenerArn).toBeDefined();

      const provider = yield* Provider.findProvider(Listener);
      const all = yield* provider.list();

      expect(
        all.some((l) => l.listenerArn === deployed.listener.listenerArn),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
