import {
  Service,
  declaredServiceNetworkMode,
  serviceNetworkConfiguration,
  serviceTargetType,
} from "@/AWS/ECS/Service.ts";
import { ServiceIngress } from "@/AWS/ECS/ServiceIngress.ts";
import * as Output from "@/Output.ts";
import { Region } from "@distilled.cloud/aws/Region";
import { Stack } from "@/Stack.ts";
import { Providers } from "@/AWS/Providers.ts";
import { inMemoryState } from "@/State/InMemoryState.ts";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const network = { subnets: ["subnet-test"], assignPublicIp: true };

describe("ECS service network modes", () => {
  it("preserves awsvpc/Fargate network configuration", () => {
    expect(serviceNetworkConfiguration("awsvpc", network, ["sg-test"])).toEqual(
      {
        awsvpcConfiguration: {
          subnets: ["subnet-test"],
          securityGroups: ["sg-test"],
          assignPublicIp: "ENABLED",
        },
      },
    );
    expect(
      serviceNetworkConfiguration(
        "awsvpc",
        { ...network, assignPublicIp: false },
        undefined,
      )?.awsvpcConfiguration?.assignPublicIp,
    ).toBe("DISABLED");
  });

  it("omits service-level networking for host, bridge, and none", () => {
    for (const mode of ["host", "bridge", "none"] as const) {
      expect(
        serviceNetworkConfiguration(mode, network, ["sg-test"]),
      ).toBeUndefined();
      expect(
        serviceNetworkConfiguration(mode, undefined, undefined),
      ).toBeUndefined();
    }
  });

  it("selects instance targets for host/bridge and IP targets for awsvpc", () => {
    expect(serviceTargetType("host")).toBe("instance");
    expect(serviceTargetType("bridge")).toBe("instance");
    expect(serviceTargetType("awsvpc")).toBe("ip");
  });

  it("honors task-definition overrides and explicit referenced-task mode", () => {
    const cluster = "arn:aws:ecs:us-east-1:123456789012:cluster/test";
    expect(
      declaredServiceNetworkMode({ cluster, image: "busybox:stable" }),
    ).toBe("awsvpc");
    expect(
      declaredServiceNetworkMode({
        cluster,
        image: "busybox:stable",
        networkMode: "awsvpc",
        taskDefinition: { networkMode: "host" },
      }),
    ).toBe("host");
    expect(
      declaredServiceNetworkMode({
        cluster,
        task: {
          taskDefinitionArn: "task:test",
          containerName: "main",
          port: 8080,
          networkMode: "bridge",
        },
      }),
    ).toBe("bridge");
  });

  for (const mode of ["host", "bridge", "awsvpc"] as const) {
    it.effect(
      `Service managed ingress uses the ${mode} task's target type`,
      () =>
        Effect.gen(function* () {
          const stack = yield* Stack;
          yield* Service("Service", {
            cluster: "arn:aws:ecs:us-east-1:123456789012:cluster/test",
            image: "busybox:stable",
            networkMode: mode,
            launchType: mode === "awsvpc" ? "FARGATE" : "EC2",
            requiresCompatibilities: [mode === "awsvpc" ? "FARGATE" : "EC2"],
            vpcId: "vpc-test",
            subnets: ["subnet-a", "subnet-b"],
            port: 8080,
            loadBalancer: true,
          });
          const targets = Object.values(stack.resources).filter(
            (resource) => resource.Type === "AWS.ELBv2.TargetGroup",
          );
          expect(targets).toHaveLength(1);
          expect(targets[0]!.Props.targetType).toBe(
            mode === "awsvpc" ? "ip" : "instance",
          );
          expect(targets[0]!.Props.port).toBe(8080);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              inMemoryState(),
              Layer.succeed(Providers, {
                kind: "ProviderCollection",
                get: () => undefined,
                providers: {},
              }),
              Layer.succeed(Region, Effect.succeed("us-east-1")),
              Layer.succeed(Stack, {
                name: "ecs-managed-network-test",
                stage: "test",
                resources: {},
                bindings: {},
                actions: {},
              }),
            ),
          ),
        ),
    );
    it.effect(
      `ServiceIngress composes ${mode} target type and container-port attachment`,
      () =>
        Effect.gen(function* () {
          const stack = yield* Stack;
          yield* ServiceIngress("Ingress", {
            network: { vpcId: "vpc-test", subnetIds: ["subnet-a", "subnet-b"] },
            service: {
              clusterArn: "cluster:test",
              serviceName: "test",
              containerName: "celld",
            },
            networkMode:
              mode === "host"
                ? Output.asOutput(mode)
                : mode === "bridge"
                  ? Config.succeed(mode)
                  : Effect.succeed(mode),
            port: 8080,
            healthCheck: { path: "/health" },
          });
          const target = stack.resources["Ingress/TargetGroup"]!;
          expect(yield* Output.evaluate(target.Props.targetType, {})).toBe(
            mode === "awsvpc" ? "ip" : "instance",
          );
          expect(target.Props.port).toBe(8080);
          const attachment = stack.resources["Ingress/Attachment"]!;
          expect(attachment.Props.containerName).toBe("celld");
          expect(attachment.Props.containerPort).toBe(8080);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              inMemoryState(),
              Layer.succeed(Providers, {
                kind: "ProviderCollection",
                get: () => undefined,
                providers: {},
              }),
              Layer.succeed(Region, Effect.succeed("us-east-1")),
              Layer.succeed(Stack, {
                name: "ecs-network-test",
                stage: "test",
                resources: {},
                bindings: {},
                actions: {},
              }),
            ),
          ),
        ),
    );
  }
});
