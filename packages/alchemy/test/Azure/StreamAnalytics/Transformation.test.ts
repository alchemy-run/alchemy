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

const getTransformation = (resourceGroupName: string, jobName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetTransformation({
      subscriptionId,
      resourceGroupName,
      jobName,
      transformationName: "Transformation",
    });
  });

const jobGone = (resourceGroupName: string, jobName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetStreamingJob({
      subscriptionId,
      resourceGroupName,
      jobName,
    });
  }).pipe(
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

const program = (props: { query: string; streamingUnits: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-transformation",
      location: "eastus",
    });
    const job = yield* Azure.StreamAnalytics.StreamingJob("Job", {
      resourceGroup: group.resourceGroupName,
    });
    const transformation = yield* Azure.StreamAnalytics.Transformation(
      "Query",
      {
        resourceGroup: group.resourceGroupName,
        streamingJob: job.jobName,
        query: props.query,
        streamingUnits: props.streamingUnits,
      },
    );
    return { group, job, transformation };
  });

const PASS_THROUGH = "SELECT * INTO [archive] FROM [events]";
const FILTERED = "SELECT * INTO [archive] FROM [events] WHERE temperature > 25";

// A never-started job is free (streaming units bill only while running).
// ~1 minute.
test.provider(
  "create, update, and delete a transformation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job, transformation } = yield* stack.deploy(
        program({ query: PASS_THROUGH, streamingUnits: 1 }),
      );
      expect(transformation.transformationName).toEqual("Transformation");
      expect(transformation.query).toEqual(PASS_THROUGH);
      const observed = yield* getTransformation(
        group.resourceGroupName,
        job.jobName,
      );
      expect(observed.properties?.query).toEqual(PASS_THROUGH);
      expect(observed.properties?.streamingUnits).toEqual(1);

      // In-place update of the query and streaming units.
      const updated = yield* stack.deploy(
        program({ query: FILTERED, streamingUnits: 3 }),
      );
      expect(updated.transformation.transformationId).toEqual(
        transformation.transformationId,
      );
      const reobserved = yield* getTransformation(
        group.resourceGroupName,
        job.jobName,
      );
      expect(reobserved.properties?.query).toEqual(FILTERED);
      expect(reobserved.properties?.streamingUnits).toEqual(3);

      // The transformation has no delete API; it goes with its job.
      yield* stack.destroy();
      expect(yield* jobGone(group.resourceGroupName, job.jobName)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:streamanalytics", "live"],
    timeout: 900_000,
  },
);
