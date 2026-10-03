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

const getFunction = (
  resourceGroupName: string,
  jobName: string,
  functionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetFunction({
      subscriptionId,
      resourceGroupName,
      jobName,
      functionName,
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

const program = (props: { name: string; script: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-function",
      location: "eastus",
    });
    const job = yield* Azure.StreamAnalytics.StreamingJob("Job", {
      resourceGroup: group.resourceGroupName,
    });
    const fn = yield* Azure.StreamAnalytics.Function("Udf", {
      resourceGroup: group.resourceGroupName,
      streamingJob: job.jobName,
      name: props.name,
      inputs: [{ dataType: "bigint" }],
      output: { dataType: "bigint" },
      binding: {
        type: "Microsoft.StreamAnalytics/JavascriptUdf",
        properties: { script: props.script },
      },
    });
    return { group, job, fn };
  });

const DOUBLE = "function (x) { return x * 2; }";
const TRIPLE = "function (x) { return x * 3; }";

const scriptOf = (fn: streamanalytics.GetFunctionResponse) =>
  (fn.properties?.properties?.binding?.properties as { script?: string })
    ?.script;

// A never-started job with a JavaScript UDF is free. ~1 minute.
test.provider(
  "create, update, replace, and delete a JavaScript function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job, fn } = yield* stack.deploy(
        program({ name: "scale", script: DOUBLE }),
      );
      expect(fn.functionName).toEqual("scale");
      expect(fn.type).toEqual("Scalar");
      expect(fn.bindingType).toEqual("Microsoft.StreamAnalytics/JavascriptUdf");
      const observed = yield* getFunction(
        group.resourceGroupName,
        job.jobName,
        "scale",
      );
      expect(scriptOf(observed)).toEqual(DOUBLE);
      expect(observed.properties?.properties?.output?.dataType).toEqual(
        "bigint",
      );

      // A redeploy with unchanged props must not rewrite the function.
      const same = yield* stack.deploy(
        program({ name: "scale", script: DOUBLE }),
      );
      expect(same.fn.etag).toEqual(fn.etag);

      // In-place update of the script.
      const updated = yield* stack.deploy(
        program({ name: "scale", script: TRIPLE }),
      );
      expect(updated.fn.functionId).toEqual(fn.functionId);
      const reobserved = yield* getFunction(
        group.resourceGroupName,
        job.jobName,
        "scale",
      );
      expect(scriptOf(reobserved)).toEqual(TRIPLE);

      // Replacement: a new name means a new function.
      const replaced = yield* stack.deploy(
        program({ name: "scale2", script: TRIPLE }),
      );
      expect(replaced.fn.functionName).toEqual("scale2");
      const old = yield* getFunction(
        group.resourceGroupName,
        job.jobName,
        "scale",
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
