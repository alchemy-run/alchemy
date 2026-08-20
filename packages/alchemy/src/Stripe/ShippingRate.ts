import {
  GetShippingRates,
  GetShippingRatesShippingRateToken,
  PostShippingRates,
  PostShippingRatesShippingRateToken,
  type PostShippingRatesShippingRateTokenRequest,
  type ShippingRate as StripeShippingRate,
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
 * The type of calculation used by the shipping rate. Stripe currently only
 * supports `fixed_amount`.
 */
export type ShippingRateType = "fixed_amount" | (string & {});

/**
 * Whether the shipping rate is considered inclusive of taxes, exclusive of
 * taxes, or unspecified.
 */
export type ShippingRateTaxBehavior = "exclusive" | "inclusive" | "unspecified";

/** A unit of time used by a delivery estimate bound. */
export type ShippingRateDeliveryUnit =
  | "business_day"
  | "day"
  | "hour"
  | "month"
  | "week";

/** One end of a delivery estimate range. */
export type ShippingRateDeliveryBound = {
  /** The unit of time. */
  unit: ShippingRateDeliveryUnit;
  /** Number of `unit`s. Must be greater than 0. */
  value: number;
};

/**
 * The estimated range for how long shipping takes. Shown to the customer on
 * Checkout Sessions.
 */
export type ShippingRateDeliveryEstimate = {
  /** Lower bound of the range. Omit for no lower bound. */
  minimum?: ShippingRateDeliveryBound;
  /** Upper bound of the range. Omit for an open-ended (infinite) estimate. */
  maximum?: ShippingRateDeliveryBound;
};

/** A per-currency override of the shipping amount. */
export type ShippingRateCurrencyOption = {
  /** Non-negative integer in the currency's minor unit (e.g. cents). */
  amount: number;
  /** Tax behavior for this currency. */
  taxBehavior?: ShippingRateTaxBehavior;
};

/** A fixed shipping charge, with optional per-currency overrides. */
export type ShippingRateFixedAmount = {
  /**
   * Non-negative integer in the currency's minor unit (e.g. `1500` for
   * $15.00). Cannot be changed after creation.
   */
  amount: number;
  /**
   * Three-letter lowercase ISO currency code. Cannot be changed after
   * creation.
   */
  currency: string;
  /**
   * Additional amounts keyed by three-letter lowercase ISO currency code.
   * Currency options can be added and updated in place; **removing** one
   * requires replacing the shipping rate.
   */
  currencyOptions?: Record<string, ShippingRateCurrencyOption>;
};

export type ShippingRateProps = {
  /**
   * Customer-facing name of the shipping rate, shown on Checkout Sessions.
   *
   * Stripe's update endpoint does not accept a new display name, so changing
   * it **replaces** the shipping rate.
   */
  displayName: string;
  /**
   * The type of calculation to use. Stripe only supports `fixed_amount`.
   * Changing it **replaces** the shipping rate.
   *
   * @default "fixed_amount"
   */
  type?: ShippingRateType;
  /**
   * The fixed amount to charge. Required when `type` is `fixed_amount`
   * (the default). `amount` and `currency` are fixed at creation time —
   * changing either **replaces** the shipping rate — while
   * `currencyOptions` is updated in place.
   */
  fixedAmount?: ShippingRateFixedAmount;
  /**
   * Estimated delivery window shown to the customer. Stripe's update
   * endpoint does not accept it, so changing it **replaces** the shipping
   * rate.
   */
  deliveryEstimate?: ShippingRateDeliveryEstimate;
  /**
   * Whether the rate is inclusive of taxes, exclusive of taxes, or
   * unspecified.
   *
   * Settable once: while Stripe reports `unspecified` this can be set in
   * place, but once it is `inclusive` or `exclusive` any change
   * **replaces** the shipping rate.
   */
  taxBehavior?: ShippingRateTaxBehavior;
  /**
   * Stripe tax code ID to use for the shipping charge — the shipping tax
   * code is `txcd_92010001`. Changing it **replaces** the shipping rate.
   */
  taxCode?: string;
  /**
   * Whether the shipping rate can be used for new purchases. Archived
   * (`false`) rates keep working for objects that already reference them.
   *
   * @default true
   */
  active?: boolean;
  /**
   * User metadata attached to the shipping rate. Alchemy additionally
   * writes three reserved `alchemy_*` keys used for ownership tracking;
   * those are stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type ShippingRate = Resource<
  "Stripe.ShippingRate",
  ShippingRateProps,
  {
    /** The Stripe shipping rate ID (`shr_…`). */
    shippingRateId: string;
    /** Customer-facing name of the shipping rate. */
    displayName: string | undefined;
    /** The type of calculation used. */
    type: ShippingRateType;
    /** Whether the rate can be used for new purchases. */
    active: boolean;
    /** The fixed amount charged, including any currency overrides. */
    fixedAmount: ShippingRateFixedAmount | undefined;
    /** The estimated delivery window shown to the customer. */
    deliveryEstimate: ShippingRateDeliveryEstimate | undefined;
    /** Whether the rate is inclusive/exclusive of taxes. */
    taxBehavior: ShippingRateTaxBehavior | undefined;
    /** The Stripe tax code ID applied to the shipping charge. */
    taxCode: string | undefined;
    /** Whether the object lives in live mode. */
    livemode: boolean;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
    /** User metadata, with alchemy's reserved keys removed. */
    metadata: Metadata;
  },
  never,
  Providers
>;

type ShippingRateAttributes = ShippingRate["Attributes"];

/**
 * A Stripe shipping rate describing the price of shipping presented to
 * customers on Checkout Sessions, Payment Links and invoices.
 *
 * Most of a shipping rate is immutable: Stripe's update endpoint only
 * accepts `active`, `metadata`, `tax_behavior` and
 * `fixed_amount.currency_options`. Changing `displayName`, `type`,
 * `fixedAmount.amount`, `fixedAmount.currency`, `deliveryEstimate` or
 * `taxCode` therefore replaces the shipping rate with a new one.
 *
 * :::caution
 * Stripe does not support deleting a shipping rate. Destroying this
 * resource archives it (`active: false`) instead; the object remains
 * visible in the dashboard and in list calls, and keeps working for
 * sessions and invoices that already reference it.
 * :::
 *
 * ### Creating a Shipping Rate
 * **Example:** Flat-rate shipping
 * ```typescript
 * const standard = yield* Stripe.ShippingRate("standard-shipping", {
 *   displayName: "Standard shipping",
 *   fixedAmount: { amount: 500, currency: "usd" },
 * });
 * ```
 *
 * **Example:** Fully configured rate with a delivery estimate
 * ```typescript
 * const express = yield* Stripe.ShippingRate("express-shipping", {
 *   displayName: "Express shipping",
 *   type: "fixed_amount",
 *   fixedAmount: {
 *     amount: 1500,
 *     currency: "usd",
 *     currencyOptions: {
 *       eur: { amount: 1400, taxBehavior: "exclusive" },
 *     },
 *   },
 *   deliveryEstimate: {
 *     minimum: { unit: "business_day", value: 1 },
 *     maximum: { unit: "business_day", value: 2 },
 *   },
 *   taxBehavior: "exclusive",
 *   taxCode: "txcd_92010001",
 *   metadata: { tier: "express" },
 * });
 * ```
 *
 * ### Archiving a Shipping Rate
 * **Example:** Retire a rate without deleting it
 * ```typescript
 * const legacy = yield* Stripe.ShippingRate("legacy-shipping", {
 *   displayName: "Legacy shipping",
 *   fixedAmount: { amount: 500, currency: "usd" },
 *   active: false,
 * });
 * ```
 *
 * ### Combining with other Stripe resources
 * **Example:** Pair a shipping rate with a tax rate
 * ```typescript
 * const shipping = yield* Stripe.ShippingRate("standard-shipping", {
 *   displayName: "Standard shipping",
 *   fixedAmount: { amount: 500, currency: "usd" },
 *   taxBehavior: "exclusive",
 *   taxCode: "txcd_92010001",
 * });
 * const vat = yield* Stripe.TaxRate("vat", {
 *   displayName: "VAT",
 *   percentage: 20,
 *   inclusive: false,
 *   country: "GB",
 * });
 *
 * return {
 *   shippingRateId: shipping.shippingRateId,
 *   taxRateId: vat.taxRateId,
 * };
 * ```
 *
 * @see https://docs.stripe.com/api/shipping_rates
 *
 * @resource
 */
export const ShippingRate = Resource<ShippingRate>("Stripe.ShippingRate");

export const ShippingRateProvider = () =>
  Provider.succeed(ShippingRate, {
    stables: [
      "shippingRateId",
      "displayName",
      "type",
      "deliveryEstimate",
      "taxCode",
      "created",
      "livemode",
    ],
    list: Effect.fn(function* () {
      const rates = yield* listAllShippingRates;
      return rates.map(shippingRateAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` is `Input<Props>` during plan — bail out until it resolves.
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;

      if (news.displayName !== output.displayName) {
        return { action: "replace" } as const;
      }
      if ((news.type ?? "fixed_amount") !== output.type) {
        return { action: "replace" } as const;
      }
      // Only `currency_options` is mutable on `fixed_amount`; the base
      // amount and currency are fixed for the object's lifetime.
      if (
        news.fixedAmount?.amount !== output.fixedAmount?.amount ||
        news.fixedAmount?.currency !== output.fixedAmount?.currency
      ) {
        return { action: "replace" } as const;
      }
      if (
        !deliveryEstimateEqual(news.deliveryEstimate, output.deliveryEstimate)
      ) {
        return { action: "replace" } as const;
      }
      if (news.taxCode !== undefined && news.taxCode !== output.taxCode) {
        return { action: "replace" } as const;
      }
      // `tax_behavior` is settable-once: Stripe accepts it while the rate is
      // still `unspecified`, and rejects any later change.
      if (
        news.taxBehavior !== undefined &&
        news.taxBehavior !== output.taxBehavior &&
        (output.taxBehavior === "inclusive" ||
          output.taxBehavior === "exclusive")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.shippingRateId) {
        const observed = yield* observeShippingRate(output.shippingRateId);
        if (!observed) return undefined;
        const attrs = shippingRateAttributes(observed);
        return (yield* isOwned(id, toMetadata(observed.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss: re-discover the object we previously created by its
      // alchemy metadata branding rather than creating a duplicate.
      const rates = yield* listAllShippingRates;
      for (const rate of rates) {
        if (yield* isOwned(id, toMetadata(rate.metadata))) {
          return shippingRateAttributes(rate);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // Observe — the cached id is a hint, not proof the object still exists.
      const observed = output?.shippingRateId
        ? yield* observeShippingRate(output.shippingRateId)
        : undefined;

      // Ensure — nothing live, so create it.
      if (!observed) {
        const created = yield* PostShippingRates({
          display_name: news.displayName,
          type: news.type ?? "fixed_amount",
          fixed_amount: news.fixedAmount
            ? {
                amount: news.fixedAmount.amount,
                currency: news.fixedAmount.currency,
                ...(news.fixedAmount.currencyOptions
                  ? {
                      currency_options: toWireCurrencyOptions(
                        news.fixedAmount.currencyOptions,
                      ),
                    }
                  : {}),
              }
            : undefined,
          delivery_estimate: news.deliveryEstimate
            ? {
                ...(news.deliveryEstimate.minimum
                  ? { minimum: news.deliveryEstimate.minimum }
                  : {}),
                ...(news.deliveryEstimate.maximum
                  ? { maximum: news.deliveryEstimate.maximum }
                  : {}),
              }
            : undefined,
          tax_behavior: news.taxBehavior,
          tax_code: news.taxCode,
          metadata: desiredMetadata,
        });
        // Stripe defaults `active` to true and the create call has no
        // `active` parameter — archive immediately when the user asked for
        // an inactive rate.
        if ((news.active ?? true) === false) {
          const archived = yield* PostShippingRatesShippingRateToken({
            shipping_rate_token: created.id,
            active: false,
          });
          return shippingRateAttributes(archived);
        }
        return shippingRateAttributes(created);
      }

      // Sync — diff desired against OBSERVED cloud state and send only the
      // delta; skip the API call entirely when nothing drifted.
      const update: PostShippingRatesShippingRateTokenRequest = {
        shipping_rate_token: observed.id,
      };
      let changed = false;

      const desiredActive = news.active ?? true;
      if (desiredActive !== observed.active) {
        update.active = desiredActive;
        changed = true;
      }

      // Settable-once: only send it while Stripe still reports the rate as
      // unspecified. A change away from a set value is a replacement, which
      // `diff` has already planned.
      if (
        news.taxBehavior !== undefined &&
        news.taxBehavior !== observed.tax_behavior &&
        (observed.tax_behavior === null ||
          observed.tax_behavior === "unspecified")
      ) {
        update.tax_behavior = news.taxBehavior;
        changed = true;
      }

      // Currency options are additive: Stripe has no way to remove one, so
      // only entries present in the desired map are pushed. Dropping a
      // currency option requires replacing the shipping rate.
      const desiredOptions = news.fixedAmount?.currencyOptions ?? {};
      const observedOptions = observed.fixed_amount?.currency_options ?? {};
      const optionDelta: Record<
        string,
        { amount: number; tax_behavior?: ShippingRateTaxBehavior }
      > = {};
      let optionsChanged = false;
      for (const [currency, option] of Object.entries(desiredOptions)) {
        const current = observedOptions[currency];
        if (
          current === undefined ||
          current.amount !== option.amount ||
          (option.taxBehavior !== undefined &&
            current.tax_behavior !== option.taxBehavior)
        ) {
          optionDelta[currency] = {
            amount: option.amount,
            ...(option.taxBehavior !== undefined
              ? { tax_behavior: option.taxBehavior }
              : {}),
          };
          optionsChanged = true;
        }
      }
      if (optionsChanged) {
        update.fixed_amount = { currency_options: optionDelta };
        changed = true;
      }

      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
        changed = true;
      }

      if (!changed) return shippingRateAttributes(observed);
      const updated = yield* PostShippingRatesShippingRateToken(update);
      return shippingRateAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Shipping rates cannot be deleted — archive instead. Idempotent: an
      // already-archived or already-missing rate is success.
      yield* PostShippingRatesShippingRateToken({
        shipping_rate_token: output.shippingRateId,
        active: false,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * Read a shipping rate by ID, mapping "missing" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled currently dispatches on the
 * Stripe `type` before the status — so the failure can surface as either
 * `NotFound` or `InvalidRequestError`. Both are handled.
 */
const observeShippingRate = (shippingRateId: string) =>
  GetShippingRatesShippingRateToken({
    shipping_rate_token: shippingRateId,
  }).pipe(
    Effect.map((rate): StripeShippingRate | undefined => rate),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/** Hard cap on pagination so a runaway cursor can never spin forever. */
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

/**
 * Exhaustively enumerate every shipping rate on the account (active and
 * archived), following Stripe's `starting_after` cursor while `has_more`.
 */
const listAllShippingRates = Effect.gen(function* () {
  const rates: StripeShippingRate[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetShippingRates({
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    rates.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return rates;
});

/**
 * Normalize Stripe's `{ [key: string]: string | undefined }` metadata map
 * onto the dense `Record<string, string>` alchemy diffs against.
 */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const toWireCurrencyOptions = (
  options: Record<string, ShippingRateCurrencyOption>,
): Record<
  string,
  { amount: number; tax_behavior?: ShippingRateTaxBehavior }
> => {
  const out: Record<
    string,
    { amount: number; tax_behavior?: ShippingRateTaxBehavior }
  > = {};
  for (const [currency, option] of Object.entries(options)) {
    out[currency] = {
      amount: option.amount,
      ...(option.taxBehavior !== undefined
        ? { tax_behavior: option.taxBehavior }
        : {}),
    };
  }
  return out;
};

const boundEqual = (
  a: ShippingRateDeliveryBound | undefined,
  b: ShippingRateDeliveryBound | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.unit === b.unit && a.value === b.value;
};

const deliveryEstimateEqual = (
  a: ShippingRateDeliveryEstimate | undefined,
  b: ShippingRateDeliveryEstimate | undefined,
): boolean =>
  boundEqual(a?.minimum, b?.minimum) && boundEqual(a?.maximum, b?.maximum);

/**
 * `tax_code` is an expandable reference — Stripe returns the bare ID unless
 * the caller expanded it, in which case it is the full `TaxCode` object.
 */
const taxCodeId = (
  taxCode: StripeShippingRate["tax_code"],
): string | undefined => {
  if (taxCode === null || taxCode === undefined) return undefined;
  return typeof taxCode === "string" ? taxCode : taxCode.id;
};

const shippingRateAttributes = (
  rate: StripeShippingRate,
): ShippingRateAttributes => ({
  shippingRateId: rate.id,
  displayName: rate.display_name ?? undefined,
  type: rate.type,
  active: rate.active,
  fixedAmount: rate.fixed_amount
    ? {
        amount: rate.fixed_amount.amount,
        currency: rate.fixed_amount.currency,
        ...(rate.fixed_amount.currency_options
          ? {
              currencyOptions: Object.fromEntries(
                Object.entries(rate.fixed_amount.currency_options).flatMap(
                  ([currency, option]) =>
                    option === undefined
                      ? []
                      : [
                          [
                            currency,
                            {
                              amount: option.amount,
                              taxBehavior: option.tax_behavior,
                            },
                          ] as const,
                        ],
                ),
              ),
            }
          : {}),
      }
    : undefined,
  deliveryEstimate: rate.delivery_estimate
    ? {
        ...(rate.delivery_estimate.minimum
          ? { minimum: rate.delivery_estimate.minimum }
          : {}),
        ...(rate.delivery_estimate.maximum
          ? { maximum: rate.delivery_estimate.maximum }
          : {}),
      }
    : undefined,
  taxBehavior: rate.tax_behavior ?? undefined,
  taxCode: taxCodeId(rate.tax_code),
  livemode: rate.livemode,
  created: rate.created,
  metadata: stripInternalMetadata(toMetadata(rate.metadata)),
});
