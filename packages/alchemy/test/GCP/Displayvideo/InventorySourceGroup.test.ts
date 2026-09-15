import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserProps,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (
  inventorySourceGroupId: string,
  owner: { partnerId?: string; advertiserId?: string },
) =>
  dv
    .getInventorySourceGroups({
      inventorySourceGroupId,
      partnerId: owner.partnerId,
      advertiserId: owner.advertiserId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getInventorySourceGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getInventorySourceGroups({
          inventorySourceGroupId: "1",
          partnerId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an inventory source group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const group = yield* GCP.Displayvideo.InventorySourceGroup(
            "Premium",
            {
              advertiserId: advertiser.advertiserId,
              displayName: "premium-publishers",
            },
          );
          return { advertiser, group };
        }),
      );

      expect(created.group.inventorySourceGroupId).toEqual(expect.any(String));
      expect(created.group.advertiserId).toEqual(
        created.advertiser.advertiserId,
      );
      expect(created.group.displayName).toEqual("premium-publishers");

      const fetched = yield* dv.getInventorySourceGroups({
        inventorySourceGroupId: created.group.inventorySourceGroupId,
        advertiserId: created.group.advertiserId,
      });
      expect(fetched.inventorySourceGroupId).toEqual(
        created.group.inventorySourceGroupId,
      );
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const group = yield* GCP.Displayvideo.InventorySourceGroup(
            "Premium",
            {
              advertiserId: advertiser.advertiserId,
              inventorySourceGroupId: created.group.inventorySourceGroupId,
              displayName: "premium-publishers-v2",
            },
          );
          return { advertiser, group };
        }),
      );

      expect(updated.group.inventorySourceGroupId).toEqual(
        created.group.inventorySourceGroupId,
      );
      expect(updated.group.displayName).toEqual("premium-publishers-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.group.inventorySourceGroupId, {
        advertiserId: created.group.advertiserId,
      });
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
