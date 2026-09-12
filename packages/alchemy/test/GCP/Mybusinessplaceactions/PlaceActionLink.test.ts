import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeCreateAccess,
  probePlaceActionAccess,
  PROBE_NAME,
  testParent,
  testUri,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  placeactions.getLocationsPlaceActionLinks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getLocationsPlaceActionLinks on a missing link fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        placeactions.getLocationsPlaceActionLinks({ name: PROBE_NAME }),
      );
      expect([...entitlementTags]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createLocationsPlaceActionLinks without Business Profile access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* placeactions
        .createLocationsPlaceActionLinks({
          parent: "locations/alchemy-missing",
          body: {
            uri: "https://example.com/alchemy-place-action-probe",
            placeActionType: "SHOP_ONLINE",
          },
        })
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        if (result.success.name) {
          yield* placeactions
            .deleteLocationsPlaceActionLinks({ name: result.success.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      } else {
        expect([...entitlementTags]).toContain(result.failure._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a place action link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const metadata = yield* probePlaceActionAccess;
      if (metadata !== "ok") {
        expect([...entitlementTags]).toContain(metadata._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* probeCreateAccess;
      if (access !== "ok") {
        expect([...entitlementTags]).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Mybusinessplaceactions.PlaceActionLink("Shop", {
            parent: testParent,
            uri: testUri,
            placeActionType: "SHOP_ONLINE",
          });
        }),
      );

      expect(created.name).toContain("/placeActionLinks/");
      expect(created.parent).toContain("locations/");
      expect(created.uri).toEqual(testUri);
      expect(created.placeActionType).toEqual("SHOP_ONLINE");
      expect(created.isPreferred).toEqual(false);

      const fetched = yield* placeactions.getLocationsPlaceActionLinks({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.uri).toContain("alchemy-");
      expect(fetched.placeActionType).toEqual("SHOP_ONLINE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Mybusinessplaceactions.PlaceActionLink("Shop", {
            name: created.name,
            parent: created.parent,
            uri: `${testUri}/v2`,
            placeActionType: "SHOP_ONLINE",
            isPreferred: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uri).toEqual(`${testUri}/v2`);
      expect(updated.isPreferred).toEqual(true);

      const refetched = yield* placeactions.getLocationsPlaceActionLinks({
        name: created.name,
      });
      expect(refetched.uri).toContain("/v2");
      expect(refetched.uri).toContain("alchemy-");
      expect(refetched.isPreferred).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
