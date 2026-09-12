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
  "getInventorySources on a missing source fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getInventorySources({
          inventorySourceId: "1",
          partnerId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an inventory source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const source = yield* GCP.Displayvideo.InventorySource("Deal", {
            advertiserId: advertiser.advertiserId,
            displayName: "premium-deal",
            exchange: "EXCHANGE_GOOGLE_AD_MANAGER",
          });
          return { advertiser, source };
        }),
      );

      expect(created.source.inventorySourceId).toEqual(expect.any(String));
      expect(created.source.advertiserId).toEqual(
        created.advertiser.advertiserId,
      );
      expect(created.source.displayName).toEqual("premium-deal");

      const fetched = yield* dv.getInventorySources({
        inventorySourceId: created.source.inventorySourceId,
        advertiserId: created.source.advertiserId,
      });
      expect(fetched.inventorySourceId).toEqual(
        created.source.inventorySourceId,
      );
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const source = yield* GCP.Displayvideo.InventorySource("Deal", {
            advertiserId: advertiser.advertiserId,
            inventorySourceId: created.source.inventorySourceId,
            displayName: "premium-deal-v2",
            exchange: "EXCHANGE_GOOGLE_AD_MANAGER",
            status: { entityStatus: "ENTITY_STATUS_PAUSED" },
          });
          return { advertiser, source };
        }),
      );

      expect(updated.source.inventorySourceId).toEqual(
        created.source.inventorySourceId,
      );
      expect(updated.source.displayName).toEqual("premium-deal-v2");
      expect(updated.source.status?.entityStatus).toEqual(
        "ENTITY_STATUS_PAUSED",
      );

      yield* stack.destroy();

      // DV360 has no InventorySources.delete — destroy archives the source.
      const leftover = yield* dv.getInventorySources({
        inventorySourceId: created.source.inventorySourceId,
        advertiserId: created.source.advertiserId,
      });
      expect(leftover.status?.entityStatus).toEqual("ENTITY_STATUS_ARCHIVED");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
