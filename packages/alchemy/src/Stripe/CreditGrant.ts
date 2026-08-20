import type { BillingCreditGrant } from "@distilled.cloud/stripe/stripe";
import {
  GetBillingCreditGrants,
  GetBillingCreditGrantsId,
  PostBillingCreditGrants,
  PostBillingCreditGrantsId,
  PostBillingCreditGrantsIdVoid,
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

/** Stripe's documented default when `priority` is omitted on create. */
const DEFAULT_PRIORITY = 50;
/** Stripe's documented default when `category` is omitted on create. */
const DEFAULT_CATEGORY = "paid";
/** Page size for the credit-grant list API (Stripe's maximum). */
const PAGE_SIZE = 100;
/** Hard bound on pagination so a huge account can never spin forever. */
const MAX_PAGES = 50;

/** The monetary value of a credit grant. */
export type CreditGrantMonetaryAmount = {
  /**
   * Three-letter [ISO currency code](https://stripe.com/docs/currencies) of
   * `value`, lowercase (e.g. `"usd"`).
   */
  currency: string;
  /**
   * A positive integer representing the amount of the credit grant in the
   * currency's smallest unit (e.g. cents for `usd`).
   */
  value: number;
};

/** The amount granted. Stripe currently only supports `monetary` credits. */
export type CreditGrantAmount = {
  /**
   * The type of this amount. Stripe currently only supports `monetary`.
   *
   * @default "monetary"
   */
  type?: "monetary" | (string & {});
  /** The monetary amount granted. */
  monetary: CreditGrantMonetaryAmount;
};

/** A price the credit grant is allowed to apply to. */
export type CreditGrantApplicablePrice = {
  /** The ID of a metered price this credit grant applies to. */
  id: string;
};

/** Narrows which prices a credit grant may be consumed against. */
export type CreditGrantScope = {
  /**
   * The price type credits may apply to. Stripe currently only supports
   * `metered`. Mutually exclusive with `prices`.
   */
  priceType?: "metered" | (string & {});
  /**
   * An explicit list of metered prices the credit grant applies to (limit
   * 20). Mutually exclusive with `priceType`.
   */
  prices?: CreditGrantApplicablePrice[];
};

/** Configuration describing what a credit grant can be applied to. */
export type CreditGrantApplicabilityConfig = {
  /** The scope of this applicability config. */
  scope: CreditGrantScope;
};

export type CreditGrantProps = {
  /**
   * ID of the customer receiving the billing credits. Cannot be changed
   * after creation — changing it replaces the credit grant.
   */
  customerId: string;
  /**
   * Amount of this credit grant. Cannot be changed after creation —
   * changing it replaces the credit grant.
   */
  amount: CreditGrantAmount;
  /**
   * Configuration specifying what this credit grant applies to. Stripe
   * currently only supports `metered` prices that have a
   * [Billing Meter](https://docs.stripe.com/api/billing/meter) attached.
   * Cannot be changed after creation — changing it replaces the credit
   * grant.
   */
  applicabilityConfig: CreditGrantApplicabilityConfig;
  /**
   * The category of this credit grant. Used for your own tracking; it is
   * never shown to the customer. Cannot be changed after creation —
   * changing it replaces the credit grant.
   *
   * @default "paid"
   */
  category?: "paid" | "promotional";
  /**
   * A descriptive name shown in the Stripe Dashboard.
   *
   * Stripe's update endpoint does not accept `name`, so changing it
   * replaces the credit grant.
   */
  name?: string;
  /**
   * Unix timestamp (seconds) at which the billing credits become effective
   * — when they become eligible for use. Defaults to the creation time.
   *
   * Stripe's update endpoint does not accept `effective_at`, so explicitly
   * changing it replaces the credit grant. Omitting it never forces a
   * replacement (Stripe's server-assigned default is left alone).
   */
  effectiveAt?: number;
  /**
   * Unix timestamp (seconds) at which the billing credits expire. Omit for
   * credits that never expire. Updated in place.
   */
  expiresAt?: number;
  /**
   * The priority for applying this credit grant relative to others. `0` is
   * the highest priority and `100` the lowest.
   *
   * Stripe's update endpoint does not accept `priority`, so changing it
   * replaces the credit grant.
   *
   * @default 50
   */
  priority?: number;
  /**
   * Arbitrary key-value pairs attached to the credit grant. Alchemy also
   * writes its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys
   * here to brand the object as owned by this stack; those are stripped
   * from the `metadata` attribute. Updated in place.
   */
  metadata?: Record<string, string>;
};

export type CreditGrant = Resource<
  "Stripe.CreditGrant",
  CreditGrantProps,
  {
    /** Unique identifier of the credit grant (`credgr_…`). */
    creditGrantId: string;
    /** ID of the customer that received the billing credits. */
    customerId: string;
    /** Amount granted, as reported by Stripe. */
    amount: {
      /** The type of the amount — currently always `"monetary"`. */
      type: "monetary" | (string & {});
      /** The monetary amount, when `type` is `"monetary"`. */
      monetary: CreditGrantMonetaryAmount | undefined;
    };
    /** Applicability configuration, as reported by Stripe. */
    applicabilityConfig: {
      /** The resolved scope of the applicability config. */
      scope: {
        /** The price type credits apply to, when scoped by type. */
        priceType: string | undefined;
        /** The explicit prices credits apply to, when scoped by price. */
        prices: CreditGrantApplicablePrice[] | undefined;
      };
    };
    /** The category of this credit grant. */
    category: "paid" | "promotional" | (string & {});
    /** The descriptive name shown in the Stripe Dashboard. */
    name: string | undefined;
    /** Unix timestamp (seconds) at which the credits become effective. */
    effectiveAt: number | undefined;
    /** Unix timestamp (seconds) at which the credits expire, if ever. */
    expiresAt: number | undefined;
    /** The application priority — `0` highest, `100` lowest. */
    priority: number | undefined;
    /** User-supplied metadata (alchemy's internal keys removed). */
    metadata: Metadata;
    /** Unix timestamp (seconds) at which the object was created. */
    created: number;
    /** Unix timestamp (seconds) at which the object was last updated. */
    updated: number;
    /**
     * Unix timestamp (seconds) at which the grant was voided, if it has
     * been. Destroying this resource voids the grant, so a re-read of a
     * destroyed grant reports this.
     */
    voidedAt: number | undefined;
    /** Whether the object exists in live mode. */
    livemode: boolean;
    /** ID of the test clock this credit grant belongs to, if any. */
    testClock: string | undefined;
  },
  never,
  Providers
>;

type CreditGrantAttributes = CreditGrant["Attributes"];

/**
 * A Stripe billing credit grant — an allocation of billing credits to a
 * customer that is automatically consumed by matching metered usage.
 *
 * :::caution
 * Stripe does not support deleting a credit grant. Destroying this resource
 * **voids** it (`POST /v1/billing/credit_grants/{id}/void`), which
 * invalidates the entire grant and all of its unused credits. The object
 * itself remains visible in the Stripe Dashboard and in `list` calls
 * forever, with `voidedAt` set.
 *
 * Stripe also exposes an `/expire` endpoint, which is a *different*
 * operation: it expires the grant as of now, leaving already-applied
 * credits intact and marking the remaining balance as expired rather than
 * invalid. Alchemy uses `/void` because it is the closest analogue to
 * "this resource no longer exists".
 * :::
 *
 * Only `expiresAt` and `metadata` can be changed in place — Stripe's update
 * endpoint accepts nothing else. Changing `customerId`, `amount`,
 * `applicabilityConfig`, `category`, `name`, `priority`, or an explicit
 * `effectiveAt` replaces the grant: a new grant is created and the old one
 * is voided.
 *
 * ### Granting credits
 * **Example:** Grant $50 of promotional credit to a customer
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 * });
 *
 * const grant = yield* Stripe.CreditGrant("acme-welcome-credit", {
 *   customerId: customer.customerId,
 *   amount: { monetary: { currency: "usd", value: 5000 } },
 *   applicabilityConfig: { scope: { priceType: "metered" } },
 *   category: "promotional",
 * });
 * ```
 *
 * ### Fully configured grant
 * **Example:** Named, prioritized, time-boxed grant with metadata
 * ```typescript
 * const grant = yield* Stripe.CreditGrant("acme-q1-credit", {
 *   customerId: customer.customerId,
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 25000 } },
 *   applicabilityConfig: { scope: { priceType: "metered" } },
 *   category: "paid",
 *   name: "Q1 prepaid credits",
 *   effectiveAt: 1767225600,
 *   expiresAt: 1774915200,
 *   priority: 10,
 *   metadata: { contract: "ACME-2026-01" },
 * });
 * ```
 *
 * ### Scoping a grant to specific metered prices
 * **Example:** Grant credits usable only against one metered price
 * ```typescript
 * const meter = yield* Stripe.Meter("api-requests", {
 *   displayName: "API requests",
 *   eventName: "api_request",
 * });
 *
 * const price = yield* Stripe.Price("api-usage", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 1,
 *   recurring: { interval: "month", usageType: "metered", meter: meter.meterId },
 * });
 *
 * const grant = yield* Stripe.CreditGrant("acme-api-credit", {
 *   customerId: customer.customerId,
 *   amount: { monetary: { currency: "usd", value: 10000 } },
 *   applicabilityConfig: { scope: { prices: [{ id: price.priceId }] } },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/billing/credit-grant
 *
 * @resource
 */
export const CreditGrant = Resource<CreditGrant>("Stripe.CreditGrant");

export const CreditGrantProvider = () =>
  Provider.succeed(CreditGrant, {
    stables: [
      "creditGrantId",
      "customerId",
      "category",
      "name",
      "effectiveAt",
      "priority",
      "created",
      "livemode",
      "testClock",
    ],
    list: Effect.fn(function* () {
      const grants = yield* listAllGrants({});
      // A voided grant is terminal — it can never be voided again and
      // Stripe keeps it in the list forever. Excluding it keeps
      // account-wide teardown from re-processing permanent residue.
      return grants.filter(isLive).map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` may still hold unresolved Outputs during plan.
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;

      if (news.customerId !== output.customerId) {
        return { action: "replace" } as const;
      }
      if (
        (news.amount.type ?? "monetary") !== output.amount.type ||
        news.amount.monetary.currency !== output.amount.monetary?.currency ||
        news.amount.monetary.value !== output.amount.monetary?.value
      ) {
        return { action: "replace" } as const;
      }
      if (
        !scopeEqual(news.applicabilityConfig.scope, output.applicabilityConfig)
      ) {
        return { action: "replace" } as const;
      }
      if ((news.category ?? DEFAULT_CATEGORY) !== output.category) {
        return { action: "replace" } as const;
      }
      if ((news.name ?? undefined) !== output.name) {
        return { action: "replace" } as const;
      }
      // Stripe defaults `effective_at` to the creation timestamp, so an
      // omitted prop must never look like a change against the observed
      // server-assigned value.
      if (
        news.effectiveAt !== undefined &&
        news.effectiveAt !== output.effectiveAt
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.priority ?? DEFAULT_PRIORITY) !==
        (output.priority ?? DEFAULT_PRIORITY)
      ) {
        return { action: "replace" } as const;
      }
      // `expiresAt` and `metadata` are updated in place — fall through to
      // the engine's default update detection.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.creditGrantId) {
        const grant = yield* getGrant(output.creditGrantId);
        // A voided grant is Stripe's terminal state — the object lingers
        // but the grant no longer exists in any meaningful sense, so
        // report it as absent and let the engine plan a fresh create.
        if (!grant || !isLive(grant)) return undefined;
        const attrs = toAttributes(grant);
        return (yield* isOwned(id, toMetadata(grant.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss: re-discover the grant by alchemy's metadata branding.
      // Stripe has no metadata-filtered search, so scan the (optionally
      // customer-narrowed) list.
      const grants = yield* listAllGrants(
        olds?.customerId !== undefined ? { customer: olds.customerId } : {},
      );
      for (const grant of grants) {
        if (!isLive(grant)) continue;
        if (yield* isOwned(id, toMetadata(grant.metadata))) {
          return toAttributes(grant);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` caches the id but is never proof the grant
      //    still exists. A grant voided out-of-band is terminal and
      //    unmodifiable, so it counts as missing.
      const observed = output?.creditGrantId
        ? yield* getGrant(output.creditGrantId)
        : undefined;
      let grant =
        observed !== undefined && isLive(observed) ? observed : undefined;

      // 2. Ensure — create when the grant is missing.
      if (!grant) {
        grant = yield* PostBillingCreditGrants({
          customer: news.customerId,
          amount: {
            type: news.amount.type ?? "monetary",
            monetary: {
              currency: news.amount.monetary.currency,
              value: news.amount.monetary.value,
            },
          },
          applicability_config: {
            scope: {
              ...(news.applicabilityConfig.scope.priceType !== undefined
                ? { price_type: news.applicabilityConfig.scope.priceType }
                : {}),
              ...(news.applicabilityConfig.scope.prices !== undefined
                ? {
                    prices: news.applicabilityConfig.scope.prices.map((p) => ({
                      id: p.id,
                    })),
                  }
                : {}),
            },
          },
          ...(news.category !== undefined ? { category: news.category } : {}),
          ...(news.name !== undefined ? { name: news.name } : {}),
          ...(news.effectiveAt !== undefined
            ? { effective_at: news.effectiveAt }
            : {}),
          ...(news.expiresAt !== undefined
            ? { expires_at: news.expiresAt }
            : {}),
          ...(news.priority !== undefined ? { priority: news.priority } : {}),
          metadata: desiredMetadata,
        });
      }

      // 3. Sync — the only mutable aspects Stripe's update endpoint accepts
      //    are `expires_at` and `metadata`. Both diff against the OBSERVED
      //    object, so adoption converges too. Right after a create this is
      //    a no-op and issues no API call.
      const observedMetadata = toMetadata(grant.metadata);
      const metadataChanged = !metadataEqual(observedMetadata, desiredMetadata);
      const observedExpiresAt = grant.expires_at ?? undefined;
      const expiresAtChanged = observedExpiresAt !== news.expiresAt;
      if (metadataChanged || expiresAtChanged) {
        grant = yield* PostBillingCreditGrantsId({
          id: grant.id,
          // Stripe unsets `expires_at` when the empty string is posted.
          ...(expiresAtChanged ? { expires_at: news.expiresAt ?? "" } : {}),
          ...(metadataChanged
            ? { metadata: metadataUpdate(observedMetadata, desiredMetadata) }
            : {}),
        });
      }

      // 4. Return the fresh attributes.
      return toAttributes(grant);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe cannot delete a credit grant. Voiding invalidates the whole
      // grant; the object itself survives with `voided_at` set. Voiding an
      // already-voided (or already-expired) grant, or one that no longer
      // resolves, is treated as success so delete stays idempotent.
      yield* PostBillingCreditGrantsIdVoid({ id: output.creditGrantId }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" || isTerminalGrantState(e.message)
            ? Effect.void
            : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * Whether a grant is still live. Voiding is Stripe's terminal state — the
 * object is never removed, so `voided_at` is the only "deleted" signal.
 */
const isLive = (grant: BillingCreditGrant): boolean => grant.voided_at == null;

/**
 * Whether an `invalid_request_error` message reports that the grant is
 * already in a terminal state (voided or expired), which makes the void call
 * a successful no-op.
 *
 * Stripe does not give these rejections a distinct error `code`, so we have
 * to match the message. The proper fix is a typed
 * `CreditGrantAlreadyVoided` / `CreditGrantExpired` tag in distilled.
 */
const isTerminalGrantState = (message: string | undefined): boolean => {
  const text = (message ?? "").toLowerCase();
  return (
    text.includes("already been voided") ||
    text.includes("already voided") ||
    text.includes("already been expired") ||
    text.includes("already expired") ||
    text.includes("has expired")
  );
};

/**
 * Fetch a credit grant by id, returning `undefined` when it no longer
 * resolves.
 *
 * Stripe reports a missing object as `invalid_request_error` with HTTP 404,
 * and distilled dispatches on `error.type` before status — so the miss can
 * surface as either `NotFound` or `InvalidRequestError` with
 * `code === "resource_missing"`. Both are handled.
 */
const getGrant = (creditGrantId: string) =>
  GetBillingCreditGrantsId({ id: creditGrantId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Exhaustively page through the credit-grant list API using Stripe's
 * `starting_after` cursor + `has_more` flag. Bounded by {@link MAX_PAGES}
 * so a pathological account can never hang a deploy.
 */
const listAllGrants = (filter: { customer?: string }) =>
  Effect.gen(function* () {
    const grants: BillingCreditGrant[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetBillingCreditGrants({
        limit: PAGE_SIZE,
        ...(filter.customer !== undefined ? { customer: filter.customer } : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      grants.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return grants;
  });

/** Stripe metadata maps are `string | undefined`-valued; drop the holes. */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const result: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/**
 * Stripe returns expandable references either as a bare id string or as the
 * fully-expanded object. We never request expansion, but normalize anyway.
 */
const referenceId = (
  reference: string | { id?: string | null } | null | undefined,
): string | undefined => {
  if (reference == null) return undefined;
  if (typeof reference === "string") return reference;
  return reference.id ?? undefined;
};

/** Whether the desired scope matches the scope Stripe reports. */
const scopeEqual = (
  desired: CreditGrantScope,
  observed: CreditGrantAttributes["applicabilityConfig"],
): boolean => {
  if ((desired.priceType ?? undefined) !== observed.scope.priceType) {
    return false;
  }
  const desiredPrices = desired.prices?.map((p) => p.id) ?? [];
  const observedPrices = observed.scope.prices?.map((p) => p.id) ?? [];
  if (desiredPrices.length !== observedPrices.length) return false;
  return desiredPrices.every((id, i) => id === observedPrices[i]);
};

/** Project a Stripe credit grant onto this resource's Attributes shape. */
const toAttributes = (grant: BillingCreditGrant): CreditGrantAttributes => ({
  creditGrantId: grant.id,
  customerId: referenceId(grant.customer) ?? "",
  amount: {
    type: grant.amount.type,
    monetary: grant.amount.monetary
      ? {
          currency: grant.amount.monetary.currency,
          value: grant.amount.monetary.value,
        }
      : undefined,
  },
  applicabilityConfig: {
    scope: {
      priceType: grant.applicability_config.scope.price_type,
      prices: grant.applicability_config.scope.prices?.map((price) => ({
        id: price.id ?? "",
      })),
    },
  },
  category: grant.category,
  name: grant.name ?? undefined,
  effectiveAt: grant.effective_at ?? undefined,
  expiresAt: grant.expires_at ?? undefined,
  priority: grant.priority ?? undefined,
  metadata: stripInternalMetadata(toMetadata(grant.metadata)),
  created: grant.created,
  updated: grant.updated,
  voidedAt: grant.voided_at ?? undefined,
  livemode: grant.livemode,
  testClock: referenceId(grant.test_clock),
});
