import {
  GetPrices,
  GetPricesPrice,
  PostPrices,
  PostPricesPrice,
  type PostPricesRequestCurrencyOptionsMap,
  type PostPricesRequestTiersList,
  type Price as StripePrice,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/** Billing frequency of a recurring price. */
export type PriceInterval = "day" | "week" | "month" | "year";

/**
 * How the quantity per period is determined. `licensed` bills the quantity
 * set on the subscription item; `metered` aggregates reported usage.
 */
export type PriceUsageType = "licensed" | "metered";

/**
 * How the price per period is computed. `per_unit` charges
 * `unitAmount`/`unitAmountDecimal` per unit; `tiered` computes the unit price
 * from `tiers` + `tiersMode`.
 */
export type PriceBillingScheme = "per_unit" | "tiered";

/** Whether the price is for a one-time purchase or a subscription. */
export type PriceType = "one_time" | "recurring";

/**
 * Whether the price is inclusive or exclusive of tax.
 *
 * Stripe locks this **once** it has been set to `inclusive` or `exclusive` —
 * see the caution on {@link Price}.
 */
export type PriceTaxBehavior = "inclusive" | "exclusive" | "unspecified";

/**
 * `graduated` prices each quantity band at the tier it falls in; `volume`
 * prices the whole quantity at the tier the total lands in.
 */
export type PriceTiersMode = "graduated" | "volume";

/** The recurring (subscription) component of a price. */
export type PriceRecurring = {
  /** Billing frequency — `day`, `week`, `month` or `year`. */
  interval: PriceInterval;
  /**
   * Number of `interval`s between billings. `interval: "month"` with
   * `intervalCount: 3` bills quarterly. Stripe caps the total span at three
   * years.
   *
   * @default 1
   */
  intervalCount?: number;
  /**
   * How the billed quantity is determined.
   *
   * @default "licensed"
   */
  usageType?: PriceUsageType;
  /**
   * ID of the `Stripe.Meter` tracking usage. Required by Stripe when
   * `usageType` is `"metered"`.
   */
  meter?: string;
  /**
   * Default number of trial days applied when a subscription is created with
   * `trial_from_plan=true`.
   */
  trialPeriodDays?: number;
};

/** One band of a `billingScheme: "tiered"` price. */
export type PriceTier = {
  /**
   * Inclusive upper bound of this tier. Use `"inf"` for the final,
   * open-ended fallback tier.
   */
  upTo: number | "inf";
  /** Per-unit amount, in the currency's minor unit (e.g. cents). */
  unitAmount?: number;
  /**
   * Same as `unitAmount` but as a decimal string with up to 12 decimal
   * places. Only one of `unitAmount` and `unitAmountDecimal` may be set.
   */
  unitAmountDecimal?: string;
  /** Flat amount charged for the entire tier, regardless of quantity. */
  flatAmount?: number;
  /**
   * Same as `flatAmount` but as a decimal string. Only one of `flatAmount`
   * and `flatAmountDecimal` may be set.
   */
  flatAmountDecimal?: string;
};

/**
 * Lets the customer choose the amount at checkout (pay-what-you-want).
 */
export type PriceCustomUnitAmount = {
  /** Set to `true` to enable customer-chosen amounts. */
  enabled: boolean;
  /** Maximum amount the customer may enter. */
  maximum?: number;
  /** Minimum amount the customer may enter. Must clear Stripe's floor. */
  minimum?: number;
  /** Amount pre-filled in the checkout field. */
  preset?: number;
};

/** Divides reported usage/quantity before the amount is computed. */
export type PriceTransformQuantity = {
  /** Divide the quantity by this number. */
  divideBy: number;
  /** Round the result of the division `up` or `down`. */
  round: "up" | "down";
};

/** Per-currency override of the price's amount, tiers and tax behavior. */
export type PriceCurrencyOption = {
  /** Amount charged in this currency, in its minor unit. */
  unitAmount?: number;
  /** Same as `unitAmount` but as a decimal string. */
  unitAmountDecimal?: string;
  /** Tax behavior for this currency. */
  taxBehavior?: PriceTaxBehavior;
  /** Tier bands for this currency (requires `billingScheme: "tiered"`). */
  tiers?: PriceTier[];
  /** Customer-chosen amount configuration for this currency. */
  customUnitAmount?: PriceCustomUnitAmount;
};

export type PriceProps = {
  /**
   * ID of the `Stripe.Product` this price belongs to. Pass
   * `product.productId`.
   *
   * Immutable — changing it **replaces** the price.
   */
  productId: string;
  /**
   * Three-letter lowercase ISO currency code (e.g. `"usd"`).
   *
   * Immutable — changing it **replaces** the price.
   */
  currency: string;
  /**
   * Amount to charge, as a positive integer in the currency's minor unit
   * (cents for USD), or `0` for a free price. Required unless
   * `unitAmountDecimal`, `customUnitAmount`, or `billingScheme: "tiered"` is
   * used.
   *
   * Immutable — changing it **replaces** the price.
   */
  unitAmount?: number;
  /**
   * Same as `unitAmount` but as a decimal string with up to 12 decimal
   * places — for sub-cent pricing. Only one of `unitAmount` and
   * `unitAmountDecimal` may be set.
   *
   * Immutable — changing it **replaces** the price.
   */
  unitAmountDecimal?: string;
  /**
   * Lets the customer name their own amount at checkout. Cannot be combined
   * with `unitAmount`/`unitAmountDecimal`.
   *
   * Immutable — changing it **replaces** the price.
   */
  customUnitAmount?: PriceCustomUnitAmount;
  /**
   * Makes this a subscription price. Omit for a one-time price.
   *
   * Immutable — changing any field of it **replaces** the price.
   */
  recurring?: PriceRecurring;
  /**
   * How the amount is computed.
   *
   * Defaults to `"tiered"` when `tiers` is supplied, otherwise `"per_unit"`.
   *
   * Immutable — changing it **replaces** the price.
   *
   * @default "per_unit"
   */
  billingScheme?: PriceBillingScheme;
  /**
   * Pricing tiers. Requires `billingScheme: "tiered"` (which Alchemy defaults
   * for you when this is set) and `tiersMode`. The last tier must use
   * `upTo: "inf"`.
   *
   * Immutable — changing it **replaces** the price.
   */
  tiers?: PriceTier[];
  /**
   * Whether tiering is `graduated` or `volume` based.
   *
   * Immutable — changing it **replaces** the price.
   */
  tiersMode?: PriceTiersMode;
  /**
   * Whether the amount is inclusive or exclusive of tax.
   *
   * Settable **once**: moving from `unspecified` (the default) to
   * `inclusive` or `exclusive` is an in-place update; every other transition
   * — including back to `unspecified` — **replaces** the price, because
   * Stripe refuses to change a locked-in value.
   *
   * @default "unspecified"
   */
  taxBehavior?: PriceTaxBehavior;
  /**
   * Divide the reported usage/quantity before computing the amount. Cannot be
   * combined with `tiers`.
   *
   * Immutable — changing it **replaces** the price.
   */
  transformQuantity?: PriceTransformQuantity;
  /**
   * Per-currency amounts, keyed by three-letter lowercase ISO currency code.
   * Mutable — updated in place.
   */
  currencyOptions?: Record<string, PriceCurrencyOption>;
  /**
   * A stable string (up to 200 chars) you can use to look this price up
   * instead of hard-coding its generated ID. Mutable — updated in place, and
   * cleared when removed.
   *
   * A lookup key may only be held by one price at a time; set
   * {@link PriceProps.transferLookupKey} to steal it from the price that
   * currently holds it.
   */
  lookupKey?: string;
  /**
   * Atomically move `lookupKey` off whichever price currently holds it and
   * onto this one, instead of failing with a conflict.
   *
   * @default false
   */
  transferLookupKey?: boolean;
  /**
   * Short internal description of the price, never shown to customers.
   * Mutable — updated in place, and cleared when removed.
   */
  nickname?: string;
  /**
   * Whether the price can be used for new purchases. Mutable — updated in
   * place. Destroying the resource sets this to `false`.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Arbitrary key/value pairs stored on the price. Mutable — keys you remove
   * are unset on the next deploy.
   *
   * Alchemy additionally writes reserved `alchemy_stack` / `alchemy_stage` /
   * `alchemy_id` entries to brand the price as owned by this stack; they are
   * stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type Price = Resource<
  "Stripe.Price",
  PriceProps,
  {
    /** Stripe's generated price ID (`price_...`). */
    priceId: string;
    /** ID of the product the price belongs to. */
    productId: string;
    /** Three-letter lowercase ISO currency code. */
    currency: string;
    /** Whether the price can be used for new purchases. */
    active: boolean;
    /** How the amount is computed. */
    billingScheme: PriceBillingScheme;
    /** `one_time` for a one-off charge, `recurring` for a subscription. */
    priceType: PriceType;
    /** Amount in the currency's minor unit, when representable as an integer. */
    unitAmount: number | undefined;
    /** Amount as a decimal string in the currency's minor unit. */
    unitAmountDecimal: string | undefined;
    /** Internal description of the price. */
    nickname: string | undefined;
    /** The stable lookup key currently held by this price. */
    lookupKey: string | undefined;
    /** Tax behavior, once Stripe has resolved one. */
    taxBehavior: PriceTaxBehavior | undefined;
    /** Whether tiering is `graduated` or `volume` based. */
    tiersMode: PriceTiersMode | undefined;
    /**
     * The resolved pricing tiers. Only populated for tiered prices — Alchemy
     * requests Stripe's `tiers` expansion on every read.
     */
    tiers: PriceTier[] | undefined;
    /** The resolved recurring configuration, for subscription prices. */
    recurring:
      | {
          interval: PriceInterval;
          intervalCount: number;
          usageType: PriceUsageType;
          meter: string | undefined;
          trialPeriodDays: number | undefined;
        }
      | undefined;
    /** The resolved quantity transformation. */
    transformQuantity: PriceTransformQuantity | undefined;
    /** The resolved customer-chosen amount configuration. */
    customUnitAmount:
      | {
          maximum: number | undefined;
          minimum: number | undefined;
          preset: number | undefined;
        }
      | undefined;
    /** The resolved per-currency amounts. */
    currencyOptions: Record<string, PriceCurrencyOption> | undefined;
    /** `true` when the price lives in live mode rather than test mode. */
    livemode: boolean;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
    /** User metadata, with Alchemy's reserved `alchemy_*` entries removed. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

type PriceAttributes = Price["Attributes"];

/**
 * A Stripe Price — the currency, amount and (optional) billing cycle attached
 * to a {@link https://docs.stripe.com/api/products | Product}. A product may
 * carry many prices (monthly, yearly, per-currency, per-tier); changing what
 * you charge means adding a price, not editing one.
 *
 * :::caution
 * **Stripe does not support deleting prices.** Destroying this resource
 * archives it by setting `active: false`. The price remains visible in the
 * Stripe dashboard and in `GET /v1/prices` forever, and existing
 * subscriptions that reference it keep billing. The archive call is
 * idempotent — an already-archived or already-missing price is a success.
 * :::
 *
 * :::caution
 * **Almost every field of a price is immutable.** `productId`, `currency`,
 * `unitAmount`, `unitAmountDecimal`, `customUnitAmount`, `recurring`,
 * `billingScheme`, `tiers`, `tiersMode` and `transformQuantity` can only be
 * changed by **replacing** the price: Alchemy creates a new price, points
 * dependents at it, and archives the old one — the price ID changes. Only
 * `active`, `nickname`, `lookupKey`, `currencyOptions`, `metadata`, and the
 * first assignment of `taxBehavior` are updated in place.
 * :::
 *
 * ### Creating a one-time price
 * **Example:** $20.00 charged once
 * ```typescript
 * const product = yield* Stripe.Product("pro", { name: "Pro" });
 *
 * const price = yield* Stripe.Price("pro-onetime", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 * ```
 *
 * ### Creating a subscription price
 * **Example:** $20.00 per month
 * ```typescript
 * const monthly = yield* Stripe.Price("pro-monthly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2000,
 *   recurring: { interval: "month" },
 * });
 * ```
 *
 * **Example:** Billed every 3 months, with a 14-day trial
 * ```typescript
 * const quarterly = yield* Stripe.Price("pro-quarterly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 5400,
 *   recurring: {
 *     interval: "month",
 *     intervalCount: 3,
 *     trialPeriodDays: 14,
 *   },
 *   nickname: "Pro quarterly",
 *   lookupKey: "pro_quarterly",
 * });
 * ```
 *
 * ### Usage-based and tiered pricing
 * **Example:** Metered price backed by a Stripe Meter
 * ```typescript
 * const meter = yield* Stripe.Meter("api-calls", {
 *   displayName: "API calls",
 *   eventName: "api_call",
 * });
 *
 * const metered = yield* Stripe.Price("api-usage", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmountDecimal: "0.0004",
 *   recurring: {
 *     interval: "month",
 *     usageType: "metered",
 *     meter: meter.meterId,
 *   },
 * });
 * ```
 *
 * **Example:** Graduated tiers — first 1,000 units free, then $0.01 each
 * ```typescript
 * const tiered = yield* Stripe.Price("api-tiered", {
 *   productId: product.productId,
 *   currency: "usd",
 *   billingScheme: "tiered",
 *   tiersMode: "graduated",
 *   tiers: [
 *     { upTo: 1000, unitAmount: 0 },
 *     { upTo: "inf", unitAmount: 1 },
 *   ],
 *   recurring: { interval: "month", usageType: "metered", meter: meter.meterId },
 * });
 * ```
 *
 * ### Multi-currency and tax
 * **Example:** One price, three currencies, tax-inclusive
 * ```typescript
 * const global = yield* Stripe.Price("pro-monthly-global", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2000,
 *   recurring: { interval: "month" },
 *   taxBehavior: "inclusive",
 *   currencyOptions: {
 *     eur: { unitAmount: 1800 },
 *     gbp: { unitAmount: 1600 },
 *   },
 * });
 * ```
 *
 * ### Retiring a price
 * **Example:** Archive the old price and roll customers onto a new one
 * ```typescript
 * // `active: false` keeps existing subscriptions billing but blocks new ones.
 * yield* Stripe.Price("pro-monthly-v1", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2000,
 *   recurring: { interval: "month" },
 *   active: false,
 * });
 *
 * // The lookup key moves to the replacement so application code is unchanged.
 * yield* Stripe.Price("pro-monthly-v2", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2500,
 *   recurring: { interval: "month" },
 *   lookupKey: "pro_monthly",
 *   transferLookupKey: true,
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/prices
 *
 * @resource
 */
export const Price = Resource<Price>("Stripe.Price");

/** Stripe returns at most 100 objects per page; cap the walk at 5,000. */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

/**
 * `tiers` and `currency_options` are expandable fields — Stripe omits them
 * from a price unless they are asked for by name, so every read/create/update
 * requests them or the corresponding attributes would always come back
 * `undefined` (and `currencyOptions` would read as permanent drift).
 */
const EXPAND = ["tiers", "currency_options"];
const LIST_EXPAND = ["data.tiers", "data.currency_options"];

export const PriceProvider = () =>
  Provider.succeed(Price, {
    // Every one of these is replacement-only (see `diff`), so none of them can
    // change across an update. `taxBehavior` is deliberately absent: it is
    // settable once, in place.
    stables: [
      "priceId",
      "productId",
      "currency",
      "priceType",
      "billingScheme",
      "unitAmount",
      "unitAmountDecimal",
      "recurring",
      "tiers",
      "tiersMode",
      "transformQuantity",
      "customUnitAmount",
      "livemode",
      "created",
    ],

    list: Effect.fn(function* () {
      const prices = yield* listPrices({});
      return prices.map(toAttrs);
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // Nothing deployed yet — the engine decides create vs. noop.
      if (!output) return undefined;

      const replace = { action: "replace" } as const;

      // `productId` and `currency` are unambiguous in both `olds` and the
      // observed attributes, so they can always be compared.
      if (news.productId !== (olds?.productId ?? output.productId)) {
        return replace;
      }
      const desiredCurrency = news.currency.toLowerCase();
      const priorCurrency = (olds?.currency ?? output.currency).toLowerCase();
      if (desiredCurrency !== priorCurrency) return replace;

      // `billingScheme` defaults to "tiered" whenever tiers are supplied, so
      // that a user who only sets `tiers` gets a valid create.
      if (billingSchemeOf(news) !== output.billingScheme) return replace;

      // Compare against the previously-declared recurring block when there is
      // one (defaults filled in on both sides), otherwise against what Stripe
      // reports — the observed shape already carries the resolved defaults.
      const priorRecurring =
        olds !== undefined
          ? normalizeRecurring(olds.recurring)
          : output.recurring;
      if (!canonicalEqual(normalizeRecurring(news.recurring), priorRecurring)) {
        return replace;
      }

      if ((news.tiersMode ?? undefined) !== (output.tiersMode ?? undefined)) {
        return replace;
      }

      if (!canonicalEqual(news.transformQuantity, output.transformQuantity)) {
        return replace;
      }

      // Stripe echoes `custom_unit_amount` back without the `enabled` flag, so
      // compare the bounds against the observed object and treat "absent" as
      // "not enabled".
      const desiredCustom = news.customUnitAmount?.enabled
        ? {
            maximum: news.customUnitAmount.maximum,
            minimum: news.customUnitAmount.minimum,
            preset: news.customUnitAmount.preset,
          }
        : undefined;
      if (!canonicalEqual(desiredCustom, output.customUnitAmount)) {
        return replace;
      }

      // Amounts and tiers are compared **declared-to-declared** whenever a
      // prior generation of props exists, because Stripe derives the fields
      // the caller left out — supplying `unitAmount: 2000` comes back with
      // `unit_amount_decimal: "2000"` as well, and a naive observed-vs-desired
      // comparison would read that as drift and replace the price forever.
      // Without `olds` (an adoption) only explicitly-declared values are
      // checked, and `tiers` is skipped entirely.
      if (olds !== undefined) {
        if (news.unitAmount !== olds.unitAmount) return replace;
        if (news.unitAmountDecimal !== olds.unitAmountDecimal) return replace;
        if (!canonicalEqual(news.tiers, olds.tiers)) return replace;
      } else {
        if (
          news.unitAmount !== undefined &&
          news.unitAmount !== output.unitAmount
        ) {
          return replace;
        }
        if (
          news.unitAmountDecimal !== undefined &&
          news.unitAmountDecimal !== output.unitAmountDecimal
        ) {
          return replace;
        }
      }

      // `taxBehavior` is settable exactly once. `unspecified` -> a real value
      // is an in-place update; anything else is locked and needs a new price.
      const observedTax = output.taxBehavior ?? "unspecified";
      const desiredTax = news.taxBehavior ?? "unspecified";
      if (desiredTax !== observedTax) {
        return observedTax === "unspecified"
          ? ({ action: "update" } as const)
          : replace;
      }

      // Everything else (active, nickname, lookupKey, currencyOptions,
      // metadata) is mutable — let the engine's default prop diff decide.
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.priceId) {
        const price = yield* getPrice(output.priceId);
        if (!price) return undefined;
        const attrs = toAttrs(price);
        return (yield* isOwned(id, toMetadata(price.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss: a price has no natural key, so re-discovery relies on the
      // `alchemy_*` metadata branding. Scope the scan to the product we last
      // deployed against — without one this would be an unbounded scan of
      // every price in the account on every greenfield create.
      const productId = olds?.productId;
      if (!productId) return undefined;
      const candidates = yield* listPrices({ product: productId });
      for (const candidate of candidates) {
        if (yield* isOwned(id, toMetadata(candidate.metadata))) {
          return toAttrs(candidate);
        }
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const metadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output.priceId` is a cache of the identifier, never
      //    proof the price still exists.
      const observed = output?.priceId
        ? yield* getPrice(output.priceId)
        : undefined;

      // 2. Ensure — create the price when it is missing. Everything
      //    replacement-only is only ever sent here.
      if (!observed) {
        const created = yield* PostPrices({
          product: news.productId,
          currency: news.currency,
          active: news.active ?? true,
          unit_amount: news.unitAmount,
          unit_amount_decimal: news.unitAmountDecimal,
          custom_unit_amount: news.customUnitAmount,
          billing_scheme: billingSchemeOf(news),
          recurring: news.recurring
            ? {
                interval: news.recurring.interval,
                interval_count: news.recurring.intervalCount,
                usage_type: news.recurring.usageType,
                meter: news.recurring.meter,
                trial_period_days: news.recurring.trialPeriodDays,
              }
            : undefined,
          tiers: tiersRequest(news.tiers),
          tiers_mode: news.tiersMode,
          tax_behavior: news.taxBehavior,
          transform_quantity: news.transformQuantity
            ? {
                divide_by: news.transformQuantity.divideBy,
                round: news.transformQuantity.round,
              }
            : undefined,
          currency_options: currencyOptionsRequest(news.currencyOptions),
          lookup_key: news.lookupKey,
          transfer_lookup_key:
            news.lookupKey !== undefined ? news.transferLookupKey : undefined,
          nickname: news.nickname,
          metadata,
          expand: EXPAND,
        });
        return toAttrs(created);
      }

      // 3. Sync — converge only the mutable aspects, diffing against what the
      //    cloud actually reports.
      const desiredActive = news.active ?? true;
      const observedNickname = observed.nickname ?? undefined;
      const observedLookupKey = observed.lookup_key ?? undefined;
      const observedTax = observed.tax_behavior ?? "unspecified";
      const observedMetadata = toMetadata(observed.metadata);

      const nicknameChanged = observedNickname !== news.nickname;
      const lookupKeyChanged = observedLookupKey !== news.lookupKey;
      const activeChanged = observed.active !== desiredActive;
      const metadataChanged = !metadataEqual(observedMetadata, metadata);
      // Stripe only accepts the first assignment of tax_behavior; a later
      // change was already planned as a replacement by `diff`.
      const taxChanged =
        news.taxBehavior !== undefined &&
        news.taxBehavior !== "unspecified" &&
        observedTax === "unspecified";
      // Per-currency amounts suffer the same derived-field problem as the
      // top-level amount, so the value comparison runs declared-to-declared
      // and only the *key set* is checked against the cloud (which catches a
      // currency added or dropped out of band).
      const currencyOptionsChanged =
        !canonicalEqual(news.currencyOptions, olds?.currencyOptions) ||
        !sameKeys(news.currencyOptions, observed.currency_options);

      if (
        !activeChanged &&
        !nicknameChanged &&
        !lookupKeyChanged &&
        !taxChanged &&
        !metadataChanged &&
        !currencyOptionsChanged
      ) {
        return toAttrs(observed);
      }

      const updated = yield* PostPricesPrice({
        price: observed.id,
        active: activeChanged ? desiredActive : undefined,
        // Stripe unsets an optional string by posting an empty value.
        nickname: nicknameChanged ? (news.nickname ?? "") : undefined,
        lookup_key: lookupKeyChanged ? (news.lookupKey ?? "") : undefined,
        transfer_lookup_key:
          lookupKeyChanged && news.lookupKey !== undefined
            ? news.transferLookupKey
            : undefined,
        tax_behavior: taxChanged ? news.taxBehavior : undefined,
        currency_options: currencyOptionsChanged
          ? (currencyOptionsRequest(news.currencyOptions) ?? "")
          : undefined,
        metadata: metadataChanged
          ? metadataUpdate(observedMetadata, metadata)
          : undefined,
        expand: EXPAND,
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Stripe has no DELETE /v1/prices/{id}. Archiving is the closest thing,
      // and it is idempotent: archiving an archived price is a no-op, and a
      // price that has vanished is already in the desired state.
      yield* PostPricesPrice({ price: output.priceId, active: false }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing"
            ? Effect.succeed(undefined)
            : Effect.fail(e),
        ),
      );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a price by ID, mapping "no such price" onto `undefined`.
 *
 * Stripe reports a missing object as `invalid_request_error` /
 * `resource_missing` with HTTP 404; distilled dispatches on the Stripe error
 * `type` before the status, so it can surface as either `NotFound` or
 * `InvalidRequestError`. Both are handled.
 */
const getPrice = (priceId: string) =>
  GetPricesPrice({ price: priceId, expand: EXPAND }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Walk `GET /v1/prices` with Stripe's `starting_after` cursor, bounded to
 * {@link MAX_PAGES} pages. Returns active and archived prices alike.
 */
const listPrices = (filter: { product?: string }) =>
  Effect.gen(function* () {
    const prices: StripePrice[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetPrices({
        limit: PAGE_SIZE,
        expand: LIST_EXPAND,
        ...(filter.product !== undefined ? { product: filter.product } : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      prices.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return prices;
  });

// ---------------------------------------------------------------------------
// Props -> request mapping
// ---------------------------------------------------------------------------

const billingSchemeOf = (props: {
  billingScheme?: PriceBillingScheme;
  tiers?: PriceTier[];
}): PriceBillingScheme =>
  props.billingScheme ?? (props.tiers !== undefined ? "tiered" : "per_unit");

const tiersRequest = (
  tiers: PriceTier[] | undefined,
): PostPricesRequestTiersList | undefined =>
  tiers?.map((tier) => ({
    up_to: tier.upTo,
    unit_amount: tier.unitAmount,
    unit_amount_decimal: tier.unitAmountDecimal,
    flat_amount: tier.flatAmount,
    flat_amount_decimal: tier.flatAmountDecimal,
  }));

const currencyOptionsRequest = (
  options: Record<string, PriceCurrencyOption> | undefined,
): PostPricesRequestCurrencyOptionsMap | undefined =>
  options === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(options).map(([code, option]) => [
          code,
          {
            unit_amount: option.unitAmount,
            unit_amount_decimal: option.unitAmountDecimal,
            tax_behavior: option.taxBehavior,
            tiers: tiersRequest(option.tiers),
            custom_unit_amount: option.customUnitAmount,
          },
        ]),
      );

// ---------------------------------------------------------------------------
// Response -> attributes mapping
// ---------------------------------------------------------------------------

/**
 * `price.product` is a bare ID unless the caller expanded it, in which case
 * it is the (possibly deleted) product object.
 */
const productIdOf = (product: StripePrice["product"]): string =>
  typeof product === "string" ? product : product.id;

/** Drop `undefined` values so the map satisfies `Record<string, string>`. */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const toTier = (tier: {
  up_to: number | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  flat_amount: number | null;
  flat_amount_decimal: string | null;
}): PriceTier => ({
  // Stripe encodes the open-ended fallback tier as a null upper bound.
  upTo: tier.up_to ?? "inf",
  unitAmount: tier.unit_amount ?? undefined,
  unitAmountDecimal: tier.unit_amount_decimal ?? undefined,
  flatAmount: tier.flat_amount ?? undefined,
  flatAmountDecimal: tier.flat_amount_decimal ?? undefined,
});

const toAttrs = (price: StripePrice): PriceAttributes => ({
  priceId: price.id,
  productId: productIdOf(price.product),
  currency: price.currency,
  active: price.active,
  billingScheme: price.billing_scheme,
  priceType: price.type,
  unitAmount: price.unit_amount ?? undefined,
  unitAmountDecimal: price.unit_amount_decimal ?? undefined,
  nickname: price.nickname ?? undefined,
  lookupKey: price.lookup_key ?? undefined,
  taxBehavior: price.tax_behavior ?? undefined,
  tiersMode: price.tiers_mode ?? undefined,
  tiers: price.tiers?.map(toTier),
  recurring: price.recurring
    ? {
        interval: price.recurring.interval,
        intervalCount: price.recurring.interval_count,
        usageType: price.recurring.usage_type,
        meter: price.recurring.meter ?? undefined,
        trialPeriodDays: price.recurring.trial_period_days ?? undefined,
      }
    : undefined,
  transformQuantity: price.transform_quantity
    ? {
        divideBy: price.transform_quantity.divide_by,
        round: price.transform_quantity.round,
      }
    : undefined,
  customUnitAmount: price.custom_unit_amount
    ? {
        maximum: price.custom_unit_amount.maximum ?? undefined,
        minimum: price.custom_unit_amount.minimum ?? undefined,
        preset: price.custom_unit_amount.preset ?? undefined,
      }
    : undefined,
  currencyOptions: price.currency_options
    ? Object.fromEntries(
        Object.entries(price.currency_options).flatMap(([code, option]) =>
          option === undefined
            ? []
            : [
                [
                  code,
                  {
                    unitAmount: option.unit_amount ?? undefined,
                    unitAmountDecimal: option.unit_amount_decimal ?? undefined,
                    taxBehavior: option.tax_behavior ?? undefined,
                    tiers: option.tiers?.map(toTier),
                    customUnitAmount: option.custom_unit_amount
                      ? {
                          enabled: true,
                          maximum:
                            option.custom_unit_amount.maximum ?? undefined,
                          minimum:
                            option.custom_unit_amount.minimum ?? undefined,
                          preset: option.custom_unit_amount.preset ?? undefined,
                        }
                      : undefined,
                  } satisfies PriceCurrencyOption,
                ],
              ],
        ),
      )
    : undefined,
  livemode: price.livemode,
  created: price.created,
  metadata: stripInternalMetadata(toMetadata(price.metadata)),
});

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

const normalizeRecurring = (recurring: PriceRecurring | undefined) =>
  recurring === undefined
    ? undefined
    : {
        interval: recurring.interval,
        intervalCount: recurring.intervalCount ?? 1,
        usageType: recurring.usageType ?? "licensed",
        meter: recurring.meter,
        trialPeriodDays: recurring.trialPeriodDays,
      };

/**
 * Canonical form used for structural comparison: `undefined` collapses onto
 * `null`, absent keys are dropped, and object keys are sorted so two equal
 * values always stringify identically.
 */
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Whether two maps carry exactly the same set of keys. */
const sameKeys = (
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean => {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
};
