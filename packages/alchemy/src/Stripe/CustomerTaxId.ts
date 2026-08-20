import {
  DeleteCustomersCustomerTaxIdsId,
  GetCustomersCustomerTaxIds,
  GetCustomersCustomerTaxIdsId,
  PostCustomersCustomerTaxIds,
  type PostCustomersCustomerTaxIdsRequestType,
  type TaxId,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * The Stripe tax ID types accepted when registering a tax ID on a customer
 * — e.g. `"eu_vat"`, `"gb_vat"`, `"us_ein"`, `"au_abn"`. Sourced directly
 * from the generated Stripe SDK so it tracks the API, with a `string`
 * escape hatch for types Stripe adds ahead of a regeneration.
 *
 * @see https://docs.stripe.com/billing/customer/tax-ids
 */
export type CustomerTaxIdType =
  | PostCustomersCustomerTaxIdsRequestType
  | (string & {});

/** Stripe's asynchronous verification state for a registered tax ID. */
export type CustomerTaxIdVerification = {
  /**
   * Verification status: `pending`, `verified`, `unverified`, or
   * `unavailable`.
   */
  status: string;
  /** The name Stripe verified against the tax authority, if any. */
  verifiedName: string | undefined;
  /** The address Stripe verified against the tax authority, if any. */
  verifiedAddress: string | undefined;
};

export type CustomerTaxIdProps = {
  /**
   * The Stripe customer the tax ID is registered against. Pass
   * `customer.customerId` from a `Stripe.Customer` resource.
   *
   * Immutable — a tax ID cannot be moved between customers, so changing
   * this replaces the resource.
   */
  customerId: string;
  /**
   * Type of the tax ID — e.g. `"eu_vat"`, `"gb_vat"`, `"us_ein"`.
   *
   * Immutable — Stripe has no update endpoint for tax IDs, so changing
   * this replaces the resource.
   */
  type: CustomerTaxIdType;
  /**
   * Value of the tax ID, e.g. `"DE123456789"` for an `eu_vat` ID.
   *
   * Immutable — Stripe has no update endpoint for tax IDs, so changing
   * this replaces the resource.
   */
  value: string;
};

export type CustomerTaxId = Resource<
  "Stripe.CustomerTaxId",
  CustomerTaxIdProps,
  {
    /** Stripe's identifier for the tax ID object, e.g. `txi_...`. */
    taxIdId: string;
    /** The customer the tax ID belongs to. */
    customerId: string;
    /** Type of the tax ID as reported by Stripe. */
    type: string;
    /** Value of the tax ID as reported by Stripe. */
    value: string;
    /**
     * Two-letter ISO country code Stripe inferred from the tax ID, when it
     * could infer one.
     */
    country: string | undefined;
    /** Unix timestamp (seconds) at which the tax ID was created. */
    created: number;
    /** `true` when the tax ID lives in Stripe's live mode. */
    livemode: boolean;
    /**
     * Stripe's verification result. Verification runs asynchronously after
     * creation, so this is usually `{ status: "pending" }` immediately
     * after a deploy and only settles on a later refresh.
     */
    verification: CustomerTaxIdVerification | undefined;
  },
  never,
  Providers
>;

type CustomerTaxIdAttributes = CustomerTaxId["Attributes"];

/**
 * A tax ID (VAT number, EIN, ABN, …) registered against a Stripe customer.
 * Customer tax IDs are printed on the invoices and credit notes issued to
 * that customer and drive Stripe Tax's reverse-charge behaviour.
 *
 * Stripe tax IDs are **entirely immutable**: there is no update endpoint, so
 * any change to `customerId`, `type`, or `value` replaces the object. They
 * also carry **no `metadata` field**, so Alchemy cannot brand them the way it
 * brands other Stripe objects — identity is the natural key
 * `(customerId, type, value)`, and a reconcile whose state row lost its
 * output re-discovers the object by listing the customer's tax IDs and
 * matching that triple rather than registering a duplicate.
 *
 * Verification against the relevant tax authority is asynchronous. The
 * `verification` attribute reflects whatever Stripe knows at the moment of
 * the deploy — typically `"pending"` — and settles on a later refresh. The
 * provider deliberately does not poll for it.
 *
 * ### Registering a tax ID
 * **Example:** EU VAT number on a customer
 * ```typescript
 * const customer = yield* Stripe.Customer("Acme", {
 *   name: "Acme GmbH",
 *   email: "billing@acme.example",
 * });
 *
 * const vat = yield* Stripe.CustomerTaxId("AcmeVat", {
 *   customerId: customer.customerId,
 *   type: "eu_vat",
 *   value: "DE123456789",
 * });
 * ```
 *
 * **Example:** US EIN on a customer
 * ```typescript
 * const ein = yield* Stripe.CustomerTaxId("AcmeEin", {
 *   customerId: customer.customerId,
 *   type: "us_ein",
 *   value: "00-0000000",
 * });
 * ```
 *
 * ### Multiple tax IDs on one customer
 * A customer may hold several tax IDs at once — declare one resource per
 * registration.
 *
 * **Example:** A UK and an EU registration side by side
 * ```typescript
 * const customer = yield* Stripe.Customer("Globex", { name: "Globex Ltd" });
 *
 * const gb = yield* Stripe.CustomerTaxId("GlobexGbVat", {
 *   customerId: customer.customerId,
 *   type: "gb_vat",
 *   value: "GB123456789",
 * });
 *
 * const eu = yield* Stripe.CustomerTaxId("GlobexEuVat", {
 *   customerId: customer.customerId,
 *   type: "eu_vat",
 *   value: "IE1234567AB",
 * });
 * ```
 *
 * ### Reading the verification result
 * **Example:** Surfacing the verification status as a stack output
 * ```typescript
 * const vat = yield* Stripe.CustomerTaxId("AcmeVat", {
 *   customerId: customer.customerId,
 *   type: "eu_vat",
 *   value: "DE123456789",
 * });
 *
 * return { verification: vat.verification };
 * ```
 *
 * @see https://docs.stripe.com/api/tax_ids
 *
 * @resource
 * @product Stripe
 * @category Billing
 */
export const CustomerTaxId = Resource<CustomerTaxId>("Stripe.CustomerTaxId");

export const CustomerTaxIdProvider = () =>
  Provider.succeed(CustomerTaxId, {
    stables: ["taxIdId", "customerId", "type", "value", "created", "livemode"],
    // Tax IDs are sub-resources keyed entirely by their parent customer:
    // Stripe exposes no account-wide listing for *customer* tax IDs, only
    // `/v1/customers/{customer}/tax_ids`. Enumerating them globally would
    // mean walking every customer in the account, so this provider reports
    // nothing to account-wide teardown — deleting the parent customer
    // removes its tax IDs anyway.
    list: Effect.fn(function* () {
      return [] as CustomerTaxIdAttributes[];
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Every field is immutable — Stripe offers no tax ID update endpoint,
      // so any concrete change replaces the object. Each comparison is
      // guarded on the prior value being known: on a greenfield plan there
      // is nothing to compare against.
      const oldCustomerId: string | undefined =
        output?.customerId ?? olds?.customerId;
      const oldType: string | undefined = output?.type ?? olds?.type;
      const oldValue: string | undefined = output?.value ?? olds?.value;
      if (
        (oldCustomerId !== undefined && oldCustomerId !== news.customerId) ||
        (oldType !== undefined && oldType !== news.type) ||
        (oldValue !== undefined && oldValue !== news.value)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const customerId: string | undefined =
        output?.customerId ?? olds?.customerId;
      if (customerId === undefined) return undefined;

      if (output?.taxIdId !== undefined) {
        const observed = yield* getTaxId(customerId, output.taxIdId);
        return observed === undefined
          ? undefined
          : toAttributes(observed, customerId);
      }

      // State loss. Tax IDs carry no metadata, so the only handle we have
      // is the natural key — scan the customer's tax IDs for a matching
      // (type, value) pair. `olds` being present is what makes this our
      // object rather than a takeover: without prior props there is
      // nothing to match on and `read` reports "absent".
      const oldType: string | undefined = olds?.type;
      const oldValue: string | undefined = olds?.value;
      if (oldType === undefined || oldValue === undefined) return undefined;
      const match = yield* findByNaturalKey(customerId, oldType, oldValue);
      return match === undefined ? undefined : toAttributes(match, customerId);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // Existence-only resource: observe, then create when missing. There
      // is no sync step because Stripe exposes nothing mutable on a tax ID.

      // 1. Observe — the cached id first, then the natural key (which also
      //    makes a re-run after a failed state commit idempotent rather
      //    than registering the same tax ID twice).
      const observed =
        (output?.taxIdId !== undefined
          ? yield* getTaxId(news.customerId, output.taxIdId)
          : undefined) ??
        (yield* findByNaturalKey(news.customerId, news.type, news.value));

      if (observed !== undefined) {
        return toAttributes(observed, news.customerId);
      }

      // 2. Ensure — register the tax ID.
      const created = yield* PostCustomersCustomerTaxIds({
        customer: news.customerId,
        type: news.type,
        value: news.value,
      });
      return toAttributes(created, news.customerId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DeleteCustomersCustomerTaxIdsId({
        customer: output.customerId,
        id: output.taxIdId,
      }).pipe(
        // Already gone (or the parent customer was deleted first, which
        // cascades) — deletion is idempotent.
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          // Stripe answers a lookup/delete of a missing object with
          // `invalid_request_error` + `code: "resource_missing"`, and
          // distilled dispatches on `error.type` before HTTP status — so
          // the failure surfaces here rather than as `NotFound`.
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
        Effect.asVoid,
      );
    }),
  });

/** Fetch one tax ID, mapping "missing" onto `undefined`. */
const getTaxId = Effect.fn(function* (customerId: string, taxIdId: string) {
  return yield* GetCustomersCustomerTaxIdsId({
    customer: customerId,
    id: taxIdId,
  }).pipe(
    Effect.map((taxId): TaxId | undefined => taxId),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );
});

/** Stripe's list pages cap at 100; bound the walk at 20 pages (2000 rows). */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

/**
 * Find a customer's tax ID by its natural key. Paginates with Stripe's
 * `starting_after` cursor, bounded so a pathological account can never spin
 * the reconciler forever.
 */
const findByNaturalKey = Effect.fn(function* (
  customerId: string,
  type: string,
  value: string,
) {
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetCustomersCustomerTaxIds({
      customer: customerId,
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(
      Effect.map((r): { data: TaxId[]; has_more: boolean } | undefined => ({
        data: [...r.data],
        has_more: r.has_more,
      })),
      // The parent customer may itself be gone — that means our tax ID is
      // gone too, not that the lookup failed.
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("InvalidRequestError", (e) =>
        e.code === "resource_missing"
          ? Effect.succeed(undefined)
          : Effect.fail(e),
      ),
    );
    if (response === undefined) return undefined;

    const match = response.data.find(
      (taxId) => taxId.type === type && taxId.value === value,
    );
    if (match !== undefined) return match;

    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) return undefined;
    startingAfter = last.id;
  }
  return undefined;
});

/** Project a Stripe `TaxId` onto this resource's Attributes shape. */
const toAttributes = (
  taxId: TaxId,
  customerId: string,
): CustomerTaxIdAttributes => ({
  taxIdId: taxId.id,
  customerId: resolveCustomerId(taxId) ?? customerId,
  type: taxId.type,
  value: taxId.value,
  country: taxId.country ?? undefined,
  created: taxId.created,
  livemode: taxId.livemode,
  verification:
    taxId.verification === null || taxId.verification === undefined
      ? undefined
      : {
          status: taxId.verification.status,
          verifiedName: taxId.verification.verified_name ?? undefined,
          verifiedAddress: taxId.verification.verified_address ?? undefined,
        },
});

/**
 * `TaxId.customer` is `string | Customer | null` — an id unless the caller
 * expanded it. Normalize to the id.
 */
const resolveCustomerId = (taxId: TaxId): string | undefined => {
  const customer = taxId.customer;
  if (customer === null || customer === undefined) return undefined;
  return typeof customer === "string" ? customer : customer.id;
};
