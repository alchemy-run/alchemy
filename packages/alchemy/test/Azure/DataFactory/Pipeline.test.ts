import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getPipeline = (
  resourceGroupName: string,
  factoryName: string,
  pipelineName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetPipeline({
      subscriptionId,
      resourceGroupName,
      factoryName,
      pipelineName,
    });
  });

const pipelineGone = (
  resourceGroupName: string,
  factoryName: string,
  pipelineName: string,
) =>
  getPipeline(resourceGroupName, factoryName, pipelineName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: {
  waitTimeInSeconds: number;
  parameters?: Record<string, Azure.DataFactory.ParameterSpecification>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("PipelineGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("PipelineFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const pipeline = yield* Azure.DataFactory.Pipeline("Nightly", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      description: "waits",
      parameters: props.parameters,
      activities: [
        {
          name: "pause",
          type: "Wait",
          typeProperties: { waitTimeInSeconds: props.waitTimeInSeconds },
        },
      ],
    });
    return { group, factory, pipeline };
  });

// ~$0: pipelines are never run. ~1-2 minutes.
test.provider(
  "create, update, and delete a pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, pipeline } = yield* stack.deploy(
        program({ waitTimeInSeconds: 5 }),
      );
      expect(pipeline.pipelineName).toMatch(/^[A-Za-z0-9_]+$/);
      const observed = yield* getPipeline(
        group.resourceGroupName,
        factory.factoryName,
        pipeline.pipelineName,
      );
      expect(observed.properties.description).toEqual("waits");
      expect(observed.properties.activities?.[0]?.type).toEqual("Wait");
      expect(observed.properties.activities?.[0]?.typeProperties).toEqual({
        waitTimeInSeconds: 5,
      });

      // In place: activity properties and a new parameter.
      const updated = yield* stack.deploy(
        program({
          waitTimeInSeconds: 10,
          parameters: { date: { type: "String", defaultValue: "today" } },
        }),
      );
      expect(updated.pipeline.pipelineName).toEqual(pipeline.pipelineName);
      const reobserved = yield* getPipeline(
        group.resourceGroupName,
        factory.factoryName,
        pipeline.pipelineName,
      );
      expect(reobserved.properties.activities?.[0]?.typeProperties).toEqual({
        waitTimeInSeconds: 10,
      });
      expect(reobserved.properties.parameters?.date?.type).toEqual("String");

      yield* stack.destroy();
      expect(
        yield* pipelineGone(
          group.resourceGroupName,
          factory.factoryName,
          pipeline.pipelineName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
