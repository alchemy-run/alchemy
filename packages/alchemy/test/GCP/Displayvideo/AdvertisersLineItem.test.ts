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

const waitUntilGone = (advertiserId: string, lineItemId: string) =>
  dv.getAdvertisersLineItems({ advertiserId, lineItemId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersLineItems on a missing line item fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersLineItems({ advertiserId: "1", lineItemId: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a line item",
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
              displayName: "li-parent",
              campaignGoal,
            },
          );
          const order = yield* GCP.Displayvideo.AdvertisersInsertionOrder(
            "Q1",
            {
              advertiserId: advertiser.advertiserId,
              campaignId: campaign.campaignId,
              displayName: "li-order",
            },
          );
          const lineItem = yield* GCP.Displayvideo.AdvertisersLineItem(
            "Prospect",
            {
              advertiserId: advertiser.advertiserId,
              insertionOrderId: order.insertionOrderId,
              displayName: "prospecting-display",
            },
          );
          return { advertiser, campaign, order, lineItem };
        }),
      );

      expect(created.lineItem.lineItemId).toEqual(expect.any(String));
      expect(created.lineItem.displayName).toEqual("prospecting-display");
      expect(created.lineItem.entityStatus).toEqual("ENTITY_STATUS_DRAFT");

      const fetched = yield* dv.getAdvertisersLineItems({
        advertiserId: created.lineItem.advertiserId,
        lineItemId: created.lineItem.lineItemId,
      });
      expect(fetched.lineItemId).toEqual(created.lineItem.lineItemId);
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
            },
          );
          const lineItem = yield* GCP.Displayvideo.AdvertisersLineItem(
            "Prospect",
            {
              advertiserId: advertiser.advertiserId,
              insertionOrderId: order.insertionOrderId,
              lineItemId: created.lineItem.lineItemId,
              displayName: "prospecting-display-v2",
            },
          );
          return { advertiser, campaign, order, lineItem };
        }),
      );

      expect(updated.lineItem.lineItemId).toEqual(created.lineItem.lineItemId);
      expect(updated.lineItem.displayName).toEqual("prospecting-display-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.lineItem.advertiserId,
        created.lineItem.lineItemId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
