import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteCustomer,
  GetCustomers,
  GetCustomer,
  CreateCustomer,
  UpdateCustomer,
  type Customer as StripeCustomer,
  type DeletedCustomer,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
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
import type { Providers } from "./Providers.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** A postal address. */
export interface CustomerAddress {
  line1?: string;
  line2?: string;
  city?: string;
  /** State, county, province, or region. */
  state?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 country code. */
  country?: string;
}

/** Where the customer's orders ship. */
export interface CustomerShipping {
  /** Recipient name. */
  name: string;
  address: CustomerAddress;
  /** Recipient phone number. */
  phone?: string;
}

/** Defaults for the customer's invoices. */
export interface CustomerInvoiceSettings {
  /** Up to 4 name/value fields shown on every invoice (e.g. a PO number). */
  customFields?: { name: string; value: string }[];
  /** Footer shown on every invoice. */
  footer?: string;
  /** How invoice PDFs render amounts and which template they use. */
  renderingOptions?: {
    /**
     * `exclude_tax` shows amounts without tax; `include_inclusive_tax`
     * includes inclusive tax.
     */
    amountTaxDisplay?: "exclude_tax" | "include_inclusive_tax";
    /** Invoice rendering template id (`inrtem_…`). */
    template?: string;
  };
  /**
   * Payment method (`pm_…`) charged for invoices and subscriptions.
   * Payment methods are attached at runtime, so if omitted the customer
   * keeps its current default.
   */
  defaultPaymentMethod?: string;
}

/** How funds a customer transfers are applied to payments. */
export type CustomerCashBalanceReconciliationMode = "automatic" | "manual" | "merchant_default";

export interface CustomerProps {
  /**
   * Customer's email address. Displayed in the Stripe dashboard and
   * useful for searching. At most 512 characters.
   */
  email?: string;
  /**
   * The customer's full name or business name.
   */
  name?: string;
  /**
   * An arbitrary string attached to the customer. Displayed alongside
   * the customer in the dashboard.
   */
  description?: string;
  /**
   * The customer's phone number.
   */
  phone?: string;
  /**
   * Billing address, shown on invoices and used for tax.
   */
  address?: CustomerAddress;
  /**
   * Shipping name, address, and phone.
   */
  shipping?: CustomerShipping;
  /**
   * Business name, shown on invoices.
   */
  businessName?: string;
  /**
   * Individual's full name, shown on invoices.
   */
  individualName?: string;
  /**
   * Languages for emails and invoices, in order of preference (e.g.
   * `["fr", "en"]`).
   */
  preferredLocales?: string[];
  /**
   * Tax exemption: `none`, `exempt`, or `reverse` (reverse charge).
   * @default "none"
   */
  taxExempt?: "exempt" | "none" | "reverse";
  /**
   * Prefix for invoice numbers (3–12 uppercase letters or digits), unique
   * across the account. Stripe keeps a deleted customer's prefix reserved,
   * so a replaced or recreated customer needs a new one. Stripe generates
   * a prefix, so if omitted the customer keeps its current one.
   */
  invoicePrefix?: string;
  /**
   * Lowest sequence number for the customer's next invoice. Invoices move
   * the sequence forward, so a deploy only ever raises it.
   */
  nextInvoiceSequence?: number;
  /**
   * Defaults for the customer's invoices.
   */
  invoiceSettings?: CustomerInvoiceSettings;
  /**
   * How funds the customer transfers (bank transfers) are applied:
   * `automatic`, `manual`, or `merchant_default`.
   * @default "merchant_default"
   */
  cashBalanceReconciliationMode?: CustomerCashBalanceReconciliationMode;
  /**
   * Test clock (`clock_…`) the customer belongs to, for simulating time in
   * test mode. Create-only — changing it replaces the customer.
   */
  testClock?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Customer = Resource<
  "Stripe.Customer",
  CustomerProps,
  {
    /** Stripe customer id (`cus_…`). */
    id: string;
    /** Customer's email address, if set. */
    email: string | undefined;
    /** The customer's full name or business name, if set. */
    name: string | undefined;
    /** Arbitrary description displayed in the dashboard, if set. */
    description: string | undefined;
    /** The customer's phone number, if set. */
    phone: string | undefined;
    /** Billing address, if set. */
    address: CustomerAddress | undefined;
    /** Shipping details, if set. */
    shipping: CustomerShipping | undefined;
    /** Business name, if set. */
    businessName: string | undefined;
    /** Individual's full name, if set. */
    individualName: string | undefined;
    /** Preferred languages, in order. */
    preferredLocales: string[];
    /** Tax exemption. */
    taxExempt: "exempt" | "none" | "reverse";
    /** Prefix for invoice numbers. */
    invoicePrefix: string | undefined;
    /** Sequence number of the customer's next invoice. */
    nextInvoiceSequence: number | undefined;
    /** Invoice defaults, if any are set. */
    invoiceSettings: CustomerInvoiceSettings | undefined;
    /** How transferred funds are applied, if known. */
    cashBalanceReconciliationMode: CustomerCashBalanceReconciliationMode | undefined;
    /** Test clock id, if the customer belongs to one. */
    testClock: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the customer was created. */
    created: number;
    /** Whether the customer exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  CustomerLookup
>;

/**
 * Props for {@link Customer.lookup}: find a customer this stack
 * doesn't manage by its id.
 */
export interface CustomerLookup {
  /** Stripe customer id, e.g. `"cus_A2b3C4d5E6f7G8"`. */
  id: string;
}

/**
 * A Stripe Customer — the billing identity invoices, subscriptions, and
 * Checkout sessions attach to. Every field except `testClock` updates in
 * place; a field left out is cleared, except `invoicePrefix`,
 * `nextInvoiceSequence`, and the default payment method, which Stripe
 * manages. Deleting a customer is permanent and
 * immediately cancels any active subscriptions.
 *
 * @see https://docs.stripe.com/api/customers
 *
 * ### Creating a Customer
 * **Example:** Email and name
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 *   name: "Alice Example",
 * });
 * ```
 *
 * **Example:** Description, phone, and metadata
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 *   name: "Alice Example",
 *   description: "Beta tester",
 *   phone: "+15555550100",
 *   metadata: { plan: "pro" },
 * });
 * ```
 *
 * ### Billing details and invoices
 * **Example:** Business customer with invoice defaults
 * ```typescript
 * const customer = yield* Stripe.Customer("acme", {
 *   email: "billing@acme.example",
 *   businessName: "Acme Inc",
 *   address: {
 *     line1: "123 Main Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94111",
 *     country: "US",
 *   },
 *   preferredLocales: ["en"],
 *   taxExempt: "reverse",
 *   invoicePrefix: "ACME",
 *   invoiceSettings: {
 *     footer: "Net 30",
 *     customFields: [{ name: "PO", value: "1234" }],
 *   },
 * });
 * ```
 *
 * **Example:** Customer on a test clock
 * ```typescript
 * const customer = yield* Stripe.Customer("trial-user", {
 *   email: "trial@example.com",
 *   testClock: "clock_1A2b3C4d5E6f7G8h",
 * });
 * ```
 *
 * ### Updating a Customer
 * **Example:** Change email and metadata
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice+updated@example.com",
 *   name: "Alice Example",
 *   metadata: { plan: "enterprise" },
 * });
 * ```
 *
 * ### Looking up an existing customer
 * `Customer.lookup` references a customer Alchemy doesn't manage (created in
 * the Stripe Dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing customer
 * ```typescript
 * const ref = Stripe.Customer.lookup({ id: "cus_A2b3C4d5E6f7G8" });
 * ```
 *
 * @resource
 * @product Customer
 */
export const Customer = Resource<Customer>("Stripe.Customer");

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const isDeletedCustomer = (value: StripeCustomer | DeletedCustomer): value is DeletedCustomer =>
  "deleted" in value && value.deleted === true;

const asCustomer = (
  value: StripeCustomer | DeletedCustomer | undefined,
): StripeCustomer | undefined => {
  if (value === undefined || isDeletedCustomer(value)) return undefined;
  return value;
};

type WireAddress = {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
};

const fromWireAddress = (address: WireAddress | null | undefined): CustomerAddress | undefined => {
  if (address == null) return undefined;
  const result: CustomerAddress = {
    ...(address.line1 ? { line1: address.line1 } : {}),
    ...(address.line2 ? { line2: address.line2 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.postal_code ? { postalCode: address.postal_code } : {}),
    ...(address.country ? { country: address.country } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
};

const toWireAddress = (address: CustomerAddress) => ({
  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.city !== undefined ? { city: address.city } : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
  ...(address.postalCode !== undefined ? { postal_code: address.postalCode } : {}),
  ...(address.country !== undefined ? { country: address.country } : {}),
});

const fromWireShipping = (shipping: StripeCustomer["shipping"]): CustomerShipping | undefined => {
  if (shipping == null) return undefined;
  return {
    name: shipping.name ?? "",
    address: fromWireAddress(shipping.address) ?? {},
    ...(shipping.phone ? { phone: shipping.phone } : {}),
  };
};

const toWireShipping = (shipping: CustomerShipping) => ({
  name: shipping.name,
  address: toWireAddress(shipping.address),
  ...(shipping.phone !== undefined ? { phone: shipping.phone } : {}),
});

const idOf = (value: string | { readonly id: string } | null | undefined) =>
  value == null ? undefined : typeof value === "string" ? value : value.id;

/** The invoice settings the props manage; Stripe-set defaults read as unset. */
const fromWireInvoiceSettings = (
  settings: StripeCustomer["invoice_settings"],
): CustomerInvoiceSettings | undefined => {
  if (settings == null) return undefined;
  const rendering = settings.rendering_options;
  const renderingOptions =
    rendering == null
      ? undefined
      : {
          ...(rendering.amount_tax_display
            ? {
                amountTaxDisplay: rendering.amount_tax_display as NonNullable<
                  CustomerInvoiceSettings["renderingOptions"]
                >["amountTaxDisplay"],
              }
            : {}),
          ...(rendering.template ? { template: rendering.template } : {}),
        };
  const defaultPaymentMethod = idOf(settings.default_payment_method);
  const result: CustomerInvoiceSettings = {
    ...(settings.custom_fields != null && settings.custom_fields.length > 0
      ? {
          customFields: settings.custom_fields.map((field) => ({
            name: field.name,
            value: field.value,
          })),
        }
      : {}),
    ...(settings.footer ? { footer: settings.footer } : {}),
    ...(renderingOptions !== undefined && Object.keys(renderingOptions).length > 0
      ? { renderingOptions }
      : {}),
    ...(defaultPaymentMethod !== undefined ? { defaultPaymentMethod } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
};

/** Settings Alchemy converges; `defaultPaymentMethod` is left to runtime unless set. */
const managedInvoiceSettings = (
  settings: CustomerInvoiceSettings | undefined,
  desired: CustomerInvoiceSettings | undefined,
) => {
  const { defaultPaymentMethod, ...rest } = settings ?? {};
  return desired?.defaultPaymentMethod !== undefined ? { ...rest, defaultPaymentMethod } : rest;
};

const toWireInvoiceSettings = (settings: CustomerInvoiceSettings | undefined) => ({
  custom_fields:
    settings?.customFields !== undefined && settings.customFields.length > 0
      ? settings.customFields
      : ("" as const),
  footer: settings?.footer ?? "",
  rendering_options:
    settings?.renderingOptions !== undefined
      ? {
          ...(settings.renderingOptions.amountTaxDisplay !== undefined
            ? { amount_tax_display: settings.renderingOptions.amountTaxDisplay }
            : {}),
          ...(settings.renderingOptions.template !== undefined
            ? { template: settings.renderingOptions.template }
            : {}),
        }
      : ("" as const),
  ...(settings?.defaultPaymentMethod !== undefined
    ? { default_payment_method: settings.defaultPaymentMethod }
    : {}),
});

const toAttrs = (customer: StripeCustomer) => ({
  id: customer.id,
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  description: customer.description ?? undefined,
  phone: customer.phone ?? undefined,
  address: fromWireAddress(customer.address),
  shipping: fromWireShipping(customer.shipping),
  businessName: customer.business_name || undefined,
  individualName: customer.individual_name || undefined,
  preferredLocales: [...(customer.preferred_locales ?? [])],
  taxExempt: (customer.tax_exempt ?? "none") as "exempt" | "none" | "reverse",
  invoicePrefix: customer.invoice_prefix ?? undefined,
  nextInvoiceSequence: customer.next_invoice_sequence,
  invoiceSettings: fromWireInvoiceSettings(customer.invoice_settings),
  cashBalanceReconciliationMode: customer.cash_balance?.settings.reconciliation_mode as
    | CustomerCashBalanceReconciliationMode
    | undefined,
  testClock: idOf(customer.test_clock),
  metadata: userMetadata(customer.metadata),
  created: customer.created,
  livemode: customer.livemode,
});

const isMissingCustomer = isMissingStripeResource;

// `cash_balance` is only returned when expanded.
const CUSTOMER_EXPAND = ["cash_balance"];

const getById = (customer: string) =>
  GetCustomer({ customer, expand: CUSTOMER_EXPAND }).pipe(
    Effect.map(asCustomer),
    Effect.catchIf(isMissingCustomer, () => Effect.undefined),
  );

const listAllCustomers = Effect.fn(function* () {
  const customers: StripeCustomer[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetCustomers({
      limit: LIST_PAGE_SIZE,
      expand: CUSTOMER_EXPAND.map((field) => `data.${field}`),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    customers.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return customers;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const customers = yield* listAllCustomers();
  const matches: StripeCustomer[] = [];
  for (const customer of customers) {
    if (yield* hasAlchemyMetadata(id, tagRecord(customer.metadata))) {
      matches.push(customer);
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

export const CustomerProvider = () =>
  Provider.succeed(Customer, {
    stables: ["id", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && (news.testClock ?? undefined) !== output.testClock) {
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
      const customers = yield* listAllCustomers();
      return customers
        .filter((customer) => {
          const metadata = tagRecord(customer.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredEmail = news.email ?? "";
      const desiredName = news.name ?? "";
      const desiredDescription = news.description ?? "";
      const desiredPhone = news.phone ?? "";

      const desiredTaxExempt = news.taxExempt ?? "none";
      const desiredLocales = news.preferredLocales ?? [];
      const desiredCashMode = news.cashBalanceReconciliationMode ?? "merchant_default";

      let current: StripeCustomer | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A customer can't move to another test clock.
      if (current !== undefined && idOf(current.test_clock) !== (news.testClock ?? undefined)) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateCustomer({
          ...(desiredEmail.length > 0 ? { email: desiredEmail } : {}),
          ...(desiredName.length > 0 ? { name: desiredName } : {}),
          ...(desiredDescription.length > 0 ? { description: desiredDescription } : {}),
          ...(desiredPhone.length > 0 ? { phone: desiredPhone } : {}),
          ...(news.address !== undefined ? { address: toWireAddress(news.address) } : {}),
          ...(news.shipping !== undefined ? { shipping: toWireShipping(news.shipping) } : {}),
          ...(news.businessName !== undefined ? { business_name: news.businessName } : {}),
          ...(news.individualName !== undefined ? { individual_name: news.individualName } : {}),
          ...(desiredLocales.length > 0 ? { preferred_locales: desiredLocales } : {}),
          ...(news.taxExempt !== undefined ? { tax_exempt: news.taxExempt } : {}),
          ...(news.invoicePrefix !== undefined ? { invoice_prefix: news.invoicePrefix } : {}),
          ...(news.nextInvoiceSequence !== undefined
            ? { next_invoice_sequence: news.nextInvoiceSequence }
            : {}),
          ...(news.invoiceSettings !== undefined
            ? { invoice_settings: toWireInvoiceSettings(news.invoiceSettings) }
            : {}),
          ...(news.cashBalanceReconciliationMode !== undefined
            ? {
                cash_balance: {
                  settings: { reconciliation_mode: news.cashBalanceReconciliationMode },
                },
              }
            : {}),
          ...(news.testClock !== undefined ? { test_clock: news.testClock } : {}),
          expand: CUSTOMER_EXPAND,
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-customer-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const emailChanged = (current.email ?? "") !== desiredEmail;
      const nameChanged = (current.name ?? "") !== desiredName;
      const descriptionChanged = (current.description ?? "") !== desiredDescription;
      const phoneChanged = (current.phone ?? "") !== desiredPhone;
      const observed = toAttrs(current);
      const addressChanged = !deepEqual(observed.address, news.address);
      const shippingChanged = !deepEqual(observed.shipping, news.shipping);
      const businessNameChanged = observed.businessName !== news.businessName;
      const individualNameChanged = observed.individualName !== news.individualName;
      const localesChanged = !deepEqual(observed.preferredLocales, desiredLocales);
      const taxExemptChanged = observed.taxExempt !== desiredTaxExempt;
      const invoicePrefixChanged =
        news.invoicePrefix !== undefined && observed.invoicePrefix !== news.invoicePrefix;
      const sequenceRaised =
        news.nextInvoiceSequence !== undefined &&
        (observed.nextInvoiceSequence ?? 0) < news.nextInvoiceSequence;
      const invoiceSettingsChanged = !deepEqual(
        managedInvoiceSettings(observed.invoiceSettings, news.invoiceSettings),
        managedInvoiceSettings(news.invoiceSettings, news.invoiceSettings),
      );
      const cashModeChanged =
        (observed.cashBalanceReconciliationMode ?? "merchant_default") !== desiredCashMode;

      if (
        !emailChanged &&
        !nameChanged &&
        !descriptionChanged &&
        !phoneChanged &&
        !addressChanged &&
        !shippingChanged &&
        !businessNameChanged &&
        !individualNameChanged &&
        !localesChanged &&
        !taxExemptChanged &&
        !invoicePrefixChanged &&
        !sequenceRaised &&
        !invoiceSettingsChanged &&
        !cashModeChanged &&
        !metadataChanged
      ) {
        return observed;
      }

      const updated = yield* UpdateCustomer({
        customer: current.id,
        expand: CUSTOMER_EXPAND,
        ...(emailChanged ? { email: desiredEmail } : {}),
        ...(nameChanged ? { name: desiredName } : {}),
        ...(descriptionChanged ? { description: desiredDescription } : {}),
        ...(phoneChanged ? { phone: desiredPhone } : {}),
        ...(addressChanged
          ? { address: news.address !== undefined ? toWireAddress(news.address) : "" }
          : {}),
        ...(shippingChanged
          ? { shipping: news.shipping !== undefined ? toWireShipping(news.shipping) : "" }
          : {}),
        ...(businessNameChanged ? { business_name: news.businessName ?? "" } : {}),
        ...(individualNameChanged ? { individual_name: news.individualName ?? "" } : {}),
        ...(localesChanged
          ? { preferred_locales: desiredLocales.length > 0 ? desiredLocales : ("" as const) }
          : {}),
        ...(taxExemptChanged ? { tax_exempt: desiredTaxExempt } : {}),
        ...(invoicePrefixChanged ? { invoice_prefix: news.invoicePrefix } : {}),
        ...(sequenceRaised ? { next_invoice_sequence: news.nextInvoiceSequence } : {}),
        ...(invoiceSettingsChanged
          ? { invoice_settings: toWireInvoiceSettings(news.invoiceSettings) }
          : {}),
        ...(cashModeChanged
          ? { cash_balance: { settings: { reconciliation_mode: desiredCashMode } } }
          : {}),
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
      yield* DeleteCustomer({ customer: output.id }).pipe(
        Effect.catchIf(isMissingCustomer, () => Effect.void),
      );
    }),
  });
