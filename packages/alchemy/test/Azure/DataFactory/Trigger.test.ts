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

const getTrigger = (
  resourceGroupName: string,
  factoryName: string,
  triggerName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetTrigger({
      subscriptionId,
      resourceGroupName,
      factoryName,
      triggerName,
    });
  });

const triggerGone = (
  resourceGroupName: string,
  factoryName: string,
  triggerName: string,
) =>
  getTrigger(resourceGroupName, factoryName, triggerName).pipe(
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

const program = (props: { started: boolean; interval: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("TriggerGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("TriggerFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const pipeline = yield* Azure.DataFactory.Pipeline("TriggerPipeline", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      activities: [
        {
          name: "pause",
          type: "Wait",
          typeProperties: { waitTimeInSeconds: 1 },
        },
      ],
    });
    // Starts far in the future so a started trigger never fires.
    const trigger = yield* Azure.DataFactory.Trigger("Daily", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "ScheduleTrigger",
      typeProperties: {
        recurrence: {
          frequency: "Day",
          interval: props.interval,
          startTime: "2060-01-01T00:00:00Z",
          timeZone: "UTC",
        },
      },
      pipelines: [{ pipelineName: pipeline.pipelineName }],
      started: props.started,
    });
    return { group, factory, pipeline, trigger };
  });

// ~$0: the schedule starts in 2060 (Data Factory rejects start times more
// than 49 years ahead), so no pipeline run is ever billed. ~1 minute.
test.provider(
  "create, start, update while started, and delete a trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, pipeline, trigger } = yield* stack.deploy(
        program({ started: false, interval: 1 }),
      );
      expect(trigger.type).toEqual("ScheduleTrigger");
      expect(trigger.runtimeState).toEqual("Stopped");
      const observed = yield* getTrigger(
        group.resourceGroupName,
        factory.factoryName,
        trigger.triggerName,
      );
      expect(observed.properties.runtimeState).toEqual("Stopped");
      expect(observed.properties.pipelines).toMatchObject([
        { pipelineReference: { referenceName: pipeline.pipelineName } },
      ]);

      // Start it.
      const started = yield* stack.deploy(
        program({ started: true, interval: 1 }),
      );
      expect(started.trigger.runtimeState).toEqual("Started");
      expect(
        (yield* getTrigger(
          group.resourceGroupName,
          factory.factoryName,
          trigger.triggerName,
        )).properties.runtimeState,
      ).toEqual("Started");

      // Change the recurrence while started: stop, update, start.
      const updated = yield* stack.deploy(
        program({ started: true, interval: 2 }),
      );
      expect(updated.trigger.triggerName).toEqual(trigger.triggerName);
      expect(updated.trigger.runtimeState).toEqual("Started");
      const reobserved = yield* getTrigger(
        group.resourceGroupName,
        factory.factoryName,
        trigger.triggerName,
      );
      expect(reobserved.properties.typeProperties).toMatchObject({
        recurrence: { interval: 2 },
      });
      expect(reobserved.properties.runtimeState).toEqual("Started");

      // Destroy stops the started trigger before deleting it.
      yield* stack.destroy();
      expect(
        yield* triggerGone(
          group.resourceGroupName,
          factory.factoryName,
          trigger.triggerName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
