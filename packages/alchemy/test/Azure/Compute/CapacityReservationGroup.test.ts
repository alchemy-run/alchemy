import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  capacityReservationGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetCapacityReservationGroup({
      subscriptionId,
      resourceGroupName,
      capacityReservationGroupName,
    }),
  );

// An empty capacity reservation group is free.
const program = (props: { zones?: string[]; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const reservations = yield* Azure.Compute.CapacityReservationGroup(
      "Reservations",
      {
        resourceGroup: group.resourceGroupName,
        zones: props.zones,
        tags: props.tags,
      },
    );
    return { group, reservations };
  });

test.provider(
  "create, update, replace, and delete a capacity reservation group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, reservations } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(reservations.capacityReservationIds).toEqual([]);
      const observed = yield* getGroup(
        group.resourceGroupName,
        reservations.capacityReservationGroupName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Reservations");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.reservations.capacityReservationGroupId).toEqual(
        reservations.capacityReservationGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        reservations.capacityReservationGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Zones are immutable: replacement.
      const replaced = yield* stack.deploy(
        program({ zones: ["1"], tags: { env: "prod" } }),
      );
      expect(replaced.reservations.capacityReservationGroupName).not.toEqual(
        reservations.capacityReservationGroupName,
      );
      expect(replaced.reservations.zones).toEqual(["1"]);
      expect(
        yield* untilGone(
          getGroup(
            group.resourceGroupName,
            reservations.capacityReservationGroupName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(
            group.resourceGroupName,
            replaced.reservations.capacityReservationGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
