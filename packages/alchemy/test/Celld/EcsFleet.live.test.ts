import * as AWS from "@/AWS/index.ts";
import * as Celld from "@/Celld/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Core from "@/Test/Core.ts";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LiveWorker from "./fixtures/ecs-live/worker.ts";

const options = {
  providers: Layer.mergeAll(
    AWS.providers(),
    Celld.providers(),
    Celld.EcsFleet({
      capacity: { type: "ec2", instanceType: "m7i.large" },
      containerRuntime: "runsc",
    }),
  ),
};
const { test } = Test.make(options);
const stack = Core.scratchStack(options, "CelldEc2Live", import.meta.url);
const cleanupOnly = process.env.CELLD_ECS_FLEET_CLEANUP === "1";

// Cold EC2, NLB and Lambda ENI provisioning can exceed 120s. Every invocation
// remains under timeout 240; cleanup-only mode resumes ordinary stack teardown.
test.skipIf(process.env.CELLD_ECS_FLEET_LIVE !== "1")(
  cleanupOnly
    ? "cleans up owned Celld EC2 probe infrastructure without deploying"
    : "dedicated EC2 Celld publishes through private management and executes a fenced runsc container",
  Core.withProviders(
    Effect.gen(function* () {
      if (cleanupOnly || process.env.CELLD_ECS_FLEET_RESUME !== "1") {
        yield* Effect.logInfo(
          "Destroying previous CelldEc2Live compute; persistent data is retained",
        );
        yield* stack.destroy();
      }
      if (cleanupOnly) return;
      const vpcs = yield* ec2.describeVpcs({
        Filters: [{ Name: "is-default", Values: ["true"] }],
      });
      const vpcId = vpcs.Vpcs?.[0]?.VpcId;
      if (!vpcId)
        return yield* Effect.fail(
          new Error("The live probe requires an existing default VPC"),
        );
      const subnets = yield* ec2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const subnetIds = [...(subnets.Subnets ?? [])]
        .sort((a, b) =>
          (a.AvailabilityZone ?? "").localeCompare(b.AvailabilityZone ?? ""),
        )
        .slice(0, 2)
        .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []));
      expect(subnetIds).toHaveLength(2);
      yield* Effect.logInfo(
        "Deploying one Celld node and one spare dedicated host",
      );
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cells = yield* Celld.Fleet("Cells", {
            instances: 1,
            cpuArchitecture: "X86_64",
            cpu: 1024,
            memory: 4096,
            vpc: { vpcId, subnetIds, securityGroupIds: [] },
            tags: { "celld-live-probe": "ecs-runsc" },
          });
          const application = yield* Celld.Application("Application", {
            entrypoint: LiveWorker,
          }).pipe(Effect.provide(Celld.Fleet.layer(Effect.succeed(cells))));
          return {
            url: application.url,
            revision: application.revision,
            hostState: cells.hostState,
            bucket: cells.bucket,
          };
        }),
      );
      yield* Effect.logInfo({ phase: "activated", ...deployed });
      const host = deployed.hostState!;
      expect(host.capabilities).toEqual({ containers: true, sandbox: true });
      const services = yield* ecs
        .describeServices({
          cluster: host.clusterArn,
          services: [host.serviceName],
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            times: 8,
            until: (response) =>
              response.services?.[0]?.runningCount === 1 &&
              response.services[0].pendingCount === 0,
          }),
        );
      expect(services.services?.[0]?.desiredCount).toBe(1);
      expect(services.services?.[0]?.runningCount).toBe(1);
      const groups = yield* autoscaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [host.autoScalingGroupName],
      });
      const hosts = groups.AutoScalingGroups?.[0]?.Instances ?? [];
      expect(hosts).toHaveLength(2);
      const instances = yield* ec2.describeInstances({
        InstanceIds: hosts.map((instance) => instance.InstanceId!),
      });
      for (const instance of instances.Reservations?.flatMap(
        (reservation) => reservation.Instances ?? [],
      ) ?? []) {
        expect(instance.State?.Name).toBe("running");
        expect(instance.InstanceType).toBe("m7i.large");
        expect(instance.Architecture).toBe("x86_64");
      }
      const runner = yield* lambda.getFunctionConfiguration({
        FunctionName: host.managementFunctionArn,
      });
      expect(runner.VpcConfig?.SecurityGroupIds).toEqual(
        host.managementSecurityGroupIds,
      );
      const functionUrl = yield* lambda
        .getFunctionUrlConfig({ FunctionName: host.managementFunctionArn })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(functionUrl).toBeUndefined();
      const http = yield* HttpClient.HttpClient;
      const body = yield* http.get(deployed.url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text
            : Effect.fail(new Error(`HTTP readiness ${response.status}`)),
        ),
        Effect.timeout("5 seconds"),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
      );
      expect(body).toBe("celld-ec2-live");
      const container = yield* http
        .get(`${deployed.url.replace(/\/$/, "")}/container`)
        .pipe(Effect.timeout("45 seconds"));
      const result = yield* container.text;
      yield* Effect.logInfo({
        phase: "container",
        status: container.status,
        result,
      });
      expect(container.status).toBe(200);
      const report = yield* Effect.try(
        () =>
          JSON.parse(result) as {
            stdout: string;
            stderr: string;
            exitCode: number;
          },
      );
      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("celld-runsc-ok");
      expect(report.stdout.toLowerCase()).toContain("gvisor");
      expect(report.stdout).toContain("FENCE_BLOCKED");
      expect(report.stdout).not.toContain("FENCE_OPEN");
      if (process.env.NO_DESTROY) {
        yield* Effect.logInfo(
          "Retaining the verified EC2 probe for inspection",
        );
        return;
      }
      yield* stack.destroy();
      yield* Effect.logInfo({
        phase: "destroyed",
        retainedBucket: deployed.bucket.uri,
      });
    }),
    options,
    stack.name,
  ),
  { timeout: 210_000 },
);
