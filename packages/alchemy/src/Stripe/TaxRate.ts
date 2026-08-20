import {
  GetTaxRates,
  GetTaxRatesTaxRate,
  PostTaxRates,
  PostTaxRatesTaxRate,
  type PostTaxRatesTaxRateRequest,
  type TaxRate as StripeTaxRate,
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
 * The high-level tax type, such as `vat` or `sales_tax`.
 */
export type TaxRateTaxType =
  | "amusement_tax"
  | "communications_tax"
  | "gst"
  | "hst"
  | "igst"
  | "jct"
  | "lease_tax"
  | "pst"
  | "qst"
  | "retail_delivery_fee"
  | "rst"
  | "sales_tax"
  | "service_tax"
  | "vat"
  | (string & {});

/**
 * The level of the jurisdiction that imposes a tax rate. Always `undefined`
 * for manually defined tax rates — Stripe only populates it for rates it
 * creates itself through Stripe Tax.
 */
export type TaxRateJurisdictionLevel =
  | "city"
  | "country"
  | "county"
  | "district"
  | "multiple"
  | "state"
  | (string & {});

/**
 * How the tax rate is computed. Only populated for tax rates created by
 * Stripe Tax; manually created rates are always percentage-based.
 */
export type TaxRateRateType = "flat_amount" | "percentage" | (string & {});

/**
 * A flat (non-percentage) tax amount. Only produced by Stripe Tax.
 */
export type TaxRateFlatAmount = {
  /** Amount charged in the smallest currency unit (e.g. cents). */
  amount: number;
  /** Three-letter ISO currency code, lowercase. */
  currency: string;
};

export type TaxRateProps = {
  /**
   * Display name shown to customers on receipts, PDFs and the hosted
   * invoice page — e.g. `"VAT"` or `"Sales Tax"`.
   */
  displayName: string;
  /**
   * The tax rate percentage out of 100 (e.g. `20` for 20%).
   *
   * Stripe does not allow the percentage of an existing tax rate to be
   * changed, so changing this **replaces** the tax rate.
   */
  percentage: number;
  /**
   * Whether the rate is inclusive (already contained in the price) or
   * exclusive (added on top of the price).
   *
   * Stripe does not allow this to be changed after creation, so changing it
   * **replaces** the tax rate.
   */
  inclusive: boolean;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code the rate applies to.
   */
  country?: string;
  /**
   * ISO 3166-2 subdivision code without the country prefix — e.g. `"NY"`
   * for New York, United States.
   */
  state?: string;
  /**
   * Jurisdiction label used for tax reporting. Also appears on the
   * customer's invoice.
   */
  jurisdiction?: string;
  /**
   * Arbitrary internal description. Never shown to customers.
   */
  description?: string;
  /**
   * The high-level tax type, such as `vat` or `sales_tax`.
   *
   * Stripe rejects an empty value for this field, so once set it can be
   * changed to another type but never cleared back to unset.
   */
  taxType?: TaxRateTaxType;
  /**
   * Whether the tax rate can be applied to new invoices, subscriptions and
   * Checkout Sessions. Archived (`false`) rates keep working for objects
   * that already reference them.
   *
   * @default true
   */
  active?: boolean;
  /**
   * User metadata attached to the tax rate. Alchemy additionally writes
   * three reserved `alchemy_*` keys used for ownership tracking; those are
   * stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type TaxRate = Resource<
  "Stripe.TaxRate",
  TaxRateProps,
  {
    /** The Stripe tax rate ID (`txr_…`). */
    taxRateId: string;
    /** Display name shown to customers. */
    displayName: string;
    /** The tax rate percentage out of 100. */
    percentage: number;
    /** Whether the rate is inclusive of the price. */
    inclusive: boolean;
    /** Whether the rate can be applied to new objects. */
    active: boolean;
    /** Two-letter ISO country code, if scoped to a country. */
    country: string | undefined;
    /** ISO 3166-2 subdivision code, if scoped to a state/province. */
    state: string | undefined;
    /** Jurisdiction label used for tax reporting. */
    jurisdiction: string | undefined;
    /** Level of the jurisdiction — only set by Stripe Tax. */
    jurisdictionLevel: TaxRateJurisdictionLevel | undefined;
    /** Internal description, never shown to customers. */
    description: string | undefined;
    /** The high-level tax type, such as `vat` or `sales_tax`. */
    taxType: TaxRateTaxType | undefined;
    /**
     * The rate Stripe actually applied for automatic tax calculations.
     * Only populated for rates created by Stripe Tax.
     */
    effectivePercentage: number | undefined;
    /** How the rate is computed — only set by Stripe Tax. */
    rateType: TaxRateRateType | undefined;
    /** Flat tax amount — only set by Stripe Tax. */
    flatAmount: TaxRateFlatAmount | undefined;
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

type TaxRateAttributes = TaxRate["Attributes"];

/**
 * A Stripe tax rate that can be applied to invoices, subscriptions and
 * Checkout Sessions to collect tax.
 *
 * `percentage` and `inclusive` are fixed at creation time — changing either
 * replaces the tax rate with a new one. Everything else (`displayName`,
 * `country`, `state`, `jurisdiction`, `description`, `taxType`, `active`,
 * `metadata`) is updated in place.
 *
 * :::caution
 * Stripe does not support deleting a tax rate. Destroying this resource
 * archives it (`active: false`) instead; the object remains visible in the
 * dashboard and in list calls, and keeps working for invoices and
 * subscriptions that already reference it.
 * :::
 *
 * ### Creating a Tax Rate
 * **Example:** Basic exclusive sales tax
 * ```typescript
 * const tax = yield* Stripe.TaxRate("sales-tax", {
 *   displayName: "Sales Tax",
 *   percentage: 8.5,
 *   inclusive: false,
 * });
 * ```
 *
 * **Example:** Inclusive VAT scoped to a jurisdiction
 * ```typescript
 * const vat = yield* Stripe.TaxRate("uk-vat", {
 *   displayName: "VAT",
 *   percentage: 20,
 *   inclusive: true,
 *   country: "GB",
 *   jurisdiction: "United Kingdom",
 *   taxType: "vat",
 *   description: "UK standard rate VAT",
 *   metadata: { region: "emea" },
 * });
 * ```
 *
 * ### Archiving a Tax Rate
 * **Example:** Keep the rate but stop applying it to new objects
 * ```typescript
 * const legacy = yield* Stripe.TaxRate("ny-sales-tax", {
 *   displayName: "NY Sales Tax",
 *   percentage: 4,
 *   inclusive: false,
 *   country: "US",
 *   state: "NY",
 *   active: false,
 * });
 * ```
 *
 * ### Using a Tax Rate with other Stripe resources
 * **Example:** Reference the rate's ID from another resource
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const tax = yield* Stripe.TaxRate("vat", {
 *   displayName: "VAT",
 *   percentage: 20,
 *   inclusive: false,
 *   country: "DE",
 * });
 *
 * // `tax.taxRateId` is an Output that can be threaded into any resource or
 * // runtime call that accepts a tax rate ID.
 * return { productId: product.productId, taxRateId: tax.taxRateId };
 * ```
 *
 * @see https://docs.stripe.com/api/tax_rates
 *
 * @resource
 */
export const TaxRate = Resource<TaxRate>("Stripe.TaxRate");

export const TaxRateProvider = () =>
  Provider.succeed(TaxRate, {
    stables: ["taxRateId", "percentage", "inclusive", "created", "livemode"],
    list: Effect.fn(function* () {
      const rates = yield* listAllTaxRates;
      return rates.map(taxRateAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` is `Input<Props>` during plan — bail out until it resolves.
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Stripe's update endpoint accepts neither `percentage` nor
      // `inclusive`; both are fixed for the lifetime of the object.
      if (news.percentage !== output.percentage) {
        return { action: "replace" } as const;
      }
      if (news.inclusive !== output.inclusive) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.taxRateId) {
        const observed = yield* observeTaxRate(output.taxRateId);
        if (!observed) return undefined;
        const attrs = taxRateAttributes(observed);
        return (yield* isOwned(id, toMetadata(observed.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss: re-discover the object we previously created by its
      // alchemy metadata branding rather than creating a duplicate.
      const rates = yield* listAllTaxRates;
      for (const rate of rates) {
        if (yield* isOwned(id, toMetadata(rate.metadata))) {
          return taxRateAttributes(rate);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // Observe — the cached id is a hint, not proof the object still exists.
      const observed = output?.taxRateId
        ? yield* observeTaxRate(output.taxRateId)
        : undefined;

      // Ensure — nothing live, so create it.
      if (!observed) {
        const created = yield* PostTaxRates({
          display_name: news.displayName,
          percentage: news.percentage,
          inclusive: news.inclusive,
          active: news.active ?? true,
          country: news.country,
          state: news.state,
          jurisdiction: news.jurisdiction,
          description: news.description,
          tax_type: news.taxType,
          metadata: desiredMetadata,
        });
        return taxRateAttributes(created);
      }

      // Sync — diff desired against OBSERVED cloud state and send only the
      // delta; skip the API call entirely when nothing drifted.
      const update: PostTaxRatesTaxRateRequest = { tax_rate: observed.id };
      let changed = false;

      if (news.displayName !== observed.display_name) {
        update.display_name = news.displayName;
        changed = true;
      }

      const desiredActive = news.active ?? true;
      if (desiredActive !== observed.active) {
        update.active = desiredActive;
        changed = true;
      }

      const country = syncString(news.country, observed.country);
      if (country !== undefined) {
        update.country = country;
        changed = true;
      }

      const state = syncString(news.state, observed.state);
      if (state !== undefined) {
        update.state = state;
        changed = true;
      }

      const jurisdiction = syncString(news.jurisdiction, observed.jurisdiction);
      if (jurisdiction !== undefined) {
        update.jurisdiction = jurisdiction;
        changed = true;
      }

      const description = syncString(news.description, observed.description);
      if (description !== undefined) {
        update.description = description;
        changed = true;
      }

      // `tax_type` is an enum — Stripe rejects the empty-string "unset"
      // idiom for it, so it can be changed but never cleared.
      if (news.taxType !== undefined && news.taxType !== observed.tax_type) {
        update.tax_type = news.taxType;
        changed = true;
      }

      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
        changed = true;
      }

      if (!changed) return taxRateAttributes(observed);
      const updated = yield* PostTaxRatesTaxRate(update);
      return taxRateAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Tax rates cannot be deleted — archive instead. Idempotent: an
      // already-archived or already-missing rate is success.
      yield* PostTaxRatesTaxRate({
        tax_rate: output.taxRateId,
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
 * Read a tax rate by ID, mapping "missing" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled currently dispatches on the
 * Stripe `type` before the status — so the failure can surface as either
 * `NotFound` or `InvalidRequestError`. Both are handled.
 */
const observeTaxRate = (taxRateId: string) =>
  GetTaxRatesTaxRate({ tax_rate: taxRateId }).pipe(
    Effect.map((rate): StripeTaxRate | undefined => rate),
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
 * Exhaustively enumerate every tax rate on the account (active and
 * archived), following Stripe's `starting_after` cursor while `has_more`.
 */
const listAllTaxRates = Effect.gen(function* () {
  const rates: StripeTaxRate[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetTaxRates({
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
 * Normalize Stripe's `{ [key: string]: string | undefined } | null` metadata
 * map onto the dense `Record<string, string>` alchemy diffs against.
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

/**
 * Value to send for an optional string field, or `undefined` when it has not
 * drifted. Stripe's idiom for clearing an optional string is posting an
 * empty value, so a field the user removed is explicitly blanked.
 */
const syncString = (
  desired: string | undefined,
  observed: string | null,
): string | undefined => {
  if (desired === undefined) {
    return observed === null || observed === "" ? undefined : "";
  }
  return desired === observed ? undefined : desired;
};

const taxRateAttributes = (rate: StripeTaxRate): TaxRateAttributes => ({
  taxRateId: rate.id,
  displayName: rate.display_name,
  percentage: rate.percentage,
  inclusive: rate.inclusive,
  active: rate.active,
  country: rate.country ?? undefined,
  state: rate.state ?? undefined,
  jurisdiction: rate.jurisdiction ?? undefined,
  jurisdictionLevel: rate.jurisdiction_level ?? undefined,
  description: rate.description ?? undefined,
  taxType: rate.tax_type ?? undefined,
  effectivePercentage: rate.effective_percentage ?? undefined,
  rateType: rate.rate_type ?? undefined,
  flatAmount: rate.flat_amount
    ? { amount: rate.flat_amount.amount, currency: rate.flat_amount.currency }
    : undefined,
  livemode: rate.livemode,
  created: rate.created,
  metadata: stripInternalMetadata(toMetadata(rate.metadata)),
});
