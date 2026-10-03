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

const getOutput = (
  resourceGroupName: string,
  jobName: string,
  outputName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetOutput({
      subscriptionId,
      resourceGroupName,
      jobName,
      outputName,
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

const program = (props: { name: string; format: "LineSeparated" | "Array" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-output",
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const job = yield* Azure.StreamAnalytics.StreamingJob("Job", {
      resourceGroup: group.resourceGroupName,
      identity: "SystemAssigned",
    });
    const output = yield* Azure.StreamAnalytics.Output("Archive", {
      resourceGroup: group.resourceGroupName,
      streamingJob: job.jobName,
      name: props.name,
      datasource: {
        type: "Microsoft.Storage/Blob",
        properties: {
          storageAccounts: [{ accountName: account.storageAccountName }],
          container: "archive",
          pathPattern: "{date}",
          dateFormat: "yyyy/MM/dd",
          authenticationMode: "Msi",
        },
      },
      serialization: {
        type: "Json",
        properties: { encoding: "UTF8", format: props.format },
      },
    });
    return { group, account, job, output };
  });

// A never-started job is free; the storage account costs cents. ~2 minutes.
test.provider(
  "create, update, replace, and delete an output",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job, output } = yield* stack.deploy(
        program({ name: "archive", format: "LineSeparated" }),
      );
      expect(output.outputName).toEqual("archive");
      expect(output.datasourceType).toEqual("Microsoft.Storage/Blob");
      const observed = yield* getOutput(
        group.resourceGroupName,
        job.jobName,
        "archive",
      );
      expect(observed.properties?.datasource?.type).toEqual(
        "Microsoft.Storage/Blob",
      );
      expect(
        (observed.properties?.serialization?.properties as { format: string })
          .format,
      ).toEqual("LineSeparated");

      // A redeploy with unchanged props must not rewrite the output.
      const same = yield* stack.deploy(
        program({ name: "archive", format: "LineSeparated" }),
      );
      expect(same.output.etag).toEqual(output.etag);

      // In-place update of the serialization.
      const updated = yield* stack.deploy(
        program({ name: "archive", format: "Array" }),
      );
      expect(updated.output.outputId).toEqual(output.outputId);
      const reobserved = yield* getOutput(
        group.resourceGroupName,
        job.jobName,
        "archive",
      );
      expect(
        (reobserved.properties?.serialization?.properties as { format: string })
          .format,
      ).toEqual("Array");

      // Replacement: a new name means a new output.
      const replaced = yield* stack.deploy(
        program({ name: "archive2", format: "Array" }),
      );
      expect(replaced.output.outputName).toEqual("archive2");
      const old = yield* getOutput(
        group.resourceGroupName,
        job.jobName,
        "archive",
      ).pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
      );
      expect(old).toEqual("gone");

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
