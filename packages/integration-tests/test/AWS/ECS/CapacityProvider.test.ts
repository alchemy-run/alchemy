import * as AWS from "@alchemy.run/aws";
import { AutoScalingGroup, LaunchTemplate } from "@alchemy.run/aws/AutoScaling";
import { amazonLinux2023 } from "@alchemy.run/aws/EC2";
import { CapacityProvider, Cluster, Service, TaskDefinition } from "@alchemy.run/aws/ECS";
import { InstanceProfile } from "@alchemy.run/aws/IAM/InstanceProfile";
import { Role } from "@alchemy.run/aws/IAM/Role";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// `list()` enumerates every capacity provider in the account/region via the
// `describeCapacityProviders` op (paginated with `nextToken`), filtering out the
// AWS-managed `FARGATE`/`FARGATE_SPOT` reserved providers. This ungated case
// proves the pagination + typing run live against the real API without needing
// an ASG-backed provider to exist.
test.provider(
  "list enumerates capacity providers in the account/region",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(CapacityProvider);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Reserved AWS-managed providers must be filtered out.
      expect(all.some((p) => p.name === "FARGATE")).toBe(false);
      expect(all.some((p) => p.name === "FARGATE_SPOT")).toBe(false);
      // Every returned item carries the full Attributes shape.
      for (const p of all) {
        expect(typeof p.name).toBe("string");
        expect(p.capacityProviderArn).toMatch(/^arn:aws:ecs:[^:]+:\d+:capacity-provider\//);
      }
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ecs", "live"], timeout: 120_000 },
);

// Full deploy + list assertion. Requires a pre-provisioned EC2 Auto Scaling
// Group ARN (set via TEST_ASG_ARN): a real capacity provider cannot be created
// without an ASG, and the distilled `auto-scaling` service is currently
// non-functional against the live API (aws-query Action derivation bug — see
// AutoScalingGroup.test.ts), so an ASG cannot be provisioned in-test. Run with:
//   TEST_ASG_ARN=arn:aws:autoscaling:... bun vitest CapacityProvider
test.provider.skipIf(!process.env.TEST_ASG_ARN)(
  "list includes a deployed capacity provider",
  (stack) =>
    Effect.gen(function* () {
      const autoScalingGroupArn = process.env.TEST_ASG_ARN!;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        CapacityProvider("ListCapacityProvider", {
          autoScalingGroupArn,
          managedScaling: {
            status: "ENABLED",
            targetCapacity: 80,
            minimumScalingStepSize: 1,
            maximumScalingStepSize: 10,
          },
          managedTerminationProtection: "DISABLED",
          tags: { env: "test" },
        }),
      );

      const provider = yield* Provider.findProvider(CapacityProvider);
      const all = yield* provider.list();

      expect(all.some((p) => p.name === deployed.name)).toBe(true);
      expect(all.some((p) => p.capacityProviderArn === deployed.capacityProviderArn)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ecs", "live"], timeout: 600_000 },
);

// A deleted capacity provider stays describable as INACTIVE for a while and
// can no longer be updated. Removing a provider and adding it back (same
// deterministic name) must create a fresh one rather than try to update the
// INACTIVE leftover. The ASG is sized to zero, so no instance launches.
test.provider(
  "recreates a capacity provider that was removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subnetIds } = yield* getDefaultVpcNetwork;
      // Explicit, stage-scoped name: ECS rejects names prefixed with
      // `aws`/`ecs`/`fargate`, which a generated name for this suite would be.
      const providerName = `alchemy-recreated-${stack.stage.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;

      const program = (withProvider: boolean) =>
        Effect.gen(function* () {
          const template = yield* LaunchTemplate("CapacityTemplate", {
            imageId: amazonLinux2023(),
            instanceType: "t3.micro",
          });
          const group = yield* AutoScalingGroup("CapacityGroup", {
            launchTemplate: template,
            subnetIds: [subnetIds[0] as `subnet-${string}`],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
          const provider = withProvider
            ? yield* CapacityProvider("RecreatedProvider", {
                name: providerName,
                autoScalingGroupArn: group.autoScalingGroupArn,
                managedTerminationProtection: "DISABLED",
              })
            : undefined;
          return { provider };
        });

      const first = yield* stack.deploy(program(true));
      const name = first.provider!.name;

      yield* stack.deploy(program(false));
      const removed = yield* ecs.describeCapacityProviders({ capacityProviders: [name] });
      expect(removed.capacityProviders?.every((p) => p.status !== "ACTIVE")).toBe(true);

      const second = yield* stack.deploy(program(true));
      expect(second.provider!.name).toBe(name);
      expect(second.provider!.status).toBe("ACTIVE");
      const live = yield* ecs.describeCapacityProviders({ capacityProviders: [name] });
      expect(live.capacityProviders?.some((p) => p.status === "ACTIVE")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ecs", "live"],
    timeout: 300_000,
  },
);

// A Managed Instances provider given only subnets creates what ECS needs
// around it: the infrastructure role, the instance role and profile, a
// security group for the instances and one for their tasks. It picks instance
// types that support Nitro Sandboxes. No task runs, so no instance launches.
test.provider(
  "Managed Instances capacity creates its roles, profile and security groups",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { vpcId, subnetIds } = yield* getDefaultVpcNetwork;

      const program = Effect.gen(function* () {
        const cluster = yield* Cluster("DefaultsCluster", {});
        const provider = yield* CapacityProvider("DefaultsCapacity", {
          cluster: cluster.clusterName,
          managedInstancesProvider: {
            instanceLaunchTemplate: {
              networkConfiguration: { subnets: subnetIds },
              nitroEnclavesEnabled: true,
            },
          },
        });
        return {
          clusterName: cluster.clusterName,
          providerName: provider.name,
          infrastructureRoleName: provider.infrastructureRoleName,
          instanceRoleName: provider.instanceRoleName,
          instanceProfileName: provider.instanceProfileName,
          securityGroupId: provider.securityGroupId,
          taskSecurityGroupId: provider.taskSecurityGroupId,
        };
      });

      const deployed = yield* stack.deploy(program);
      const infrastructureRoleName = deployed.infrastructureRoleName!;
      const instanceRoleName = deployed.instanceRoleName!;
      const instanceProfileName = deployed.instanceProfileName!;
      const groupIds = [deployed.securityGroupId!, deployed.taskSecurityGroupId!];
      expect(groupIds[0]).not.toBe(groupIds[1]);

      const observed = (yield* ecs.describeCapacityProviders({
        cluster: deployed.clusterName,
      })).capacityProviders?.find((p) => p.name === deployed.providerName);
      const launchTemplate = observed?.managedInstancesProvider?.instanceLaunchTemplate;
      expect(observed?.status).toBe("ACTIVE");
      expect(launchTemplate?.nitroEnclavesEnabled).toBe(true);
      expect(launchTemplate?.networkConfiguration?.securityGroups).toEqual([
        deployed.securityGroupId,
      ]);
      // The default instance types support Nitro Sandboxes.
      expect(launchTemplate?.instanceRequirements?.allowedInstanceTypes).toContain("m7i.xlarge");
      expect(launchTemplate?.instanceRequirements?.vCpuCount).toMatchObject({ min: 4, max: 16 });

      // ECS assumes the infrastructure role and passes the instance role,
      // which the instances run with through the profile.
      const infrastructureRole = yield* iam.getRole({ RoleName: infrastructureRoleName });
      expect(observed?.managedInstancesProvider?.infrastructureRoleArn).toBe(
        infrastructureRole.Role.Arn,
      );
      const profile = yield* iam.getInstanceProfile({ InstanceProfileName: instanceProfileName });
      expect(launchTemplate?.ec2InstanceProfileArn).toBe(profile.InstanceProfile.Arn);
      expect(profile.InstanceProfile.Roles?.map((role) => role.RoleName)).toEqual([
        instanceRoleName,
      ]);

      // Both groups are in the subnets' VPC and admit nothing.
      const groups = yield* ec2.describeSecurityGroups({ GroupIds: groupIds });
      expect(groups.SecurityGroups?.map((group) => group.VpcId)).toEqual([vpcId, vpcId]);
      expect(groups.SecurityGroups?.flatMap((group) => group.IpPermissions ?? [])).toEqual([]);

      // The defaults are stable: an unchanged program plans no update.
      expect((yield* stack.plan(program)).resources.DefaultsCapacity?.action).toBe("noop");

      yield* stack.destroy();

      const roleExists = (RoleName: string) =>
        iam.getRole({ RoleName }).pipe(
          Effect.as(true),
          Effect.catchTag("NoSuchEntityException", () => Effect.succeed(false)),
        );
      expect(yield* roleExists(infrastructureRoleName)).toBe(false);
      expect(yield* roleExists(instanceRoleName)).toBe(false);
      expect(
        yield* iam.getInstanceProfile({ InstanceProfileName: instanceProfileName }).pipe(
          Effect.as(true),
          Effect.catchTag("NoSuchEntityException", () => Effect.succeed(false)),
        ),
      ).toBe(false);
      for (const groupId of groupIds) {
        expect(
          yield* ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
            Effect.map((found) => (found.SecurityGroups ?? []).length > 0),
            Effect.catchTag("InvalidGroup.NotFound", () => Effect.succeed(false)),
          ),
        ).toBe(false);
      }
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:ecs", "provider:aws:ec2", "provider:aws:iam", "live"],
    timeout: 600_000,
  },
);

class SandboxTaskNotRunning extends Data.TaggedError("SandboxTaskNotRunning")<{
  readonly status: string | undefined;
}> {}

// Nitro Sandboxes on ECS: a Managed Instances capacity provider with
// `nitroEnclavesEnabled` launches a supported instance, and a service whose
// task definition sets `ISOLATED_SANDBOX` runs its task in its own Nitro
// Sandbox. ECS reports the isolation on the running task. A mutable launch
// template field updates in place; destroy deletes the cluster-scoped
// provider. Launching the instance takes a few minutes.
test.provider.skipIf(!!process.env.FAST)(
  "Managed Instances capacity runs a task in a Nitro Sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { vpcId, subnetIds, defaultSecurityGroupId } = yield* getDefaultVpcNetwork;

      const program = (monitoring: "BASIC" | "DETAILED") =>
        Effect.gen(function* () {
          const instanceRole = yield* Role("SandboxInstanceRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonECSInstanceRolePolicyForManagedInstances",
            ],
          });
          const instanceProfile = yield* InstanceProfile("SandboxInstanceProfile", {
            roleName: instanceRole.roleName,
          });
          const infrastructureRole = yield* Role("SandboxInfrastructureRole", {
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
              "arn:aws:iam::aws:policy/AmazonECSInfrastructureRolePolicyForManagedInstances",
            ],
            // The managed policy only passes roles named `ecsInstanceRole*`.
            inlinePolicies: {
              PassInstanceRole: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["iam:PassRole"],
                    Resource: [instanceRole.roleArn],
                    Condition: { StringLike: { "iam:PassedToService": "ec2.*" } },
                  },
                ],
              },
            },
          });
          const cluster = yield* Cluster("SandboxCluster", {});
          const provider = yield* CapacityProvider("SandboxCapacity", {
            cluster: cluster.clusterName,
            managedInstancesProvider: {
              infrastructureRoleArn: infrastructureRole.roleArn,
              instanceLaunchTemplate: {
                ec2InstanceProfileArn: instanceProfile.instanceProfileArn,
                networkConfiguration: {
                  subnets: subnetIds,
                  securityGroups: [defaultSecurityGroupId],
                },
                monitoring,
                nitroEnclavesEnabled: true,
                instanceRequirements: {
                  vCpuCount: { min: 4, max: 4 },
                  memoryMiB: { min: 8192, max: 16384 },
                  allowedInstanceTypes: ["m6i.xlarge", "m7i.xlarge", "c6i.xlarge", "c7i.xlarge"],
                },
              },
            },
          });
          const task = yield* TaskDefinition("SandboxTask", {
            requiresCompatibilities: ["MANAGED_INSTANCES"],
            networkMode: "awsvpc",
            cpu: 1024,
            memory: 2048,
            trustedExecutionConfiguration: { isolationMode: "ISOLATED_SANDBOX" },
            containerDefinitions: [
              {
                name: "app",
                image: "public.ecr.aws/docker/library/busybox:stable",
                essential: true,
                command: ["sh", "-c", "while true; do sleep 30; done"],
              },
            ],
          });
          const service = yield* Service("SandboxService", {
            cluster,
            task,
            desiredCount: 1,
            capacityProviderStrategy: [{ capacityProvider: provider.name, weight: 1 }],
            vpcId,
            subnets: subnetIds,
            securityGroups: [defaultSecurityGroupId],
            assignPublicIp: false,
          });
          return {
            clusterName: cluster.clusterName,
            providerName: provider.name,
            serviceName: service.serviceName,
          };
        });

      const deployed = yield* stack.deploy(program("BASIC"));

      // ECS lists a Managed Instances provider only under its cluster.
      const describeProvider = ecs
        .describeCapacityProviders({ cluster: deployed.clusterName })
        .pipe(
          Effect.map((r) => r.capacityProviders?.find((p) => p.name === deployed.providerName)),
        );
      const provider = yield* describeProvider;
      const launchTemplate = provider?.managedInstancesProvider?.instanceLaunchTemplate;
      expect(provider?.type).toBe("MANAGED_INSTANCES");
      expect(launchTemplate?.nitroEnclavesEnabled).toBe(true);

      // The task waits for ECS to launch an instance, then starts in its
      // sandbox.
      const running = yield* Effect.gen(function* () {
        const { taskArns } = yield* ecs.listTasks({
          cluster: deployed.clusterName,
          serviceName: deployed.serviceName,
          desiredStatus: "RUNNING",
        });
        const { tasks } = taskArns?.length
          ? yield* ecs.describeTasks({ cluster: deployed.clusterName, tasks: taskArns })
          : { tasks: [] };
        const task = tasks?.find((t) => t.lastStatus === "RUNNING");
        if (!task) {
          return yield* new SandboxTaskNotRunning({ status: tasks?.[0]?.lastStatus });
        }
        return task;
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "SandboxTaskNotRunning",
          schedule: Schedule.max([Schedule.spaced("10 seconds"), Schedule.recurs(36)]),
        }),
      );
      expect(running.trustedExecutionSummary?.isolationMode).toBe("ISOLATED_SANDBOX");

      // Monitoring updates the provider in place.
      const updated = yield* stack.deploy(program("DETAILED"));
      expect(updated.providerName).toBe(deployed.providerName);
      const observed = yield* describeProvider;
      expect(observed?.managedInstancesProvider?.instanceLaunchTemplate?.monitoring).toBe(
        "DETAILED",
      );

      // The instances ECS launched for the provider, to check they go.
      const { containerInstanceArns } = yield* ecs.listContainerInstances({
        cluster: deployed.clusterName,
      });
      const { containerInstances } = containerInstanceArns?.length
        ? yield* ecs.describeContainerInstances({
            cluster: deployed.clusterName,
            containerInstances: containerInstanceArns,
          })
        : { containerInstances: [] };
      const instanceIds = (containerInstances ?? []).flatMap((c) =>
        c.ec2InstanceId ? [c.ec2InstanceId] : [],
      );
      expect(instanceIds.length).toBeGreaterThan(0);
      const { Reservations } = yield* ec2.describeInstances({ InstanceIds: instanceIds });
      expect(
        Reservations?.flatMap((r) => r.Instances ?? []).every((i) => i.EnclaveOptions?.Enabled),
      ).toBe(true);

      yield* stack.destroy();
      const after = yield* ec2.describeInstances({ InstanceIds: instanceIds });
      expect(
        after.Reservations?.flatMap((r) => r.Instances ?? []).every(
          (i) => i.State?.Name === "shutting-down" || i.State?.Name === "terminated",
        ),
      ).toBe(true);
      const clusters = yield* ecs.describeClusters({ clusters: [deployed.clusterName] });
      expect(clusters.clusters?.every((c) => c.status === "INACTIVE")).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:ecs", "provider:aws:iam", "live"],
    timeout: 900_000,
  },
);
