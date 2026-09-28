import * as AWS from "@/AWS/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Explicit opt-in: creates real ECS resources, but desiredCount: 0 launches no tasks.
test.provider.skipIf(process.env.CELLD_ECS_NETWORK_LIVE !== "1")(
  "AWS accepts host/bridge network omission and preserves awsvpc on create and update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const network = yield* getDefaultVpcNetwork;
      const deploy = (round: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("NetworkCluster", {});
            return yield* Effect.forEach(
              ["host", "bridge", "awsvpc"] as const,
              (mode) =>
                Effect.gen(function* () {
                  const task = yield* AWS.ECS.TaskDefinition(`Task-${mode}`, {
                    networkMode: mode,
                    requiresCompatibilities: [
                      mode === "awsvpc" ? "FARGATE" : "EC2",
                    ],
                    cpu: 256,
                    memory: 512,
                    containerDefinitions: [
                      {
                        name: "main",
                        image: "busybox:stable",
                        essential: true,
                        portMappings: [
                          {
                            containerPort: 8080,
                            hostPort: mode === "bridge" ? 0 : 8080,
                            protocol: "tcp",
                          },
                        ],
                      },
                    ],
                  });
                  const service = yield* AWS.ECS.Service(`Service-${mode}`, {
                    cluster,
                    task: {
                      taskDefinitionArn: task.taskDefinitionArn,
                      containerName: task.containerName,
                      port: task.port,
                      networkMode: mode,
                    },
                    launchType: mode === "awsvpc" ? "FARGATE" : "EC2",
                    desiredCount: 0,
                    ...(mode === "awsvpc"
                      ? { vpcId: network.vpcId, subnets: network.subnetIds }
                      : {}),
                    tags: { round },
                  });
                  return {
                    mode,
                    clusterArn: cluster.clusterArn,
                    serviceName: service.serviceName,
                  };
                }),
            );
          }),
        );
      for (const round of ["create", "update"]) {
        const services = yield* deploy(round);
        for (const service of services) {
          const response = yield* ecs.describeServices({
            cluster: service.clusterArn,
            services: [service.serviceName],
          });
          const observed = response.services?.[0];
          expect(observed?.desiredCount).toBe(0);
          if (service.mode === "awsvpc") {
            expect(
              observed?.networkConfiguration?.awsvpcConfiguration?.subnets,
            ).toEqual(expect.arrayContaining(network.subnetIds));
          } else {
            expect(observed?.networkConfiguration).toBeUndefined();
          }
        }
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
