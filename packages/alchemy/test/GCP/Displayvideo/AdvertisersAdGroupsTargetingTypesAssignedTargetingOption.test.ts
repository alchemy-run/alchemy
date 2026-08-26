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

const waitUntilGone = (
  advertiserId: string,
  adGroupId: string,
  targetingType: string,
  assignedTargetingOptionId: string,
) =>
  dv
    .getAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
      advertiserId,
      adGroupId,
      targetingType,
      assignedTargetingOptionId,
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
  "getAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions on a missing option fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
          advertiserId: "1",
          adGroupId: "1",
          targetingType: "TARGETING_TYPE_KEYWORD",
          assignedTargetingOptionId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an assigned targeting option",
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
          const option =
            yield* GCP.Displayvideo.AdvertisersAdGroupsTargetingTypesAssignedTargetingOption(
              "Exclude",
              {
                advertiserId: advertiser.advertiserId,
                adGroupId: adGroup.adGroupId,
                targetingType: "TARGETING_TYPE_KEYWORD",
                keywordDetails: { keyword: "competitor", negative: true },
              },
            );
          return { advertiser, campaign, order, lineItem, adGroup, option };
        }),
      );

      expect(created.option.assignedTargetingOptionId).toEqual(
        expect.any(String),
      );
      expect(created.option.targetingType).toEqual("TARGETING_TYPE_KEYWORD");

      const fetched =
        yield* dv.getAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
          advertiserId: created.option.advertiserId,
          adGroupId: created.option.adGroupId,
          targetingType: created.option.targetingType,
          assignedTargetingOptionId: created.option.assignedTargetingOptionId,
        });
      expect(fetched.assignedTargetingOptionId).toEqual(
        created.option.assignedTargetingOptionId,
      );
      expect(fetched.keywordDetails?.negative).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.option.advertiserId,
        created.option.adGroupId,
        created.option.targetingType,
        created.option.assignedTargetingOptionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
