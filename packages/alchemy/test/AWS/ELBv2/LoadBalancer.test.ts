import * as AWS from "@/AWS";
import { Subnet, VpcId } from "@/AWS/EC2";
import { LoadBalancer } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The testing account is at its VPC limit and has no default VPC, so we reuse an
// existing VPC and carve two stack-owned subnets (subnets don't count against
// the VPC limit). An ALB needs subnets in at least two distinct AZs.
test.provider(
  "list enumerates the deployed load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter(
          (az) => az.State === "available",
        ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      // Pick an existing VPC with room to carve /24 subnets.
      const vpcs = yield* EC2.describeVpcs({});
      const vpc = (vpcs.Vpcs ?? []).find((v) => {
        if (v.State !== "available" || !v.VpcId || !v.CidrBlock) return false;
        const prefix = Number(v.CidrBlock.split("/")[1]);
        return Number.isFinite(prefix) && prefix <= 23;
      });
      const vpcId = VpcId(vpc?.VpcId!);
      expect(vpcId).toBeTruthy();
      const [a, b] = vpc!.CidrBlock!.split("/")[0].split(".");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("ListLbSubnet1", {
            vpcId,
            cidrBlock: `${a}.${b}.222.0/24`,
            availabilityZone: az1,
          });

          const subnet2 = yield* Subnet("ListLbSubnet2", {
            vpcId,
            cidrBlock: `${a}.${b}.223.0/24`,
            availabilityZone: az2,
          });

          const loadBalancer = yield* LoadBalancer("ListLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });

          return { loadBalancer };
        }),
      );

      const provider = yield* Provider.findProvider(LoadBalancer);
      const all = yield* provider.list();

      expect(
        all.some(
          (x) => x.loadBalancerArn === deployed.loadBalancer.loadBalancerArn,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);
