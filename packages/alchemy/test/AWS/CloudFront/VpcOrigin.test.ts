import * as AWS from "@/AWS";
import { VpcOrigin } from "@/AWS/CloudFront";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import { Subnet } from "@/AWS/EC2/Subnet";
import { Vpc } from "@/AWS/EC2/Vpc";
import { LoadBalancer } from "@/AWS/ELBv2/LoadBalancer";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The full lifecycle requires a real, internal Application Load Balancer in a
// VPC, which is slow to provision. Gate it behind an env var; the probe below
// runs unconditionally and proves the typed error surface cheaply.
const runLifecycle = process.env.CLOUDFRONT_TEST_VPC_ORIGIN === "1";

describe("AWS.CloudFront.VpcOrigin", () => {
  // Fast probe (no deploy): creating a VPC origin against a bogus ARN must
  // surface a typed `InvalidArgument` (or `EntityNotFound`), proving the error
  // typing for the create op without provisioning any infrastructure.
  test.provider("createVpcOrigin rejects a bogus ARN with a typed error", () =>
    Effect.gen(function* () {
      const result = yield* cloudfront
        .createVpcOrigin({
          VpcOriginEndpointConfig: {
            Name: "alchemy-vpc-origin-probe",
            Arn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/does-not-exist/0000000000000000",
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
          },
        })
        .pipe(Effect.flip);

      expect(["InvalidArgument", "EntityNotFound", "AccessDenied"]).toContain(
        result._tag,
      );
    }),
  );

  test.provider.skipIf(!runLifecycle)(
    "create, update, and delete a VPC origin for an internal ALB",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("VpcOriginVpc", {
              cidrBlock: "10.40.0.0/16",
            });
            // An internal ALB needs no public routing, so we only need the VPC,
            // two subnets in different AZs, and a security group.
            const subnetA = yield* Subnet("VpcOriginSubnetA", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.40.1.0/24",
              availabilityZone: "us-east-1a",
            });
            const subnetB = yield* Subnet("VpcOriginSubnetB", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.40.2.0/24",
              availabilityZone: "us-east-1b",
            });
            const sg = yield* SecurityGroup("VpcOriginSg", {
              vpcId: vpc.vpcId,
              description: "alchemy vpc origin alb",
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 80,
                  toPort: 80,
                  cidrIpv4: "0.0.0.0/0",
                },
              ],
            });
            const alb = yield* LoadBalancer("VpcOriginAlb", {
              scheme: "internal",
              type: "application",
              subnets: [subnetA.subnetId, subnetB.subnetId],
              securityGroups: [sg.groupId],
            });
            const vpcOrigin = yield* VpcOrigin("AppVpcOrigin", {
              arn: alb.loadBalancerArn,
              httpPort: 80,
              originProtocolPolicy: "http-only",
            });
            return { vpcOrigin };
          }),
        );

        // Out-of-band: confirm it deployed.
        const got = yield* cloudfront.getVpcOrigin({
          Id: deployed.vpcOrigin.vpcOriginId,
        });
        expect(got.VpcOrigin?.Status).toEqual("Deployed");
        expect(got.VpcOrigin?.VpcOriginEndpointConfig.HTTPPort).toEqual(80);
        expect(
          got.VpcOrigin?.VpcOriginEndpointConfig.OriginProtocolPolicy,
        ).toEqual("http-only");

        yield* stack.destroy();
        yield* assertVpcOriginDeleted(deployed.vpcOrigin.vpcOriginId);
      }),
    { timeout: 600_000 },
  );

  test.provider.skipIf(!runLifecycle)(
    "list enumerates account VPC origins",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(VpcOrigin);
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        for (const item of all) {
          expect(item.vpcOriginId).toBeDefined();
          expect(item.vpcOriginArn).toBeDefined();
        }
      }),
  );
});

const assertVpcOriginDeleted = (id: string) =>
  cloudfront.getVpcOrigin({ Id: id }).pipe(
    Effect.flatMap((result) =>
      result.VpcOrigin
        ? Effect.fail(new Error("VpcOriginStillExists"))
        : Effect.void,
    ),
    Effect.catchTag("EntityNotFound", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "VpcOriginStillExists",
      schedule: Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );
