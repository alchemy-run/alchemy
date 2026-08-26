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

export type AdvertisersAdGroupAdProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the ad.
   */
  advertiserId: string;
  /**
   * Parent ad group id. Immutable — changing it replaces the ad.
   */
  adGroupId: string;
  /**
   * System-assigned ad id. Omit on create; pass the observed id to
   * update in place.
   */
  adGroupAdId?: string;
  /**
   * Display name (max 255 bytes). Ads have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Serving status.
   * @default "ENTITY_STATUS_DRAFT"
   */
  entityStatus?: string;
  /** Demand Gen image ad details. */
  demandGenImageAd?: dv.DemandGenImageAd;
  /** Demand Gen video ad details. */
  demandGenVideoAd?: dv.DemandGenVideoAd;
  /** Demand Gen carousel ad details. */
  demandGenCarouselAd?: dv.DemandGenCarouselAd;
  /** Demand Gen product ad details. */
  demandGenProductAd?: dv.DemandGenProductAd;
  /** Optional DCM tracking info for Demand Gen ads. */
  dcmTrackingInfo?: dv.DcmTrackingInfo;
};

export type AdvertisersAdGroupAd = Resource<
  "GCP.Displayvideo.AdvertisersAdGroupAd",
  AdvertisersAdGroupAdProps,
  {
    /** Resource name `advertisers/{advertiser}/adGroupAds/{ad}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Parent ad group id. */
    adGroupId: string;
    /** System-assigned ad id. */
    adGroupAdId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Demand Gen image ad details. */
    demandGenImageAd: dv.DemandGenImageAd | undefined;
    /** Demand Gen video ad details. */
    demandGenVideoAd: dv.DemandGenVideoAd | undefined;
    /** Demand Gen carousel ad details. */
    demandGenCarouselAd: dv.DemandGenCarouselAd | undefined;
    /** Demand Gen product ad details. */
    demandGenProductAd: dv.DemandGenProductAd | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 ad group ad.
 *
 * Ads have no labels field — Alchemy stamps ownership into the display
 * name so `list` / nuke can find them. Advertiser id and ad group id
 * are immutable. Create currently supports Demand Gen ads only.
 *
 * ### Creating an Ad
 * **Example:** Demand Gen image ad
 * ```typescript
 * const ad = yield* GCP.Displayvideo.AdvertisersAdGroupAd("Hero", {
 *   advertiserId: adGroup.advertiserId,
 *   adGroupId: adGroup.adGroupId,
 *   displayName: "hero-image",
 *   demandGenImageAd: {
 *     headlines: ["Spring sale"],
 *     descriptions: ["Shop the collection"],
 *     businessName: "Example",
 *     finalUrl: "https://example.com",
 *     callToAction: "Shop now",
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersAdGroupAd = Resource<AdvertisersAdGroupAd>(
  "GCP.Displayvideo.AdvertisersAdGroupAd",
);

export class AdvertisersAdGroupAdNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersAdGroupAdNotResolved",
)<{
  adGroupAdId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_DRAFT";

const toAttrs = (ad: dv.AdGroupAd) => {
  const parsed = parseOwnership(ad.displayName);
  return {
    name: ad.name ?? "",
    advertiserId: ad.advertiserId ?? "",
    adGroupId: ad.adGroupId ?? "",
    adGroupAdId: ad.adGroupAdId ?? "",
    displayName: parsed.text,
    entityStatus: ad.entityStatus,
    demandGenImageAd: ad.demandGenImageAd,
    demandGenVideoAd: ad.demandGenVideoAd,
    demandGenCarouselAd: ad.demandGenCarouselAd,
    demandGenProductAd: ad.demandGenProductAd,
  };
};

const getById = (advertiserId: string, adGroupAdId: string | undefined) =>
  !adGroupAdId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersAdGroupAds({ advertiserId, adGroupAdId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersAdGroupAds.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.adGroupAds ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.AdGroupAd[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((ads) => ads.find((ad) => ad.displayName === displayName)),
  );

export const AdvertisersAdGroupAdProvider = () =>
  Provider.succeed(AdvertisersAdGroupAd, {
    stables: ["name", "advertiserId", "adGroupId", "adGroupAdId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousGroup = olds?.adGroupId ?? output?.adGroupId;
      if (previousGroup !== undefined && news.adGroupId !== previousGroup) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.adGroupAdId ?? output?.adGroupAdId;
      if (
        previousId !== undefined &&
        news.adGroupAdId !== undefined &&
        news.adGroupAdId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.adGroupAdId ?? output?.adGroupAdId,
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
          .filter((ad) => hasOwnershipMarker(ad.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const adGroupId = news.adGroupId;
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

      let current = yield* getById(
        advertiserId,
        news.adGroupAdId ?? output?.adGroupAdId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersAdGroupAds({
            advertiserId,
            body: {
              adGroupId,
              displayName,
              entityStatus,
              demandGenImageAd: news.demandGenImageAd,
              demandGenVideoAd: news.demandGenVideoAd,
              demandGenCarouselAd: news.demandGenCarouselAd,
              demandGenProductAd: news.demandGenProductAd,
              dcmTrackingInfo: news.dcmTrackingInfo,
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
        return yield* new AdvertisersAdGroupAdNotResolved({
          adGroupAdId: news.adGroupAdId ?? output?.adGroupAdId ?? displayName,
        });
      }

      const adGroupAdId = current.adGroupAdId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const imageChanged = !jsonEqual(
        current.demandGenImageAd,
        news.demandGenImageAd,
      );
      const videoChanged = !jsonEqual(
        current.demandGenVideoAd,
        news.demandGenVideoAd,
      );
      const carouselChanged = !jsonEqual(
        current.demandGenCarouselAd,
        news.demandGenCarouselAd,
      );
      const productChanged = !jsonEqual(
        current.demandGenProductAd,
        news.demandGenProductAd,
      );
      const dcmChanged = !jsonEqual(
        current.dcmTrackingInfo,
        news.dcmTrackingInfo,
      );

      if (
        displayChanged ||
        statusChanged ||
        imageChanged ||
        videoChanged ||
        carouselChanged ||
        productChanged ||
        dcmChanged
      ) {
        current = yield* dv.patchAdvertisersAdGroupAds({
          advertiserId,
          adGroupAdId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            imageChanged ? "demandGenImageAd" : undefined,
            videoChanged ? "demandGenVideoAd" : undefined,
            carouselChanged ? "demandGenCarouselAd" : undefined,
            productChanged ? "demandGenProductAd" : undefined,
            dcmChanged ? "dcmTrackingInfo" : undefined,
          ),
          body: {
            advertiserId,
            adGroupAdId,
            adGroupId,
            displayName,
            entityStatus,
            demandGenImageAd: news.demandGenImageAd,
            demandGenVideoAd: news.demandGenVideoAd,
            demandGenCarouselAd: news.demandGenCarouselAd,
            demandGenProductAd: news.demandGenProductAd,
            dcmTrackingInfo: news.dcmTrackingInfo,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.adGroupAdId) return;
      yield* dv
        .deleteAdvertisersAdGroupAds({
          advertiserId: output.advertiserId,
          adGroupAdId: output.adGroupAdId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
