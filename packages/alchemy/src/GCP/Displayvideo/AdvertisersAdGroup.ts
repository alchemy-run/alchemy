import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  jsonEqual,
  listOwnedAdvertiserIds,
  MAX_AD_GROUP_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type AdGroupInventoryControlValue = {
  /** Inventory strategy. */
  adGroupInventoryStrategy?: string;
  /** Selected inventories when the strategy is custom. */
  selectedInventories?: {
    allowYoutubeStream?: boolean;
    allowGoogleDisplayNetwork?: boolean;
    allowYoutubeShorts?: boolean;
    allowGmail?: boolean;
    allowYoutubeFeed?: boolean;
    allowDiscover?: boolean;
  };
};

export type AdGroupBidStrategy = {
  /** Demand Gen bid strategy. */
  demandGenBid?: { type?: string; value?: string };
  /** YouTube and Partners bid strategy. */
  youtubeAndPartnersBid?: { type?: string; value?: string };
};

export type AdvertisersAdGroupProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the ad
   * group.
   */
  advertiserId: string;
  /**
   * Parent line item id. Immutable — changing it replaces the ad group.
   */
  lineItemId: string;
  /**
   * System-assigned ad group id. Omit on create; pass the observed id
   * to update in place.
   */
  adGroupId?: string;
  /**
   * Display name (max 255 bytes). Ad groups have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Ad format. Immutable. Create currently supports Demand Gen only.
   * @default "AD_GROUP_FORMAT_DEMAND_GEN"
   */
  adGroupFormat?: string;
  /**
   * Serving status.
   * @default "ENTITY_STATUS_DRAFT"
   */
  entityStatus?: string;
  /** Bidding strategy (`demandGenBid` or `youtubeAndPartnersBid`). */
  bidStrategy?: AdGroupBidStrategy;
  /** Inventory control. Required for Demand Gen ad groups. */
  adGroupInventoryControl?: AdGroupInventoryControlValue;
  /** Product-feed matching settings. */
  productFeedData?: dv.ProductFeedData;
  /** Optimized targeting expansion. */
  targetingExpansion?: dv.TargetingExpansionConfig;
};

export type AdvertisersAdGroup = Resource<
  "GCP.Displayvideo.AdvertisersAdGroup",
  AdvertisersAdGroupProps,
  {
    /** Resource name `advertisers/{advertiser}/adGroups/{adGroup}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Parent line item id. */
    lineItemId: string;
    /** System-assigned ad group id. */
    adGroupId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Ad format. */
    adGroupFormat: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Bidding strategy. */
    bidStrategy: AdGroupBidStrategy | undefined;
    /** Inventory control. */
    adGroupInventoryControl: AdGroupInventoryControlValue | undefined;
    /** Product-feed matching settings. */
    productFeedData: dv.ProductFeedData | undefined;
    /** Optimized targeting expansion. */
    targetingExpansion: dv.TargetingExpansionConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 ad group under a line item.
 *
 * Ad groups have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Advertiser id, line item
 * id, and format are immutable. Create currently supports Demand Gen
 * ad groups only.
 *
 * ### Creating an Ad Group
 * **Example:** Demand Gen ad group
 * ```typescript
 * const adGroup = yield* GCP.Displayvideo.AdvertisersAdGroup("Feed", {
 *   advertiserId: lineItem.advertiserId,
 *   lineItemId: lineItem.lineItemId,
 *   displayName: "demand-gen-feed",
 *   adGroupFormat: "AD_GROUP_FORMAT_DEMAND_GEN",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersAdGroup = Resource<AdvertisersAdGroup>(
  "GCP.Displayvideo.AdvertisersAdGroup",
);

export class AdvertisersAdGroupNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersAdGroupNotResolved",
)<{
  adGroupId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_DRAFT";
const DEFAULT_FORMAT = "AD_GROUP_FORMAT_DEMAND_GEN";

const toAttrs = (adGroup: dv.AdGroup) => {
  const parsed = parseOwnership(adGroup.displayName);
  return {
    name: adGroup.name ?? "",
    advertiserId: adGroup.advertiserId ?? "",
    lineItemId: adGroup.lineItemId ?? "",
    adGroupId: adGroup.adGroupId ?? "",
    displayName: parsed.text,
    adGroupFormat: adGroup.adGroupFormat,
    entityStatus: adGroup.entityStatus,
    bidStrategy: adGroup.bidStrategy,
    adGroupInventoryControl: adGroup.adGroupInventoryControl,
    productFeedData: adGroup.productFeedData,
    targetingExpansion: adGroup.targetingExpansion,
  };
};

const getById = (advertiserId: string, adGroupId: string | undefined) =>
  !adGroupId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersAdGroups({ advertiserId, adGroupId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersAdGroups.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.adGroups ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.AdGroup[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((adGroups) =>
      adGroups.find((adGroup) => adGroup.displayName === displayName),
    ),
  );

export const AdvertisersAdGroupProvider = () =>
  Provider.succeed(AdvertisersAdGroup, {
    stables: ["name", "advertiserId", "lineItemId", "adGroupId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLineItem = olds?.lineItemId ?? output?.lineItemId;
      if (
        previousLineItem !== undefined &&
        news.lineItemId !== previousLineItem
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousFormat = olds?.adGroupFormat ?? output?.adGroupFormat;
      if (
        previousFormat !== undefined &&
        news.adGroupFormat !== undefined &&
        news.adGroupFormat !== previousFormat
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.adGroupId ?? output?.adGroupId;
      if (
        previousId !== undefined &&
        news.adGroupId !== undefined &&
        news.adGroupId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.adGroupId ?? output?.adGroupId,
      );
      if (existing === undefined && advertiserId) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          advertiserId,
          encodeOwnershipLine(
            ownership,
            olds?.displayName,
            MAX_AD_GROUP_DISPLAY_NAME_LENGTH,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const advertiserIds = yield* listOwnedAdvertiserIds();
        const pages = yield* Effect.forEach(
          advertiserIds,
          (advertiserId) => listAt(advertiserId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((adGroup) => hasOwnershipMarker(adGroup.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const lineItemId = news.lineItemId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        userName,
        MAX_AD_GROUP_DISPLAY_NAME_LENGTH,
      );
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const adGroupFormat = news.adGroupFormat ?? DEFAULT_FORMAT;

      let current = yield* getById(
        advertiserId,
        news.adGroupId ?? output?.adGroupId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersAdGroups({
            advertiserId,
            body: {
              lineItemId,
              displayName,
              entityStatus,
              adGroupFormat,
              bidStrategy: news.bidStrategy,
              adGroupInventoryControl: news.adGroupInventoryControl,
              productFeedData: news.productFeedData,
              targetingExpansion: news.targetingExpansion,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(advertiserId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersAdGroupNotResolved({
          adGroupId: news.adGroupId ?? output?.adGroupId ?? displayName,
        });
      }

      const adGroupId = current.adGroupId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const bidChanged = !jsonEqual(current.bidStrategy, news.bidStrategy);
      const inventoryChanged = !jsonEqual(
        current.adGroupInventoryControl,
        news.adGroupInventoryControl,
      );
      const feedChanged = !jsonEqual(
        current.productFeedData,
        news.productFeedData,
      );
      const expansionChanged = !jsonEqual(
        current.targetingExpansion,
        news.targetingExpansion,
      );

      if (
        displayChanged ||
        statusChanged ||
        bidChanged ||
        inventoryChanged ||
        feedChanged ||
        expansionChanged
      ) {
        current = yield* dv.patchAdvertisersAdGroups({
          advertiserId,
          adGroupId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            bidChanged ? "bidStrategy" : undefined,
            inventoryChanged ? "adGroupInventoryControl" : undefined,
            feedChanged ? "productFeedData" : undefined,
            expansionChanged ? "targetingExpansion" : undefined,
          ),
          body: {
            advertiserId,
            adGroupId,
            lineItemId,
            displayName,
            entityStatus,
            bidStrategy: news.bidStrategy,
            adGroupInventoryControl: news.adGroupInventoryControl,
            productFeedData: news.productFeedData,
            targetingExpansion: news.targetingExpansion,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.adGroupId) return;
      yield* dv
        .deleteAdvertisersAdGroups({
          advertiserId: output.advertiserId,
          adGroupId: output.adGroupId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
