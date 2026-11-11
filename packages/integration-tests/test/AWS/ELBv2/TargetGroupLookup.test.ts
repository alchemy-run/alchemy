import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:elbv2", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "TargetGroupLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // The default VPC, itself looked up.
    const vpc = AWS.EC2.Vpc.lookup({ isDefault: true });
    const group = yield* AWS.ELBv2.TargetGroup("lookup-target", {
      vpcId: vpc.vpcId,
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
    });
    return {
      targetGroupArn: group.targetGroupArn.as<string>(),
      targetGroupName: group.targetGroupName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up target group resolves by ARN and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { targetGroupArn, targetGroupName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.ELBv2.TargetGroup.lookup({ targetGroupName });
          const byArn = AWS.ELBv2.TargetGroup.lookup({ targetGroupArn });
          return { arn: byName.targetGroupArn, name: byArn.targetGroupName };
        },
        {
          arn: targetGroupArn,
          name: targetGroupName,
        },
      );
      const { TargetGroups } = yield* elbv2.describeTargetGroups({
        TargetGroupArns: [targetGroupArn],
      });
      expect(TargetGroups?.[0]?.TargetGroupName).toBe(targetGroupName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing target group fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-target-group", {
            value: AWS.ELBv2.TargetGroup.lookup({ targetGroupName: name.slice(0, 32) })
              .targetGroupArn,
          }),
        ),
        ["LookupNotFoundError"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a target group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.ELBv2.TargetGroup("lookup-managed", {
          vpcId: AWS.EC2.Vpc.lookup({ isDefault: true }).vpcId,
          port: 80,
          protocol: "HTTP",
          targetType: "ip",
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-target-group-consumer", {
              value: AWS.ELBv2.TargetGroup.lookup({ targetGroupArn: attrs.targetGroupArn })
                .targetGroupArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

// A load balancer takes minutes to provision and delete, so it has its own
// target, skipped by `--fast`. An internal NLB needs one subnet and no
// security group.
const fast = !!process.env.FAST;
const LoadBalancerStack = Alchemy.Stack(
  "LoadBalancerLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vpc = yield* AWS.EC2.Vpc("lookup-lb-vpc", { cidrBlock: "10.46.0.0/16" });
    const subnet = yield* AWS.EC2.Subnet("lookup-lb-subnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.46.1.0/24",
    });
    const group = yield* AWS.ELBv2.TargetGroup("lookup-lb-targets", {
      vpcId: vpc.vpcId,
      port: 80,
      protocol: "TCP",
      targetType: "ip",
    });
    const lb = yield* AWS.ELBv2.LoadBalancer("lookup-lb", {
      type: "network",
      scheme: "internal",
      subnets: [subnet.subnetId],
    });
    const listener = yield* AWS.ELBv2.Listener("lookup-lb-listener", {
      loadBalancerArn: lb.loadBalancerArn,
      port: 80,
      protocol: "TCP",
      targetGroupArn: group.targetGroupArn,
    });
    return {
      loadBalancerArn: lb.loadBalancerArn.as<string>(),
      loadBalancerName: lb.loadBalancerName.as<string>(),
      dnsName: lb.dnsName.as<string>(),
      listenerArn: listener.listenerArn.as<string>(),
    };
  }),
);

const lbTarget = beforeAll(
  fast
    ? Effect.succeed({ loadBalancerArn: "", loadBalancerName: "", dnsName: "", listenerArn: "" })
    : deploy(LoadBalancerStack),
  { timeout: 600_000 },
);
afterAll.skipIf(fast || !!process.env.NO_DESTROY)(destroy(LoadBalancerStack), {
  timeout: 600_000,
});

test.provider.skipIf(fast)(
  "a looked-up load balancer and listener resolve by ARN, name and port",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { loadBalancerArn, loadBalancerName, dnsName, listenerArn } = yield* lbTarget;
      yield* expectLookupConsumers(
        stack,
        () => ({
          byName: AWS.ELBv2.LoadBalancer.lookup({ loadBalancerName }).loadBalancerArn,
          byArn: AWS.ELBv2.LoadBalancer.lookup({ loadBalancerArn }).dnsName,
          listenerByPort: AWS.ELBv2.Listener.lookup({ loadBalancerArn, port: 80 }).listenerArn,
          listenerByArn: AWS.ELBv2.Listener.lookup({ listenerArn }).loadBalancerArn,
        }),
        {
          byName: loadBalancerArn,
          byArn: dnsName,
          listenerByPort: listenerArn,
          listenerByArn: loadBalancerArn,
        },
      );
    }),
  { tags, timeout: 180_000 },
);
