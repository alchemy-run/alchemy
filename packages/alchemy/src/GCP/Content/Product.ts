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
  DEFAULT_AVAILABILITY,
  DEFAULT_CHANNEL,
  DEFAULT_CONDITION,
  DEFAULT_COUNTRY,
  DEFAULT_LANGUAGE,
  DEFAULT_PRICE,
  encodeOwnership,
  findOwnedProduct,
  getProduct,
  jsonEqual,
  listOwnedProducts,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_TITLE_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  productRestId,
  sameStringList,
  sameText,
  toResourceId,
} from "./internal.ts";

export type ContentPrice = {
  /** ISO 4217 currency code. */
  currency?: string;
  /** Price as a decimal string. */
  value?: string;
};

export type ProductShipping = {
  country?: string;
  region?: string;
  service?: string;
  price?: ContentPrice;
  minHandlingTime?: string;
  maxHandlingTime?: string;
  minTransitTime?: string;
  maxTransitTime?: string;
  locationId?: string;
  locationGroupName?: string;
  postalCode?: string;
};

export type ProductTax = {
  country?: string;
  region?: string;
  rate?: number;
  taxShip?: boolean;
  locationId?: string;
  postalCode?: string;
};

export type ProductProps = {
  /**
   * Merchant Center account id. Cannot be a multi-client account.
   * Immutable — changing it replaces the product.
   */
  merchantId: string;
  /**
   * Supplemental feed id. When set, insert and delete apply to that
   * feed instead of the primary Content API feed. Immutable — changing
   * it replaces the product.
   */
  feedId?: string;
  /**
   * Merchant offer id. If omitted, a unique id is generated from the
   * stack, stage, and logical id. Immutable — changing it replaces the
   * product.
   */
  offerId?: string;
  /**
   * Item channel (`online` or `local`). Immutable — changing it
   * replaces the product.
   * @default "online"
   */
  channel?: string;
  /**
   * Two-letter ISO 639-1 language code. Immutable — changing it
   * replaces the product.
   * @default "en"
   */
  contentLanguage?: string;
  /**
   * CLDR territory code for the country of sale. Immutable — changing
   * it replaces the product.
   * @default "US"
   */
  targetCountry?: string;
  /**
   * Feed label. When set, the REST id uses the feed label instead of
   * `targetCountry`. Immutable — changing it replaces the product.
   */
  feedLabel?: string;
  /**
   * Product title (max 150 characters). Generated when omitted.
   */
  title?: string;
  /**
   * Product description. Products have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
  /**
   * Landing-page URL.
   */
  link?: string;
  /**
   * Primary image URL.
   */
  imageLink?: string;
  /**
   * Additional image URLs.
   */
  additionalImageLinks?: string[];
  /**
   * Mobile landing-page URL.
   */
  mobileLink?: string;
  /**
   * Canonical landing-page URL.
   */
  canonicalLink?: string;
  /**
   * Availability (`in stock`, `out of stock`, `preorder`, `backorder`).
   * @default "in stock"
   */
  availability?: string;
  /**
   * Date a pre-ordered product becomes available (ISO 8601).
   */
  availabilityDate?: string;
  /**
   * Condition (`new`, `refurbished`, `used`).
   * @default "new"
   */
  condition?: string;
  /**
   * Price of the item.
   * @default { currency: "USD", value: "1.00" }
   */
  price?: ContentPrice;
  /**
   * Sale price.
   */
  salePrice?: ContentPrice;
  /**
   * Sale-price effective date range.
   */
  salePriceEffectiveDate?: string;
  /**
   * Brand.
   */
  brand?: string;
  /**
   * Global Trade Item Number.
   */
  gtin?: string;
  /**
   * Manufacturer part number.
   */
  mpn?: string;
  /**
   * Google product category.
   */
  googleProductCategory?: string;
  /**
   * Merchant product types.
   */
  productTypes?: string[];
  /**
   * Whether unique product identifiers exist. Defaults to false so
   * GTIN, MPN, and brand are not required.
   * @default false
   */
  identifierExists?: boolean;
  /**
   * Whether the item is targeted towards adults.
   * @default false
   */
  adult?: boolean;
  /**
   * Color.
   */
  color?: string;
  /**
   * Sizes.
   */
  sizes?: string[];
  /**
   * Size type (apparel).
   */
  sizeType?: string;
  /**
   * Size system (apparel).
   */
  sizeSystem?: string;
  /**
   * Target gender.
   */
  gender?: string;
  /**
   * Target age group.
   */
  ageGroup?: string;
  /**
   * Shared identifier for variants of the same product.
   */
  itemGroupId?: string;
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
  /**
   * Expiration date (ISO 8601).
   */
  expirationDate?: string;
  /**
   * Shipping rules.
   */
  shipping?: ProductShipping[];
  /**
   * Shipping label used with account-level shipping rules.
   */
  shippingLabel?: string;
  /**
   * Tax information.
   */
  taxes?: ProductTax[];
  /**
   * Ads redirect URL.
   */
  adsRedirect?: string;
  /**
   * Pause publication (`ads`).
   */
  pause?: string;
  /**
   * Whether the item is a merchant-defined bundle.
   */
  isBundle?: boolean;
  /**
   * Pattern.
   */
  pattern?: string;
  /**
   * Material.
   */
  material?: string;
  /**
   * Pickup method (`buy`, `reserve`, `ship to store`, `not supported`).
   */
  pickupMethod?: string;
  /**
   * Pickup SLA (`same day`, `next day`, `2-day`, …).
   */
  pickupSla?: string;
  /**
   * Energy efficiency class.
   */
  energyEfficiencyClass?: string;
  /**
   * Dynamic remarketing title.
   */
  displayAdsTitle?: string;
  /**
   * Dynamic remarketing link.
   */
  displayAdsLink?: string;
  /**
   * Dynamic remarketing id.
   */
  displayAdsId?: string;
  /**
   * Ads grouping.
   */
  adsGrouping?: string;
  /**
   * Ads labels.
   */
  adsLabels?: string[];
  /**
   * Promotion ids.
   */
  promotionIds?: string[];
  /**
   * Destinations to include.
   */
  includedDestinations?: string[];
  /**
   * Destinations to exclude.
   */
  excludedDestinations?: string[];
  /**
   * Multipack quantity.
   */
  multipack?: string;
  /**
   * Transit time label.
   */
  transitTimeLabel?: string;
  /**
   * Max handling time in business days.
   */
  maxHandlingTime?: string;
  /**
   * Min handling time in business days.
   */
  minHandlingTime?: string;
  /**
   * Cost of goods sold.
   */
  costOfGoodsSold?: ContentPrice;
};

export type Product = Resource<
  "GCP.Content.Product",
  ProductProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** REST product id (`channel:language:country:offerId`). */
    productId: string;
    /** Merchant offer id. */
    offerId: string;
    /** Channel. */
    channel: string;
    /** Content language. */
    contentLanguage: string;
    /** Target country. */
    targetCountry: string | undefined;
    /** Feed label. */
    feedLabel: string | undefined;
    /** Supplemental feed id. */
    feedId: string | undefined;
    /** Product title. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Landing-page URL. */
    link: string | undefined;
    /** Primary image URL. */
    imageLink: string | undefined;
    /** Additional image URLs. */
    additionalImageLinks: string[];
    /** Availability. */
    availability: string | undefined;
    /** Condition. */
    condition: string | undefined;
    /** Price. */
    price: ContentPrice | undefined;
    /** Sale price. */
    salePrice: ContentPrice | undefined;
    /** Brand. */
    brand: string | undefined;
    /** GTIN. */
    gtin: string | undefined;
    /** MPN. */
    mpn: string | undefined;
    /** Google product category. */
    googleProductCategory: string | undefined;
    /** Product types. */
    productTypes: string[];
    /** Whether unique identifiers exist. */
    identifierExists: boolean;
    /** Adult targeting. */
    adult: boolean;
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
    /** Offer source (`api`, `crawl`, `feed`). */
    source: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center product (Content API for Shopping).
 *
 * Products have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. `merchantId`, `offerId`, `channel`,
 * `contentLanguage`, `targetCountry`, `feedLabel`, and `feedId` are
 * identity — changing them replaces the product. Title, description,
 * links, price, availability, and the other product attributes update
 * in place via `products.insert` (upsert). Creating a product requires
 * a Merchant Center account.
 *
 * ### Creating a Product
 * **Example:** Generated offer id
 * ```typescript
 * const product = yield* GCP.Content.Product("Tote", {
 *   merchantId: "123456",
 *   title: "Canvas tote",
 *   link: "https://example.com/tote",
 *   imageLink: "https://example.com/tote.jpg",
 *   price: { currency: "USD", value: "24.00" },
 * });
 * ```
 *
 * **Example:** Explicit offer id and brand
 * ```typescript
 * const product = yield* GCP.Content.Product("Tote", {
 *   merchantId: "123456",
 *   offerId: "tote-navy",
 *   title: "Canvas tote",
 *   brand: "Example",
 *   link: "https://example.com/tote",
 *   imageLink: "https://example.com/tote.jpg",
 *   price: { currency: "USD", value: "24.00" },
 * });
 * ```
 *
 * ### Updating a Product
 * **Example:** Change the title and price
 * ```typescript
 * const product = yield* GCP.Content.Product("Tote", {
 *   merchantId: existing.merchantId,
 *   offerId: existing.offerId,
 *   title: "Canvas tote large",
 *   link: "https://example.com/tote",
 *   imageLink: "https://example.com/tote.jpg",
 *   price: { currency: "USD", value: "29.00" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Product = Resource<Product>("GCP.Content.Product");

export class ProductNotResolved extends Data.TaggedError(
  "GCP.Content.ProductNotResolved",
)<{
  productId: string;
}> {}

const priceOf = (price: ContentPrice | undefined): ContentPrice | undefined => {
  if (price === undefined) return undefined;
  return {
    currency: price.currency,
    value: price.value,
  };
};

const toAttrs = (
  product: content.Product,
  merchantId: string,
  feedId?: string,
) => {
  const parsed = parseOwnership(product.description);
  const channel = product.channel ?? DEFAULT_CHANNEL;
  const contentLanguage = product.contentLanguage ?? DEFAULT_LANGUAGE;
  const offerId = product.offerId ?? "";
  return {
    merchantId,
    productId:
      product.id ??
      productRestId({
        channel,
        contentLanguage,
        targetCountry: product.targetCountry,
        feedLabel: product.feedLabel,
        offerId,
      }),
    offerId,
    channel,
    contentLanguage,
    targetCountry: product.targetCountry,
    feedLabel: product.feedLabel,
    feedId,
    title: product.title,
    description: parsed.text,
    link: product.link,
    imageLink: product.imageLink,
    additionalImageLinks: product.additionalImageLinks ?? [],
    availability: product.availability,
    condition: product.condition,
    price: priceOf(product.price),
    salePrice: priceOf(product.salePrice),
    brand: product.brand,
    gtin: product.gtin,
    mpn: product.mpn,
    googleProductCategory: product.googleProductCategory,
    productTypes: product.productTypes ?? [],
    identifierExists: product.identifierExists === true,
    adult: product.adult === true,
    customLabel0: product.customLabel0,
    customLabel1: product.customLabel1,
    customLabel2: product.customLabel2,
    customLabel3: product.customLabel3,
    customLabel4: product.customLabel4,
    source: product.source,
  };
};

const desiredProduct = (input: {
  offerId: string;
  channel: string;
  contentLanguage: string;
  targetCountry: string;
  feedLabel?: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  news: ProductProps;
}): content.Product => ({
  offerId: input.offerId,
  channel: input.channel,
  contentLanguage: input.contentLanguage,
  targetCountry: input.targetCountry,
  feedLabel: input.feedLabel,
  title: input.title,
  description: input.description,
  link: input.link,
  imageLink: input.imageLink,
  additionalImageLinks: input.news.additionalImageLinks,
  mobileLink: input.news.mobileLink,
  canonicalLink: input.news.canonicalLink,
  availability: input.news.availability ?? DEFAULT_AVAILABILITY,
  availabilityDate: input.news.availabilityDate,
  condition: input.news.condition ?? DEFAULT_CONDITION,
  price: input.news.price ?? { ...DEFAULT_PRICE },
  salePrice: input.news.salePrice,
  salePriceEffectiveDate: input.news.salePriceEffectiveDate,
  brand: input.news.brand,
  gtin: input.news.gtin,
  mpn: input.news.mpn,
  googleProductCategory: input.news.googleProductCategory,
  productTypes: input.news.productTypes,
  identifierExists: input.news.identifierExists ?? false,
  adult: input.news.adult === true ? true : undefined,
  color: input.news.color,
  sizes: input.news.sizes,
  sizeType: input.news.sizeType,
  sizeSystem: input.news.sizeSystem,
  gender: input.news.gender,
  ageGroup: input.news.ageGroup,
  itemGroupId: input.news.itemGroupId,
  customLabel0: input.news.customLabel0,
  customLabel1: input.news.customLabel1,
  customLabel2: input.news.customLabel2,
  customLabel3: input.news.customLabel3,
  customLabel4: input.news.customLabel4,
  expirationDate: input.news.expirationDate,
  shipping: input.news.shipping,
  shippingLabel: input.news.shippingLabel,
  taxes: input.news.taxes,
  adsRedirect: input.news.adsRedirect,
  pause: input.news.pause,
  isBundle: input.news.isBundle,
  pattern: input.news.pattern,
  material: input.news.material,
  pickupMethod: input.news.pickupMethod,
  pickupSla: input.news.pickupSla,
  energyEfficiencyClass: input.news.energyEfficiencyClass,
  displayAdsTitle: input.news.displayAdsTitle,
  displayAdsLink: input.news.displayAdsLink,
  displayAdsId: input.news.displayAdsId,
  adsGrouping: input.news.adsGrouping,
  adsLabels: input.news.adsLabels,
  promotionIds: input.news.promotionIds,
  includedDestinations: input.news.includedDestinations,
  excludedDestinations: input.news.excludedDestinations,
  multipack: input.news.multipack,
  transitTimeLabel: input.news.transitTimeLabel,
  maxHandlingTime: input.news.maxHandlingTime,
  minHandlingTime: input.news.minHandlingTime,
  costOfGoodsSold: input.news.costOfGoodsSold,
});

const productNeedsSync = (current: content.Product, desired: content.Product) =>
  !sameText(current.title, desired.title) ||
  !sameText(current.description, desired.description) ||
  !sameText(current.link, desired.link) ||
  !sameText(current.imageLink, desired.imageLink) ||
  !sameStringList(current.additionalImageLinks, desired.additionalImageLinks) ||
  !sameText(current.mobileLink, desired.mobileLink) ||
  !sameText(current.canonicalLink, desired.canonicalLink) ||
  !sameText(current.availability, desired.availability) ||
  !sameText(current.availabilityDate, desired.availabilityDate) ||
  !sameText(current.condition, desired.condition) ||
  !jsonEqual(priceOf(current.price), priceOf(desired.price)) ||
  !jsonEqual(priceOf(current.salePrice), priceOf(desired.salePrice)) ||
  !sameText(current.salePriceEffectiveDate, desired.salePriceEffectiveDate) ||
  !sameText(current.brand, desired.brand) ||
  !sameText(current.gtin, desired.gtin) ||
  !sameText(current.mpn, desired.mpn) ||
  !sameText(current.googleProductCategory, desired.googleProductCategory) ||
  !sameStringList(current.productTypes, desired.productTypes) ||
  (current.identifierExists === true) !== (desired.identifierExists === true) ||
  (current.adult === true) !== (desired.adult === true) ||
  !sameText(current.color, desired.color) ||
  !sameStringList(current.sizes, desired.sizes) ||
  !sameText(current.sizeType, desired.sizeType) ||
  !sameText(current.sizeSystem, desired.sizeSystem) ||
  !sameText(current.gender, desired.gender) ||
  !sameText(current.ageGroup, desired.ageGroup) ||
  !sameText(current.itemGroupId, desired.itemGroupId) ||
  !sameText(current.customLabel0, desired.customLabel0) ||
  !sameText(current.customLabel1, desired.customLabel1) ||
  !sameText(current.customLabel2, desired.customLabel2) ||
  !sameText(current.customLabel3, desired.customLabel3) ||
  !sameText(current.customLabel4, desired.customLabel4) ||
  !sameText(current.expirationDate, desired.expirationDate) ||
  !jsonEqual(current.shipping ?? [], desired.shipping ?? []) ||
  !sameText(current.shippingLabel, desired.shippingLabel) ||
  !jsonEqual(current.taxes ?? [], desired.taxes ?? []) ||
  !sameText(current.adsRedirect, desired.adsRedirect) ||
  !sameText(current.pause, desired.pause) ||
  (current.isBundle === true) !== (desired.isBundle === true) ||
  !sameText(current.pattern, desired.pattern) ||
  !sameText(current.material, desired.material) ||
  !sameText(current.pickupMethod, desired.pickupMethod) ||
  !sameText(current.pickupSla, desired.pickupSla) ||
  !sameText(current.energyEfficiencyClass, desired.energyEfficiencyClass) ||
  !sameText(current.displayAdsTitle, desired.displayAdsTitle) ||
  !sameText(current.displayAdsLink, desired.displayAdsLink) ||
  !sameText(current.displayAdsId, desired.displayAdsId) ||
  !sameText(current.adsGrouping, desired.adsGrouping) ||
  !sameStringList(current.adsLabels, desired.adsLabels) ||
  !sameStringList(current.promotionIds, desired.promotionIds) ||
  !sameStringList(current.includedDestinations, desired.includedDestinations) ||
  !sameStringList(current.excludedDestinations, desired.excludedDestinations) ||
  !sameText(current.multipack, desired.multipack) ||
  !sameText(current.transitTimeLabel, desired.transitTimeLabel) ||
  !sameText(current.maxHandlingTime, desired.maxHandlingTime) ||
  !sameText(current.minHandlingTime, desired.minHandlingTime) ||
  !jsonEqual(
    priceOf(current.costOfGoodsSold),
    priceOf(desired.costOfGoodsSold),
  );

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: [
      "merchantId",
      "productId",
      "offerId",
      "channel",
      "contentLanguage",
      "targetCountry",
      "feedLabel",
      "feedId",
      "source",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousOffer = olds?.offerId ?? output?.offerId;
      if (
        previousOffer !== undefined &&
        news.offerId !== undefined &&
        news.offerId !== previousOffer
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousChannel = olds?.channel ?? output?.channel;
      const nextChannel = news.channel ?? DEFAULT_CHANNEL;
      if (previousChannel !== undefined && previousChannel !== nextChannel) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousLanguage = olds?.contentLanguage ?? output?.contentLanguage;
      const nextLanguage = news.contentLanguage ?? DEFAULT_LANGUAGE;
      if (previousLanguage !== undefined && previousLanguage !== nextLanguage) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousCountry = olds?.targetCountry ?? output?.targetCountry;
      const nextCountry = news.targetCountry ?? DEFAULT_COUNTRY;
      if (previousCountry !== undefined && previousCountry !== nextCountry) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousLabel = olds?.feedLabel ?? output?.feedLabel ?? "";
      if ((news.feedLabel ?? "") !== previousLabel) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousFeed = olds?.feedId ?? output?.feedId ?? "";
      if ((news.feedId ?? "") !== previousFeed) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const offerId = yield* toResourceId(id, olds?.offerId, output?.offerId);
      const channel = olds?.channel ?? output?.channel ?? DEFAULT_CHANNEL;
      const contentLanguage =
        olds?.contentLanguage ?? output?.contentLanguage ?? DEFAULT_LANGUAGE;
      const targetCountry =
        olds?.targetCountry ?? output?.targetCountry ?? DEFAULT_COUNTRY;
      const feedLabel = olds?.feedLabel ?? output?.feedLabel;
      const productId =
        output?.productId ??
        productRestId({
          channel,
          contentLanguage,
          targetCountry,
          feedLabel,
          offerId,
        });
      let existing = yield* getProduct(merchantId, productId);
      if (existing === undefined && merchantId) {
        existing = yield* findOwnedProduct(id, merchantId, offerId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        merchantId,
        olds?.feedId ?? output?.feedId,
      );
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const rows = yield* listOwnedProducts();
        return rows.map((row) =>
          toAttrs(row.product, row.merchantId, undefined),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const offerId = yield* toResourceId(id, news.offerId, output?.offerId);
      const channel = news.channel ?? output?.channel ?? DEFAULT_CHANNEL;
      const contentLanguage =
        news.contentLanguage ?? output?.contentLanguage ?? DEFAULT_LANGUAGE;
      const targetCountry =
        news.targetCountry ?? output?.targetCountry ?? DEFAULT_COUNTRY;
      const feedLabel = news.feedLabel ?? output?.feedLabel;
      const productId =
        output?.productId ??
        productRestId({
          channel,
          contentLanguage,
          targetCountry,
          feedLabel,
          offerId,
        });
      const ownership = yield* createInternalLabels(id);
      const title = (yield* toResourceId(
        id,
        news.title,
        output?.title,
        MAX_PRODUCT_TITLE_LENGTH,
      )).slice(0, MAX_PRODUCT_TITLE_LENGTH);
      const description = encodeOwnership(
        ownership,
        news.description,
        MAX_PRODUCT_DESCRIPTION_LENGTH,
      );
      const link = news.link ?? `https://example.com/p/${offerId}`;
      const imageLink =
        news.imageLink ?? `https://example.com/p/${offerId}.jpg`;
      const desired = desiredProduct({
        offerId,
        channel,
        contentLanguage,
        targetCountry,
        feedLabel,
        title,
        description,
        link,
        imageLink,
        news,
      });

      let current = yield* getProduct(merchantId, productId);
      if (current === undefined) {
        current = yield* findOwnedProduct(id, merchantId, offerId);
      }

      const upsert = () =>
        content
          .insertProducts({
            merchantId,
            feedId: news.feedId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getProduct(merchantId, productId),
            ),
          );

      if (current === undefined) {
        current = (yield* upsert()) ?? undefined;
      } else if (productNeedsSync(current, desired)) {
        current = (yield* upsert()) ?? current;
      }

      if (current === undefined) {
        return yield* new ProductNotResolved({ productId });
      }

      return toAttrs(current, merchantId, news.feedId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.productId || !output.merchantId) return;
      yield* content
        .deleteProducts({
          merchantId: output.merchantId,
          productId: output.productId,
          feedId: output.feedId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("Forbidden", () => Effect.void),
        );
    }),
  });
