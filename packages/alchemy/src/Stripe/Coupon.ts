import type { Coupon as StripeCoupon } from "@distilled.cloud/stripe/stripe";
import {
  DeleteCouponsCoupon,
  GetCoupons,
  GetCouponsCoupon,
  PostCoupons,
  PostCouponsCoupon,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * How long the discount stays in effect once applied to a subscription.
 *
 * - `once` — the discount applies to the first invoice only.
 * - `repeating` — the discount applies for `durationInMonths` months.
 * - `forever` — the discount applies to every invoice.
 */
export type CouponDuration = "forever" | "once" | "repeating";

/** A per-currency `amountOff` override for an amount-based coupon. */
export type CouponCurrencyOption = {
  /**
   * Amount (in the minor unit of the enclosing currency) subtracted from
   * the invoice subtotal when the invoice is denominated in that currency.
   */
  amountOff: number;
};

/** Restricts which products a coupon discounts. */
export type CouponAppliesTo = {
  /** Product IDs this coupon applies to. */
  products: string[];
};

export type CouponProps = {
  /**
   * The coupon's ID — the customer-facing code merchants type into the
   * dashboard when applying it. Stripe generates a random one when omitted.
   *
   * Changing this replaces the coupon.
   */
  id?: string;
  /**
   * Name of the coupon displayed to customers on invoices and receipts.
   * Stripe falls back to showing the coupon `id` when unset.
   *
   * Mutable — changing it updates the existing coupon in place.
   */
  name?: string;
  /**
   * A positive integer, in the minor unit of {@link currency}, subtracted
   * from the invoice total. Required when {@link percentOff} is not set,
   * and mutually exclusive with it.
   *
   * Changing this replaces the coupon.
   */
  amountOff?: number;
  /**
   * Three-letter ISO currency code for {@link amountOff}. Required when
   * `amountOff` is set.
   *
   * Changing this replaces the coupon.
   */
  currency?: string;
  /**
   * A float greater than 0 and at most 100 — the percentage taken off the
   * invoice subtotal. Required when {@link amountOff} is not set, and
   * mutually exclusive with it.
   *
   * Changing this replaces the coupon.
   */
  percentOff?: number;
  /**
   * How long the discount stays in effect when applied to a subscription.
   *
   * Changing this replaces the coupon.
   *
   * @default "once"
   */
  duration?: CouponDuration;
  /**
   * Number of months the discount applies for. Required — and only
   * valid — when {@link duration} is `"repeating"`.
   *
   * Changing this replaces the coupon.
   */
  durationInMonths?: number;
  /**
   * Total number of times the coupon can be redeemed across all customers
   * before it stops being valid.
   *
   * Changing this replaces the coupon.
   */
  maxRedemptions?: number;
  /**
   * Unix timestamp (seconds) after which the coupon can no longer be
   * applied to new customers. Cannot be more than five years out.
   *
   * Changing this replaces the coupon.
   */
  redeemBy?: number;
  /**
   * Restricts the discount to a specific set of products.
   *
   * Changing this replaces the coupon.
   */
  appliesTo?: CouponAppliesTo;
  /**
   * Per-currency `amountOff` overrides, keyed by three-letter ISO currency
   * code. Only supported on amount-based coupons.
   *
   * Mutable — changing it updates the existing coupon in place.
   */
  currencyOptions?: Record<string, CouponCurrencyOption>;
  /**
   * Arbitrary key/value pairs attached to the coupon. Alchemy additionally
   * writes its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys to
   * brand ownership; those are stripped from the returned `metadata`
   * attribute.
   *
   * Mutable — changing it updates the existing coupon in place. Keys the
   * user removes are explicitly unset on Stripe.
   */
  metadata?: Record<string, string>;
};

export type Coupon = Resource<
  "Stripe.Coupon",
  CouponProps,
  {
    /** The coupon's Stripe ID — also the code merchants apply. */
    couponId: string;
    /** Customer-facing name, or `undefined` when Stripe shows the id. */
    name: string | undefined;
    /** Amount, in the minor unit of `currency`, taken off the subtotal. */
    amountOff: number | undefined;
    /** Three-letter ISO currency code paired with `amountOff`. */
    currency: string | undefined;
    /** Percentage taken off the subtotal. */
    percentOff: number | undefined;
    /** How long the discount stays in effect on a subscription. */
    duration: CouponDuration;
    /** Months the discount applies for when `duration` is `"repeating"`. */
    durationInMonths: number | undefined;
    /** Total redemptions allowed before the coupon stops being valid. */
    maxRedemptions: number | undefined;
    /** Unix timestamp after which the coupon can no longer be redeemed. */
    redeemBy: number | undefined;
    /** Product IDs the coupon is restricted to, if any. */
    appliesToProducts: string[] | undefined;
    /** Per-currency `amountOff` overrides, keyed by ISO currency code. */
    currencyOptions: Record<string, CouponCurrencyOption> | undefined;
    /** Number of times the coupon has been applied to a customer. */
    timesRedeemed: number;
    /** Whether the coupon can still be applied to a customer. */
    valid: boolean;
    /** `true` when the coupon lives in live mode rather than test mode. */
    livemode: boolean;
    /** Unix timestamp (seconds) at which the coupon was created. */
    created: number;
    /** User metadata, with Alchemy's internal `alchemy_*` keys stripped. */
    metadata: Metadata;
  },
  never,
  Providers
>;

type CouponAttributes = Coupon["Attributes"];

/**
 * A percent-off or amount-off discount that can be applied to
 * subscriptions, invoices, checkout sessions and quotes.
 *
 * Almost every field of a Stripe coupon is immutable by design — only
 * `name`, `metadata` and `currencyOptions` can be updated after creation.
 * Changing anything else (the discount amount, duration, redemption limits,
 * the products it applies to, or the coupon's own `id`) replaces the
 * coupon: a new one is created and the old one deleted. Existing customers
 * who already redeemed the old coupon keep their discount.
 *
 * ### Creating a Coupon
 * **Example:** A 25% off coupon that applies to the first invoice only
 * ```typescript
 * const coupon = yield* Stripe.Coupon("WelcomeDiscount", {
 *   percentOff: 25,
 *   duration: "once",
 *   name: "Welcome 25% off",
 * });
 * ```
 *
 * **Example:** A fixed amount off, repeating for three months
 * ```typescript
 * const coupon = yield* Stripe.Coupon("ThreeMonthsOff", {
 *   amountOff: 1000, // $10.00
 *   currency: "usd",
 *   duration: "repeating",
 *   durationInMonths: 3,
 * });
 * ```
 *
 * ### Choosing the coupon ID
 * **Example:** A human-typed coupon code
 * ```typescript
 * const coupon = yield* Stripe.Coupon("BlackFriday", {
 *   id: "BLACKFRIDAY",
 *   percentOff: 40,
 *   duration: "once",
 * });
 * ```
 *
 * Omit `id` and Stripe generates a random one. Changing an explicit `id`
 * later replaces the coupon.
 *
 * ### Limiting redemption
 * **Example:** First 100 redemptions, expiring at a fixed date
 * ```typescript
 * const coupon = yield* Stripe.Coupon("LaunchWeek", {
 *   percentOff: 50,
 *   duration: "forever",
 *   maxRedemptions: 100,
 *   redeemBy: 1767225600, // 2026-01-01T00:00:00Z
 * });
 * ```
 *
 * ### Restricting to specific products
 * **Example:** Discount only the Pro plan's product
 * ```typescript
 * const pro = yield* Stripe.Product("Pro", { name: "Pro Plan" });
 * const coupon = yield* Stripe.Coupon("ProOnly", {
 *   percentOff: 15,
 *   duration: "forever",
 *   appliesTo: { products: [pro.productId] },
 * });
 * ```
 *
 * ### Handing the coupon to customers
 * **Example:** A redeemable promotion code backed by the coupon
 * ```typescript
 * const coupon = yield* Stripe.Coupon("SummerSale", {
 *   percentOff: 20,
 *   duration: "once",
 * });
 * const code = yield* Stripe.PromotionCode("SummerSaleCode", {
 *   couponId: coupon.couponId,
 *   code: "SUMMER20",
 * });
 * ```
 *
 * ### Multi-currency amount-off coupons
 * **Example:** Different absolute discounts per currency
 * ```typescript
 * const coupon = yield* Stripe.Coupon("TenOff", {
 *   amountOff: 1000,
 *   currency: "usd",
 *   duration: "once",
 *   currencyOptions: {
 *     eur: { amountOff: 900 },
 *     gbp: { amountOff: 800 },
 *   },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/coupons
 *
 * @resource
 */
export const Coupon = Resource<Coupon>("Stripe.Coupon");

export const CouponProvider = () =>
  Provider.succeed(Coupon, {
    stables: [
      "couponId",
      "amountOff",
      "currency",
      "percentOff",
      "duration",
      "durationInMonths",
      "maxRedemptions",
      "redeemBy",
      "appliesToProducts",
      "livemode",
      "created",
    ],
    list: Effect.fn(function* () {
      const coupons = yield* listAllCoupons;
      return coupons.map(couponAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` arrives as `Input<CouponProps>` during plan — bail out until
      // every referenced Output has been resolved.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Everything Stripe refuses to mutate. `PostCouponsCoupon` only accepts
      // `name`, `metadata` and `currency_options`; any other change has to be
      // a create-then-delete.
      const replaced =
        (news.id !== undefined && news.id !== output.couponId) ||
        news.amountOff !== output.amountOff ||
        normalizeCurrency(news.currency) !==
          normalizeCurrency(output.currency) ||
        news.percentOff !== output.percentOff ||
        (news.duration ?? "once") !== output.duration ||
        news.durationInMonths !== output.durationInMonths ||
        news.maxRedemptions !== output.maxRedemptions ||
        news.redeemBy !== output.redeemBy ||
        !productsEqual(news.appliesTo?.products, output.appliesToProducts);
      return replaced ? ({ action: "replace" } as const) : undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const couponId = output?.couponId ?? olds?.id;
      if (couponId !== undefined) {
        const coupon = yield* getCoupon(couponId);
        if (coupon === undefined) return undefined;
        const attrs = couponAttributes(coupon);
        // A coupon we already provisioned is ours by construction. One found
        // purely from a user-supplied `id` may predate this stack.
        if (output?.couponId !== undefined) return attrs;
        return (yield* isOwned(id, asMetadata(coupon.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss with a Stripe-generated id: the only handle left is the
      // `alchemy_*` branding written into the coupon's metadata.
      const coupons = yield* listAllCoupons;
      for (const coupon of coupons) {
        if (yield* isOwned(id, asMetadata(coupon.metadata))) {
          return couponAttributes(coupon);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the id is either the one we deployed or the one the
      //    user pinned; a Stripe-generated id we've never seen means create.
      const couponId = output?.couponId ?? news.id;
      const observed =
        couponId !== undefined ? yield* getCoupon(couponId) : undefined;

      // 2. Ensure — create when absent. A create that already landed (state
      //    persistence failed after the POST) surfaces as
      //    `resource_already_exists` for a user-pinned id; re-read instead.
      const existing =
        observed ??
        (yield* PostCoupons({
          id: news.id,
          name: news.name,
          amount_off: news.amountOff,
          currency: news.currency,
          percent_off: news.percentOff,
          duration: news.duration,
          duration_in_months: news.durationInMonths,
          max_redemptions: news.maxRedemptions,
          redeem_by: news.redeemBy,
          applies_to: news.appliesTo
            ? { products: [...news.appliesTo.products] }
            : undefined,
          currency_options: toCurrencyOptions(news.currencyOptions),
          metadata: desiredMetadata,
        }).pipe(
          Effect.catchTag("InvalidRequestError", (e) => {
            const pinned = news.id;
            if (e.code !== "resource_already_exists" || pinned === undefined) {
              return Effect.fail(e);
            }
            // Only recover the race when the object that beat us is branded
            // as ours — otherwise this is a genuine id collision with someone
            // else's coupon and must surface as the Stripe error.
            return GetCouponsCoupon({ coupon: pinned }).pipe(
              Effect.flatMap((coupon) =>
                isOwned(id, asMetadata(coupon.metadata)).pipe(
                  Effect.flatMap((owned) =>
                    owned ? Effect.succeed(coupon) : Effect.fail(e),
                  ),
                ),
              ),
            );
          }),
        ));

      // 3. Sync — diff the three mutable aspects against OBSERVED state and
      //    issue at most one update call.
      const nameChanged =
        (news.name ?? undefined) !== (existing.name ?? undefined);
      const metadataChanged = !metadataEqual(
        asMetadata(existing.metadata),
        desiredMetadata,
      );
      const currencyOptionsChanged = !currencyOptionsEqual(
        existing.currency_options,
        news.currencyOptions,
      );
      const coupon =
        nameChanged || metadataChanged || currencyOptionsChanged
          ? yield* PostCouponsCoupon({
              coupon: existing.id,
              // Stripe unsets a string field when posted as the empty string.
              name: nameChanged ? (news.name ?? "") : undefined,
              metadata: metadataChanged
                ? metadataUpdate(asMetadata(existing.metadata), desiredMetadata)
                : undefined,
              currency_options: currencyOptionsChanged
                ? toCurrencyOptions(news.currencyOptions)
                : undefined,
            })
          : existing;

      return couponAttributes(coupon);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Idempotent: a coupon already gone (or deleted out of band) is
      // success, not an error.
      yield* DeleteCouponsCoupon({ coupon: output.couponId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * `GET /v1/coupons/{coupon}`, mapping a missing coupon to `undefined`.
 *
 * Stripe answers a deleted object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled dispatches on `error.type`
 * before status — so the miss can arrive as either tag.
 */
const getCoupon = (couponId: string) =>
  GetCouponsCoupon({ coupon: couponId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Exhaustively enumerate the account's coupons via Stripe's
 * `starting_after` cursor. Bounded at 100 pages (10k coupons) so a
 * misbehaving cursor can never spin forever.
 */
const listAllCoupons = Effect.gen(function* () {
  const coupons: StripeCoupon[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetCoupons({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    coupons.push(...res.data);
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return coupons;
});

const couponAttributes = (coupon: StripeCoupon): CouponAttributes => ({
  couponId: coupon.id,
  name: coupon.name ?? undefined,
  amountOff: coupon.amount_off ?? undefined,
  currency: coupon.currency ?? undefined,
  percentOff: coupon.percent_off ?? undefined,
  duration: coupon.duration,
  durationInMonths: coupon.duration_in_months ?? undefined,
  maxRedemptions: coupon.max_redemptions ?? undefined,
  redeemBy: coupon.redeem_by ?? undefined,
  appliesToProducts: coupon.applies_to
    ? [...coupon.applies_to.products]
    : undefined,
  currencyOptions: fromCurrencyOptions(coupon.currency_options),
  timesRedeemed: coupon.times_redeemed,
  valid: coupon.valid,
  livemode: coupon.livemode,
  created: coupon.created,
  metadata: stripInternalMetadata(asMetadata(coupon.metadata)),
});

const fromCurrencyOptions = (
  options:
    | { [currency: string]: { amount_off: number } | undefined }
    | undefined,
): Record<string, CouponCurrencyOption> | undefined => {
  if (options === undefined) return undefined;
  const out: Record<string, CouponCurrencyOption> = {};
  for (const [currency, value] of Object.entries(options)) {
    if (value !== undefined) out[currency] = { amountOff: value.amount_off };
  }
  return out;
};

const toCurrencyOptions = (
  options: Record<string, CouponCurrencyOption> | undefined,
): { [currency: string]: { amount_off: number } } | undefined => {
  if (options === undefined) return undefined;
  const out: { [currency: string]: { amount_off: number } } = {};
  for (const [currency, value] of Object.entries(options)) {
    out[currency] = { amount_off: value.amountOff };
  }
  return out;
};

const currencyOptionsEqual = (
  observed:
    | { [currency: string]: { amount_off: number } | undefined }
    | undefined,
  desired: Record<string, CouponCurrencyOption> | undefined,
): boolean => {
  // `undefined` means "don't manage currency options", so an unset prop never
  // clears what Stripe already holds.
  if (desired === undefined) return true;
  const left = fromCurrencyOptions(observed) ?? {};
  const keys = Object.keys(desired);
  if (keys.length !== Object.keys(left).length) return false;
  return keys.every((key) => left[key]?.amountOff === desired[key]?.amountOff);
};

const productsEqual = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  if (a === undefined || b === undefined) {
    return a === undefined && b === undefined;
  }
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
};

/**
 * Stripe metadata maps are generated with an optional index signature
 * (`string | undefined`); Alchemy's {@link Metadata} helpers take a plain
 * `Record<string, string>`. Drop the undefined-valued entries.
 */
const asMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata | undefined => {
  if (metadata === null || metadata === undefined) return undefined;
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const normalizeCurrency = (currency: string | undefined): string | undefined =>
  currency?.toLowerCase();
