import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPrices,
  GetPrice,
  CreatePrice,
  UpdatePrice,
  type Price as StripePrice,
  type PriceProduct,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import { isMissingStripeResource } from "./missing.ts";
import type { Product } from "./Product.ts";
import type { Providers } from "./Providers.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export type PriceInterval = "day" | "month" | "week" | "year";
export type PriceUsageType = "licensed" | "metered";
export type PriceType = "one_time" | "recurring";
export type PriceTaxBehavior = "exclusive" | "inclusive" | "unspecified";
export type PriceTiersMode = "graduated" | "volume";

export interface PriceTier {
  /**
   * Inclusive upper bound of the tier in units. The last tier uses
   * `"inf"`.
   */
  upTo: number | "inf";
  /**
   * Per-unit amount in the currency's minor units for units in this tier.
   */
  unitAmount?: number;
  /**
   * Flat amount in the currency's minor units added once for this tier.
   */
  flatAmount?: number;
}

export interface PriceRecurring {
  /**
   * Billing frequency. Create-only — changing it replaces the price.
   */
  interval: PriceInterval;
  /**
   * Number of intervals between billings. Maximum of three years
   * (`3` years, `36` months, or `156` weeks).
   * @default 1
   */
  intervalCount?: number;
  /**
   * How quantity per period is determined. `licensed` bills the
   * subscription quantity; `metered` aggregates usage records.
   * @default "licensed"
   */
  usageType?: PriceUsageType;
  /**
   * Meter that tracks usage for a metered price. Create-only.
   */
  meter?: string;
  /**
   * Default trial length (days) when subscribing with
   * `trial_from_plan=true`. Create-only.
   */
  trialPeriodDays?: number;
}

export interface PriceProps {
  /**
   * Stripe Product this price belongs to — the resource, or a `prod_…`
   * id. Create-only — changing it replaces the price.
   */
  product: string | Product;
  /**
   * Three-letter ISO currency code, lowercase (e.g. `"usd"`). Create-only
   * — changing it replaces the price.
   */
  currency: string;
  /**
   * Amount in the currency's minor units (e.g. cents). Required unless
   * `unitAmountDecimal` is set or the price is tiered. Create-only —
   * changing it replaces the price.
   */
  unitAmount?: number;
  /**
   * Decimal amount in the currency's minor units, at most 12 decimal
   * places. Mutually exclusive with `unitAmount`. Create-only.
   */
  unitAmountDecimal?: string;
  /**
   * Recurring billing configuration. Omit for a one-time price.
   * Create-only — changing it replaces the price.
   */
  recurring?: PriceRecurring;
  /**
   * Pricing tiers, which make the price tiered (`billing_scheme=tiered`)
   * instead of `unitAmount`. Requires `tiersMode`. Create-only — changing
   * them replaces the price.
   */
  tiers?: PriceTier[];
  /**
   * How `tiers` apply: `volume` prices every unit at the tier the total
   * quantity reaches, `graduated` prices each unit at the tier it falls
   * in. Create-only — changing it replaces the price.
   */
  tiersMode?: PriceTiersMode;
  /**
   * Whether the price's amounts include tax (`inclusive`) or Stripe Tax
   * adds it on top (`exclusive`). An `unspecified` price takes a new value
   * in place; changing an `inclusive` or `exclusive` price replaces it.
   * If omitted, the price keeps its current tax behavior.
   */
  taxBehavior?: PriceTaxBehavior;
  /**
   * Brief description of the price, hidden from customers.
   */
  nickname?: string;
  /**
   * Whether the price can be used for new purchases.
   * @default true
   */
  active?: boolean;
  /**
   * Lookup key used to retrieve this price from a static string (max 200
   * characters).
   */
  lookupKey?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Price = Resource<
  "Stripe.Price",
  PriceProps,
  {
    /** Stripe price id (`price_…`). */
    id: string;
    /** Id of the product this price belongs to. */
    product: string;
    /** Three-letter ISO currency code. */
    currency: string;
    /** Amount in the currency's minor units, or `undefined` when unset. */
    unitAmount: number | undefined;
    /** Decimal amount in the currency's minor units, or `undefined`. */
    unitAmountDecimal: string | undefined;
    /** Whether the price can be used for new purchases. */
    active: boolean;
    /** Brief description of the price, hidden from customers. */
    nickname: string | undefined;
    /** Lookup key, if set. */
    lookupKey: string | undefined;
    /** `one_time` or `recurring`. */
    type: PriceType;
    /** Recurring billing configuration, if this is a recurring price. */
    recurring: PriceRecurring | undefined;
    /** Pricing tiers, if the price is tiered. */
    tiers: PriceTier[] | undefined;
    /** How tiers apply, if the price is tiered. */
    tiersMode: PriceTiersMode | undefined;
    /** Whether the amount includes tax, if specified. */
    taxBehavior: PriceTaxBehavior | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the price was created. */
    created: number;
    /** Whether the price exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  PriceLookup
>;

/**
 * Props for {@link Price.lookup}: find a price this stack
 * doesn't manage by its id.
 */
export interface PriceLookup {
  /** Stripe price id, e.g. `"price_1A2b3C4d5E6f7G8h"`. */
  id: string;
}

/**
 * A Stripe Price — the unit cost attached to a Product. Currency, amount,
 * product, recurring interval, and tiers are immutable (changing them
 * replaces the price). Nickname, metadata, lookup key, and `active` update
 * in place, and so does tax behavior while it is still `unspecified`. Prices cannot be deleted; destroy deactivates
 * them (`active=false`).
 *
 * @see https://docs.stripe.com/api/prices
 *
 * ### Creating a Price
 * **Example:** One-time price
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const price = yield* Stripe.Price("pro-once", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 * ```
 *
 * **Example:** Recurring monthly price
 * ```typescript
 * const price = yield* Stripe.Price("pro-monthly", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 1500,
 *   recurring: { interval: "month" },
 *   nickname: "Pro monthly",
 * });
 * ```
 *
 * **Example:** Tiered per-seat price, tax exclusive
 * ```typescript
 * const price = yield* Stripe.Price("team-seats", {
 *   product,
 *   currency: "usd",
 *   recurring: { interval: "month" },
 *   tiersMode: "graduated",
 *   tiers: [
 *     { upTo: 5, unitAmount: 1500 },
 *     { upTo: "inf", unitAmount: 1200 },
 *   ],
 *   taxBehavior: "exclusive",
 * });
 * ```
 *
 * ### Updating a Price
 * **Example:** Nickname, metadata, and deactivate
 * ```typescript
 * const price = yield* Stripe.Price("pro-monthly", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 1500,
 *   recurring: { interval: "month" },
 *   nickname: "Pro monthly (paused)",
 *   active: false,
 *   metadata: { tier: "pro" },
 * });
 * ```
 *
 * ### Destroying a Price
 * **Example:** Deactivate instead of delete
 * ```typescript
 * // Stripe cannot delete a used price. `alchemy destroy` sets
 * // `active: false`.
 * ```
 *
 * ### Looking up an existing price
 * `Price.lookup` references a price Alchemy doesn't manage (created in
 * the Stripe Dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing price
 * ```typescript
 * const ref = Stripe.Price.lookup({ id: "price_1A2b3C4d5E6f7G8h" });
 * ```
 *
 * @resource
 * @product Product
 */
export const Price = Resource<Price>("Stripe.Price");

export class PriceNotResolved extends Data.TaggedError("Stripe.PriceNotResolved")<{
  product: string;
  currency: string;
}> {}

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const productIdOf = (product: PriceProduct): string => {
  if (typeof product === "string") return product;
  return product.id;
};

const alchemyProductId = (product: string | Product): string => {
  if (typeof product === "string") return product;
  const id = product.id as unknown;
  if (typeof id === "string") return id;
  return String(id);
};

const toRecurring = (recurring: StripePrice["recurring"]): PriceRecurring | undefined => {
  if (recurring == null) return undefined;
  return {
    interval: recurring.interval as PriceInterval,
    intervalCount: recurring.interval_count,
    usageType: recurring.usage_type as PriceUsageType,
    ...(recurring.meter != null ? { meter: recurring.meter } : {}),
    ...(recurring.trial_period_days != null
      ? { trialPeriodDays: recurring.trial_period_days }
      : {}),
  };
};

const toTiers = (tiers: StripePrice["tiers"]): PriceTier[] | undefined =>
  tiers?.map((tier) => ({
    upTo: tier.up_to ?? "inf",
    ...(tier.unit_amount != null ? { unitAmount: tier.unit_amount } : {}),
    ...(tier.flat_amount != null ? { flatAmount: tier.flat_amount } : {}),
  }));

const tiersEqual = (news: PriceTier[] | undefined, observed: PriceTier[] | undefined): boolean => {
  if (news === undefined) return true;
  if (observed === undefined || news.length !== observed.length) return false;
  return news.every(
    (tier, index) =>
      tier.upTo === observed[index]?.upTo &&
      tier.unitAmount === observed[index]?.unitAmount &&
      tier.flatAmount === observed[index]?.flatAmount,
  );
};

const toAttrs = (price: StripePrice) => ({
  id: price.id,
  product: productIdOf(price.product),
  currency: price.currency,
  unitAmount: price.unit_amount ?? undefined,
  unitAmountDecimal: price.unit_amount_decimal ?? undefined,
  active: price.active,
  nickname: price.nickname ?? undefined,
  lookupKey: price.lookup_key ?? undefined,
  type: price.type as PriceType,
  recurring: toRecurring(price.recurring),
  tiers: toTiers(price.tiers),
  tiersMode: (price.tiers_mode ?? undefined) as PriceTiersMode | undefined,
  taxBehavior: (price.tax_behavior ?? undefined) as PriceTaxBehavior | undefined,
  metadata: userMetadata(price.metadata),
  created: price.created,
  livemode: price.livemode,
});

const isMissingPrice = isMissingStripeResource;

const getById = (price: string) =>
  GetPrice({ price, expand: ["tiers"] }).pipe(
    Effect.catchIf(isMissingPrice, () => Effect.undefined),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPrices({
      active,
      limit: LIST_PAGE_SIZE,
      expand: ["data.tiers"],
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    prices.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return prices;
});

const listAllPrices = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all([listByActive(true), listByActive(false)], {
    concurrency: 2,
  });
  const seen = new Set<string>();
  const prices: StripePrice[] = [];
  for (const price of [...active, ...inactive]) {
    if (seen.has(price.id)) continue;
    seen.add(price.id);
    prices.push(price);
  }
  return prices;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const prices = yield* listAllPrices();
  const matches: StripePrice[] = [];
  for (const price of prices) {
    if (yield* hasAlchemyMetadata(id, tagRecord(price.metadata))) {
      matches.push(price);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: { id?: string; logicalId: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const recurringEqual = (
  news: PriceRecurring | undefined,
  observed: PriceRecurring | undefined,
): boolean => {
  if (news === undefined) return true;
  if (observed === undefined) return false;
  if (news.interval !== observed.interval) return false;
  if ((news.intervalCount ?? 1) !== (observed.intervalCount ?? 1)) return false;
  if ((news.usageType ?? "licensed") !== (observed.usageType ?? "licensed")) {
    return false;
  }
  if ((news.meter ?? undefined) !== (observed.meter ?? undefined)) return false;
  if ((news.trialPeriodDays ?? undefined) !== (observed.trialPeriodDays ?? undefined)) {
    return false;
  }
  return true;
};

// Stripe sets `tax_behavior` once: `unspecified` can become `inclusive` or
// `exclusive` in place, but a set behavior can never change again.
const isTaxBehaviorSet = (taxBehavior: PriceTaxBehavior | undefined) =>
  taxBehavior === "inclusive" || taxBehavior === "exclusive";

const shouldReplace = (news: PriceProps, output: Price["Attributes"] | undefined) => {
  if (output === undefined) return false;
  if (alchemyProductId(news.product) !== output.product) return true;
  if (news.currency !== output.currency) return true;
  if (news.unitAmount !== undefined && news.unitAmount !== output.unitAmount) {
    return true;
  }
  if (news.unitAmountDecimal !== undefined && news.unitAmountDecimal !== output.unitAmountDecimal) {
    return true;
  }
  if (!recurringEqual(news.recurring, output.recurring)) return true;
  if (!tiersEqual(news.tiers, output.tiers)) return true;
  if (news.tiersMode !== undefined && news.tiersMode !== output.tiersMode) return true;
  if (
    news.taxBehavior !== undefined &&
    news.taxBehavior !== output.taxBehavior &&
    isTaxBehaviorSet(output.taxBehavior)
  ) {
    return true;
  }
  return false;
};

export const PriceProvider = () =>
  Provider.succeed(Price, {
    stables: ["id", "product", "currency", "type", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    lookup: Effect.fn(function* ({ id }) {
      const existing = yield* getById(id);
      return existing === undefined ? undefined : toAttrs(existing);
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata))) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      // Default list API is active prices; inactive (deactivated) rows
      // stay in Stripe but must not re-enter nuke. Filter to alchemy_stack
      // so account-wide teardown only touches our rows.
      const prices = yield* listByActive(true);
      return prices
        .filter((price) => {
          const metadata = tagRecord(price.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const desiredNickname = news.nickname ?? "";
      const desiredLookupKey = news.lookupKey ?? "";

      let current: StripePrice | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A previous generation (same logical id, different immutable
      // fields) must not be reused — Stripe prices cannot change amount,
      // currency, product, or recurring interval.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePrice({
          product: alchemyProductId(news.product),
          currency: news.currency,
          active: desiredActive,
          metadata,
          expand: ["tiers"],
          ...(news.unitAmount !== undefined ? { unit_amount: news.unitAmount } : {}),
          ...(news.unitAmountDecimal !== undefined
            ? { unit_amount_decimal: news.unitAmountDecimal }
            : {}),
          ...(news.recurring !== undefined
            ? {
                recurring: {
                  interval: news.recurring.interval,
                  ...(news.recurring.intervalCount !== undefined
                    ? { interval_count: news.recurring.intervalCount }
                    : {}),
                  ...(news.recurring.usageType !== undefined
                    ? { usage_type: news.recurring.usageType }
                    : {}),
                  ...(news.recurring.meter !== undefined ? { meter: news.recurring.meter } : {}),
                  ...(news.recurring.trialPeriodDays !== undefined
                    ? { trial_period_days: news.recurring.trialPeriodDays }
                    : {}),
                },
              }
            : {}),
          ...(news.tiers !== undefined
            ? {
                billing_scheme: "tiered",
                tiers: news.tiers.map((tier) => ({
                  up_to: tier.upTo,
                  ...(tier.unitAmount !== undefined ? { unit_amount: tier.unitAmount } : {}),
                  ...(tier.flatAmount !== undefined ? { flat_amount: tier.flatAmount } : {}),
                })),
              }
            : {}),
          ...(news.tiersMode !== undefined ? { tiers_mode: news.tiersMode } : {}),
          ...(news.taxBehavior !== undefined ? { tax_behavior: news.taxBehavior } : {}),
          ...(desiredNickname.length > 0 ? { nickname: desiredNickname } : {}),
          ...(desiredLookupKey.length > 0
            ? { lookup_key: desiredLookupKey, transfer_lookup_key: true }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-price-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new PriceNotResolved({
          product: alchemyProductId(news.product),
          currency: news.currency,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const nicknameChanged = (current.nickname ?? "") !== desiredNickname;
      const lookupKeyChanged = (current.lookup_key ?? "") !== desiredLookupKey;
      const taxBehaviorChanged =
        news.taxBehavior !== undefined && news.taxBehavior !== (current.tax_behavior ?? undefined);

      if (
        !activeChanged &&
        !nicknameChanged &&
        !lookupKeyChanged &&
        !taxBehaviorChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePrice({
        price: current.id,
        expand: ["tiers"],
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(nicknameChanged ? { nickname: desiredNickname } : {}),
        ...(lookupKeyChanged ? { lookup_key: desiredLookupKey, transfer_lookup_key: true } : {}),
        ...(taxBehaviorChanged ? { tax_behavior: news.taxBehavior } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdatePrice({
        price: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingPrice, () => Effect.void));
    }),
  });
