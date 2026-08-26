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
  getCheckoutSettings,
  hasCheckoutOwnership,
  listAccessibleMerchantIds,
  sameText,
  stampCheckoutUri,
  stripCheckoutOwnership,
} from "./internal.ts";

export type FreelistingsprogramCheckoutsettingProps = {
  /**
   * Merchant Center account id. Checkout settings are a singleton per
   * merchant. Immutable — changing it replaces the resource.
   */
  merchantId: string;
  /**
   * Checkout URL template. `{id}` is replaced with the product offer id.
   * Checkout settings have no labels field, so Alchemy ownership is
   * stored as an `alc` query parameter and stripped from attributes.
   */
  checkoutUriTemplate?: string;
  /**
   * Cart URL template.
   */
  cartUriTemplate?: string;
};

export type FreelistingsprogramCheckoutsetting = Resource<
  "GCP.Content.FreelistingsprogramCheckoutsetting",
  FreelistingsprogramCheckoutsettingProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** Checkout URL template with the Alchemy query parameter stripped. */
    checkoutUriTemplate: string | undefined;
    /** Cart URL template with the Alchemy query parameter stripped. */
    cartUriTemplate: string | undefined;
    /** Merchant enrollment state. */
    enrollmentState: string | undefined;
    /** Merchant review state. */
    reviewState: string | undefined;
    /** Effective enrollment state. */
    effectiveEnrollmentState: string | undefined;
    /** Effective review state. */
    effectiveReviewState: string | undefined;
  },
  never,
  Providers
>;

/**
 * Checkout settings for the Merchant Center free listings program.
 *
 * This is a singleton per merchant (`get` / `insert` / `delete` on
 * `{merchantId}/freelistingsprogram/checkoutsettings`). Settings have no
 * labels field — Alchemy stamps ownership into the checkout URL as an
 * `alc` query parameter so `list` / nuke can find them. URI templates
 * update by deleting and re-inserting the enrollment.
 *
 * ### Creating Checkout Settings
 * **Example:** Enroll checkout
 * ```typescript
 * const settings = yield* GCP.Content.FreelistingsprogramCheckoutsetting(
 *   "Checkout",
 *   {
 *     merchantId: "123",
 *     checkoutUriTemplate: "https://example.com/checkout?item_id={id}",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const FreelistingsprogramCheckoutsetting =
  Resource<FreelistingsprogramCheckoutsetting>(
    "GCP.Content.FreelistingsprogramCheckoutsetting",
  );

export class FreelistingsprogramCheckoutsettingNotResolved extends Data.TaggedError(
  "GCP.Content.FreelistingsprogramCheckoutsettingNotResolved",
)<{
  merchantId: string;
}> {}

const toAttrs = (settings: content.CheckoutSettings, merchantId: string) => ({
  merchantId: settings.merchantId ?? merchantId,
  checkoutUriTemplate: stripCheckoutOwnership(
    settings.uriSettings?.checkoutUriTemplate,
  ),
  cartUriTemplate: stripCheckoutOwnership(
    settings.uriSettings?.cartUriTemplate,
  ),
  enrollmentState: settings.enrollmentState,
  reviewState: settings.reviewState,
  effectiveEnrollmentState: settings.effectiveEnrollmentState,
  effectiveReviewState: settings.effectiveReviewState,
});

const ownershipUri = (settings: content.CheckoutSettings) =>
  settings.uriSettings?.checkoutUriTemplate ??
  settings.uriSettings?.cartUriTemplate ??
  settings.effectiveUriSettings?.checkoutUriTemplate;

export const FreelistingsprogramCheckoutsettingProvider = () =>
  Provider.succeed(FreelistingsprogramCheckoutsetting, {
    stables: ["merchantId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const existing = yield* getCheckoutSettings(merchantId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId);
      return hasCheckoutOwnership(ownershipUri(existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const settings = yield* Effect.forEach(
          merchantIds,
          (merchantId) => getCheckoutSettings(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < settings.length; i++) {
          const current = settings[i];
          if (current === undefined) continue;
          if (!hasCheckoutOwnership(ownershipUri(current))) continue;
          attrs.push(toAttrs(current, merchantIds[i]!));
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const ownership = yield* createInternalLabels(id);
      const checkoutUriTemplate = stampCheckoutUri(
        ownership,
        news.checkoutUriTemplate,
      );
      const cartUriTemplate = news.cartUriTemplate
        ? stampCheckoutUri(ownership, news.cartUriTemplate)
        : undefined;
      const uriSettings: content.UrlSettings = {
        checkoutUriTemplate,
        cartUriTemplate,
      };

      let current = yield* getCheckoutSettings(
        output?.merchantId ?? merchantId,
      );

      const ensure = () =>
        content
          .insertFreelistingsprogramCheckoutsettings({
            merchantId,
            body: { uriSettings },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getCheckoutSettings(merchantId)),
          );

      if (current === undefined) {
        current = (yield* ensure()) ?? undefined;
      }

      if (current === undefined) {
        return yield* new FreelistingsprogramCheckoutsettingNotResolved({
          merchantId,
        });
      }

      const checkoutChanged = !sameText(
        current.uriSettings?.checkoutUriTemplate,
        checkoutUriTemplate,
      );
      const cartChanged = !sameText(
        current.uriSettings?.cartUriTemplate,
        cartUriTemplate,
      );

      if (checkoutChanged || cartChanged) {
        yield* content
          .deleteFreelistingsprogramCheckoutsettings({ merchantId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        current = (yield* ensure()) ?? undefined;
      }

      if (current === undefined) {
        return yield* new FreelistingsprogramCheckoutsettingNotResolved({
          merchantId,
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* content
        .deleteFreelistingsprogramCheckoutsettings({
          merchantId: output.merchantId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
