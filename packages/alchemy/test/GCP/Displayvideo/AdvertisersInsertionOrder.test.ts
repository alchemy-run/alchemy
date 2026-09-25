import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserProps,
  campaignGoal,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (advertiserId: string, insertionOrderId: string) =>
  dv.getAdvertisersInsertionOrders({ advertiserId, insertionOrderId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersInsertionOrders on a missing insertion order fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersInsertionOrders({
          advertiserId: "1",
          insertionOrderId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an insertion order",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const campaign = yield* GCP.Displayvideo.AdvertisersCampaign(
            "Spring",
            {
              advertiserId: advertiser.advertiserId,
              displayName: "io-parent",
              campaignGoal,
            },
          );
          const order = yield* GCP.Displayvideo.AdvertisersInsertionOrder(
            "Q1",
            {
              advertiserId: advertiser.advertiserId,
              campaignId: campaign.campaignId,
              displayName: "q1-prospecting",
            },
          );
          return { advertiser, campaign, order };
        }),
      );

      expect(created.order.insertionOrderId).toEqual(expect.any(String));
      expect(created.order.displayName).toEqual("q1-prospecting");
      expect(created.order.entityStatus).toEqual("ENTITY_STATUS_DRAFT");

      const fetched = yield* dv.getAdvertisersInsertionOrders({
        advertiserId: created.order.advertiserId,
        insertionOrderId: created.order.insertionOrderId,
      });
      expect(fetched.insertionOrderId).toEqual(created.order.insertionOrderId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const campaign = yield* GCP.Displayvideo.AdvertisersCampaign(
            "Spring",
            {
              advertiserId: advertiser.advertiserId,
              campaignId: created.campaign.campaignId,
              campaignGoal,
            },
          );
          const order = yield* GCP.Displayvideo.AdvertisersInsertionOrder(
            "Q1",
            {
              advertiserId: advertiser.advertiserId,
              campaignId: campaign.campaignId,
              insertionOrderId: created.order.insertionOrderId,
              displayName: "q1-prospecting-v2",
            },
          );
          return { advertiser, campaign, order };
        }),
      );

      expect(updated.order.insertionOrderId).toEqual(
        created.order.insertionOrderId,
      );
      expect(updated.order.displayName).toEqual("q1-prospecting-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.order.advertiserId,
        created.order.insertionOrderId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
