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

const getInput = (
  resourceGroupName: string,
  jobName: string,
  inputName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetInput({
      subscriptionId,
      resourceGroupName,
      jobName,
      inputName,
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

const program = (props: {
  type: "Stream" | "Reference";
  pathPattern: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-input",
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const job = yield* Azure.StreamAnalytics.StreamingJob("Job", {
      resourceGroup: group.resourceGroupName,
      identity: "SystemAssigned",
    });
    const input = yield* Azure.StreamAnalytics.Input("Events", {
      resourceGroup: group.resourceGroupName,
      streamingJob: job.jobName,
      type: props.type,
      datasource: {
        type: "Microsoft.Storage/Blob",
        properties: {
          storageAccounts: [{ accountName: account.storageAccountName }],
          container: "incoming",
          pathPattern: props.pathPattern,
          authenticationMode: "Msi",
        },
      },
      serialization: { type: "Json", properties: { encoding: "UTF8" } },
    });
    return { group, account, job, input };
  });

// A never-started job is free; the storage account costs cents. ~2 minutes.
test.provider(
  "create, update, replace, and delete an input",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job, input } = yield* stack.deploy(
        program({ type: "Stream", pathPattern: "events/{date}" }),
      );
      expect(input.type).toEqual("Stream");
      expect(input.streamingJob).toEqual(job.jobName);
      const observed = yield* getInput(
        group.resourceGroupName,
        job.jobName,
        input.inputName,
      );
      expect(observed.properties?.type).toEqual("Stream");
      expect(observed.properties?.serialization?.type).toEqual("Json");
      const datasource = observed.properties?.datasource as {
        type: string;
        properties: { pathPattern: string; container: string };
      };
      expect(datasource.type).toEqual("Microsoft.Storage/Blob");
      expect(datasource.properties.container).toEqual("incoming");
      expect(datasource.properties.pathPattern).toEqual("events/{date}");

      // In-place update of the data source.
      const updated = yield* stack.deploy(
        program({ type: "Stream", pathPattern: "telemetry/{date}" }),
      );
      expect(updated.input.inputId).toEqual(input.inputId);
      const reobserved = yield* getInput(
        group.resourceGroupName,
        job.jobName,
        input.inputName,
      );
      expect(
        (reobserved.properties?.datasource as typeof datasource).properties
          .pathPattern,
      ).toEqual("telemetry/{date}");

      // Replacement: Stream → Reference is immutable.
      const replaced = yield* stack.deploy(
        program({ type: "Reference", pathPattern: "telemetry/{date}" }),
      );
      expect(replaced.input.type).toEqual("Reference");
      expect(replaced.input.inputName).not.toEqual(input.inputName);
      const old = yield* getInput(
        group.resourceGroupName,
        job.jobName,
        input.inputName,
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
