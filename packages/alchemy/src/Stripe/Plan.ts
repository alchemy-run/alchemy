import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  DeletePlansPlan,
  GetPlans,
  GetPlansPlan,
  type PlanMetadataMap,
  type PlanProduct,
  PostPlans,
  PostPlansPlan,
  type PostPlansPlanRequest,
  type PostPlansRequest,
  type PostPlansRequestProduct,
  type PostPlansRequestTiersItem,
  type Plan as StripePlan,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  internalMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

const TypeId = "Stripe.Plan" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on list pages walked while searching for a plan. Stripe returns
 * at most 100 objects per page, so this caps a cold read at 10k plans rather
 * than looping unbounded on a pathological account.
 */
const MAX_PAGES = 100;

/** Billing frequency of a plan's recurring charge. */
export type PlanInterval = "day" | "week" | "month" | "year";

/** How the price per period is computed. */
export type PlanBillingScheme = "per_unit" | "tiered";

/** How the quantity billed per period is determined. */
export type PlanUsageType = "licensed" | "metered";

/** How successive tiers combine when `billingScheme` is `"tiered"`. */
export type PlanTiersMode = "graduated" | "volume";

/**
 * One pricing tier, used when `billingScheme` is `"tiered"`. The lower bound
 * of a tier is one more than the upper bound of the previous tier.
 */
export type PlanTier = {
  /**
   * Inclusive upper bound of this tier, or `"inf"` for the fallback tier
   * that covers everything above the previous tier.
   */
  upTo: number | "inf";
  /** Per-unit amount, in the currency's minor unit, for units in this tier. */
  unitAmount?: number;
  /**
   * Same as {@link PlanTier.unitAmount} but as a decimal string with up to 12
   * decimal places. Only one of `unitAmount` and `unitAmountDecimal` may be
   * set.
   */
  unitAmountDecimal?: string;
  /** Flat amount charged for the whole tier, regardless of quantity. */
  flatAmount?: number;
  /**
   * Same as {@link PlanTier.flatAmount} but as a decimal string. Only one of
   * `flatAmount` and `flatAmountDecimal` may be set.
   */
  flatAmountDecimal?: string;
};

/** A pricing tier as Stripe reports it back. */
export type PlanTierAttributes = {
  /** Inclusive upper bound of the tier; `null` for the fallback tier. */
  upTo: number | null;
  /** Per-unit amount for units in this tier. */
  unitAmount: number | null;
  /** Per-unit amount as a decimal string. */
  unitAmountDecimal: string | null;
  /** Flat amount charged for the whole tier. */
  flatAmount: number | null;
  /** Flat amount as a decimal string. */
  flatAmountDecimal: string | null;
};

/**
 * Transformation applied to reported usage (or set quantity) before the
 * billed amount is computed. Cannot be combined with `tiers`.
 */
export type PlanTransformUsage = {
  /** Divide the usage by this number before pricing it. */
  divideBy: number;
  /** Round the divided result `"up"` or `"down"`. */
  round: "up" | "down";
};

/**
 * An inline product to create alongside the plan, instead of pointing the
 * plan at an existing product with `productId`.
 */
export type PlanInlineProduct = {
  /** Customer-facing name of the product. */
  name: string;
  /**
   * Whether the product is available for purchase.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Explicit product identifier. Must be unique in the account. Stripe
   * generates one when omitted.
   */
  id?: string;
  /** Free-form key/value pairs stored on the product. */
  metadata?: Metadata;
  /**
   * Text shown on the customer's card or bank statement. Up to 22
   * characters.
   */
  statementDescriptor?: string;
  /** Stripe Tax tax code ID for the product. */
  taxCode?: string;
  /** Label for a unit of the product, shown on receipts and invoices. */
  unitLabel?: string;
};

export type PlanProps = {
  /**
   * Explicit plan identifier, unique across every plan in the account. Stripe
   * generates a random one (e.g. `price_1A2b3C`) when omitted.
   *
   * Immutable — changing an explicitly-set `planId` replaces the plan.
   */
  planId?: string;
  /**
   * ID of an existing product whose pricing this plan describes. Mutually
   * exclusive with {@link PlanProps.product}; exactly one of the two is
   * required.
   *
   * Immutable — changing it replaces the plan.
   */
  productId?: string;
  /**
   * An inline service product to create together with the plan. Mutually
   * exclusive with {@link PlanProps.productId}; exactly one of the two is
   * required.
   *
   * The inline product is owned by Stripe, not by Alchemy: destroying the
   * plan does not delete it. Prefer a separate `Stripe.Product` resource
   * unless you specifically want a throwaway product.
   *
   * Immutable — changing it replaces the plan.
   */
  product?: PlanInlineProduct;
  /**
   * Amount charged each billing period, as a positive integer in the
   * currency's minor unit (cents for `usd`); `0` for a free plan. Only valid
   * when `billingScheme` is `"per_unit"`. Only one of `amount` and
   * `amountDecimal` may be set.
   *
   * Immutable — changing it replaces the plan.
   */
  amount?: number;
  /**
   * Same as {@link PlanProps.amount} but as a decimal string with up to 12
   * decimal places, for sub-cent pricing.
   *
   * Immutable — changing it replaces the plan.
   */
  amountDecimal?: string;
  /**
   * Three-letter lowercase ISO currency code, e.g. `"usd"`.
   *
   * Immutable — changing it replaces the plan.
   */
  currency: string;
  /**
   * Billing frequency.
   *
   * Immutable — changing it replaces the plan.
   */
  interval: PlanInterval;
  /**
   * Number of `interval`s between billings — `interval: "month"` with
   * `intervalCount: 3` bills quarterly. Maximum of three years.
   *
   * Immutable — changing it replaces the plan.
   *
   * @default 1
   */
  intervalCount?: number;
  /**
   * `"licensed"` bills the quantity set on the subscription; `"metered"`
   * bills aggregated reported usage.
   *
   * Immutable — changing it replaces the plan.
   *
   * @default "licensed"
   */
  usageType?: PlanUsageType;
  /**
   * `"per_unit"` charges `amount` per unit; `"tiered"` computes the price
   * from `tiers` and `tiersMode`.
   *
   * Immutable — changing it replaces the plan.
   *
   * @default "per_unit"
   */
  billingScheme?: PlanBillingScheme;
  /**
   * Pricing tiers, in ascending `upTo` order. Requires `billingScheme` to be
   * `"tiered"`, and the last tier must use `upTo: "inf"`.
   *
   * Immutable — changing it replaces the plan.
   */
  tiers?: PlanTier[];
  /**
   * Whether tiered pricing is `"graduated"` (each tier prices only the units
   * that fall inside it) or `"volume"` (the tier the total quantity lands in
   * prices every unit).
   *
   * Immutable — changing it replaces the plan.
   */
  tiersMode?: PlanTiersMode;
  /**
   * Transform reported usage before pricing it. Cannot be combined with
   * `tiers`.
   *
   * Immutable — changing it replaces the plan.
   */
  transformUsage?: PlanTransformUsage;
  /**
   * ID of the `Stripe.Meter` tracking usage for a metered plan.
   *
   * Immutable — changing it replaces the plan.
   */
  meter?: string;
  /**
   * Number of trial days applied when a customer is subscribed with
   * `trial_from_plan=true`. Mutable.
   */
  trialPeriodDays?: number;
  /** Internal-only description of the plan, never shown to customers. Mutable. */
  nickname?: string;
  /**
   * Whether the plan can be used for new subscriptions. Mutable — set to
   * `false` to retire a plan without deleting it.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Free-form key/value pairs stored on the plan. Mutable.
   *
   * Alchemy additionally writes reserved `alchemy_*` keys recording the
   * owning stack, stage and logical ID; those are stripped from the
   * `metadata` attribute.
   */
  metadata?: Metadata;
};

export type PlanAttributes = {
  /** Stripe's identifier for the plan, e.g. `price_1A2b3C4d5E6f`. */
  planId: string;
  /** ID of the product whose pricing this plan describes. */
  productId: string | undefined;
  /** Whether the plan can be used for new subscriptions. */
  active: boolean;
  /** Amount charged per period, in the currency's minor unit. */
  amount: number | undefined;
  /** Amount charged per period, as a decimal string. */
  amountDecimal: string | undefined;
  /** How the price per period is computed. */
  billingScheme: PlanBillingScheme;
  /** Three-letter lowercase ISO currency code. */
  currency: string;
  /** Billing frequency. */
  interval: PlanInterval;
  /** Number of `interval`s between billings. */
  intervalCount: number;
  /** Internal-only description of the plan. */
  nickname: string | undefined;
  /** ID of the meter tracking usage for a metered plan. */
  meter: string | undefined;
  /**
   * Pricing tiers, when `billingScheme` is `"tiered"`. Stripe only returns
   * tiers when they are expanded, which this provider always requests.
   */
  tiers: PlanTierAttributes[] | undefined;
  /** Whether tiered pricing is graduated or volume based. */
  tiersMode: PlanTiersMode | undefined;
  /** Usage transformation applied before pricing. */
  transformUsage: PlanTransformUsage | undefined;
  /** Trial days applied with `trial_from_plan=true`. */
  trialPeriodDays: number | undefined;
  /** How the quantity billed per period is determined. */
  usageType: PlanUsageType;
  /** User-supplied metadata, with Alchemy's reserved `alchemy_*` keys removed. */
  metadata: Metadata;
  /** Unix timestamp (seconds) at which the plan was created. */
  created: number;
  /** `true` when the plan lives in the account's live mode. */
  livemode: boolean;
};

export type Plan = Resource<
  TypeId,
  PlanProps,
  PlanAttributes,
  never,
  Providers
>;

/**
 * A legacy Stripe Plan: the recurring price, currency and billing cycle for
 * subscriptions to a product.
 *
 * Plans are Stripe's **legacy** subscription primitive and have been
 * superseded by {@link Price}, which is backwards compatible with the Plans
 * API and supports one-time charges, multi-currency pricing and lookup keys.
 * Reach for `Stripe.Price` for anything new; this resource exists for parity
 * with accounts that still model their catalog as plans.
 *
 * Almost every field of a plan is fixed at creation — Stripe's update
 * endpoint only accepts `active`, `nickname`, `trial_period_days`, `product`
 * and `metadata`. Changing anything else (amount, currency, interval, tiers,
 * usage type, meter, or an explicitly-set `planId`) replaces the plan: a new
 * plan is created and the old one deleted.
 *
 * ### Creating a Plan
 * **Example:** Minimal monthly plan on an existing product
 * ```typescript
 * const plan = yield* Stripe.Plan("Pro", {
 *   productId: product.productId,
 *   currency: "usd",
 *   interval: "month",
 *   amount: 2000,
 * });
 * ```
 *
 * **Example:** Fully configured metered, tiered plan
 * ```typescript
 * const plan = yield* Stripe.Plan("Usage", {
 *   planId: "usage-monthly",
 *   productId: product.productId,
 *   currency: "usd",
 *   interval: "month",
 *   intervalCount: 1,
 *   usageType: "metered",
 *   billingScheme: "tiered",
 *   tiersMode: "graduated",
 *   tiers: [
 *     { upTo: 1_000, unitAmount: 0 },
 *     { upTo: "inf", unitAmount: 5 },
 *   ],
 *   trialPeriodDays: 14,
 *   nickname: "Usage based",
 *   active: true,
 *   metadata: { tier: "usage" },
 * });
 * ```
 *
 * ### Composing with a Product
 * **Example:** Product plus a plan priced against it
 * ```typescript
 * const product = yield* Stripe.Product("ProProduct", { name: "Pro" });
 *
 * const monthly = yield* Stripe.Plan("ProMonthly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   interval: "month",
 *   amount: 2000,
 * });
 * ```
 *
 * **Example:** Inline product, created and owned by Stripe
 * ```typescript
 * // The inline product is NOT tracked by Alchemy — destroying the plan
 * // leaves it behind. Prefer a `Stripe.Product` resource when you want the
 * // product's lifecycle managed too.
 * const plan = yield* Stripe.Plan("Starter", {
 *   product: { name: "Starter" },
 *   currency: "usd",
 *   interval: "month",
 *   amount: 500,
 * });
 * ```
 *
 * ### Retiring a Plan
 * **Example:** Stop new subscriptions without deleting the plan
 * ```typescript
 * const plan = yield* Stripe.Plan("Legacy", {
 *   productId: product.productId,
 *   currency: "usd",
 *   interval: "month",
 *   amount: 1000,
 *   active: false,
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/plans
 *
 * @resource
 * @product Stripe
 */
export const Plan = Resource<Plan>(TypeId);

/** Returns true if the given value is a Plan resource. */
export const isPlan = (value: unknown): value is Plan =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Stripe only returns a plan's `tiers` when they are expanded, so every
 * single-object call asks for them. Without this the `tiers` attribute would
 * always be `undefined` and the tiers comparison in `diff` could never run.
 */
const EXPAND_TIERS = ["tiers"];

/**
 * List expansion is addressed through the `data.` prefix.
 */
const EXPAND_LIST_TIERS = ["data.tiers"];

/**
 * A plan's `product` is `string | Product | DeletedProduct` depending on
 * expansion; normalize it down to the product id.
 */
const productIdOf = (
  product: PlanProduct | null | undefined,
): string | undefined => {
  if (product === null || product === undefined) return undefined;
  return typeof product === "string" ? product : product.id;
};

const nullToUndefined = <A>(value: A | null | undefined): A | undefined =>
  value === null ? undefined : value;

/**
 * Stripe's generated metadata map is `Record<string, string | undefined>`,
 * while alchemy's {@link Metadata} helpers work on `Record<string, string>`.
 * Drop the (never actually populated) undefined slots at the boundary.
 */
const observedMetadata = (
  metadata: PlanMetadataMap | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Raised when Stripe rejects the create because the requested plan id is
 * already in use by a plan this stack does not own.
 */
export class PlanIdTakenError extends Data.TaggedError("StripePlanIdTaken")<{
  /** The plan id Stripe reported as already taken. */
  readonly planId: string;
}> {}

const toTierAttributes = (tier: {
  up_to: number | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  flat_amount: number | null;
  flat_amount_decimal: string | null;
}): PlanTierAttributes => ({
  upTo: tier.up_to,
  unitAmount: tier.unit_amount,
  unitAmountDecimal: tier.unit_amount_decimal,
  flatAmount: tier.flat_amount,
  flatAmountDecimal: tier.flat_amount_decimal,
});

const toAttributes = (plan: StripePlan): PlanAttributes => ({
  planId: plan.id,
  productId: productIdOf(plan.product),
  active: plan.active,
  amount: nullToUndefined(plan.amount),
  amountDecimal: nullToUndefined(plan.amount_decimal),
  billingScheme: plan.billing_scheme as PlanBillingScheme,
  currency: plan.currency,
  interval: plan.interval as PlanInterval,
  intervalCount: plan.interval_count,
  nickname: nullToUndefined(plan.nickname),
  meter: nullToUndefined(plan.meter),
  tiers: plan.tiers?.map(toTierAttributes),
  tiersMode: nullToUndefined(plan.tiers_mode) as PlanTiersMode | undefined,
  transformUsage: plan.transform_usage
    ? {
        divideBy: plan.transform_usage.divide_by,
        round: plan.transform_usage.round as "up" | "down",
      }
    : undefined,
  trialPeriodDays: nullToUndefined(plan.trial_period_days),
  usageType: plan.usage_type as PlanUsageType,
  metadata: stripInternalMetadata(observedMetadata(plan.metadata)),
  created: plan.created,
  livemode: plan.livemode,
});

/**
 * Stripe answers a lookup for a deleted/never-existing object with HTTP 404
 * and `type: "invalid_request_error"`, `code: "resource_missing"`. Distilled
 * dispatches on `type` before status, so that surfaces as
 * `InvalidRequestError` rather than `NotFound` — both are treated as absent.
 *
 * TODO(distilled): patch the Stripe model so `resource_missing` is typed as a
 * dedicated `NotFound`-shaped tag and this second arm can go away.
 */
const missingAsUndefined = <A, R>(
  effect: Effect.Effect<A, StripeOpError, R>,
): Effect.Effect<A | undefined, StripeOpError, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError" && e.code === "resource_missing",
      () => Effect.succeed(undefined),
    ),
  );

/** Retrieve one plan by Stripe id; `undefined` when it is gone. */
const getPlanById = (planId: string) =>
  missingAsUndefined(GetPlansPlan({ plan: planId, expand: EXPAND_TIERS }));

/**
 * Walk every page of `/v1/plans`. Bounded by {@link MAX_PAGES}; Stripe pages
 * with `starting_after` + `has_more`.
 */
const listPlans = Effect.fn(function* () {
  const plans: StripePlan[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetPlans({
      limit: 100,
      expand: EXPAND_LIST_TIERS,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    plans.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return plans;
});

/**
 * Find the plan branded with this stack/stage/logical-id. Used for the cold
 * read after state loss, and to re-discover a plan whose create succeeded but
 * whose state commit did not.
 */
const findOwnedPlan = Effect.fn(function* (id: string) {
  const branding = yield* internalMetadata(id);
  const plans = yield* listPlans();
  return plans.find((plan) =>
    Object.entries(branding).every(
      ([key, value]) => plan.metadata?.[key] === value,
    ),
  );
});

const desiredProduct = (
  news: PlanProps,
): PostPlansRequestProduct | undefined => {
  if (news.productId !== undefined) return news.productId;
  const product = news.product;
  if (product === undefined) return undefined;
  return {
    name: product.name,
    ...(product.active !== undefined ? { active: product.active } : {}),
    ...(product.id !== undefined ? { id: product.id } : {}),
    ...(product.metadata !== undefined ? { metadata: product.metadata } : {}),
    ...(product.statementDescriptor !== undefined
      ? { statement_descriptor: product.statementDescriptor }
      : {}),
    ...(product.taxCode !== undefined ? { tax_code: product.taxCode } : {}),
    ...(product.unitLabel !== undefined
      ? { unit_label: product.unitLabel }
      : {}),
  };
};

const toTierRequest = (tier: PlanTier): PostPlansRequestTiersItem => ({
  up_to: tier.upTo,
  ...(tier.unitAmount !== undefined ? { unit_amount: tier.unitAmount } : {}),
  ...(tier.unitAmountDecimal !== undefined
    ? { unit_amount_decimal: tier.unitAmountDecimal }
    : {}),
  ...(tier.flatAmount !== undefined ? { flat_amount: tier.flatAmount } : {}),
  ...(tier.flatAmountDecimal !== undefined
    ? { flat_amount_decimal: tier.flatAmountDecimal }
    : {}),
});

const createRequest = (
  news: PlanProps,
  metadata: Metadata,
): PostPlansRequest => {
  const product = desiredProduct(news);
  return {
    currency: news.currency,
    interval: news.interval,
    metadata,
    expand: EXPAND_TIERS,
    ...(news.planId !== undefined ? { id: news.planId } : {}),
    ...(product !== undefined ? { product } : {}),
    ...(news.amount !== undefined ? { amount: news.amount } : {}),
    ...(news.amountDecimal !== undefined
      ? { amount_decimal: news.amountDecimal }
      : {}),
    ...(news.intervalCount !== undefined
      ? { interval_count: news.intervalCount }
      : {}),
    ...(news.usageType !== undefined ? { usage_type: news.usageType } : {}),
    ...(news.billingScheme !== undefined
      ? { billing_scheme: news.billingScheme }
      : {}),
    ...(news.tiers !== undefined
      ? { tiers: news.tiers.map(toTierRequest) }
      : {}),
    ...(news.tiersMode !== undefined ? { tiers_mode: news.tiersMode } : {}),
    ...(news.transformUsage !== undefined
      ? {
          transform_usage: {
            divide_by: news.transformUsage.divideBy,
            round: news.transformUsage.round,
          },
        }
      : {}),
    ...(news.meter !== undefined ? { meter: news.meter } : {}),
    ...(news.trialPeriodDays !== undefined
      ? { trial_period_days: news.trialPeriodDays }
      : {}),
    ...(news.nickname !== undefined ? { nickname: news.nickname } : {}),
    ...(news.active !== undefined ? { active: news.active } : {}),
  };
};

/**
 * Whether the desired tiers already match what Stripe reports. Only the
 * fields the caller actually specified are compared: Stripe echoes both the
 * integer and the decimal form of every amount, so comparing the unspecified
 * half would report drift forever.
 */
const tiersMatch = (
  desired: ReadonlyArray<PlanTier>,
  observed: ReadonlyArray<PlanTierAttributes>,
): boolean => {
  if (desired.length !== observed.length) return false;
  return desired.every((tier, index) => {
    const seen = observed[index];
    if (seen === undefined) return false;
    if ((tier.upTo === "inf" ? null : tier.upTo) !== seen.upTo) return false;
    if (tier.unitAmount !== undefined && tier.unitAmount !== seen.unitAmount) {
      return false;
    }
    if (
      tier.unitAmountDecimal !== undefined &&
      tier.unitAmountDecimal !== seen.unitAmountDecimal
    ) {
      return false;
    }
    if (tier.flatAmount !== undefined && tier.flatAmount !== seen.flatAmount) {
      return false;
    }
    if (
      tier.flatAmountDecimal !== undefined &&
      tier.flatAmountDecimal !== seen.flatAmountDecimal
    ) {
      return false;
    }
    return true;
  });
};

export const PlanProvider = () =>
  Provider.succeed(Plan, {
    // Stripe's update endpoint only accepts active, nickname,
    // trial_period_days, product and metadata; `product` changes are
    // modelled as a replacement here, so everything below is fixed for the
    // lifetime of a given plan.
    stables: [
      "planId",
      "productId",
      "amount",
      "amountDecimal",
      "billingScheme",
      "currency",
      "interval",
      "intervalCount",
      "meter",
      "tiers",
      "tiersMode",
      "transformUsage",
      "usageType",
      "created",
      "livemode",
    ],

    list: Effect.fn(function* () {
      const plans = yield* listPlans();
      return plans.map(toAttributes);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // Nothing deployed yet — the engine creates, there is nothing to
      // compare against.
      if (output === undefined) return undefined;

      // Every immutable field, compared against OBSERVED state. A prop the
      // caller left unset is never a replacement trigger: Stripe picked the
      // value and it stays authoritative.
      if (news.planId !== undefined && news.planId !== output.planId) {
        return { action: "replace" } as const;
      }
      if (news.productId !== undefined && news.productId !== output.productId) {
        return { action: "replace" } as const;
      }
      // An inline product is created once with the plan; switching from an
      // inline product to a product id (or supplying a different inline
      // name) means a different product, hence a new plan.
      if (
        news.product !== undefined &&
        news.productId === undefined &&
        news.product.id !== undefined &&
        news.product.id !== output.productId
      ) {
        return { action: "replace" } as const;
      }
      if (news.currency.toLowerCase() !== output.currency) {
        return { action: "replace" } as const;
      }
      if (news.interval !== output.interval) {
        return { action: "replace" } as const;
      }
      if (
        news.intervalCount !== undefined &&
        news.intervalCount !== output.intervalCount
      ) {
        return { action: "replace" } as const;
      }
      if (news.amount !== undefined && news.amount !== output.amount) {
        return { action: "replace" } as const;
      }
      if (
        news.amountDecimal !== undefined &&
        news.amountDecimal !== output.amountDecimal
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.billingScheme !== undefined &&
        news.billingScheme !== output.billingScheme
      ) {
        return { action: "replace" } as const;
      }
      if (news.usageType !== undefined && news.usageType !== output.usageType) {
        return { action: "replace" } as const;
      }
      if (news.tiersMode !== undefined && news.tiersMode !== output.tiersMode) {
        return { action: "replace" } as const;
      }
      // `output.tiers` is only populated when Stripe expanded them. If it is
      // absent we cannot prove drift, so we do not force a replacement.
      if (
        news.tiers !== undefined &&
        output.tiers !== undefined &&
        !tiersMatch(news.tiers, output.tiers)
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.transformUsage !== undefined &&
        (news.transformUsage.divideBy !== output.transformUsage?.divideBy ||
          news.transformUsage.round !== output.transformUsage?.round)
      ) {
        return { action: "replace" } as const;
      }
      if (news.meter !== undefined && news.meter !== output.meter) {
        return { action: "replace" } as const;
      }
      // Everything else (active, nickname, trialPeriodDays, metadata) is
      // mutable — let the engine's default update logic decide.
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      // Owned path — the engine already wrote this plan through us, so
      // refresh through the cached Stripe id.
      if (output?.planId !== undefined) {
        const observed = yield* getPlanById(output.planId);
        if (observed) return toAttributes(observed);
      }

      // Attribute loss with props intact — a user-supplied `planId` is a
      // natural key, but a plan sitting on that id proves nothing about who
      // created it. Only alchemy's branding does, so anything else is
      // reported unowned and takeover is gated behind `--adopt`.
      if (olds?.planId !== undefined) {
        const observed = yield* getPlanById(olds.planId);
        if (observed) {
          const attrs = toAttributes(observed);
          return (yield* isOwned(id, observedMetadata(observed.metadata)))
            ? attrs
            : Unowned(attrs);
        }
      }

      // Cold read (full state loss), or a Stripe-generated id — the only
      // handle left is alchemy's metadata branding.
      const match = yield* findOwnedPlan(id);
      return match ? toAttributes(match) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the cached id is a hint, not proof the plan still
      //    exists. Fall back to a branding scan so a create whose state
      //    commit failed is re-discovered instead of duplicated. A
      //    user-supplied `news.planId` is deliberately NOT used as a lookup
      //    key here: an id that happens to be taken by a plan we did not
      //    create must not be silently taken over.
      let observed =
        output?.planId !== undefined
          ? yield* getPlanById(output.planId)
          : undefined;
      if (observed === undefined) {
        observed = yield* findOwnedPlan(id);
      }

      // 2. Ensure — create when missing. A racing create that already
      //    claimed an explicitly-requested `planId` surfaces as
      //    `resource_already_exists`; re-read it and accept it only when it
      //    carries our branding.
      if (observed === undefined) {
        observed = yield* PostPlans(createRequest(news, desiredMetadata)).pipe(
          Effect.catchIf(
            (e) =>
              e._tag === "InvalidRequestError" &&
              e.code === "resource_already_exists",
            () =>
              Effect.gen(function* () {
                const raced = yield* findOwnedPlan(id);
                if (raced !== undefined) return raced;
                return yield* new PlanIdTakenError({
                  planId: news.planId ?? id,
                });
              }),
          ),
        );
      }

      // 3. Sync — only the fields Stripe's update endpoint accepts, each
      //    diffed against observed cloud state. `product` is deliberately
      //    excluded: a product change is modelled as a replacement, so
      //    reaching here with a different product would mean the engine
      //    already decided the plan stays as-is.
      const update: Omit<PostPlansPlanRequest, "plan"> = {};
      let dirty = false;
      if (news.active !== undefined && news.active !== observed.active) {
        update.active = news.active;
        dirty = true;
      }
      if (
        news.nickname !== undefined &&
        news.nickname !== (observed.nickname ?? undefined)
      ) {
        update.nickname = news.nickname;
        dirty = true;
      }
      if (
        news.trialPeriodDays !== undefined &&
        news.trialPeriodDays !== (observed.trial_period_days ?? undefined)
      ) {
        update.trial_period_days = news.trialPeriodDays;
        dirty = true;
      }
      const seenMetadata = observedMetadata(observed.metadata);
      if (!metadataEqual(seenMetadata, desiredMetadata)) {
        // Stripe unsets a metadata key by posting an empty string, so keys
        // that disappeared must be blanked explicitly.
        update.metadata = metadataUpdate(seenMetadata, desiredMetadata);
        dirty = true;
      }
      if (dirty) {
        observed = yield* PostPlansPlan({
          plan: observed.id,
          expand: EXPAND_TIERS,
          ...update,
        });
      }

      // 4. Return the fresh attributes.
      return toAttributes(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an already-deleted plan is success, not an error.
      yield* missingAsUndefined(DeletePlansPlan({ plan: output.planId }));
    }),
  });
