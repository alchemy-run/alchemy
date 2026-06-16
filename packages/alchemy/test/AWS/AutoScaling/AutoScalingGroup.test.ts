import * as AWS from "@/AWS";
import { AutoScalingGroup } from "@/AWS/AutoScaling";
import { amazonLinux2023, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const launchTemplateName = "alchemy-test-asg-lt-oob";

// The launch template is created out-of-band via distilled `ec2` rather than the
// `AWS.AutoScaling.LaunchTemplate` resource: that resource's read-before-create
// path currently dies on an untyped `ec2` NotFound (`describeLaunchTemplates`
// does not declare `InvalidLaunchTemplateName.NotFoundException`), which is a gap
// in a different provider. Creating the template directly isolates this test to
// the ASG `list()` operation under test.
const cleanupLaunchTemplate = ec2
  .deleteLaunchTemplate({ LaunchTemplateName: launchTemplateName } as any)
  .pipe(Effect.catch(() => Effect.void));

// `list()` enumerates every Auto Scaling Group in the account/region via the
// paginated `autoscaling.describeAutoScalingGroups` op. Deploy a real ASG (sized
// to zero so no EC2 instances launch), resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed group appears in
// the exhaustively paginated result.
//
// Gated off by default: the entire distilled `auto-scaling` service is currently
// non-functional against the live API. The `aws-query` protocol derives the
// request `Action` from the input shape's identifier (stripping a trailing
// `Request|Input|Message`), but AutoScaling's Smithy input shapes do not follow
// that convention — `describeAutoScalingGroups` takes `AutoScalingGroupNamesType`
// — so every describe call sends `Action=AutoScalingGroupNamesType` and AWS
// rejects it:
//
//   UnknownAwsError: Could not find operation AutoScalingGroupNamesType for
//   version 2011-01-01  (errorTag: InvalidAction)
//
// This is a distilled generator/protocol bug affecting the whole service (the ASG
// resource has never been live-tested), not the `list()` implementation. Once the
// `aws-query` Action derivation uses the real operation name, run this with
// AWS_TEST_AUTOSCALING=1.
test.provider.skipIf(!process.env.AWS_TEST_AUTOSCALING)(
  "list enumerates the deployed auto scaling group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      yield* cleanupLaunchTemplate;
      yield* ec2.createLaunchTemplate({
        LaunchTemplateName: launchTemplateName,
        LaunchTemplateData: { ImageId: imageId, InstanceType: "t3.micro" },
      } as any);

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("TestVpc", { cidrBlock: "10.0.0.0/16" });
          const subnet = yield* Subnet("TestSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          return yield* AutoScalingGroup("ListAutoScalingGroup", {
            autoScalingGroupName: "alchemy-test-asg-list",
            launchTemplate: { launchTemplateName },
            subnetIds: [subnet.subnetId],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
        }),
      );

      const provider = yield* Provider.findProvider(AutoScalingGroup);
      const all = yield* provider.list();

      expect(
        all.some((g) => g.autoScalingGroupName === group.autoScalingGroupName),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(Effect.ensuring(cleanupLaunchTemplate)),
  { timeout: 240_000 },
);
