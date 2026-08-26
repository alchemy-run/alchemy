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

const waitUntilGone = (advertiserId: string, adGroupAdId: string) =>
  dv.getAdvertisersAdGroupAds({ advertiserId, adGroupAdId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersAdGroupAds on a missing ad fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersAdGroupAds({ advertiserId: "1", adGroupAdId: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an ad group ad",
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
              campaignGoal,
            },
          );
          const order = yield* GCP.Displayvideo.AdvertisersInsertionOrder(
            "Q1",
            {
              advertiserId: advertiser.advertiserId,
              campaignId: campaign.campaignId,
            },
          );
          const lineItem = yield* GCP.Displayvideo.AdvertisersLineItem(
            "Demand",
            {
              advertiserId: advertiser.advertiserId,
              insertionOrderId: order.insertionOrderId,
              lineItemType: "LINE_ITEM_TYPE_DEMAND_GEN",
              budget: {
                budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED",
                maxAmount: "1000000",
              },
              bidStrategy: {
                demandGenBid: {
                  type: "DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CLICKS",
                },
              },
            },
          );
          const adGroup = yield* GCP.Displayvideo.AdvertisersAdGroup("Feed", {
            advertiserId: advertiser.advertiserId,
            lineItemId: lineItem.lineItemId,
            adGroupFormat: "AD_GROUP_FORMAT_DEMAND_GEN",
          });
          const ad = yield* GCP.Displayvideo.AdvertisersAdGroupAd("Hero", {
            advertiserId: advertiser.advertiserId,
            adGroupId: adGroup.adGroupId,
            displayName: "hero-image",
            demandGenImageAd: {
              headlines: ["Spring sale"],
              descriptions: ["Shop the collection"],
              businessName: "Example",
              finalUrl: "https://example.com",
              callToAction: "Shop now",
            },
          });
          return { advertiser, campaign, order, lineItem, adGroup, ad };
        }),
      );

      expect(created.ad.adGroupAdId).toEqual(expect.any(String));
      expect(created.ad.displayName).toEqual("hero-image");

      const fetched = yield* dv.getAdvertisersAdGroupAds({
        advertiserId: created.ad.advertiserId,
        adGroupAdId: created.ad.adGroupAdId,
      });
      expect(fetched.adGroupAdId).toEqual(created.ad.adGroupAdId);
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
            "Demand",
            {
              advertiserId: advertiser.advertiserId,
              insertionOrderId: order.insertionOrderId,
              lineItemId: created.lineItem.lineItemId,
              lineItemType: "LINE_ITEM_TYPE_DEMAND_GEN",
            },
          );
          const adGroup = yield* GCP.Displayvideo.AdvertisersAdGroup("Feed", {
            advertiserId: advertiser.advertiserId,
            lineItemId: lineItem.lineItemId,
            adGroupId: created.adGroup.adGroupId,
            adGroupFormat: "AD_GROUP_FORMAT_DEMAND_GEN",
          });
          const ad = yield* GCP.Displayvideo.AdvertisersAdGroupAd("Hero", {
            advertiserId: advertiser.advertiserId,
            adGroupId: adGroup.adGroupId,
            adGroupAdId: created.ad.adGroupAdId,
            displayName: "hero-image-v2",
            demandGenImageAd: {
              headlines: ["Spring sale"],
              descriptions: ["Shop the collection"],
              businessName: "Example",
              finalUrl: "https://example.com/sale",
              callToAction: "Shop now",
            },
          });
          return { advertiser, campaign, order, lineItem, adGroup, ad };
        }),
      );

      expect(updated.ad.adGroupAdId).toEqual(created.ad.adGroupAdId);
      expect(updated.ad.displayName).toEqual("hero-image-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.ad.advertiserId,
        created.ad.adGroupAdId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
