import {
  type Address as StripeAddress,
  type Customer as StripeCustomerObject,
  DeleteCustomersCustomer,
  GetCustomers,
  GetCustomersCustomer,
  GetCustomersSearch,
  type InvoiceSettingCustomerSetting,
  PostCustomers,
  type PostCustomersCustomerRequest,
  PostCustomersCustomer,
  type Shipping as StripeShipping,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import {
  ALCHEMY_ID_KEY,
  ALCHEMY_STACK_KEY,
  ALCHEMY_STAGE_KEY,
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * The most pages of 100 customers `read`/`list` will walk before giving up.
 * Stripe list endpoints are cursor-paginated with no total, so the loop is
 * bounded rather than run to exhaustion (see the speed doctrine).
 */
const MAX_LIST_PAGES = 20;

/** A postal address on a Stripe customer. */
export type CustomerAddress = {
  /** City, district, suburb, town, or village. */
  city?: string;
  /** Two-letter ISO 3166-1 alpha-2 country code (e.g. `"US"`). */
  country?: string;
  /** Address line 1 — street, PO box, or company name. */
  line1?: string;
  /** Address line 2 — apartment, suite, unit, or building. */
  line2?: string;
  /** ZIP or postal code. */
  postalCode?: string;
  /** State, county, province, or region (ISO 3166-2). */
  state?: string;
};

/** Mailing/shipping details printed on invoices emailed to the customer. */
export type CustomerShipping = {
  /** The shipping address. */
  address: CustomerAddress;
  /** Recipient name. */
  name: string;
  /** Recipient phone number, including extension. */
  phone?: string;
};

/** A custom key/value row rendered on the customer's invoices. */
export type CustomerInvoiceCustomField = {
  /** Field label. Up to 40 characters. */
  name: string;
  /** Field value. Up to 140 characters. */
  value: string;
};

/** PDF rendering defaults for the customer's invoices. */
export type CustomerInvoiceRenderingOptions = {
  /**
   * How line-item prices and amounts are displayed with respect to tax on
   * invoice PDFs.
   */
  amountTaxDisplay?: "exclude_tax" | "include_inclusive_tax";
  /** ID of the invoice rendering template to use for future invoices. */
  template?: string;
};

/** Default invoice settings applied to every invoice for the customer. */
export type CustomerInvoiceSettings = {
  /**
   * Up to 4 custom fields rendered on the customer's invoices.
   */
  customFields?: CustomerInvoiceCustomField[];
  /**
   * ID of a payment method already attached to the customer, used as the
   * default for subscriptions and invoices.
   */
  defaultPaymentMethod?: string;
  /** Default footer text rendered on the customer's invoices. */
  footer?: string;
  /** Default PDF rendering options for the customer's invoices. */
  renderingOptions?: CustomerInvoiceRenderingOptions;
};

/**
 * The customer's tax exemption status. `reverse` prints
 * **"Reverse charge"** on invoice and receipt PDFs.
 */
export type CustomerTaxExempt = "none" | "exempt" | "reverse";

export type CustomerProps = {
  /**
   * The customer's email address. Displayed alongside the customer in the
   * Stripe dashboard and used for invoice delivery. Up to 512 characters.
   */
  email?: string;
  /**
   * The customer's full name or business name. Up to 150 characters.
   */
  name?: string;
  /**
   * An arbitrary string attached to the customer, displayed alongside it in
   * the Stripe dashboard.
   */
  description?: string;
  /** The customer's phone number. */
  phone?: string;
  /**
   * The customer's billing address. Required in some countries for tax
   * calculation.
   */
  address?: CustomerAddress;
  /**
   * Mailing and shipping address for the customer. Appears on invoices
   * emailed to this customer.
   */
  shipping?: CustomerShipping;
  /**
   * An integer amount in cents (or local equivalent) representing the
   * customer's starting balance. A negative amount is a credit that
   * decreases the amount due on the next invoice; a positive amount
   * increases it.
   *
   * Only managed when explicitly set — omitting it leaves whatever balance
   * Stripe has accrued out-of-band untouched.
   */
  balance?: number;
  /**
   * Prefix used to generate the customer's invoice numbers. Must be 3–12
   * uppercase letters or numbers and unique across the Stripe account. When
   * omitted, Stripe generates one.
   */
  invoicePrefix?: string;
  /** Default invoice settings for this customer. */
  invoiceSettings?: CustomerInvoiceSettings;
  /**
   * The sequence number to use on the customer's next invoice. Ignored by
   * Stripe when the account uses account-level invoice sequencing, so it is
   * only pushed when explicitly set.
   *
   * @default 1
   */
  nextInvoiceSequence?: number;
  /**
   * The customer's preferred locales (languages), ordered by preference —
   * e.g. `["en-US", "fr-FR"]`.
   */
  preferredLocales?: string[];
  /**
   * The customer's tax exemption status.
   *
   * @default "none"
   */
  taxExempt?: CustomerTaxExempt;
  /**
   * ID of a test-mode test clock to attach the customer to. Customers cannot
   * be moved between test clocks, so changing this replaces the customer.
   */
  testClock?: string;
  /**
   * Arbitrary key/value pairs stored on the customer. Alchemy additionally
   * writes the reserved `alchemy_stack` / `alchemy_stage` / `alchemy_id`
   * keys to brand the object as owned by this stack; those are stripped back
   * out of the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type Customer = Resource<
  "Stripe.Customer",
  CustomerProps,
  {
    /** The Stripe customer ID (`cus_…`). */
    customerId: string;
    /** The customer's email address, if set. */
    email: string | undefined;
    /** The customer's full name or business name, if set. */
    name: string | undefined;
    /** The customer's description, if set. */
    description: string | undefined;
    /** The customer's phone number, if set. */
    phone: string | undefined;
    /** The customer's billing address, if set. */
    address: CustomerAddress | undefined;
    /** The customer's shipping details, if set. */
    shipping: CustomerShipping | undefined;
    /** The customer's current account balance, in the smallest currency unit. */
    balance: number;
    /**
     * Three-letter ISO currency code the customer is billed in for recurring
     * charges. Assigned by Stripe on the first invoice.
     */
    currency: string | undefined;
    /** Prefix Stripe uses to generate this customer's invoice numbers. */
    invoicePrefix: string | undefined;
    /** The customer's default invoice settings, if any are set. */
    invoiceSettings: CustomerInvoiceSettings | undefined;
    /** The sequence number of the customer's next invoice, if tracked per-customer. */
    nextInvoiceSequence: number | undefined;
    /** The customer's preferred locales, ordered by preference. */
    preferredLocales: string[];
    /** The customer's tax exemption status. */
    taxExempt: CustomerTaxExempt;
    /** ID of the test clock the customer is attached to, if any. */
    testClock: string | undefined;
    /** Whether the customer's most recent invoice state change was a failure. */
    delinquent: boolean;
    /** `true` when the customer lives in live mode, `false` in test mode. */
    livemode: boolean;
    /** Unix timestamp (seconds) at which the customer was created. */
    created: number;
    /** User-supplied metadata, with alchemy's reserved keys stripped out. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

type CustomerAttributes = Customer["Attributes"];

/**
 * A Stripe customer — the object recurring charges, saved payment methods,
 * invoices, and subscriptions hang off of.
 *
 * Alchemy brands every customer it creates with reserved `alchemy_*`
 * metadata keys, which is how a customer is re-discovered after state loss
 * and how adoption of a pre-existing customer is gated.
 *
 * Deleting a customer in Stripe is a **soft delete**: the object stays
 * retrievable at its ID forever, with `deleted: true` and every other field
 * dropped. Alchemy treats such a response as absent, so destroying and then
 * re-deploying a customer produces a brand new `cus_…` ID rather than
 * resurrecting the tombstone.
 *
 * ### Creating a Customer
 * **Example:** Minimal customer
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   name: "Acme, Inc.",
 * });
 * ```
 *
 * **Example:** Customer with billing and shipping addresses
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   name: "Acme, Inc.",
 *   phone: "+15555550123",
 *   address: {
 *     line1: "1 Market St",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94105",
 *     country: "US",
 *   },
 *   shipping: {
 *     name: "Acme Receiving",
 *     address: { line1: "500 Dock St", city: "Oakland", country: "US" },
 *   },
 * });
 * ```
 *
 * ### Invoicing defaults
 * **Example:** Customer with invoice settings and a tax exemption
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   invoicePrefix: "ACME",
 *   invoiceSettings: {
 *     footer: "Thanks for your business!",
 *     customFields: [{ name: "PO Number", value: "PO-1234" }],
 *     renderingOptions: { amountTaxDisplay: "exclude_tax" },
 *   },
 *   taxExempt: "reverse",
 *   preferredLocales: ["en-US"],
 *   metadata: { tier: "enterprise" },
 * });
 * ```
 *
 * ### Composing with other Stripe resources
 * **Example:** Reference another Stripe resource from the customer
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   metadata: { plan: product.productId },
 * });
 * ```
 *
 * ### Test clocks
 * **Example:** Attach the customer to a test clock
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   testClock: "clock_1234",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/customers
 *
 * @resource
 */
export const Customer = Resource<Customer>("Stripe.Customer");

export const CustomerProvider = () =>
  Provider.succeed(Customer, {
    stables: ["customerId", "created", "livemode", "testClock"],

    list: Effect.fn(function* () {
      const customers = yield* listAllCustomers;
      // Only enumerate customers alchemy branded. Stripe accounts routinely
      // hold customers created by the application itself (checkout, billing
      // portal); nuke deletes everything `list` reports, so anything without
      // our branding must stay invisible to it.
      return customers
        .filter(
          (customer) =>
            toMetadata(customer.metadata)[ALCHEMY_STACK_KEY] !== undefined,
        )
        .map(toAttributes);
    }),

    diff: Effect.fn(function* ({ news = {}, output }) {
      if (!isResolved(news)) return undefined;
      // `test_clock` is accepted on create but absent from the update API —
      // Stripe never moves a customer between clocks. Every other property
      // is mutable, so the engine's default update logic handles them.
      if (news.testClock !== output?.testClock) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      if (output?.customerId) {
        const customer = yield* observeCustomer(output.customerId);
        if (customer === undefined) return undefined;
        const attrs = toAttributes(customer);
        return (yield* isOwned(id, toMetadata(customer.metadata)))
          ? attrs
          : Unowned(attrs);
      }
      // State loss: re-discover the customer through alchemy's branding.
      const found = yield* findCustomerByBranding(id);
      return found === undefined ? undefined : toAttributes(found);
    }),

    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` caches the id but never proves the customer is
      //    still there (Stripe soft-deletes, and `read` may have run long
      //    ago), so always go look.
      const observed = output?.customerId
        ? yield* observeCustomer(output.customerId)
        : undefined;

      // 2. Ensure — a missing customer is created with the full desired
      //    shape, which leaves nothing for the sync step to do.
      if (observed === undefined) {
        const created = yield* PostCustomers({
          ...createRequest(news),
          metadata: desiredMetadata,
          ...(news.testClock !== undefined
            ? { test_clock: news.testClock }
            : {}),
        });
        return toAttributes(created);
      }

      // 3. Sync — diff desired against OBSERVED cloud state and apply only
      //    the delta; skip the API call entirely when nothing changed.
      const current = toAttributes(observed);
      const delta = updateRequest(
        current,
        news,
        toMetadata(observed.metadata),
        desiredMetadata,
      );
      if (delta === undefined) return current;
      const updated = yield* PostCustomersCustomer({
        customer: observed.id,
        ...delta,
      });
      return toAttributes(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent: a customer that is already gone (or already
      // tombstoned) is a success, not a failure.
      yield* DeleteCustomersCustomer({ customer: output.customerId }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    }),
  });

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Retrieve a customer, mapping "does not exist" to `undefined`.
 *
 * Stripe's delete is a soft delete: `GET /v1/customers/{id}` on a destroyed
 * customer keeps returning HTTP 200, with a `DeletedCustomer` body carrying
 * only `{ id, object, deleted: true }`. Treating that as "still there" would
 * make a destroyed customer look alive forever, so it maps to `undefined`
 * exactly like a 404.
 */
const observeCustomer = Effect.fn(function* (customerId: string) {
  const response = yield* GetCustomersCustomer({ customer: customerId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    // Stripe answers a missing object with `type: invalid_request_error` and
    // `code: resource_missing`; distilled dispatches on `type` first, so the
    // 404 surfaces as `InvalidRequestError` rather than `NotFound`.
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
  if (response === undefined) return undefined;
  if ("deleted" in response) return undefined;
  return response;
});

/** Stripe search-query-language predicate matching this stack/stage/id. */
const brandingQuery = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return [
    `metadata['${ALCHEMY_STACK_KEY}']:'${stack.name}'`,
    `metadata['${ALCHEMY_STAGE_KEY}']:'${stage}'`,
    `metadata['${ALCHEMY_ID_KEY}']:'${id}'`,
  ].join(" AND ");
});

/**
 * Re-discover a customer whose state row was lost, by alchemy's metadata
 * branding.
 *
 * The search API is tried first because it is a single indexed request, but
 * its index lags writes by up to a minute (and is unavailable to some
 * accounts), so a miss falls back to a bounded, strongly-consistent walk of
 * the customer list.
 */
const findCustomerByBranding = Effect.fn(function* (id: string) {
  const query = yield* brandingQuery(id);
  const searched = yield* GetCustomersSearch({ query, limit: 100 }).pipe(
    Effect.map((page) => page.data),
    Effect.catch(() => Effect.succeed<StripeCustomerObject[]>([])),
  );
  for (const candidate of searched) {
    if (yield* isOwned(id, toMetadata(candidate.metadata))) return candidate;
  }
  const listed = yield* listAllCustomers;
  for (const candidate of listed) {
    if (yield* isOwned(id, toMetadata(candidate.metadata))) return candidate;
  }
  return undefined;
});

/** Walk `GET /v1/customers` with the `starting_after` cursor, bounded. */
const listAllCustomers = Effect.gen(function* () {
  const customers: StripeCustomerObject[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = yield* GetCustomers({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    customers.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return customers;
});

// ---------------------------------------------------------------------------
// Props -> Stripe request
// ---------------------------------------------------------------------------

const toRequestAddress = (address: CustomerAddress) => ({
  city: address.city,
  country: address.country,
  line1: address.line1,
  line2: address.line2,
  postal_code: address.postalCode,
  state: address.state,
});

const toRequestShipping = (shipping: CustomerShipping) => ({
  address: toRequestAddress(shipping.address),
  name: shipping.name,
  phone: shipping.phone,
});

/**
 * Build the `invoice_settings` payload. Sub-fields the caller dropped but
 * Stripe still has set are explicitly blanked (`""` unsets in Stripe), so the
 * nested object converges rather than accumulating stale values.
 */
const toRequestInvoiceSettings = (
  desired: CustomerInvoiceSettings,
  current: CustomerInvoiceSettings | undefined,
) => ({
  custom_fields: desired.customFields
    ? desired.customFields.map((field) => ({
        name: field.name,
        value: field.value,
      }))
    : current?.customFields
      ? ("" as const)
      : undefined,
  default_payment_method:
    desired.defaultPaymentMethod ??
    (current?.defaultPaymentMethod !== undefined ? "" : undefined),
  footer: desired.footer ?? (current?.footer !== undefined ? "" : undefined),
  rendering_options: desired.renderingOptions
    ? {
        amount_tax_display: desired.renderingOptions.amountTaxDisplay,
        template: desired.renderingOptions.template,
      }
    : current?.renderingOptions
      ? ("" as const)
      : undefined,
});

/** The full create payload for a greenfield customer. */
const createRequest = (news: CustomerProps) => ({
  address: news.address ? toRequestAddress(news.address) : undefined,
  balance: news.balance,
  description: news.description,
  email: news.email,
  invoice_prefix: news.invoicePrefix,
  invoice_settings: news.invoiceSettings
    ? toRequestInvoiceSettings(news.invoiceSettings, undefined)
    : undefined,
  name: news.name,
  next_invoice_sequence: news.nextInvoiceSequence,
  phone: news.phone,
  preferred_locales: news.preferredLocales,
  shipping: news.shipping ? toRequestShipping(news.shipping) : undefined,
  tax_exempt: news.taxExempt,
});

/**
 * Converge an observed customer onto the desired props, returning only the
 * fields that actually differ — or `undefined` when the customer is already
 * in the desired state, so reconcile can skip the API call entirely.
 */
const updateRequest = (
  current: CustomerAttributes,
  news: CustomerProps,
  observedMetadata: Metadata,
  desiredMetadata: Metadata,
): Omit<PostCustomersCustomerRequest, "customer"> | undefined => {
  const update: Omit<PostCustomersCustomerRequest, "customer"> = {};
  let changed = false;

  const email = scalarDelta(news.email, current.email);
  if (email !== undefined) {
    update.email = email;
    changed = true;
  }
  const name = scalarDelta(news.name, current.name);
  if (name !== undefined) {
    update.name = name;
    changed = true;
  }
  const description = scalarDelta(news.description, current.description);
  if (description !== undefined) {
    update.description = description;
    changed = true;
  }
  const phone = scalarDelta(news.phone, current.phone);
  if (phone !== undefined) {
    update.phone = phone;
    changed = true;
  }

  if (news.address !== undefined) {
    if (!deepEqual(news.address, current.address)) {
      update.address = toRequestAddress(news.address);
      changed = true;
    }
  } else if (current.address !== undefined) {
    update.address = "";
    changed = true;
  }

  if (news.shipping !== undefined) {
    if (!deepEqual(news.shipping, current.shipping)) {
      update.shipping = toRequestShipping(news.shipping);
      changed = true;
    }
  } else if (current.shipping !== undefined) {
    update.shipping = "";
    changed = true;
  }

  if (news.invoiceSettings !== undefined) {
    if (!deepEqual(news.invoiceSettings, current.invoiceSettings)) {
      update.invoice_settings = toRequestInvoiceSettings(
        news.invoiceSettings,
        current.invoiceSettings,
      );
      changed = true;
    }
  } else if (current.invoiceSettings !== undefined) {
    update.invoice_settings = {
      custom_fields: "",
      default_payment_method: "",
      footer: "",
      rendering_options: "",
    };
    changed = true;
  }

  // `balance`, `invoice_prefix` and `next_invoice_sequence` are only ever
  // pushed when explicitly requested. Stripe owns them otherwise — balance
  // moves with credits applied out-of-band, and the other two are
  // account-generated — so blanking them on prop removal would fight the API.
  if (news.balance !== undefined && news.balance !== current.balance) {
    update.balance = news.balance;
    changed = true;
  }
  if (
    news.invoicePrefix !== undefined &&
    news.invoicePrefix !== current.invoicePrefix
  ) {
    update.invoice_prefix = news.invoicePrefix;
    changed = true;
  }
  if (
    news.nextInvoiceSequence !== undefined &&
    news.nextInvoiceSequence !== current.nextInvoiceSequence
  ) {
    update.next_invoice_sequence = news.nextInvoiceSequence;
    changed = true;
  }

  // Stripe's form encoder drops empty arrays, so an emptied `preferredLocales`
  // cannot be pushed as a clear — only a non-empty desired list converges.
  if (
    news.preferredLocales !== undefined &&
    !deepEqual(news.preferredLocales, current.preferredLocales)
  ) {
    update.preferred_locales = news.preferredLocales;
    changed = true;
  }

  const taxExempt = news.taxExempt ?? "none";
  if (taxExempt !== current.taxExempt) {
    update.tax_exempt = taxExempt;
    changed = true;
  }

  if (!metadataEqual(observedMetadata, desiredMetadata)) {
    update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
    changed = true;
  }

  return changed ? update : undefined;
};

/**
 * The value to POST for a nullable scalar, or `undefined` when the field is
 * already converged. Stripe unsets a scalar when it is posted as `""`.
 */
const scalarDelta = (
  desired: string | undefined,
  observed: string | undefined,
): string | undefined => {
  if (desired !== undefined) return desired === observed ? undefined : desired;
  return observed !== undefined ? "" : undefined;
};

// ---------------------------------------------------------------------------
// Stripe object -> Attributes
// ---------------------------------------------------------------------------

/** Stripe metadata values are typed `string | undefined`; drop the holes. */
const toMetadata = (
  metadata: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const toAddress = (
  address: StripeAddress | null | undefined,
): CustomerAddress | undefined => {
  if (address == null) return undefined;
  const out: CustomerAddress = {};
  if (address.city != null) out.city = address.city;
  if (address.country != null) out.country = address.country;
  if (address.line1 != null) out.line1 = address.line1;
  if (address.line2 != null) out.line2 = address.line2;
  if (address.postal_code != null) out.postalCode = address.postal_code;
  if (address.state != null) out.state = address.state;
  return Object.keys(out).length === 0 ? undefined : out;
};

const toShipping = (
  shipping: StripeShipping | null | undefined,
): CustomerShipping | undefined => {
  if (shipping == null) return undefined;
  const out: CustomerShipping = {
    address: toAddress(shipping.address) ?? {},
    name: shipping.name ?? "",
  };
  if (shipping.phone != null) out.phone = shipping.phone;
  return out;
};

const toInvoiceSettings = (
  settings: InvoiceSettingCustomerSetting | null | undefined,
): CustomerInvoiceSettings | undefined => {
  if (settings == null) return undefined;
  const out: CustomerInvoiceSettings = {};
  if (settings.custom_fields != null && settings.custom_fields.length > 0) {
    out.customFields = settings.custom_fields.map((field) => ({
      name: field.name,
      value: field.value,
    }));
  }
  if (typeof settings.default_payment_method === "string") {
    out.defaultPaymentMethod = settings.default_payment_method;
  } else if (settings.default_payment_method != null) {
    out.defaultPaymentMethod = settings.default_payment_method.id;
  }
  if (settings.footer != null) out.footer = settings.footer;
  if (settings.rendering_options != null) {
    const rendering: CustomerInvoiceRenderingOptions = {};
    const display = settings.rendering_options.amount_tax_display;
    if (display === "exclude_tax" || display === "include_inclusive_tax") {
      rendering.amountTaxDisplay = display;
    }
    if (settings.rendering_options.template != null) {
      rendering.template = settings.rendering_options.template;
    }
    if (Object.keys(rendering).length > 0) out.renderingOptions = rendering;
  }
  return Object.keys(out).length === 0 ? undefined : out;
};

const toAttributes = (customer: StripeCustomerObject): CustomerAttributes => ({
  customerId: customer.id,
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  description: customer.description ?? undefined,
  phone: customer.phone ?? undefined,
  address: toAddress(customer.address),
  shipping: toShipping(customer.shipping),
  balance: customer.balance ?? 0,
  currency: customer.currency ?? undefined,
  invoicePrefix: customer.invoice_prefix ?? undefined,
  invoiceSettings: toInvoiceSettings(customer.invoice_settings),
  nextInvoiceSequence: customer.next_invoice_sequence,
  preferredLocales: customer.preferred_locales
    ? [...customer.preferred_locales]
    : [],
  taxExempt: customer.tax_exempt ?? "none",
  testClock:
    customer.test_clock == null
      ? undefined
      : typeof customer.test_clock === "string"
        ? customer.test_clock
        : customer.test_clock.id,
  delinquent: customer.delinquent ?? false,
  livemode: customer.livemode,
  created: customer.created,
  metadata: stripInternalMetadata(toMetadata(customer.metadata)),
});

// ---------------------------------------------------------------------------
// Plain-data equality
// ---------------------------------------------------------------------------

/**
 * Structural equality over the plain JSON-ish shapes this provider compares
 * (addresses, shipping, invoice settings, locale lists). Keys whose value is
 * `undefined` are treated as absent, so `{ city: undefined }` equals `{}`.
 */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((k) => left[k] !== undefined);
  const rightKeys = Object.keys(right).filter((k) => right[k] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
};
