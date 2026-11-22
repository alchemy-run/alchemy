import * as AWS from "@alchemy.run/aws";
import { SecurityGroup } from "@alchemy.run/aws/EC2/SecurityGroup";
import type { SubnetId } from "@alchemy.run/aws/EC2/Subnet";
import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { Service } from "@alchemy.run/aws/ECS/Service";
import { TaskDefinition } from "@alchemy.run/aws/ECS/TaskDefinition";
import { Listener } from "@alchemy.run/aws/ELBv2/Listener";
import { ListenerRule } from "@alchemy.run/aws/ELBv2/ListenerRule";
import { LoadBalancer } from "@alchemy.run/aws/ELBv2/LoadBalancer";
import { TargetGroup } from "@alchemy.run/aws/ELBv2/TargetGroup";
import { Role } from "@alchemy.run/aws/IAM/Role";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// ECS native blue/green against a user-wired ALB:
//
// 0. The ALB, both target groups and the production rule, so the target
//    groups are attached to a load balancer before ECS sees them.
// 1. A plain rolling service on the "blue" target group.
// 2. Switch it to BLUE_GREEN with an infrastructure role created in the SAME
//    apply. ECS assumes the role to validate the target groups and rejects
//    until IAM has propagated it (#3089) — the provider must wait it out.
// 3. Roll a new task revision. Each blue/green deployment starts the tasks in
//    the group without traffic and moves the production rule to it, while
//    DescribeServices keeps reporting the configured group. The waiter must
//    count the alternate group's targets too, or it times out every other
//    deploy (#3090).
//
// Slow: an ALB plus three Fargate rollouts.
test.provider.skipIf(!!process.env.FAST)(
  "native blue/green: role created in the same apply, waiter follows the traffic shift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;
      const subnets = net.subnetIds as SubnetId[];

      const deploy = (input: {
        readonly service?: { readonly version: string; readonly blueGreen: boolean };
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const securityGroup = yield* SecurityGroup("BlueGreenSg", {
              vpcId: net.vpcId,
              description: "alchemy ECS blue/green test",
              ingress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" }],
              egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
            });
            const loadBalancer = yield* LoadBalancer("BlueGreenAlb", {
              type: "application",
              scheme: "internal",
              subnets,
              securityGroups: [securityGroup.groupId],
            });
            const targetGroupProps = {
              vpcId: net.vpcId,
              port: 80,
              protocol: "HTTP",
              targetType: "ip",
              healthCheckPath: "/",
              healthCheckInterval: "5 seconds",
              healthCheckTimeout: "2 seconds",
              healthyThresholdCount: 2,
              attributes: { "deregistration_delay.timeout_seconds": "5" },
            } as const;
            const blue = yield* TargetGroup("BlueGreenBlue", targetGroupProps);
            const green = yield* TargetGroup("BlueGreenGreen", targetGroupProps);
            const listener = yield* Listener("BlueGreenListener", {
              loadBalancerArn: loadBalancer.loadBalancerArn,
              port: 80,
              protocol: "HTTP",
              defaultActions: [{ type: "fixedResponse", statusCode: "404" }],
            });
            const rule = yield* ListenerRule("BlueGreenRule", {
              listenerArn: listener.listenerArn,
              priority: 1,
              conditions: [{ pathPattern: { values: ["/*"] } }],
              actions: [
                {
                  type: "forward",
                  targetGroups: [
                    { targetGroupArn: blue.targetGroupArn, weight: 100 },
                    { targetGroupArn: green.targetGroupArn, weight: 0 },
                  ],
                },
              ],
            });
            const infrastructure = {
              ruleArn: rule.ruleArn.as<string>(),
              blueArn: blue.targetGroupArn.as<string>(),
              greenArn: green.targetGroupArn.as<string>(),
            };
            if (input.service === undefined) {
              return { ...infrastructure, clusterArn: undefined, serviceName: undefined };
            }
            const { version, blueGreen: useBlueGreen } = input.service;
            const task = yield* TaskDefinition("BlueGreenTask", {
              requiresCompatibilities: ["FARGATE"],
              cpu: 256,
              memory: 512,
              containerDefinitions: [
                {
                  name: "app",
                  image: "public.ecr.aws/nginx/nginx:stable",
                  essential: true,
                  environment: [{ name: "VERSION", value: version }],
                  portMappings: [{ containerPort: 80 }],
                },
              ],
            });
            const cluster = yield* Cluster("BlueGreenCluster", {});

            const blueGreen = useBlueGreen
              ? {
                  role: yield* Role("BlueGreenInfrastructureRole", {
                    assumeRolePolicyDocument: {
                      Version: "2012-10-17",
                      Statement: [
                        {
                          Effect: "Allow",
                          Principal: { Service: "ecs.amazonaws.com" },
                          Action: ["sts:AssumeRole"],
                        },
                      ],
                    },
                    managedPolicyArns: [
                      "arn:aws:iam::aws:policy/AmazonECSInfrastructureRolePolicyForLoadBalancers",
                    ],
                  }),
                }
              : undefined;

            const service = yield* Service("BlueGreenService", {
              cluster,
              task,
              desiredCount: 1,
              vpcId: net.vpcId,
              subnets,
              securityGroups: [securityGroup.groupId],
              // Default-VPC public subnets: the task needs a public IP to pull
              // from ECR Public without a NAT.
              assignPublicIp: true,
              loadBalancers: [
                {
                  targetGroupArn: blue.targetGroupArn,
                  containerName: "app",
                  containerPort: 80,
                  advancedConfiguration: blueGreen
                    ? {
                        alternateTargetGroupArn: green.targetGroupArn,
                        productionListenerRule: rule.ruleArn,
                        roleArn: blueGreen.role.roleArn,
                      }
                    : undefined,
                },
              ],
              deploymentConfiguration: blueGreen
                ? { strategy: "BLUE_GREEN", bakeTimeInMinutes: 0 }
                : undefined,
              deploymentStabilizationTimeout: "10 minutes",
            });
            return {
              ...infrastructure,
              clusterArn: service.clusterArn.as<string>(),
              serviceName: service.serviceName.as<string>(),
            };
          }),
        );

      // The target group the production rule sends all traffic to.
      const liveTargetGroup = (ruleArn: string) =>
        elbv2
          .describeRules({ RuleArns: [ruleArn] })
          .pipe(
            Effect.map(
              (rules) =>
                rules.Rules?.[0]?.Actions?.find(
                  (action) => action.Type === "forward",
                )?.ForwardConfig?.TargetGroups?.find((group) => group.Weight === 100)
                  ?.TargetGroupArn,
            ),
          );
      const healthyTargets = (targetGroupArn: string) =>
        elbv2
          .describeTargetHealth({ TargetGroupArn: targetGroupArn })
          .pipe(
            Effect.map(
              (health) =>
                (health.TargetHealthDescriptions ?? []).filter(
                  (target) => target.TargetHealth?.State === "healthy",
                ).length,
            ),
          );

      // ── 0. ALB wiring ────────────────────────────────────────────────
      yield* deploy({});

      // ── 1. rolling service on blue ───────────────────────────────────
      const rolling = yield* deploy({ service: { version: "1", blueGreen: false } });
      expect(yield* liveTargetGroup(rolling.ruleArn)).toBe(rolling.blueArn);
      expect(yield* healthyTargets(rolling.blueArn)).toBe(1);

      // ── 2. switch to blue/green with a brand-new role (#3089) ─────────
      const switched = yield* deploy({ service: { version: "2", blueGreen: true } });
      const liveAfterSwitch = yield* liveTargetGroup(switched.ruleArn);
      expect(yield* healthyTargets(liveAfterSwitch!)).toBe(1);

      // ── 3. roll again: traffic moves to the other group (#3090) ───────
      const rolled = yield* deploy({ service: { version: "3", blueGreen: true } });
      const liveAfterRoll = yield* liveTargetGroup(rolled.ruleArn);
      expect(liveAfterRoll).not.toBe(liveAfterSwitch);
      expect([liveAfterSwitch, liveAfterRoll]).toContain(rolled.greenArn);
      expect(yield* healthyTargets(liveAfterRoll!)).toBe(1);

      const described = yield* ecs.describeServices({
        cluster: rolled.clusterArn!,
        services: [rolled.serviceName!],
      });
      const service = described.services?.[0];
      expect(service?.deploymentConfiguration?.strategy).toBe("BLUE_GREEN");
      expect(service?.deployments?.length).toBe(1);
      expect(service?.deployments?.[0]?.rolloutState).toBe("COMPLETED");
      // DescribeServices still names the configured group, which is why the
      // waiter has to read the alternate one as well.
      expect(service?.loadBalancers?.[0]?.targetGroupArn).toBe(rolled.blueArn);

      // ── destroy + zero-orphan proof ───────────────────────────────────
      yield* stack.destroy();
      const after = yield* ecs
        .describeServices({
          cluster: rolled.clusterArn!,
          services: [rolled.serviceName!],
        })
        .pipe(Effect.catchTag("ClusterNotFoundException", () => Effect.succeed({ services: [] })));
      expect((after.services ?? []).filter((candidate) => candidate.status !== "INACTIVE")).toEqual(
        [],
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:ecs", "provider:aws:elbv2", "live"],
    timeout: 1_800_000,
  },
);
