import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  advertiserProps,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersLocationLists on a missing list fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersLocationLists({
          advertiserId: "1",
          locationListId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a location list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const list = yield* GCP.Displayvideo.AdvertisersLocationList("Geo", {
            advertiserId: advertiser.advertiserId,
            locationType: "TARGETING_LOCATION_TYPE_REGIONAL",
            displayName: "us-regions",
          });
          return { advertiser, list };
        }),
      );

      expect(created.list.locationListId).toEqual(expect.any(String));
      expect(created.list.advertiserId).toEqual(
        created.advertiser.advertiserId,
      );
      expect(created.list.displayName).toEqual("us-regions");
      expect(created.list.locationType).toEqual(
        "TARGETING_LOCATION_TYPE_REGIONAL",
      );

      const fetched = yield* dv.getAdvertisersLocationLists({
        advertiserId: created.list.advertiserId,
        locationListId: created.list.locationListId,
      });
      expect(fetched.locationListId).toEqual(created.list.locationListId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const list = yield* GCP.Displayvideo.AdvertisersLocationList("Geo", {
            advertiserId: advertiser.advertiserId,
            locationListId: created.list.locationListId,
            locationType: "TARGETING_LOCATION_TYPE_REGIONAL",
            displayName: "us-regions-v2",
          });
          return { advertiser, list };
        }),
      );

      expect(updated.list.locationListId).toEqual(created.list.locationListId);
      expect(updated.list.displayName).toEqual("us-regions-v2");

      yield* stack.destroy();

      // DV360 has no LocationLists.delete — destroy strips the ownership prefix.
      const leftover = yield* dv.getAdvertisersLocationLists({
        advertiserId: created.list.advertiserId,
        locationListId: created.list.locationListId,
      });
      expect(leftover.displayName ?? "").not.toContain("alchemy-id=");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
