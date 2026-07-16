import * as AWS from "@/AWS";
import { AutoScalingGroup, LaunchTemplate } from "@/AWS/AutoScaling";
import { amazonLinux2023, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
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

// Whole-resource `launchTemplate: template` spelling. The engine resolves the
// resource reference to its bare Attributes record before it reaches the
// provider — no resource `Type` marker survives — so `toLaunchTemplateSpec`
// must narrow on the attributes shape. Pre-fix it fell through to the
// reference branch, which sent BOTH LaunchTemplateId and LaunchTemplateName
// to `createAutoScalingGroup` (AWS rejects a spec carrying both) with the
// version defaulted to `$Default` instead of the template's resolved default
// version.
//
// The fleet is placed into a subnet of the account's default VPC (resolved
// out-of-band) rather than a throwaway `Vpc` resource: a failed run loses its
// in-memory scratch state, and orphaned VPCs quickly exhaust the 5-per-region
// quota.
const wholeAsgName = "alchemy-test-asg-whole-lt";
const cleanupWholeAsg = autoscaling
  .deleteAutoScalingGroup({
    AutoScalingGroupName: wholeAsgName,
    ForceDelete: true,
  } as any)
  .pipe(Effect.catch(() => Effect.void));

test.provider(
  "wires a whole LaunchTemplate resource by id and pinned default version",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanupWholeAsg;
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back
      // to a syntactically valid id if the lookup returns nothing.
      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      const subnets = yield* ec2.describeSubnets({
        Filters: [{ Name: "default-for-az", Values: ["true"] }],
      } as any);
      const subnetId = subnets.Subnets?.[0]?.SubnetId;
      if (!subnetId) {
        return yield* Effect.die(
          new Error("no default-VPC subnet available in this region"),
        );
      }

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* LaunchTemplate("WholeLtTemplate", {
            imageId,
            instanceType: "t3.micro",
          });
          const group = yield* AutoScalingGroup("WholeLtGroup", {
            autoScalingGroupName: wholeAsgName,
            // Whole resource — resolves to bare Attributes at deploy time.
            launchTemplate: template,
            subnetIds: [subnetId as `subnet-${string}`],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
          return {
            templateId: template.launchTemplateId.as<string>(),
            templateDefaultVersion: template.defaultVersionNumber.as<number>(),
            group,
          };
        }),
      );

      // The group is wired to the template by ID with the version pinned to
      // the template's resolved default version (not "$Default").
      expect(deployed.group.launchTemplateId).toEqual(deployed.templateId);
      expect(deployed.group.launchTemplateVersion).toEqual(
        String(deployed.templateDefaultVersion),
      );

      // Out-of-band: the live group carries the id-only spec.
      const described = yield* autoscaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [wholeAsgName],
      } as any);
      const live = described.AutoScalingGroups?.[0];
      expect(live?.LaunchTemplate?.LaunchTemplateId).toEqual(
        deployed.templateId,
      );

      yield* stack.destroy();
    }).pipe(Effect.ensuring(cleanupWholeAsg)),
  { timeout: 240_000 },
);
