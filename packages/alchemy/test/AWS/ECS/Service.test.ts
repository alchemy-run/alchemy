import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2/Subnet.ts";
import { Vpc } from "@/AWS/EC2/Vpc.ts";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region collection, fanned out per
// cluster): deploy a real cluster + service, resolve the provider from context
// via the typed `findProvider`, call `list()`, and assert the deployed service
// appears in the exhaustively-paginated result
// (listClusters -> listServices -> describeServices hydration).
//
// To stay inside the speed budget we avoid building/pushing a Docker image
// (the canonical `AWS.ECS.Task` resource) and instead register a minimal task
// definition against a public image and run the service at `desiredCount: 0`,
// so `createService` returns immediately without waiting for Fargate task
// placement. Networking is a throwaway VPC + single subnet (no NAT/IGW needed
// since no task is ever launched).
test.provider("list enumerates the deployed service", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Register a minimal Fargate task definition pointing at a public image.
    const registered = yield* ecs.registerTaskDefinition({
      family: "alchemy-test-ecs-service-list",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      containerDefinitions: [
        {
          name: "app",
          image: "public.ecr.aws/nginx/nginx:stable",
          essential: true,
          portMappings: [{ containerPort: 80, protocol: "tcp" }],
        },
      ],
    });
    const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn;
    if (!taskDefinitionArn) {
      return yield* Effect.die(
        new Error("registerTaskDefinition returned no task definition ARN"),
      );
    }

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListServiceVpc", {
          cidrBlock: "10.71.0.0/16",
        });
        const subnet = yield* Subnet("ListServiceSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.71.1.0/24",
        });
        const cluster = yield* Cluster("ListServiceCluster", {
          clusterName: "alchemy-test-ecs-service-list",
        });
        return yield* Service("ListService", {
          cluster,
          task: {
            taskDefinitionArn,
            containerName: "app",
            port: 80,
          },
          desiredCount: 0,
          vpcId: vpc.vpcId,
          subnets: [subnet.subnetId],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Service);
    const all = yield* provider.list();

    expect(all.some((s) => s.serviceArn === service.serviceArn)).toBe(true);
    const found = all.find((s) => s.serviceArn === service.serviceArn);
    expect(found?.serviceName).toEqual(service.serviceName);
    expect(found?.clusterArn).toEqual(service.clusterArn);

    yield* stack.destroy();

    yield* ecs
      .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
      .pipe(Effect.catchTag("ClientException", () => Effect.void));
  }),
);
