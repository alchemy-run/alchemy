import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeReservations,
  project,
  region,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getAdminProjectsLocationsReservations on a missing reservation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        pubsublite.getAdminProjectsLocationsReservations({
          name: `projects/${project}/locations/${region}/reservations/alchemy-missing-reservation`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeReservations();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Pubsublite.AdminReservation("Capacity", {
            location: region,
            throughputCapacity: "4",
          });
        }),
      );

      expect(created.name).toContain("/reservations/");
      expect(created.reservationId).toContain("+alc.");
      expect(created.location).toEqual(region);
      expect(created.throughputCapacity).toEqual("4");

      const fetched = yield* pubsublite.getAdminProjectsLocationsReservations({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.throughputCapacity).toEqual("4");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Pubsublite.AdminReservation("Capacity", {
            reservationId: created.reservationId,
            location: region,
            throughputCapacity: "8",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.throughputCapacity).toEqual("8");

      const refetched = yield* pubsublite.getAdminProjectsLocationsReservations(
        {
          name: created.name,
        },
      );
      expect(refetched.throughputCapacity).toEqual("8");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        pubsublite.getAdminProjectsLocationsReservations({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
