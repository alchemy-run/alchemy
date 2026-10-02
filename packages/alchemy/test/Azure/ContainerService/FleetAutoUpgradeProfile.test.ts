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

const getProfile = (
  resourceGroupName: string,
  fleetName: string,
  autoUpgradeProfileName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetAutoUpgradeProfile({
      subscriptionId,
      resourceGroupName,
      fleetName,
      autoUpgradeProfileName,
    });
  });

const profileGone = (
  resourceGroupName: string,
  fleetName: string,
  autoUpgradeProfileName: string,
) =>
  getProfile(resourceGroupName, fleetName, autoUpgradeProfileName).pipe(
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

const program = (props: { nodeImageSelection: "Latest" | "Consistent" }) =>
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
        stages: [{ name: "all", groups: [{ name: "default" }] }],
      },
    );
    const profile = yield* Azure.ContainerService.FleetAutoUpgradeProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        fleet: fleet.fleetName,
        channel: "Stable",
        updateStrategyId: strategy.updateStrategyId,
        nodeImageSelection: props.nodeImageSelection,
        // Paused: the test must never trigger an update run.
        disabled: true,
      },
    );
    return { group, fleet, profile };
  });

// Hubless fleet + paused profile: free, about a minute.
test.provider(
  "create, update, and delete a fleet auto-upgrade profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ nodeImageSelection: "Latest" }),
      );
      const { group, fleet, profile } = created;
      expect(profile.channel).toEqual("Stable");
      expect(profile.disabled).toEqual(true);
      const observed = yield* getProfile(
        group.resourceGroupName,
        fleet.fleetName,
        profile.autoUpgradeProfileName,
      );
      expect(observed.properties?.nodeImageSelection?.type).toEqual("Latest");
      expect(observed.properties?.updateStrategyId?.toLowerCase()).toContain(
        "/updatestrategies/",
      );

      const updated = yield* stack.deploy(
        program({ nodeImageSelection: "Consistent" }),
      );
      expect(updated.profile.autoUpgradeProfileName).toEqual(
        profile.autoUpgradeProfileName,
      );
      const reobserved = yield* getProfile(
        group.resourceGroupName,
        fleet.fleetName,
        profile.autoUpgradeProfileName,
      );
      expect(reobserved.properties?.nodeImageSelection?.type).toEqual(
        "Consistent",
      );

      yield* stack.destroy();
      expect(
        yield* profileGone(
          group.resourceGroupName,
          fleet.fleetName,
          profile.autoUpgradeProfileName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerservice", "live"],
    timeout: 600_000,
  },
);
