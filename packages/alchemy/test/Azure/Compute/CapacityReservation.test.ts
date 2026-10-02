import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withVcpus } from "../gates.ts";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReservation = (
  resourceGroupName: string,
  capacityReservationGroupName: string,
  capacityReservationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetCapacityReservation({
      subscriptionId,
      resourceGroupName,
      capacityReservationGroupName,
      capacityReservationName,
    }),
  );

// One reserved 1-vCPU instance (~$0.04/hour) for a few minutes. The free
// trial rejects every capacity reservation SKU with `SkuNotAvailable`
// ("Capacity Restrictions"), so the lifecycle runs on paid subscriptions
// only; the probe below pins the trial's rejection.
const program = (props: { capacity: number; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: VM_LOCATION,
    });
    const reservations = yield* Azure.Compute.CapacityReservationGroup(
      "Reservations",
      { resourceGroup: group.resourceGroupName, location: VM_LOCATION },
    );
    const reservation = yield* Azure.Compute.CapacityReservation("Small", {
      resourceGroup: group.resourceGroupName,
      capacityReservationGroup: reservations.capacityReservationGroupName,
      sku: VM_SIZE,
      capacity: props.capacity,
      tags: props.tags,
    });
    return { group, reservations, reservation };
  });

test.provider(
  "probe: capacity reservations are rejected on the free trial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = yield* subscriptionId;
      const { group, reservations } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: VM_LOCATION,
          });
          const reservations = yield* Azure.Compute.CapacityReservationGroup(
            "Reservations",
            { resourceGroup: group.resourceGroupName, location: VM_LOCATION },
          );
          return { group, reservations };
        }),
      );
      const error = yield* compute
        .CapacityReservationsCreateOrUpdate({
          subscriptionId: id,
          resourceGroupName: group.resourceGroupName,
          capacityReservationGroupName:
            reservations.capacityReservationGroupName,
          capacityReservationName: "probe",
          location: VM_LOCATION,
          sku: { name: VM_SIZE, capacity: 1 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SkuNotAvailable");
      expect(error.message).toContain("Capacity Restrictions");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

test.provider.skipIf(!runPaidOnly)(
  "create, resize, and delete a capacity reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, reservations, reservation } = yield* stack.deploy(
        program({ capacity: 1, tags: { env: "test" } }),
      );
      expect(reservation.sku).toEqual(VM_SIZE);
      expect(reservation.capacity).toEqual(1);
      expect(reservation.location).toEqual(VM_LOCATION);
      const observed = yield* getReservation(
        group.resourceGroupName,
        reservations.capacityReservationGroupName,
        reservation.capacityReservationName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: release the capacity and change tags.
      const updated = yield* stack.deploy(
        program({ capacity: 0, tags: { env: "prod" } }),
      );
      expect(updated.reservation.capacityReservationId).toEqual(
        reservation.capacityReservationId,
      );
      const reobserved = yield* getReservation(
        group.resourceGroupName,
        reservations.capacityReservationGroupName,
        reservation.capacityReservationName,
      );
      expect(reobserved.sku?.capacity).toEqual(0);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getReservation(
            group.resourceGroupName,
            reservations.capacityReservationGroupName,
            reservation.capacityReservationName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
