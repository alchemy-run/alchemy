import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  getProductDeliveryTime,
  jsonEqual,
  listAccessibleMerchantIds,
  listProductsAt,
} from "./internal.ts";

export type DeliveryTime = {
  /** Minimum handling time in business days. */
  minHandlingTimeDays?: number;
  /** Maximum handling time in business days. */
  maxHandlingTimeDays?: number;
  /** Minimum transit time in business days. */
  minTransitTimeDays?: number;
  /** Maximum transit time in business days. */
  maxTransitTimeDays?: number;
};

export type DeliveryArea = {
  /** CLDR country code (for example `US`). */
  countryCode?: string;
  /** Subdivision code without country prefix (for example `NY`). */
  regionCode?: string;
  /** Postal code range. */
  postalCodeRange?: {
    firstPostalCode?: string;
    lastPostalCode?: string;
  };
};

export type AreaDeliveryTime = {
  /** Delivery area. */
  deliveryArea?: DeliveryArea;
  /** Delivery time for that area. */
  deliveryTime?: DeliveryTime;
};

export type ProductdeliverytimeProps = {
  /**
   * Merchant Center account that contains the product. Cannot be a
   * multi-client account. Immutable — changing it replaces the resource.
   */
  merchantId: string;
  /**
   * Content API product id
   * (`channel:contentLanguage:targetCountry:offerId`). Immutable —
   * changing it replaces the resource. This resource has no labels or
   * description field — `list` returns every product delivery time on
   * accessible merchants keyed by this id.
   */
  productId: string;
  /**
   * Area / delivery-time pairs (max 100).
   */
  areaDeliveryTimes: AreaDeliveryTime[];
};

export type Productdeliverytime = Resource<
  "GCP.Content.Productdeliverytime",
  ProductdeliverytimeProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** Content API product id. */
    productId: string;
    /** Area / delivery-time pairs. */
    areaDeliveryTimes: AreaDeliveryTime[];
  },
  never,
  Providers
>;

/**
 * Estimated delivery time for a Merchant Center product.
 *
 * Only authorized shipping-signal partners can use this resource.
 * `createProductdeliverytime` is a full-document upsert. `merchantId` and
 * `productId` are identity. There is no labels or description field, so
 * `list` / nuke enumerates product delivery times by listing products
 * and getting each delivery-time row.
 *
 * ### Creating Product Delivery Time
 * **Example:** Country-wide transit window
 * ```typescript
 * const pdt = yield* GCP.Content.Productdeliverytime("SkuShip", {
 *   merchantId: "123",
 *   productId: "online:en:US:sku-1",
 *   areaDeliveryTimes: [
 *     {
 *       deliveryArea: { countryCode: "US" },
 *       deliveryTime: {
 *         minHandlingTimeDays: 1,
 *         maxHandlingTimeDays: 2,
 *         minTransitTimeDays: 3,
 *         maxTransitTimeDays: 5,
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Productdeliverytime = Resource<Productdeliverytime>(
  "GCP.Content.Productdeliverytime",
);

export class ProductdeliverytimeNotResolved extends Data.TaggedError(
  "GCP.Content.ProductdeliverytimeNotResolved",
)<{
  merchantId: string;
  productId: string;
}> {}

const areasOf = (
  areas: content.ProductDeliveryTimeAreaDeliveryTimeList | undefined,
): AreaDeliveryTime[] =>
  (areas ?? []).map((area) => ({
    deliveryArea: area.deliveryArea
      ? {
          countryCode: area.deliveryArea.countryCode,
          regionCode: area.deliveryArea.regionCode,
          postalCodeRange: area.deliveryArea.postalCodeRange,
        }
      : undefined,
    deliveryTime: area.deliveryTime,
  }));

const toAttrs = (
  pdt: content.ProductDeliveryTime,
  merchantId: string,
  productId: string,
) => ({
  merchantId,
  productId: pdt.productId?.productId ?? productId,
  areaDeliveryTimes: areasOf(pdt.areaDeliveryTimes),
});

export const ProductdeliverytimeProvider = () =>
  Provider.succeed(Productdeliverytime, {
    stables: ["merchantId", "productId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      const previousProduct = olds?.productId ?? output?.productId;
      if (
        (previousMerchant !== undefined &&
          news.merchantId !== previousMerchant) ||
        (previousProduct !== undefined && news.productId !== previousProduct)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const productId = olds?.productId ?? output?.productId ?? "";
      const existing = yield* getProductDeliveryTime(merchantId, productId);
      if (existing === undefined) return undefined;
      return toAttrs(existing, merchantId, productId);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const attrs = [];
        for (const merchantId of merchantIds) {
          const products = yield* listProductsAt(merchantId);
          const pdts = yield* Effect.forEach(
            products,
            (product) => getProductDeliveryTime(merchantId, product.id ?? ""),
            { concurrency: 4 },
          );
          for (const pdt of pdts) {
            if (pdt === undefined) continue;
            attrs.push(
              toAttrs(pdt, merchantId, pdt.productId?.productId ?? ""),
            );
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const merchantId = news.merchantId;
      const productId = news.productId;
      const body: content.ProductDeliveryTime = {
        productId: { productId },
        areaDeliveryTimes: news.areaDeliveryTimes,
      };

      let current = yield* getProductDeliveryTime(
        merchantId,
        output?.productId ?? productId,
      );

      if (current === undefined) {
        const created = yield* content
          .createProductdeliverytime({ merchantId, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getProductDeliveryTime(merchantId, productId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProductdeliverytimeNotResolved({
          merchantId,
          productId,
        });
      }

      if (
        !jsonEqual(areasOf(current.areaDeliveryTimes), news.areaDeliveryTimes)
      ) {
        current = yield* content.createProductdeliverytime({
          merchantId,
          body,
        });
      }

      return toAttrs(current, merchantId, productId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.productId) return;
      yield* content
        .deleteProductdeliverytime({
          merchantId: output.merchantId,
          productId: output.productId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
