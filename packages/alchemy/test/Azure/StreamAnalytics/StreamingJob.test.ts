import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getJob = (resourceGroupName: string, jobName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetStreamingJob({
      subscriptionId,
      resourceGroupName,
      jobName,
    });
  });

const jobGone = (resourceGroupName: string, jobName: string) =>
  getJob(resourceGroupName, jobName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  location: string;
  eventsOutOfOrderPolicy: "Adjust" | "Drop";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-job",
      location: "eastus",
    });
    const job = yield* Azure.StreamAnalytics.StreamingJob("Job", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      eventsOutOfOrderPolicy: props.eventsOutOfOrderPolicy,
      compatibilityLevel: "1.2",
      tags: props.tags,
    });
    return { group, job };
  });

// A created-but-never-started job is free; ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a streaming job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job } = yield* stack.deploy(
        program({
          location: "eastus",
          eventsOutOfOrderPolicy: "Adjust",
          tags: { env: "test" },
        }),
      );
      expect(job.jobName).toMatch(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,61}[a-zA-Z0-9]$/,
      );
      expect(job.location.toLowerCase().replace(/\s/g, "")).toEqual("eastus");
      expect(job.jobType).toEqual("Cloud");
      expect(job.tags).toEqual({ env: "test" });

      const observed = yield* getJob(group.resourceGroupName, job.jobName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.jobState).not.toEqual("Running");
      expect(observed.properties?.eventsOutOfOrderPolicy).toEqual("Adjust");
      expect(observed.properties?.compatibilityLevel).toEqual("1.2");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Job");

      // In-place update: policy and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          eventsOutOfOrderPolicy: "Drop",
          tags: { env: "prod" },
        }),
      );
      expect(updated.job.streamingJobId).toEqual(job.streamingJobId);
      const reobserved = yield* getJob(group.resourceGroupName, job.jobName);
      expect(reobserved.properties?.eventsOutOfOrderPolicy).toEqual("Drop");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new location means a new job.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          eventsOutOfOrderPolicy: "Drop",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.job.location.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus2",
      );
      expect(replaced.job.jobGuid).not.toEqual(job.jobGuid);
      const moved = yield* getJob(
        group.resourceGroupName,
        replaced.job.jobName,
      );
      expect(moved.location?.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus2",
      );

      yield* stack.destroy();
      expect(
        yield* jobGone(group.resourceGroupName, replaced.job.jobName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:streamanalytics", "live"],
    timeout: 900_000,
  },
);
