import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Listener, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Exercises the full DefaultActions surface on a single ALB listener:
// forward -> redirect -> fixedResponse -> weighted multi-target-group forward
// with stickiness, all in-place via modifyListener. Reuses the default VPC and
// carves stack-owned subnets (subnets don't count against the VPC limit).
test.provider(
  "listener default actions: forward -> redirect -> fixedResponse -> weighted",
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

      const defaultVpc = yield* getDefaultVpc;

      // STAGE 1: simple forward listener (sugar form).
      const s1 = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(224),
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(225),
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          const tgBlue = yield* TargetGroup("LTgBlue", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const tgGreen = yield* TargetGroup("LTgGreen", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const listener = yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            targetGroupArn: tgBlue.targetGroupArn,
            port: 80,
            protocol: "HTTP",
          });
          return {
            listenerArn: listener.listenerArn,
            blue: tgBlue.targetGroupArn,
            green: tgGreen.targetGroupArn,
            lb: lb.loadBalancerArn,
            s1: subnet1.subnetId,
            s2: subnet2.subnetId,
          };
        }),
      );

      const listenerArn = s1.listenerArn;
      const describe = elbv2
        .describeListeners({ ListenerArns: [listenerArn] })
        .pipe(Effect.map((r) => r.Listeners?.[0]));

      let observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("forward");

      // STAGE 2: redirect HTTP -> HTTPS (in place).
      yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(224),
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(225),
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          yield* TargetGroup("LTgBlue", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* TargetGroup("LTgGreen", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "redirect",
                statusCode: "HTTP_301",
                protocol: "HTTPS",
                port: "443",
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("redirect");
      expect(observed?.DefaultActions?.[0]?.RedirectConfig?.StatusCode).toBe(
        "HTTP_301",
      );

      // STAGE 3: fixed-response (in place).
      yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(224),
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(225),
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          yield* TargetGroup("LTgBlue", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* TargetGroup("LTgGreen", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "fixedResponse",
                statusCode: "503",
                contentType: "text/plain",
                messageBody: "down",
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("fixed-response");
      expect(
        observed?.DefaultActions?.[0]?.FixedResponseConfig?.StatusCode,
      ).toBe("503");

      // STAGE 4: weighted multi-target-group forward with stickiness.
      yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(224),
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(225),
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          const tgBlue = yield* TargetGroup("LTgBlue", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const tgGreen = yield* TargetGroup("LTgGreen", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "forward",
                targetGroups: [
                  { targetGroupArn: tgBlue.targetGroupArn, weight: 90 },
                  { targetGroupArn: tgGreen.targetGroupArn, weight: 10 },
                ],
                stickiness: { enabled: true, durationSeconds: 3600 },
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      const forward = observed?.DefaultActions?.find(
        (x) => x.Type === "forward",
      );
      expect(forward?.ForwardConfig?.TargetGroups?.length).toBe(2);
      const weights = (forward?.ForwardConfig?.TargetGroups ?? [])
        .map((t) => t.Weight)
        .sort();
      expect(weights).toEqual([10, 90]);
      expect(forward?.ForwardConfig?.TargetGroupStickinessConfig?.Enabled).toBe(
        true,
      );

      yield* stack.destroy();

      // Verify the listener is gone.
      const after = yield* elbv2
        .describeListeners({ ListenerArns: [listenerArn] })
        .pipe(
          Effect.map((r) => r.Listeners?.length ?? 0),
          Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
