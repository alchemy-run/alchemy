import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as ELBv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

test(
  "create load balancer, target group, and listener",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const resources = yield* test.deploy(
      Effect.gen(function* () {
        const network = yield* AWS.EC2.Network("Elbv2Network", {
          cidrBlock: "10.61.0.0/16",
          availabilityZones: 2,
        });
        const securityGroup = yield* AWS.EC2.SecurityGroup("Elbv2SecurityGroup", {
          vpcId: network.vpcId,
          ingress: [
            {
              ipProtocol: "tcp",
              fromPort: 80,
              toPort: 80,
              cidrIpv4: "0.0.0.0/0",
            },
          ],
        });

        const loadBalancer = yield* AWS.ELBv2.LoadBalancer("TestLoadBalancer", {
          type: "application",
          scheme: "internet-facing",
          subnets: network.publicSubnetIds,
          securityGroups: [securityGroup.groupId],
        });
        const targetGroup = yield* AWS.ELBv2.TargetGroup("TestTargetGroup", {
          vpcId: network.vpcId,
          port: 3000,
          protocol: "HTTP",
          targetType: "instance",
          healthCheckPath: "/",
        });
        const listener = yield* AWS.ELBv2.Listener("TestListener", {
          loadBalancerArn: loadBalancer.loadBalancerArn,
          targetGroupArn: targetGroup.targetGroupArn,
          port: 80,
          protocol: "HTTP",
        });

        return {
          loadBalancer,
          targetGroup,
          listener,
        };
      }),
    );

    const loadBalancers = yield* ELBv2.describeLoadBalancers({
      LoadBalancerArns: [resources.loadBalancer.loadBalancerArn],
    });
    const targetGroups = yield* ELBv2.describeTargetGroups({
      TargetGroupArns: [resources.targetGroup.targetGroupArn],
    });
    const listeners = yield* ELBv2.describeListeners({
      ListenerArns: [resources.listener.listenerArn],
    });

    expect(loadBalancers.LoadBalancers?.[0]?.DNSName).toBeTruthy();
    expect(targetGroups.TargetGroups?.[0]?.TargetGroupArn).toBe(
      resources.targetGroup.targetGroupArn,
    );
    expect(listeners.Listeners?.[0]?.ListenerArn).toBe(
      resources.listener.listenerArn,
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())) as Effect.Effect<void, any, any>,
);
