import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSet = (resourceGroupName: string, availabilitySetName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetAvailabilitySet({
      subscriptionId,
      resourceGroupName,
      availabilitySetName,
    }),
  );

// Availability sets and proximity placement groups are free.
const program = (props: {
  faultDomains: number;
  withPpg: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ppg = yield* Azure.Compute.ProximityPlacementGroup("Ppg", {
      resourceGroup: group.resourceGroupName,
    });
    const set = yield* Azure.Compute.AvailabilitySet("Set", {
      resourceGroup: group.resourceGroupName,
      platformFaultDomainCount: props.faultDomains,
      platformUpdateDomainCount: 5,
      proximityPlacementGroupId: props.withPpg
        ? ppg.proximityPlacementGroupId
        : undefined,
      tags: props.tags,
    });
    return { group, ppg, set };
  });

test.provider(
  "create, update, replace, and delete an availability set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, set } = yield* stack.deploy(
        program({ faultDomains: 2, withPpg: false, tags: { env: "test" } }),
      );
      expect(set.sku).toEqual("Aligned");
      expect(set.platformFaultDomainCount).toEqual(2);
      expect(set.platformUpdateDomainCount).toEqual(5);
      const observed = yield* getSet(
        group.resourceGroupName,
        set.availabilitySetName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Set");
      expect(observed.properties?.proximityPlacementGroup).toBeUndefined();

      // In place: tags and proximity placement group.
      const updated = yield* stack.deploy(
        program({ faultDomains: 2, withPpg: true, tags: { env: "prod" } }),
      );
      expect(updated.set.availabilitySetId).toEqual(set.availabilitySetId);
      const reobserved = yield* getSet(
        group.resourceGroupName,
        set.availabilitySetName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        reobserved.properties?.proximityPlacementGroup?.id?.toLowerCase(),
      ).toEqual(updated.ppg.proximityPlacementGroupId.toLowerCase());

      // Fault domain count is immutable: replacement.
      const replaced = yield* stack.deploy(
        program({ faultDomains: 3, withPpg: true, tags: { env: "prod" } }),
      );
      expect(replaced.set.availabilitySetName).not.toEqual(
        set.availabilitySetName,
      );
      expect(replaced.set.platformFaultDomainCount).toEqual(3);
      expect(
        yield* untilGone(
          getSet(group.resourceGroupName, set.availabilitySetName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getSet(group.resourceGroupName, replaced.set.availabilitySetName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
