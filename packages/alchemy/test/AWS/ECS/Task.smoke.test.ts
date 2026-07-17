import * as AWS from "@/AWS";
import {
  InternetGateway,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  Subnet,
  Vpc,
} from "@/AWS/EC2";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestTask from "./fixtures/task.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Full end-to-end: build + push the bundled Task image, run it on Fargate
// behind an Alchemy-managed public ALB, and prove over HTTP that (a) the
// `{ fetch }` handler is served and (b) the `ServerHost.run` background loop is
// actually executing inside the deployed container (`/ticks` keeps climbing).
//
// This is the real-deploy regression for #706. It is heavy (Docker build + ECR
// push + Fargate placement + ALB health), so it is skipped under `FAST=1`.
test.provider.skipIf(!!process.env.FAST)(
  "deploys a real Fargate task that serves HTTP and runs a background loop",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* ec2.describeAvailabilityZones({});
      const available = (azResult.AvailabilityZones ?? []).filter(
        (az) => az.State === "available",
      );
      const az1 = available[0]?.ZoneName!;
      const az2 = available[1]?.ZoneName!;

      const { url, targetGroupArn } = yield* stack.deploy(
        Effect.gen(function* () {
          // Public networking: VPC + IGW + 2 public subnets (ALB needs ≥2 AZs)
          // + route to the IGW + a security group that admits the ALB (80) and
          // the container traffic port (3000).
          const vpc = yield* Vpc("EcsE2EVpc", {
            cidrBlock: "10.80.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
          const igw = yield* InternetGateway("EcsE2EIgw", {
            vpcId: vpc.vpcId,
          });
          const subnetA = yield* Subnet("EcsE2ESubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.80.1.0/24",
            availabilityZone: az1,
            mapPublicIpOnLaunch: true,
          });
          const subnetB = yield* Subnet("EcsE2ESubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.80.2.0/24",
            availabilityZone: az2,
            mapPublicIpOnLaunch: true,
          });
          const routeTable = yield* RouteTable("EcsE2ERouteTable", {
            vpcId: vpc.vpcId,
          });
          yield* Route("EcsE2ERoute", {
            routeTableId: routeTable.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: igw.internetGatewayId,
          });
          yield* RouteTableAssociation("EcsE2EAssocA", {
            routeTableId: routeTable.routeTableId,
            subnetId: subnetA.subnetId,
          });
          yield* RouteTableAssociation("EcsE2EAssocB", {
            routeTableId: routeTable.routeTableId,
            subnetId: subnetB.subnetId,
          });
          const securityGroup = yield* SecurityGroup("EcsE2ESg", {
            vpcId: vpc.vpcId,
            description: "alchemy ecs task e2e",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "ALB ingress",
              },
              {
                ipProtocol: "tcp",
                fromPort: 3000,
                toPort: 3000,
                cidrIpv4: "0.0.0.0/0",
                description: "container traffic",
              },
            ],
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "all outbound",
              },
            ],
          });

          const cluster = yield* Cluster("EcsE2ECluster", {
            clusterName: "alchemy-test-ecs-task-e2e",
          });

          // The bundled long-running Task (builds + pushes the image).
          const task = yield* TestTask;

          const service = yield* Service("EcsE2EService", {
            cluster,
            task: {
              taskDefinitionArn: task.taskDefinitionArn,
              containerName: task.containerName,
              port: task.port,
            },
            desiredCount: 1,
            public: true,
            listenerPort: 80,
            healthCheckPath: "/health",
            vpcId: vpc.vpcId,
            subnets: [subnetA.subnetId, subnetB.subnetId],
            securityGroups: [securityGroup.groupId],
            assignPublicIp: true,
          });

          return {
            url: service.url,
            targetGroupArn: service.targetGroupArn,
          };
        }),
      );

      expect(url).toBeTruthy();
      expect(targetGroupArn).toBeTruthy();

      // Gate on target health via the ELBv2 API (no DNS): wait until the task
      // is placed, the image pulled, and the ALB health check on `/health`
      // passes. Polling via the API — rather than HTTP — avoids looking up the
      // freshly-created ALB hostname before its DNS record exists (a premature
      // lookup gets NXDOMAIN negatively cached by the resolver for minutes).
      yield* elbv2
        .describeTargetHealth({ TargetGroupArn: targetGroupArn! })
        .pipe(
          Effect.flatMap((result) => {
            const states = (result.TargetHealthDescriptions ?? []).map(
              (t) => t.TargetHealth?.State,
            );
            return states.includes("healthy")
              ? Effect.void
              : Effect.fail(
                  new Error(`no healthy target yet: [${states.join(", ")}]`),
                );
          }),
          Effect.tapError((error) => Effect.logError(error)),
          // ~12 min budget: image pull + container boot + the ALB health check
          // ramp (default 5 × 30s consecutive successes) can take several
          // minutes for a cold Fargate task.
          Effect.retry({ schedule: Schedule.spaced("12 seconds"), times: 60 }),
        );

      // The ALB has been active for a while now, so its DNS resolves. Probe the
      // public endpoint (still retry through edge/DNS propagation).
      const health = yield* HttpClient.get(`${url}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 30 }),
      );
      expect(health.status).toBe(200);
      expect(yield* health.json).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing in-container:
      // the tick counter climbs between two reads.
      const readTicks = HttpClient.get(`${url}/ticks`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      yield* Effect.sleep("3 seconds");
      const second = yield* readTicks;
      expect(second).toBeGreaterThan(first);

      yield* stack.destroy();
    }),
  { timeout: 1_200_000 },
);
