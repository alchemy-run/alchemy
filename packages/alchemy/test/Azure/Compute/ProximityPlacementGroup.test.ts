import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  proximityPlacementGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetProximityPlacementGroup({
      subscriptionId,
      resourceGroupName,
      proximityPlacementGroupName,
    }),
  );

// Proximity placement groups are free.
const program = (props: {
  zones?: string[];
  intentVmSizes?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ppg = yield* Azure.Compute.ProximityPlacementGroup("Ppg", {
      resourceGroup: group.resourceGroupName,
      zones: props.zones,
      intentVmSizes: props.intentVmSizes,
      tags: props.tags,
    });
    return { group, ppg };
  });

test.provider(
  "create, update, replace, and delete a proximity placement group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ppg } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(ppg.proximityPlacementGroupType).toEqual("Standard");
      const observed = yield* getGroup(
        group.resourceGroupName,
        ppg.proximityPlacementGroupName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Ppg");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.ppg.proximityPlacementGroupId).toEqual(
        ppg.proximityPlacementGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        ppg.proximityPlacementGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Pinning to a zone replaces the group.
      const replaced = yield* stack.deploy(
        program({
          zones: ["1"],
          intentVmSizes: ["Standard_B1s"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.ppg.proximityPlacementGroupName).not.toEqual(
        ppg.proximityPlacementGroupName,
      );
      expect(replaced.ppg.zones).toEqual(["1"]);
      const zonal = yield* getGroup(
        group.resourceGroupName,
        replaced.ppg.proximityPlacementGroupName,
      );
      expect(zonal.properties?.intent?.vmSizes).toEqual(["Standard_B1s"]);
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, ppg.proximityPlacementGroupName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(
            group.resourceGroupName,
            replaced.ppg.proximityPlacementGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
