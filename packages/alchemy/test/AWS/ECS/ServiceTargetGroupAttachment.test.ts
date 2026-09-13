import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2/Subnet.ts";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import { ServiceTargetGroupAttachment } from "@/AWS/ECS/ServiceTargetGroupAttachment.ts";
import { Listener, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";
import { reclaimTaskDefinitionFamily } from "./reclaimTaskDefinitionFamily.ts";

const { test } = Test.make({ providers: AWS.providers() });

const CLUSTER_NAME = "alchemy-test-ecs-tg-attachment";
const FAMILY = "alchemy-test-ecs-tg-attachment";

// Attach a composed target group to an EXISTING service (the out-of-band
// counterpart of `Service`'s own `loadBalancer` prop), verify the service's
// load-balancer list out of band, re-deploy to prove idempotence, then
// destroy and verify the detach + teardown out of band.
//
// The service runs at `desiredCount: 0` against a minimal public-image task
// definition so no Fargate task is ever placed: the attachment deployment
// converges immediately (0 desired = 0 running) and the whole lifecycle fits
// the speed budget. Networking is stack-owned subnets in the standing default
// VPC (two AZs, required for an application load balancer).
test.provider(
  "attaches a target group to an existing service and detaches on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* reclaimTaskDefinitionFamily(FAMILY);
      yield* Effect.addFinalizer(() =>
        reclaimTaskDefinitionFamily(FAMILY).pipe(Effect.ignore),
      );
      const registered = yield* ecs.registerTaskDefinition({
        family: FAMILY,
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

      const azResult = yield* EC2.describeAvailabilityZones({});
      const availableAzs =
        azResult.AvailabilityZones?.filter((az) => az.State === "available") ??
        [];
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;
      const defaultVpc = yield* getDefaultVpc;

      const program = Effect.gen(function* () {
        const subnet1 = yield* Subnet("AttachmentSubnet1", {
          vpcId: defaultVpc.vpcId,
          cidrBlock: defaultVpc.subnetCidrBlock(241),
          availabilityZone: az1,
        });
        const subnet2 = yield* Subnet("AttachmentSubnet2", {
          vpcId: defaultVpc.vpcId,
          cidrBlock: defaultVpc.subnetCidrBlock(242),
          availabilityZone: az2,
        });
        const cluster = yield* Cluster("AttachmentCluster", {
          clusterName: CLUSTER_NAME,
        });
        const service = yield* Service("AttachmentService", {
          cluster,
          task: { taskDefinitionArn, containerName: "app", port: 80 },
          desiredCount: 0,
          vpcId: defaultVpc.vpcId,
          subnets: [subnet1.subnetId, subnet2.subnetId],
        });
        const targetGroup = yield* TargetGroup("AttachmentTargetGroup", {
          vpcId: defaultVpc.vpcId,
          port: 80,
          protocol: "HTTP",
          targetType: "ip",
        });
        const loadBalancer = yield* LoadBalancer("AttachmentLoadBalancer", {
          type: "application",
          scheme: "internal",
          subnets: [subnet1.subnetId, subnet2.subnetId],
        });
        const listener = yield* Listener("AttachmentListener", {
          loadBalancerArn: loadBalancer.loadBalancerArn,
          targetGroupArn: targetGroup.targetGroupArn,
          port: 80,
          protocol: "HTTP",
        });
        const attachment = yield* ServiceTargetGroupAttachment("Attachment", {
          cluster: cluster.clusterArn,
          serviceName: service.serviceName,
          // ECS only accepts a target group already associated with a load
          // balancer — gate the ARN on the listener like ServiceIngress does.
          targetGroupArn: Output.all(
            Output.asOutput(targetGroup.targetGroupArn),
            Output.asOutput(listener.listenerArn),
          ).pipe(
            Output.map(([targetGroupArn]: [string, string]) => targetGroupArn),
          ),
          containerName: "app",
          containerPort: 80,
        });
        return {
          attachment,
          serviceName: service.serviceName,
          targetGroupArn: targetGroup.targetGroupArn,
        };
      });

      const describeAttachedService = (serviceName: string) =>
        ecs
          .describeServices({ cluster: CLUSTER_NAME, services: [serviceName] })
          .pipe(
            Effect.map((described) =>
              described.services?.find(
                (service) => service.serviceName === serviceName,
              ),
            ),
          );

      const deployed = yield* stack.deploy(program);
      expect(deployed.attachment.targetGroupArn).toBe(deployed.targetGroupArn);
      expect(deployed.attachment.serviceName).toBe(deployed.serviceName);

      // Out-of-band: the service's load balancer list carries our entry.
      const attached = yield* describeAttachedService(deployed.serviceName);
      expect(attached?.loadBalancers).toEqual([
        {
          targetGroupArn: deployed.targetGroupArn,
          containerName: "app",
          containerPort: 80,
        },
      ]);

      // Idempotent: a second deploy observes the entry and changes nothing.
      const again = yield* stack.deploy(program);
      expect(again.attachment.targetGroupArn).toBe(deployed.targetGroupArn);
      const stillAttached = yield* describeAttachedService(
        deployed.serviceName,
      );
      expect(
        stillAttached?.loadBalancers?.map((lb) => lb.targetGroupArn),
      ).toEqual([deployed.targetGroupArn]);

      yield* stack.destroy();

      // Out-of-band gone-proofs: the target group is deleted (the detach
      // released it) and the cluster is INACTIVE or absent.
      const targetGroups = yield* elbv2
        .describeTargetGroups({ TargetGroupArns: [deployed.targetGroupArn] })
        .pipe(
          Effect.map((r) => r.TargetGroups?.length ?? 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(targetGroups).toBe(0);
      const clusters = yield* ecs.describeClusters({
        clusters: [CLUSTER_NAME],
      });
      expect((clusters.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(
        false,
      );

      yield* reclaimTaskDefinitionFamily(FAMILY);
    }),
  { timeout: 300_000 },
);
