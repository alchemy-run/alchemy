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
  getCollection,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleMerchantIds,
  listCollectionsAt,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  toResourceId,
} from "./internal.ts";

export type CollectionFeaturedProduct = {
  /** Offer id of the featured product. */
  offerId?: string;
  /** X-coordinate of the product callout on a shoppable image. */
  x?: number;
  /** Y-coordinate of the product callout on a shoppable image. */
  y?: number;
};

export type CollectionProps = {
  /**
   * Merchant Center account that owns the collection. This account
   * cannot be a multi-client account. Immutable — changing it replaces
   * the collection.
   */
  merchantId: string;
  /**
   * REST id of the collection. If omitted, a unique id is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the collection.
   */
  collectionId?: string;
  /**
   * Collection headlines. Collections have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix on the first headline
   * and stripped from attributes.
   */
  headline?: string[];
  /**
   * Landing page URL for the collection.
   */
  link?: string;
  /**
   * Mobile-optimized landing page URL.
   */
  mobileLink?: string;
  /**
   * Language of the collection (ISO 639-1).
   */
  language?: string;
  /**
   * Product country (CLDR territory code).
   */
  productCountry?: string;
  /**
   * Collection image URLs.
   */
  imageLink?: string[];
  /**
   * Featured products in the collection.
   */
  featuredProduct?: CollectionFeaturedProduct[];
  /**
   * Custom label 0.
   */
  customLabel0?: string;
  /**
   * Custom label 1.
   */
  customLabel1?: string;
  /**
   * Custom label 2.
   */
  customLabel2?: string;
  /**
   * Custom label 3.
   */
  customLabel3?: string;
  /**
   * Custom label 4.
   */
  customLabel4?: string;
};

export type Collection = Resource<
  "GCP.Content.Collection",
  CollectionProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** REST id of the collection. */
    collectionId: string;
    /** Headlines with the Alchemy ownership prefix stripped. */
    headline: string[] | undefined;
    /** Landing page URL. */
    link: string | undefined;
    /** Mobile landing page URL. */
    mobileLink: string | undefined;
    /** Language. */
    language: string | undefined;
    /** Product country. */
    productCountry: string | undefined;
    /** Image URLs. */
    imageLink: string[] | undefined;
    /** Featured products. */
    featuredProduct: CollectionFeaturedProduct[] | undefined;
    /** Custom label 0. */
    customLabel0: string | undefined;
    /** Custom label 1. */
    customLabel1: string | undefined;
    /** Custom label 2. */
    customLabel2: string | undefined;
    /** Custom label 3. */
    customLabel3: string | undefined;
    /** Custom label 4. */
    customLabel4: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center collection (Shopping Content API).
 *
 * Collections have no labels field — Alchemy stamps ownership into the
 * first headline so `list` / nuke can find them. `merchantId` and
 * `collectionId` are identity. `createCollections` is a full-document
 * upsert, so updates replace the collection in place.
 *
 * ### Creating a Collection
 * **Example:** Generated id
 * ```typescript
 * const collection = yield* GCP.Content.Collection("Summer", {
 *   merchantId: "123",
 *   headline: ["Summer picks"],
 *   link: "https://example.com/summer",
 *   language: "en",
 *   productCountry: "US",
 * });
 * ```
 *
 * **Example:** Explicit id and featured products
 * ```typescript
 * const collection = yield* GCP.Content.Collection("Summer", {
 *   merchantId: "123",
 *   collectionId: "summer-picks",
 *   headline: ["Summer picks"],
 *   featuredProduct: [{ offerId: "sku-1", x: 0.2, y: 0.3 }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Collection = Resource<Collection>("GCP.Content.Collection");

export class CollectionNotResolved extends Data.TaggedError(
  "GCP.Content.CollectionNotResolved",
)<{
  merchantId: string;
  collectionId: string;
}> {}

const ownershipText = (collection: content.Collection) =>
  collection.headline?.[0];

const toAttrs = (collection: content.Collection, merchantId: string) => {
  const parsed = parseOwnership(collection.headline?.[0]);
  const rest = (collection.headline ?? []).slice(1);
  const headline =
    parsed.text !== undefined || rest.length > 0
      ? [parsed.text ?? "", ...rest].filter((line, index) =>
          index === 0 ? parsed.text !== undefined : true,
        )
      : undefined;
  return {
    merchantId,
    collectionId: collection.id ?? "",
    headline,
    link: collection.link,
    mobileLink: collection.mobileLink,
    language: collection.language,
    productCountry: collection.productCountry,
    imageLink: collection.imageLink,
    featuredProduct: collection.featuredProduct,
    customLabel0: collection.customLabel0,
    customLabel1: collection.customLabel1,
    customLabel2: collection.customLabel2,
    customLabel3: collection.customLabel3,
    customLabel4: collection.customLabel4,
  };
};

const desiredHeadline = (
  ownership: Record<string, string>,
  headline: string[] | undefined,
  generated: string,
) => {
  const first = encodeOwnershipLine(ownership, headline?.[0] ?? generated);
  return [first, ...(headline ?? []).slice(1)];
};

export const CollectionProvider = () =>
  Provider.succeed(Collection, {
    stables: ["merchantId", "collectionId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      const previousId = olds?.collectionId ?? output?.collectionId;
      if (
        (previousMerchant !== undefined &&
          news.merchantId !== previousMerchant) ||
        (previousId !== undefined &&
          news.collectionId !== undefined &&
          news.collectionId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const collectionId = yield* toResourceId(
        id,
        olds?.collectionId,
        output?.collectionId,
      );
      let existing = yield* getCollection(merchantId, collectionId);
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(ownership, olds?.headline?.[0]);
        const listed = yield* listCollectionsAt(merchantId);
        existing = listed.find((item) => item.headline?.[0] === wanted);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listCollectionsAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const collection of pages[i] ?? []) {
            if (!hasOwnershipMarker(ownershipText(collection))) continue;
            attrs.push(toAttrs(collection, merchantId));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const collectionId = yield* toResourceId(
        id,
        news.collectionId,
        output?.collectionId,
      );
      const ownership = yield* createInternalLabels(id);
      const generated = yield* toDisplayName(
        id,
        news.headline?.[0],
        parseOwnership(output?.headline?.[0]).text,
      );
      const headline = desiredHeadline(ownership, news.headline, generated);
      const body: content.Collection = {
        id: collectionId,
        headline,
        link: news.link,
        mobileLink: news.mobileLink,
        language: news.language,
        productCountry: news.productCountry,
        imageLink: news.imageLink,
        featuredProduct: news.featuredProduct,
        customLabel0: news.customLabel0,
        customLabel1: news.customLabel1,
        customLabel2: news.customLabel2,
        customLabel3: news.customLabel3,
        customLabel4: news.customLabel4,
      };

      let current = yield* getCollection(
        merchantId,
        news.collectionId ?? output?.collectionId ?? collectionId,
      );
      if (current === undefined) {
        const listed = yield* listCollectionsAt(merchantId);
        current = listed.find((item) => item.headline?.[0] === headline[0]);
      }

      if (current === undefined) {
        const created = yield* content
          .createCollections({ merchantId, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getCollection(merchantId, collectionId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionNotResolved({ merchantId, collectionId });
      }

      const changed =
        !sameText(current.id, collectionId) ||
        !jsonEqual(current.headline, headline) ||
        !sameText(current.link, news.link) ||
        !sameText(current.mobileLink, news.mobileLink) ||
        !sameText(current.language, news.language) ||
        !sameText(current.productCountry, news.productCountry) ||
        !jsonEqual(current.imageLink, news.imageLink) ||
        !jsonEqual(current.featuredProduct, news.featuredProduct) ||
        !sameText(current.customLabel0, news.customLabel0) ||
        !sameText(current.customLabel1, news.customLabel1) ||
        !sameText(current.customLabel2, news.customLabel2) ||
        !sameText(current.customLabel3, news.customLabel3) ||
        !sameText(current.customLabel4, news.customLabel4);

      if (changed) {
        current = yield* content.createCollections({ merchantId, body });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.collectionId) return;
      yield* content
        .deleteCollections({
          merchantId: output.merchantId,
          collectionId: output.collectionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
