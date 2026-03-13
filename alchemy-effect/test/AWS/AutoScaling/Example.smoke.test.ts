import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as Http from "alchemy-effect/Http";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

test(
  "deploy aws-ec2 web fleet example shape",
  { timeout: 300_000 },
  Effect.gen(function* () {
    yield* destroy();

    const web = yield* test.deploy(
      Effect.gen(function* () {
        const imageId = yield* AWS.EC2.amazonLinux();
        const network = yield* AWS.EC2.Network("SmokeNetwork", {
          cidrBlock: "10.63.0.0/16",
          availabilityZones: 2,
          nat: "single",
        });
        const albSecurityGroup = yield* AWS.EC2.SecurityGroup(
          "SmokeAlbSecurityGroup",
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
        const nlbSecurityGroup = yield* AWS.EC2.SecurityGroup(
          "SmokeNlbSecurityGroup",
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
        const appSecurityGroup = yield* AWS.EC2.SecurityGroup(
          "SmokeAppSecurityGroup",
          {
            vpcId: network.vpcId,
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
          },
        );

        const launchTemplate = yield* Effect.gen(function* () {
          yield* Http.serve(HttpServerResponse.json({ ok: true }));

          return {
            main: import.meta.path,
            imageId,
            instanceType: "t3.micro",
            securityGroupIds: [appSecurityGroup.groupId],
            port: 3000,
          };
        }).pipe(
          Effect.provide(AWS.EC2.HttpServer),
          AWS.AutoScaling.LaunchTemplate("SmokeLaunchTemplate"),
        );

        const alb = yield* AWS.ELBv2.LoadBalancer("SmokeAlb", {
          type: "application",
          scheme: "internet-facing",
          subnets: network.publicSubnetIds,
          securityGroups: [albSecurityGroup.groupId],
        });
        const albTargetGroup = yield* AWS.ELBv2.TargetGroup("SmokeAlbTargetGroup", {
          vpcId: network.vpcId,
          port: 3000,
          protocol: "HTTP",
          targetType: "instance",
          healthCheckPath: "/",
        });
        yield* AWS.ELBv2.Listener("SmokeAlbListener", {
          loadBalancerArn: alb.loadBalancerArn,
          targetGroupArn: albTargetGroup.targetGroupArn,
          port: 80,
          protocol: "HTTP",
        });

        const nlb = yield* AWS.ELBv2.LoadBalancer("SmokeNlb", {
          type: "network",
          scheme: "internet-facing",
          subnets: network.publicSubnetIds,
          securityGroups: [nlbSecurityGroup.groupId],
        });
        const nlbTargetGroup = yield* AWS.ELBv2.TargetGroup("SmokeNlbTargetGroup", {
          vpcId: network.vpcId,
          port: 3000,
          protocol: "TCP",
          targetType: "instance",
        });
        yield* AWS.ELBv2.Listener("SmokeNlbListener", {
          loadBalancerArn: nlb.loadBalancerArn,
          targetGroupArn: nlbTargetGroup.targetGroupArn,
          port: 80,
          protocol: "TCP",
        });

        const autoScalingGroup = yield* AWS.AutoScaling.AutoScalingGroup(
          "SmokeFleet",
          {
            launchTemplate,
            subnetIds: network.privateSubnetIds,
            minSize: 1,
            maxSize: 2,
            desiredCapacity: 1,
            targetGroupArns: [
              albTargetGroup.targetGroupArn,
              nlbTargetGroup.targetGroupArn,
            ],
            healthCheckType: "ELB",
            healthCheckGracePeriod: 120,
          },
        );

        yield* AWS.AutoScaling.ScalingPolicy("SmokeScalingPolicy", {
          autoScalingGroup,
          predefinedMetricType: "ASGAverageCPUUtilization",
          targetValue: 60,
          estimatedInstanceWarmup: 120,
        });

        return {
          albDnsName: alb.dnsName,
          nlbDnsName: nlb.dnsName,
          autoScalingGroupName: autoScalingGroup.autoScalingGroupName,
        };
      }),
    );

    expect(web.albDnsName).toBeTruthy();
    expect(web.nlbDnsName).toBeTruthy();
    expect(web.autoScalingGroupName).toBeTruthy();

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())) as Effect.Effect<void, any, any>,
);
