import type {
  PromotionCode as StripePromotionCode,
  PromotionCodesResourceRestrictions,
} from "@distilled.cloud/stripe/stripe";
import {
  GetPromotionCodes,
  GetPromotionCodesPromotionCode,
  PostPromotionCodes,
  PostPromotionCodesPromotionCode,
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

/** A per-currency minimum-spend override for a promotion code. */
export type PromotionCodeCurrencyOption = {
  /**
   * Minimum amount, in the minor unit of the enclosing currency, that must
   * be spent before the code can be redeemed.
   */
  minimumAmount: number;
};

/** Conditions under which a promotion code may be redeemed. */
export type PromotionCodeRestrictions = {
  /**
   * Only allow redemption by customers with no prior successful payments
   * or invoices.
   *
   * @default false
   */
  firstTimeTransaction?: boolean;
  /**
   * Minimum amount, in the minor unit of {@link minimumAmountCurrency},
   * required for the code to apply.
   */
  minimumAmount?: number;
  /** Three-letter ISO currency code for {@link minimumAmount}. */
  minimumAmountCurrency?: string;
  /**
   * Per-currency minimum-spend overrides, keyed by three-letter ISO
   * currency code.
   */
  currencyOptions?: Record<string, PromotionCodeCurrencyOption>;
};

export type PromotionCodeProps = {
  /**
   * The coupon this promotion code redeems into. Pass a
   * `Stripe.Coupon`'s `couponId`.
   *
   * Changing this replaces the promotion code.
   */
  couponId: string;
  /**
   * The customer-facing code. Must be unique across all *active* promotion
   * codes for a given customer. Valid characters are `a-z`, `A-Z`, `0-9`
   * and `-`; Stripe generates one when omitted and normalizes what you
   * provide to upper case.
   *
   * Changing this replaces the promotion code.
   */
  code?: string;
  /**
   * The ID of the only customer allowed to redeem this code. When unset,
   * any customer can redeem it.
   *
   * Changing this replaces the promotion code.
   */
  customer?: string;
  /**
   * Unix timestamp (seconds) after which the code can no longer be
   * redeemed. Cannot be later than the coupon's own `redeemBy`.
   *
   * Changing this replaces the promotion code.
   */
  expiresAt?: number;
  /**
   * Number of times this code can be redeemed. Cannot exceed the coupon's
   * `maxRedemptions`.
   *
   * Changing this replaces the promotion code.
   */
  maxRedemptions?: number;
  /**
   * Conditions restricting redemption (minimum spend, first-time
   * customers only, per-currency minimums).
   *
   * Changing this replaces the promotion code. Stripe's update endpoint
   * accepts only `restrictions.currency_options`, so Alchemy treats the
   * whole block as immutable rather than partially converging it.
   */
  restrictions?: PromotionCodeRestrictions;
  /**
   * Whether the code is currently redeemable. Deactivating frees the
   * `code` string for reuse by another active promotion code.
   *
   * Mutable — changing it updates the existing promotion code in place.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Arbitrary key/value pairs attached to the promotion code. Alchemy
   * additionally writes its own `alchemy_stack` / `alchemy_stage` /
   * `alchemy_id` keys to brand ownership; those are stripped from the
   * returned `metadata` attribute.
   *
   * Mutable — changing it updates the existing promotion code in place.
   * Keys the user removes are explicitly unset on Stripe.
   */
  metadata?: Record<string, string>;
};

export type PromotionCode = Resource<
  "Stripe.PromotionCode",
  PromotionCodeProps,
  {
    /** The promotion code's Stripe ID (`promo_…`). */
    promotionCodeId: string;
    /** The customer-facing code string, as normalized by Stripe. */
    code: string;
    /** ID of the coupon this code redeems into. */
    couponId: string | undefined;
    /** Whether the code is currently redeemable. */
    active: boolean;
    /** ID of the only customer allowed to redeem, if restricted. */
    customer: string | undefined;
    /** Unix timestamp after which the code can no longer be redeemed. */
    expiresAt: number | undefined;
    /** Number of times this code can be redeemed. */
    maxRedemptions: number | undefined;
    /** Redemption conditions, as reported by Stripe. */
    restrictions: {
      /** Whether redemption is limited to first-time customers. */
      firstTimeTransaction: boolean;
      /** Minimum spend required, in the minor unit of the currency. */
      minimumAmount: number | undefined;
      /** Three-letter ISO currency code for `minimumAmount`. */
      minimumAmountCurrency: string | undefined;
      /** Per-currency minimum-spend overrides. */
      currencyOptions: Record<string, PromotionCodeCurrencyOption> | undefined;
    };
    /** Number of times the code has been redeemed. */
    timesRedeemed: number;
    /** `true` when the code lives in live mode rather than test mode. */
    livemode: boolean;
    /** Unix timestamp (seconds) at which the code was created. */
    created: number;
    /** User metadata, with Alchemy's internal `alchemy_*` keys stripped. */
    metadata: Metadata;
  },
  never,
  Providers
>;

type PromotionCodeAttributes = PromotionCode["Attributes"];

/**
 * A customer-redeemable code that applies an underlying
 * {@link Coupon}. One coupon can back many promotion codes, which is how
 * you hand out per-campaign or per-partner strings that all resolve to the
 * same discount.
 *
 * Only `active` and `metadata` can be updated after creation. Changing the
 * coupon, code string, customer restriction, expiry, redemption cap or
 * restrictions replaces the promotion code.
 *
 * Stripe has **no delete API for promotion codes**. Destroying this
 * resource deactivates it (`active: false`) instead: the code stops being
 * redeemable and its string becomes available for reuse, but the object
 * remains visible in the dashboard and in list calls forever. The
 * deactivation is idempotent — an already-inactive or already-missing code
 * is treated as success.
 *
 * ### Creating a Promotion Code
 * **Example:** A code backed by a coupon
 * ```typescript
 * const coupon = yield* Stripe.Coupon("SummerSale", {
 *   percentOff: 20,
 *   duration: "once",
 * });
 * const code = yield* Stripe.PromotionCode("SummerSaleCode", {
 *   couponId: coupon.couponId,
 * });
 * ```
 *
 * Omitting `code` lets Stripe generate the customer-facing string; read it
 * back from the `code` attribute.
 *
 * **Example:** A hand-picked code string
 * ```typescript
 * const code = yield* Stripe.PromotionCode("SummerSaleCode", {
 *   couponId: coupon.couponId,
 *   code: "SUMMER20",
 * });
 * ```
 *
 * ### Limiting who can redeem
 * **Example:** Restrict to one customer, capped and expiring
 * ```typescript
 * const code = yield* Stripe.PromotionCode("VipCode", {
 *   couponId: coupon.couponId,
 *   code: "VIP2026",
 *   customer: "cus_ABC123",
 *   maxRedemptions: 1,
 *   expiresAt: 1767225600, // 2026-01-01T00:00:00Z
 * });
 * ```
 *
 * ### Redemption restrictions
 * **Example:** Minimum spend, first-time customers only
 * ```typescript
 * const code = yield* Stripe.PromotionCode("NewCustomers", {
 *   couponId: coupon.couponId,
 *   code: "WELCOME",
 *   restrictions: {
 *     firstTimeTransaction: true,
 *     minimumAmount: 5000, // $50.00
 *     minimumAmountCurrency: "usd",
 *     currencyOptions: {
 *       eur: { minimumAmount: 4500 },
 *     },
 *   },
 * });
 * ```
 *
 * ### Retiring a code
 * **Example:** Deactivate without destroying the stack resource
 * ```typescript
 * const code = yield* Stripe.PromotionCode("SummerSaleCode", {
 *   couponId: coupon.couponId,
 *   code: "SUMMER20",
 *   active: false,
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/promotion_codes
 *
 * @resource
 */
export const PromotionCode = Resource<PromotionCode>("Stripe.PromotionCode");

export const PromotionCodeProvider = () =>
  Provider.succeed(PromotionCode, {
    stables: [
      "promotionCodeId",
      "code",
      "couponId",
      "customer",
      "expiresAt",
      "maxRedemptions",
      "restrictions",
      "livemode",
      "created",
    ],
    list: Effect.fn(function* () {
      const codes = yield* listAllPromotionCodes;
      return codes.map(promotionCodeAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` arrives as `Input<PromotionCodeProps>` during plan — bail out
      // until every referenced Output has been resolved.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // `PostPromotionCodesPromotionCode` accepts only `active`, `metadata`
      // and `restrictions.currency_options`; everything else replaces.
      const replaced =
        news.couponId !== output.couponId ||
        (news.code !== undefined &&
          news.code.toLowerCase() !== output.code.toLowerCase()) ||
        news.customer !== output.customer ||
        news.expiresAt !== output.expiresAt ||
        news.maxRedemptions !== output.maxRedemptions ||
        !restrictionsEqual(news.restrictions, output.restrictions);
      return replaced ? ({ action: "replace" } as const) : undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.promotionCodeId !== undefined) {
        const found = yield* getPromotionCode(output.promotionCodeId);
        return found === undefined ? undefined : promotionCodeAttributes(found);
      }
      // State loss. Promotion codes carry metadata, so the `alchemy_*`
      // branding is the authoritative handle; a user-pinned `code` narrows
      // the search when present.
      const candidates =
        olds?.code !== undefined
          ? yield* findPromotionCodesByCode(olds.code)
          : yield* listAllPromotionCodes;
      for (const candidate of candidates) {
        if (yield* isOwned(id, asMetadata(candidate.metadata))) {
          return promotionCodeAttributes(candidate);
        }
      }
      // A same-code object that isn't branded as ours exists but belongs to
      // someone else — gate takeover behind `--adopt`.
      const foreign = olds?.code !== undefined ? candidates[0] : undefined;
      return foreign === undefined
        ? undefined
        : Unowned(promotionCodeAttributes(foreign));
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — prefer the deployed id; otherwise a pinned `code` lets
      //    us recover from a create whose state commit never landed.
      const observed = output?.promotionCodeId
        ? yield* getPromotionCode(output.promotionCodeId)
        : news.code !== undefined
          ? yield* findOwnedByCode(id, news.code)
          : undefined;

      // 2. Ensure — create when absent.
      const existing =
        observed ??
        (yield* PostPromotionCodes({
          promotion: { type: "coupon", coupon: news.couponId },
          code: news.code,
          customer: news.customer,
          expires_at: news.expiresAt,
          max_redemptions: news.maxRedemptions,
          restrictions: toRestrictions(news.restrictions),
          active: news.active,
          metadata: desiredMetadata,
        }));

      // 3. Sync — diff the two mutable aspects against OBSERVED state.
      const desiredActive = news.active ?? true;
      const activeChanged = desiredActive !== existing.active;
      const metadataChanged = !metadataEqual(
        asMetadata(existing.metadata),
        desiredMetadata,
      );
      const promotionCode =
        activeChanged || metadataChanged
          ? yield* PostPromotionCodesPromotionCode({
              promotion_code: existing.id,
              active: activeChanged ? desiredActive : undefined,
              metadata: metadataChanged
                ? metadataUpdate(asMetadata(existing.metadata), desiredMetadata)
                : undefined,
            })
          : existing;

      return promotionCodeAttributes(promotionCode);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe cannot delete promotion codes — deactivating is the closest
      // thing to a teardown, and it frees the `code` string for reuse.
      // Idempotent: already-inactive and already-missing are both success.
      yield* PostPromotionCodesPromotionCode({
        promotion_code: output.promotionCodeId,
        active: false,
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * `GET /v1/promotion_codes/{promotion_code}`, mapping a missing object to
 * `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled dispatches on `error.type`
 * before status — so the miss can arrive as either tag.
 */
const getPromotionCode = (promotionCodeId: string) =>
  GetPromotionCodesPromotionCode({ promotion_code: promotionCodeId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/** Every promotion code (active or not) carrying the given code string. */
const findPromotionCodesByCode = (code: string) =>
  GetPromotionCodes({ code, limit: 100 }).pipe(Effect.map((res) => res.data));

/** The promotion code with this code string that is branded as ours. */
const findOwnedByCode = Effect.fn(function* (id: string, code: string) {
  const candidates = yield* findPromotionCodesByCode(code);
  for (const candidate of candidates) {
    if (yield* isOwned(id, asMetadata(candidate.metadata))) return candidate;
  }
  return undefined;
});

/**
 * Exhaustively enumerate the account's promotion codes via Stripe's
 * `starting_after` cursor. Bounded at 100 pages (10k codes) so a
 * misbehaving cursor can never spin forever.
 */
const listAllPromotionCodes = Effect.gen(function* () {
  const codes: StripePromotionCode[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetPromotionCodes({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    codes.push(...res.data);
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return codes;
});

const promotionCodeAttributes = (
  promotionCode: StripePromotionCode,
): PromotionCodeAttributes => ({
  promotionCodeId: promotionCode.id,
  code: promotionCode.code,
  couponId: expandedId(promotionCode.promotion.coupon),
  active: promotionCode.active,
  customer: expandedId(promotionCode.customer),
  expiresAt: promotionCode.expires_at ?? undefined,
  maxRedemptions: promotionCode.max_redemptions ?? undefined,
  restrictions: fromRestrictions(promotionCode.restrictions),
  timesRedeemed: promotionCode.times_redeemed,
  livemode: promotionCode.livemode,
  created: promotionCode.created,
  metadata: stripInternalMetadata(asMetadata(promotionCode.metadata)),
});

/**
 * Stripe expandable references arrive either as a bare id string or as the
 * fully expanded object; both carry the id we want.
 */
const expandedId = (
  value: string | { id: string } | null | undefined,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : value.id;
};

const fromRestrictions = (
  restrictions: PromotionCodesResourceRestrictions,
): PromotionCodeAttributes["restrictions"] => ({
  firstTimeTransaction: restrictions.first_time_transaction,
  minimumAmount: restrictions.minimum_amount ?? undefined,
  minimumAmountCurrency: restrictions.minimum_amount_currency ?? undefined,
  currencyOptions: fromCurrencyOptions(restrictions.currency_options),
});

const fromCurrencyOptions = (
  options:
    | { [currency: string]: { minimum_amount: number } | undefined }
    | undefined,
): Record<string, PromotionCodeCurrencyOption> | undefined => {
  if (options === undefined) return undefined;
  const out: Record<string, PromotionCodeCurrencyOption> = {};
  for (const [currency, value] of Object.entries(options)) {
    if (value !== undefined) {
      out[currency] = { minimumAmount: value.minimum_amount };
    }
  }
  return out;
};

const toRestrictions = (
  restrictions: PromotionCodeRestrictions | undefined,
) => {
  if (restrictions === undefined) return undefined;
  const currencyOptions = restrictions.currencyOptions;
  return {
    first_time_transaction: restrictions.firstTimeTransaction,
    minimum_amount: restrictions.minimumAmount,
    minimum_amount_currency: restrictions.minimumAmountCurrency,
    currency_options:
      currencyOptions === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(currencyOptions).map(([currency, value]) => [
              currency,
              { minimum_amount: value.minimumAmount },
            ]),
          ),
  };
};

const restrictionsEqual = (
  desired: PromotionCodeRestrictions | undefined,
  observed: PromotionCodeAttributes["restrictions"],
): boolean =>
  (desired?.firstTimeTransaction ?? false) === observed.firstTimeTransaction &&
  desired?.minimumAmount === observed.minimumAmount &&
  normalizeCurrency(desired?.minimumAmountCurrency) ===
    normalizeCurrency(observed.minimumAmountCurrency) &&
  currencyOptionsEqual(desired?.currencyOptions, observed.currencyOptions);

const currencyOptionsEqual = (
  desired: Record<string, PromotionCodeCurrencyOption> | undefined,
  observed: Record<string, PromotionCodeCurrencyOption> | undefined,
): boolean => {
  const left = desired ?? {};
  const right = observed ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => left[key]?.minimumAmount === right[key]?.minimumAmount,
  );
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
