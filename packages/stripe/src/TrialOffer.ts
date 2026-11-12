import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  CreateProductCatalogTrialOffer,
  GetProductCatalogTrialOffer,
  GetProductCatalogTrialOffers,
  UpdateProductCatalogTrialOffer,
  type ProductCatalogTrialOffer as StripeTrialOffer,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { atSpecApiVersion, STRIPE_SPEC_API_VERSION } from "./internal/version.ts";
import { isMissingStripeResource } from "./missing.ts";
import type { Price } from "./Price.ts";
import type { Providers } from "./Providers.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface TrialOfferProps {
  /**
   * The discounted (or free) recurring price charged during the trial — the
   * resource, or a `price_…` id. Create-only — changing it replaces the
   * trial offer.
   */
  price: string | Price;
  /**
   * How long the trial lasts, in billing periods of `price`. Create-only.
   */
  duration: { iterations: number };
  /**
   * What happens when the trial ends: the subscription moves to
   * `transition.price`. Create-only.
   */
  endBehavior: { transition: { price: string | Price } };
  /**
   * Internal label for the offer, hidden from customers. Create-only.
   */
  nickname?: string;
  /**
   * Whether new subscriptions can use the offer.
   * @default true
   */
  active?: boolean;
}

export type TrialOffer = Resource<
  "Stripe.TrialOffer",
  TrialOfferProps,
  {
    /** Stripe trial offer id (`to_…`). */
    id: string;
    /** Price charged during the trial. */
    price: string;
    /** Trial length, in billing periods. */
    duration: { iterations: number };
    /** Price the subscription moves to when the trial ends. */
    endBehavior: { transition: { price: string } };
    /** Internal label, if set. */
    nickname: string | undefined;
    /** Whether new subscriptions can use the offer. */
    active: boolean;
    /** Whether the offer exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  TrialOfferLookup
>;

/** Props for {@link TrialOffer.lookup}: find a trial offer this stack doesn't manage by its id. */
export interface TrialOfferLookup {
  /** Stripe trial offer id, e.g. `"to_1A2b3C4d5E6f7G8h"`. */
  id: string;
}

/**
 * A Stripe trial offer — a paid or discounted trial a subscription starts
 * on, which moves to a full price after a set number of billing periods.
 * Pass its id as a subscription item's `trial_offer` to apply it.
 *
 * Everything but `active` is fixed once created, so changing any other prop
 * replaces the offer. Trial offers can't be deleted: destroy deactivates
 * them. They carry no metadata, so an offer this stack didn't create is
 * only adopted with `--adopt`.
 *
 * @see https://docs.stripe.com/billing/subscriptions/trials/paid-trials
 *
 * ### Creating a trial offer
 * **Example:** $1 for the first month, then $10 a month
 * ```typescript
 * const intro = yield* Stripe.Price("intro", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 100,
 *   recurring: { interval: "month" },
 * });
 * const monthly = yield* Stripe.Price("monthly", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 1000,
 *   recurring: { interval: "month" },
 * });
 * const offer = yield* Stripe.TrialOffer("intro-offer", {
 *   price: intro,
 *   duration: { iterations: 1 },
 *   endBehavior: { transition: { price: monthly } },
 * });
 * ```
 *
 * ### Looking up an existing trial offer
 * `TrialOffer.lookup` references an offer Alchemy doesn't manage. It is read
 * during plan/deploy, never created, updated or deleted.
 *
 * **Example:** Reference an existing trial offer
 * ```typescript
 * const ref = Stripe.TrialOffer.lookup({ id: "to_1A2b3C4d5E6f7G8h" });
 * ```
 *
 * @resource
 * @product Product
 */
export const TrialOffer = Resource<TrialOffer>("Stripe.TrialOffer");

type TrialOfferAttributes = TrialOffer["Attributes"];

const idOf = (value: string | { readonly id: string }) =>
  typeof value === "string" ? value : value.id;

/** A Price prop resolves to its attributes at runtime, so its id is a string. */
const priceIdOf = (price: string | Price): string => {
  if (typeof price === "string") return price;
  const id = price.id as unknown;
  return typeof id === "string" ? id : String(id);
};

const toAttrs = (offer: StripeTrialOffer): TrialOfferAttributes => ({
  id: offer.id,
  price: idOf(offer.price),
  duration: { iterations: offer.duration.relative?.iterations ?? 0 },
  endBehavior: {
    transition: {
      price: offer.end_behavior.transition ? idOf(offer.end_behavior.transition.price) : "",
    },
  },
  nickname: offer.nickname ?? undefined,
  active: offer.active,
  livemode: offer.livemode,
});

const matches = (news: TrialOfferProps, attrs: TrialOfferAttributes) =>
  priceIdOf(news.price) === attrs.price &&
  news.duration.iterations === attrs.duration.iterations &&
  priceIdOf(news.endBehavior.transition.price) === attrs.endBehavior.transition.price &&
  (news.nickname ?? undefined) === attrs.nickname;

const getById = (id: string) =>
  GetProductCatalogTrialOffer({ id }).pipe(
    atSpecApiVersion,
    Effect.catchIf(isMissingStripeResource, () => Effect.undefined),
  );

/** An offer with the same shape on the same price; offers carry no metadata. */
const findMatching = Effect.fn(function* (news: TrialOfferProps) {
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetProductCatalogTrialOffers({
      prices: [priceIdOf(news.price)],
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(atSpecApiVersion);
    const match = response.data.find((offer) => offer.active && matches(news, toAttrs(offer)));
    if (match !== undefined) return match;
    if (!response.has_more || response.data.length === 0) return undefined;
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) return undefined;
  }
  return undefined;
});

export const TrialOfferProvider = () =>
  Provider.succeed(TrialOffer, {
    stables: ["id", "price", "duration", "endBehavior", "nickname", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && !matches(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    lookup: Effect.fn(function* ({ id }) {
      const existing = yield* getById(id);
      return existing === undefined ? undefined : toAttrs(existing);
    }),

    read: Effect.fn(function* ({ output, olds }) {
      if (output !== undefined) {
        const byId = yield* getById(output.id);
        if (byId !== undefined) return toAttrs(byId);
      }
      if (olds === undefined) return undefined;
      // No metadata: an offer matched by shape can't be proven ours.
      const found = yield* findMatching(olds);
      return found === undefined ? undefined : Unowned(toAttrs(found));
    }),

    // Trial offers carry no ownership marker, so nuke never enumerates them.
    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      const desiredActive = news.active ?? true;
      let current = output !== undefined ? yield* getById(output.id) : undefined;
      if (current !== undefined && !matches(news, toAttrs(current))) {
        current = undefined;
      }
      current ??= yield* findMatching(news);
      if (current === undefined) {
        current = yield* CreateProductCatalogTrialOffer({
          price: priceIdOf(news.price),
          duration: { type: "relative", relative: { iterations: news.duration.iterations } },
          end_behavior: { transition: { price: priceIdOf(news.endBehavior.transition.price) } },
          active: desiredActive,
          ...(news.nickname !== undefined ? { nickname: news.nickname } : {}),
        }).pipe(
          withRequestOptions({
            apiVersion: STRIPE_SPEC_API_VERSION,
            idempotencyKey: `alchemy-trial-offer-${instanceId}`,
          }),
        );
      }
      if (current.active !== desiredActive) {
        current = yield* UpdateProductCatalogTrialOffer({
          id: current.id,
          active: desiredActive,
        }).pipe(atSpecApiVersion);
      }
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdateProductCatalogTrialOffer({ id: existing.id, active: false }).pipe(
        atSpecApiVersion,
        Effect.catchIf(isMissingStripeResource, () => Effect.void),
      );
    }),
  });
