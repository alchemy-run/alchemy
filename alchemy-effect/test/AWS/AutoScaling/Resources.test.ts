import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

test(
  "create launch template, autoscaling group, and scaling policy",
  { timeout: 240_000 },
  Effect.gen(function* () {
    yield* destroy();

    const resources = yield* test.deploy(
      Effect.gen(function* () {
        const imageId = yield* AWS.EC2.amazonLinux();
        const network = yield* AWS.EC2.Network("AutoScalingNetwork", {
          cidrBlock: "10.62.0.0/16",
          availabilityZones: 2,
        });
        const securityGroup = yield* AWS.EC2.SecurityGroup(
          "AutoScalingSecurityGroup",
          {
            vpcId: network.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
              },
            ],
          },
        );

        const launchTemplate = yield* AWS.AutoScaling.LaunchTemplate(
          "AutoScalingLaunchTemplate",
          {
            imageId,
            instanceType: "t3.micro",
            securityGroupIds: [securityGroup.groupId],
            associatePublicIpAddress: true,
          },
        );

        const autoScalingGroup = yield* AWS.AutoScaling.AutoScalingGroup(
          "AutoScalingGroup",
          {
            launchTemplate,
            subnetIds: network.publicSubnetIds,
            minSize: 1,
            maxSize: 2,
            desiredCapacity: 1,
          },
        );

        const scalingPolicy = yield* AWS.AutoScaling.ScalingPolicy(
          "AutoScalingPolicy",
          {
            autoScalingGroup,
            predefinedMetricType: "ASGAverageCPUUtilization",
            targetValue: 60,
          },
        );

        return {
          launchTemplate,
          autoScalingGroup,
          scalingPolicy,
        };
      }),
    );

    const launchTemplates = yield* ec2.describeLaunchTemplates({
      LaunchTemplateIds: [resources.launchTemplate.launchTemplateId],
    } as any);
    const groups = yield* autoscaling.describeAutoScalingGroups({
      AutoScalingGroupNames: [resources.autoScalingGroup.autoScalingGroupName],
    } as any);
    const policies = yield* autoscaling.describePolicies({
      AutoScalingGroupName: resources.autoScalingGroup.autoScalingGroupName,
      PolicyNames: [resources.scalingPolicy.policyName],
    } as any);

    expect(launchTemplates.LaunchTemplates?.[0]?.LaunchTemplateId).toBe(
      resources.launchTemplate.launchTemplateId,
    );
    expect(groups.AutoScalingGroups?.[0]?.AutoScalingGroupName).toBe(
      resources.autoScalingGroup.autoScalingGroupName,
    );
    expect(policies.ScalingPolicies?.[0]?.PolicyARN).toBe(
      resources.scalingPolicy.policyArn,
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())) as Effect.Effect<void, any, any>,
);
