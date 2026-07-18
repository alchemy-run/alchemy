import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// The image-owning `Service` platform form: `image:` (mirrored into ECR) with
// `loadBalancer: true` — the Service synthesizes its own task definition
// (roles, log group, ECR repository) and wires an ALB + target group +
// listener + owned ingress security group, defaulting networking to the
// account's default VPC. `desiredCount: 0` keeps the test inside the speed
// budget (no Fargate placement, no image pull on the service side — the
// mirror is a local docker pull/tag/push of a tiny busybox).
//
// Requires a local Docker daemon (same as the ECS Bindings fixture).
test.provider(
  "image-owning service synthesizes its task definition and ALB",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("PlatformSvcCluster", {
            clusterName: "alchemy-test-ecs-service-platform",
          });
          // Docker Hub busybox: the public.ecr.aws mirror aggressively
          // rate-limits anonymous pulls during local builds.
          return yield* Service("PlatformEdge", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            port: 80,
            desiredCount: 0,
            loadBalancer: true,
          });
        }),
      );

      // Synthesized task definition attributes.
      expect(deployed.serviceArn).toBeTruthy();
      expect(deployed.taskDefinitionArn).toBeTruthy();
      expect(deployed.taskFamily).toBeTruthy();
      expect(deployed.repositoryName).toBeTruthy();
      expect(deployed.imageUri).toContain(deployed.repositoryName!);
      expect(deployed.code?.hash).toBeTruthy();
      expect(deployed.taskRoleArn).toBeTruthy();
      expect(deployed.executionRoleArn).toBeTruthy();
      expect(deployed.logGroupName).toBeTruthy();

      // Managed ingress attributes.
      expect(deployed.url).toMatch(/^http:\/\//);
      expect(deployed.loadBalancerArn).toBeTruthy();
      expect(deployed.targetGroupArn).toBeTruthy();
      expect(deployed.listenerArn).toBeTruthy();
      expect(deployed.securityGroupId).toBeTruthy();

      // Out-of-band: the registered task definition runs the mirrored image.
      const described = yield* ecs.describeTaskDefinition({
        taskDefinition: deployed.taskDefinitionArn,
      });
      const container = described.taskDefinition?.containerDefinitions?.[0];
      expect(container?.image).toBe(deployed.imageUri);
      expect(container?.command).toEqual([
        "sh",
        "-c",
        "while true; do sleep 30; done",
      ]);
      expect(container?.portMappings?.[0]?.containerPort).toBe(80);

      // Out-of-band: the service is wired to the generated target group.
      const services = yield* ecs.describeServices({
        cluster: deployed.clusterArn,
        services: [deployed.serviceName],
      });
      const svc = services.services?.[0];
      expect(svc?.loadBalancers?.[0]?.targetGroupArn).toBe(
        deployed.targetGroupArn,
      );
      expect(svc?.loadBalancers?.[0]?.containerPort).toBe(80);

      yield* stack.destroy();

      // Zero-orphan proofs: every owned resource is gone (or terminally
      // deleting) after destroy.
      const repoGone = yield* ecr
        .describeRepositories({
          repositoryNames: [deployed.repositoryName!],
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("RepositoryNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(repoGone).toBe(true);

      const lbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancerArn!],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(lbGone).toBe(true);

      const sgGone = yield* ec2
        .describeSecurityGroups({ GroupIds: [deployed.securityGroupId!] })
        .pipe(
          Effect.map((r) => (r.SecurityGroups ?? []).length === 0),
          Effect.catchTag("InvalidGroup.NotFound", () => Effect.succeed(true)),
        );
      expect(sgGone).toBe(true);

      // The revision is deregistered (INACTIVE / DELETE_IN_PROGRESS) or
      // already hard-deleted.
      const taskDefGone = yield* ecs
        .describeTaskDefinition({
          taskDefinition: deployed.taskDefinitionArn,
        })
        .pipe(
          Effect.map((r) => r.taskDefinition?.status !== "ACTIVE"),
          Effect.catchTag("ClientException", () => Effect.succeed(true)),
        );
      expect(taskDefGone).toBe(true);

      const clusters = yield* ecs.describeClusters({
        clusters: ["alchemy-test-ecs-service-platform"],
      });
      expect((clusters.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(
        false,
      );
    }),
  { timeout: 420_000 },
);
