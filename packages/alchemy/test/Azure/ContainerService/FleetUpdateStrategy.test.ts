import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getStrategy = (
  resourceGroupName: string,
  fleetName: string,
  updateStrategyName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetFleetUpdateStrategy({
      subscriptionId,
      resourceGroupName,
      fleetName,
      updateStrategyName,
    });
  });

const strategyGone = (
  resourceGroupName: string,
  fleetName: string,
  updateStrategyName: string,
) =>
  getStrategy(resourceGroupName, fleetName, updateStrategyName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (stages: Azure.ContainerService.FleetUpdateStage[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const fleet = yield* Azure.ContainerService.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
    });
    const strategy = yield* Azure.ContainerService.FleetUpdateStrategy(
      "Strategy",
      {
        resourceGroup: group.resourceGroupName,
        fleet: fleet.fleetName,
        stages,
      },
    );
    return { group, fleet, strategy };
  });

// Hubless fleet + strategy: free, about a minute.
test.provider(
  "create, update, and delete a fleet update strategy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program([{ name: "staging", groups: [{ name: "staging" }] }]),
      );
      const { group, fleet, strategy } = created;
      expect(strategy.stageNames).toEqual(["staging"]);
      expect(strategy.updateStrategyId).toContain("/updateStrategies/");
      const observed = yield* getStrategy(
        group.resourceGroupName,
        fleet.fleetName,
        strategy.updateStrategyName,
      );
      expect(observed.properties?.strategy.stages.length).toEqual(1);

      const updated = yield* stack.deploy(
        program([
          {
            name: "staging",
            groups: [{ name: "staging" }],
            afterStageWaitInSeconds: 3600,
          },
          { name: "production", groups: [{ name: "production" }] },
        ]),
      );
      expect(updated.strategy.updateStrategyName).toEqual(
        strategy.updateStrategyName,
      );
      expect(updated.strategy.stageNames).toEqual(["staging", "production"]);
      const reobserved = yield* getStrategy(
        group.resourceGroupName,
        fleet.fleetName,
        strategy.updateStrategyName,
      );
      expect(
        reobserved.properties?.strategy.stages[0]?.afterStageWaitInSeconds,
      ).toEqual(3600);

      yield* stack.destroy();
      expect(
        yield* strategyGone(
          group.resourceGroupName,
          fleet.fleetName,
          strategy.updateStrategyName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerservice", "live"],
    timeout: 600_000,
  },
);
