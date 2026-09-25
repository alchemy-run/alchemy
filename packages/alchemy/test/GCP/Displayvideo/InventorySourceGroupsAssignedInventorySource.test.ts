import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  advertiserProps,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const listAssigned = (
  inventorySourceGroupId: string,
  assignedInventorySourceId: string,
  owner: { partnerId?: string; advertiserId?: string },
) =>
  dv.listInventorySourceGroupsAssignedInventorySources
    .pages({
      inventorySourceGroupId,
      partnerId: owner.partnerId,
      advertiserId: owner.advertiserId,
      filter: `assignedInventorySourceId="${assignedInventorySourceId}"`,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assignedInventorySources ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

const waitUntilGone = (
  inventorySourceGroupId: string,
  assignedInventorySourceId: string,
  owner: { partnerId?: string; advertiserId?: string },
) =>
  listAssigned(inventorySourceGroupId, assignedInventorySourceId, owner).pipe(
    Effect.map((rows) =>
      rows.length === 0 ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "Forbidden"] as const, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "listInventorySourceGroupsAssignedInventorySources on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.listInventorySourceGroupsAssignedInventorySources({
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
  "create and delete an assigned inventory source",
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
          const source = yield* GCP.Displayvideo.InventorySource("Deal", {
            advertiserId: advertiser.advertiserId,
            displayName: "premium-deal",
            exchange: "EXCHANGE_GOOGLE_AD_MANAGER",
          });
          const assigned =
            yield* GCP.Displayvideo.InventorySourceGroupsAssignedInventorySource(
              "Deal",
              {
                inventorySourceGroupId: group.inventorySourceGroupId,
                inventorySourceId: source.inventorySourceId,
                advertiserId: advertiser.advertiserId,
              },
            );
          return { advertiser, group, source, assigned };
        }),
      );

      expect(created.assigned.assignedInventorySourceId).toEqual(
        expect.any(String),
      );
      expect(created.assigned.inventorySourceId).toEqual(
        created.source.inventorySourceId,
      );
      expect(created.assigned.inventorySourceGroupId).toEqual(
        created.group.inventorySourceGroupId,
      );

      const fetched = yield* listAssigned(
        created.assigned.inventorySourceGroupId,
        created.assigned.assignedInventorySourceId,
        { advertiserId: created.assigned.advertiserId },
      );
      expect(fetched.length).toBeGreaterThan(0);
      expect(fetched[0]?.inventorySourceId).toEqual(
        created.source.inventorySourceId,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.assigned.inventorySourceGroupId,
        created.assigned.assignedInventorySourceId,
        { advertiserId: created.assigned.advertiserId },
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
