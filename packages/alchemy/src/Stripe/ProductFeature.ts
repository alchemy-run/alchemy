import type { StripeOpContext, StripeOpError } from "@distilled.cloud/stripe";
import {
  DeleteProductsProductFeaturesId,
  GetProductsProductFeatures,
  GetProductsProductFeaturesId,
  PostProductsProductFeatures,
  type ProductFeature as StripeProductFeature,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Stripe reports a missing object as an HTTP 404, but distilled dispatches on
 * the Stripe `error.type` first — so a detached feature can surface either as
 * `NotFound` or as `InvalidRequestError` with `code === "resource_missing"`.
 * Both mean "absent".
 */
const absentAsUndefined = <A>(
  effect: Effect.Effect<A, StripeOpError, StripeOpContext>,
): Effect.Effect<A | undefined, StripeOpError, StripeOpContext> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/** Stripe's list endpoints cap `limit` at 100. */
const PAGE_SIZE = 100;
/** Hard bound on pagination so a runaway cursor can never spin forever. */
const MAX_PAGES = 50;

/** Exhaustively enumerate the features attached to a product. */
const listProductFeatures = Effect.fn(function* (productId: string) {
  const attachments: StripeProductFeature[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetProductsProductFeatures({
      product: productId,
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    attachments.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return attachments;
});

/**
 * Find the attachment linking `productId` to `entitlementFeatureId`. The
 * (product, feature) pair — not the `prodft_…` id — is this resource's real
 * identity, because Stripe has no metadata on the attachment to brand.
 */
const findAttachment = Effect.fn(function* (
  productId: string,
  entitlementFeatureId: string,
) {
  const attachments = yield* listProductFeatures(productId).pipe(
    // A product deleted out from under us is "no attachments", not a failure.
    Effect.catchTag("NotFound", () =>
      Effect.succeed<StripeProductFeature[]>([]),
    ),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed<StripeProductFeature[]>([])
        : Effect.fail(error),
    ),
  );
  return attachments.find(
    (attachment) => attachment.entitlement_feature.id === entitlementFeatureId,
  );
});

const productFeatureAttrs = (
  productId: string,
  attachment: StripeProductFeature,
): ProductFeature["Attributes"] => ({
  productFeatureId: attachment.id,
  productId,
  entitlementFeatureId: attachment.entitlement_feature.id,
  featureLookupKey: attachment.entitlement_feature.lookup_key,
  featureName: attachment.entitlement_feature.name,
  livemode: attachment.livemode,
});

export type ProductFeatureProps = {
  /**
   * The Stripe product (`prod_…`) to attach the feature to. Changing it
   * **replaces** the attachment — Stripe has no API to move an attachment
   * between products.
   */
  productId: string;
  /**
   * The Stripe Entitlements feature (`feat_…`) to attach. Changing it
   * **replaces** the attachment.
   */
  entitlementFeatureId: string;
};

export type ProductFeature = Resource<
  "Stripe.ProductFeature",
  ProductFeatureProps,
  {
    /** Stripe's unique identifier for the attachment (`prodft_…`). */
    productFeatureId: string;
    /** The product the feature is attached to. */
    productId: string;
    /** The entitlement feature that is attached. */
    entitlementFeatureId: string;
    /** The attached feature's lookup key, resolved from Stripe. */
    featureLookupKey: string;
    /** The attached feature's name, resolved from Stripe. */
    featureName: string;
    /** `true` when the attachment lives in live mode, `false` in test mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * Attaches a `Stripe.Feature` to a Stripe product. When a customer purchases
 * a product with attached features, Stripe creates an entitlement to each
 * feature for that customer.
 *
 * This is a pure link resource: it has no mutable configuration of its own, so
 * every change to either side of the link replaces the attachment. It also has
 * no `metadata` field — Stripe does not model one on `product_feature` — so
 * its identity is the (product, feature) pair, and `read` rediscovers it by
 * listing the product's features and matching the feature id.
 *
 * ### Attaching a Feature to a Product
 * **Example:** Basic attachment
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const feature = yield* Stripe.Feature("api-access", {
 *   lookupKey: "api_access",
 *   name: "API Access",
 * });
 *
 * yield* Stripe.ProductFeature("pro-api-access", {
 *   productId: product.productId,
 *   entitlementFeatureId: feature.featureId,
 * });
 * ```
 *
 * ### Attaching several Features to one Product
 * **Example:** A product that grants three entitlements
 * ```typescript
 * const product = yield* Stripe.Product("enterprise", {
 *   name: "Enterprise Plan",
 * });
 *
 * for (const [lookupKey, name] of [
 *   ["api_access", "API Access"],
 *   ["sso", "Single Sign-On"],
 *   ["audit_log", "Audit Log"],
 * ] as const) {
 *   const feature = yield* Stripe.Feature(lookupKey, { lookupKey, name });
 *   yield* Stripe.ProductFeature(`enterprise-${lookupKey}`, {
 *     productId: product.productId,
 *     entitlementFeatureId: feature.featureId,
 *   });
 * }
 * ```
 *
 * @see https://docs.stripe.com/api/product-feature
 *
 * @resource
 */
export const ProductFeature = Resource<ProductFeature>("Stripe.ProductFeature");

export const ProductFeatureProvider = () =>
  Provider.succeed(ProductFeature, {
    stables: ["productFeatureId", "productId", "entitlementFeatureId"],
    // No `list`: attachments are keyed entirely by their parent product, and
    // Stripe exposes no account-wide `product_feature` listing. Deleting the
    // product removes its attachments, so account-wide teardown is covered by
    // the `Stripe.Product` provider.
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) {
        // The planning engine resolves stable attributes even when the
        // upstream resource is being updated in place, so an unresolved
        // `news` here means a parent is being created or replaced. With a
        // prior output in hand, the latter is the only possibility — and the
        // attachment must be recreated against the new parent.
        return output !== undefined
          ? ({ action: "replace" } as const)
          : undefined;
      }
      if (
        output !== undefined &&
        (news.productId !== output.productId ||
          news.entitlementFeatureId !== output.entitlementFeatureId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const productId = output?.productId ?? olds?.productId;
      if (productId === undefined) return undefined;
      if (output?.productFeatureId) {
        const observed = yield* absentAsUndefined(
          GetProductsProductFeaturesId({
            product: productId,
            id: output.productFeatureId,
          }),
        );
        if (observed) return productFeatureAttrs(productId, observed);
      }
      // State loss, or the attachment was recreated out of band under a new
      // id: rediscover it by the (product, feature) pair.
      const entitlementFeatureId =
        output?.entitlementFeatureId ?? olds?.entitlementFeatureId;
      if (entitlementFeatureId === undefined) return undefined;
      const match = yield* findAttachment(productId, entitlementFeatureId);
      return match ? productFeatureAttrs(productId, match) : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // Existence-only resource: observe, and create when missing. There is
      // nothing mutable on an attachment, so there is no sync step.
      let observed = output?.productFeatureId
        ? yield* absentAsUndefined(
            GetProductsProductFeaturesId({
              product: news.productId,
              id: output.productFeatureId,
            }),
          )
        : undefined;
      if (!observed) {
        observed = yield* findAttachment(
          news.productId,
          news.entitlementFeatureId,
        );
      }
      if (!observed) {
        observed = yield* PostProductsProductFeatures({
          product: news.productId,
          entitlement_feature: news.entitlementFeatureId,
        }).pipe(
          // A concurrent deploy (or a retried request whose response was
          // lost) can win the race and create the attachment first; Stripe
          // rejects the duplicate, so re-resolve instead of failing.
          Effect.catchTag("InvalidRequestError", (error) =>
            findAttachment(news.productId, news.entitlementFeatureId).pipe(
              Effect.flatMap((raced) =>
                raced ? Effect.succeed(raced) : Effect.fail(error),
              ),
            ),
          ),
        );
      }
      return productFeatureAttrs(news.productId, observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an attachment that is already gone — including when the
      // whole product was deleted first — is success, not an error.
      yield* absentAsUndefined(
        DeleteProductsProductFeaturesId({
          product: output.productId,
          id: output.productFeatureId,
        }),
      );
    }),
  });
