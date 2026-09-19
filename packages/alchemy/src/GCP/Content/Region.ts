import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  getRegion,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleMerchantIds,
  listRegionsAt,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type RegionPostalCodeRange = {
  /** Inclusive lower bound (`94108`, `9410*`, `9*`). */
  begin?: string;
  /** Inclusive upper bound. Omitted means all codes matching `begin`. */
  end?: string;
};

export type RegionPostalCodeArea = {
  /** CLDR territory code for the postal codes. */
  regionCode?: string;
  /** Postal code ranges. */
  postalCodes?: RegionPostalCodeRange[];
};

export type RegionGeoTargetArea = {
  /** Location ids of the same type (for example US states). */
  geotargetCriteriaIds?: string[];
};

export type RegionProps = {
  /**
   * Merchant Center account that owns the region. Immutable — changing
   * it replaces the region.
   */
  merchantId: string;
  /**
   * Client-assigned region id. If omitted, a unique id is generated.
   * Immutable — changing it replaces the region.
   */
  regionId?: string;
  /**
   * Display name. Regions have no labels field, so Alchemy ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
  /**
   * Postal-code area. Mutually exclusive with `geotargetArea`.
   */
  postalCodeArea?: RegionPostalCodeArea;
  /**
   * Geotarget area. Mutually exclusive with `postalCodeArea`.
   */
  geotargetArea?: RegionGeoTargetArea;
};

export type Region = Resource<
  "GCP.Content.Region",
  RegionProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** Region id. */
    regionId: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Postal-code area. */
    postalCodeArea: RegionPostalCodeArea | undefined;
    /** Geotarget area. */
    geotargetArea: RegionGeoTargetArea | undefined;
    /** Whether the region can be used in regional inventory. */
    regionalInventoryEligible: boolean | undefined;
    /** Whether the region can be used in shipping services. */
    shippingEligible: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center geographic region for regional inventory and
 * shipping.
 *
 * Regions have no labels field — Alchemy stamps ownership into
 * `displayName`. `merchantId` and `regionId` are identity. Display name
 * and area update in place.
 *
 * ### Creating a Region
 * **Example:** Postal code range
 * ```typescript
 * const region = yield* GCP.Content.Region("BayArea", {
 *   merchantId: "123",
 *   displayName: "bay-area",
 *   postalCodeArea: {
 *     regionCode: "US",
 *     postalCodes: [{ begin: "94000", end: "94199" }],
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Region = Resource<Region>("GCP.Content.Region");

export class RegionNotResolved extends Data.TaggedError(
  "GCP.Content.RegionNotResolved",
)<{
  merchantId: string;
  regionId: string;
}> {}

const toAttrs = (region: content.Region, merchantId: string) => {
  const parsed = parseOwnership(region.displayName);
  return {
    merchantId: region.merchantId ?? merchantId,
    regionId: region.regionId ?? "",
    displayName: parsed.text,
    postalCodeArea: region.postalCodeArea,
    geotargetArea: region.geotargetArea,
    regionalInventoryEligible: region.regionalInventoryEligible,
    shippingEligible: region.shippingEligible,
  };
};

export const RegionProvider = () =>
  Provider.succeed(Region, {
    stables: ["merchantId", "regionId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      const previousId = olds?.regionId ?? output?.regionId;
      if (
        (previousMerchant !== undefined &&
          news.merchantId !== previousMerchant) ||
        (previousId !== undefined &&
          news.regionId !== undefined &&
          news.regionId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const regionId = yield* toResourceId(
        id,
        olds?.regionId,
        output?.regionId,
      );
      let existing = yield* getRegion(merchantId, regionId);
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(ownership, olds?.displayName);
        const listed = yield* listRegionsAt(merchantId);
        existing = listed.find((item) => item.displayName === wanted);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listRegionsAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const region of pages[i] ?? []) {
            if (!hasOwnershipMarker(region.displayName)) continue;
            attrs.push(toAttrs(region, merchantId));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const regionId = yield* toResourceId(id, news.regionId, output?.regionId);
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const body: content.Region = {
        displayName,
        postalCodeArea: news.postalCodeArea,
        geotargetArea: news.geotargetArea,
      };

      let current = yield* getRegion(
        merchantId,
        news.regionId ?? output?.regionId ?? regionId,
      );
      if (current === undefined) {
        const listed = yield* listRegionsAt(merchantId);
        current = listed.find((item) => item.displayName === displayName);
      }

      if (current === undefined) {
        const created = yield* content
          .createRegions({ merchantId, regionId, body })
          .pipe(
            Effect.catchTag("Conflict", () => getRegion(merchantId, regionId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegionNotResolved({ merchantId, regionId });
      }

      const idNow = current.regionId ?? regionId;
      const displayChanged = !sameText(current.displayName, displayName);
      const postalChanged = !jsonEqual(
        current.postalCodeArea,
        news.postalCodeArea,
      );
      const geoChanged = !jsonEqual(current.geotargetArea, news.geotargetArea);

      if (displayChanged || postalChanged || geoChanged) {
        current = yield* content.patchRegions({
          merchantId,
          regionId: idNow,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            postalChanged ? "postalCodeArea" : undefined,
            geoChanged ? "geotargetArea" : undefined,
          ),
          body,
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.regionId) return;
      yield* content
        .deleteRegions({
          merchantId: output.merchantId,
          regionId: output.regionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
