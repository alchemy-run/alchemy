import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  QUICKSTART_JOB_IMAGE,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const where = (resourceGroupName: string, jobName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, jobName };
  });

const getJob = (resourceGroupName: string, jobName: string) =>
  where(resourceGroupName, jobName).pipe(Effect.flatMap(app.GetJob));

const program = (
  trigger:
    | { triggerType: "Manual" }
    | { triggerType: "Schedule"; cronExpression: string },
  tags: Record<string, string>,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const job = yield* Azure.ContainerApps.Job("Job", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration:
        trigger.triggerType === "Manual"
          ? {
              triggerType: "Manual",
              replicaTimeout: 120,
              replicaRetryLimit: 0,
              manualTriggerConfig: {
                parallelism: 1,
                replicaCompletionCount: 1,
              },
            }
          : {
              triggerType: "Schedule",
              replicaTimeout: 120,
              replicaRetryLimit: 0,
              scheduleTriggerConfig: {
                cronExpression: trigger.cronExpression,
                parallelism: 1,
                replicaCompletionCount: 1,
              },
            },
      template: {
        containers: [
          {
            name: "main",
            image: QUICKSTART_JOB_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
          },
        ],
      },
      tags,
    });
    return { group, env, job };
  });

// Cost: Consumption environment (free idle) + one 0.25 vCPU execution of a
// few seconds, inside the monthly free grant (~$0).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, run, update, and delete a container apps job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job } = yield* stack.deploy(
        program({ triggerType: "Manual" }, { env: "test" }),
      );
      expect(job.jobName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(job.triggerType).toEqual("Manual");

      const observed = yield* getJob(group.resourceGroupName, job.jobName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.configuration?.replicaTimeout).toEqual(120);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Job");

      // Start an execution out-of-band and wait for it to complete.
      const execution = yield* where(group.resourceGroupName, job.jobName).pipe(
        Effect.flatMap(app.StartJob),
      );
      expect(execution.name).toBeDefined();
      const finished = yield* where(group.resourceGroupName, job.jobName).pipe(
        Effect.flatMap(app.ListJobsExecutions),
        Effect.map((page) => page.value.find((e) => e.name === execution.name)),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (e) =>
            e?.properties?.status === "Succeeded" ||
            e?.properties?.status === "Failed",
          times: 24,
        }),
      );
      expect(finished?.properties?.status).toEqual("Succeeded");

      // In-place update: switch to a schedule trigger and change tags.
      const updated = yield* stack.deploy(
        program(
          { triggerType: "Schedule", cronExpression: "0 3 * * *" },
          { env: "prod" },
        ),
      );
      expect(updated.job.jobId).toEqual(job.jobId);
      expect(updated.job.triggerType).toEqual("Schedule");
      const reobserved = yield* getJob(group.resourceGroupName, job.jobName);
      expect(
        reobserved.properties?.configuration?.scheduleTriggerConfig
          ?.cronExpression,
      ).toEqual("0 3 * * *");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(getJob(group.resourceGroupName, job.jobName)),
      ).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
