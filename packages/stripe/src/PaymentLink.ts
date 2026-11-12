import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPaymentLinks,
  GetPaymentLink,
  GetPaymentLinkLineItems,
  CreatePaymentLink,
  UpdatePaymentLink,
  type Item as StripeLineItem,
  type PaymentLink as StripePaymentLink,
  type CreatePaymentLinkRequest,
  type CreatePaymentLinkRequestAfterCompletion,
  type CreatePaymentLinkRequestLineItemsItem,
  type UpdatePaymentLinkRequest,
  type UpdatePaymentLinkRequestAfterCompletion,
  type UpdatePaymentLinkRequestLineItemsItem,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import { subsetDiffers } from "alchemy/Util/equal";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { fromWire, toWire } from "./internal/case.ts";
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

export type PaymentLinkBillingAddressCollection = "auto" | "required";
export type PaymentLinkCustomerCreation = "always" | "if_required";
export type PaymentLinkPaymentMethodCollection = "always" | "if_required";
export type PaymentLinkSubmitType = "auto" | "book" | "donate" | "pay" | "subscribe";
export type PaymentLinkAfterCompletionType = "hosted_confirmation" | "redirect";

export interface PaymentLinkLineItemAdjustableQuantity {
  /**
   * When true, the customer can change this item's quantity at checkout.
   */
  enabled: boolean;
  /**
   * Minimum quantity the customer can purchase. Defaults to `0`.
   */
  minimum?: number;
  /**
   * Maximum quantity the customer can purchase. Defaults to `99`.
   */
  maximum?: number;
}

export interface PaymentLinkLineItem {
  /**
   * Stripe Price id (`price_…`). Changing the set of prices replaces
   * the payment link — existing items can only change quantity.
   */
  price: string;
  /**
   * Quantity of this line item. Mutable for existing items.
   */
  quantity: number;
  /**
   * When set, the customer can adjust quantity during checkout.
   */
  adjustableQuantity?: PaymentLinkLineItemAdjustableQuantity;
}

export interface PaymentLinkAfterCompletionHostedConfirmation {
  /**
   * Custom message shown on Stripe's hosted confirmation page.
   */
  customMessage?: string;
}

export interface PaymentLinkAfterCompletionRedirect {
  /**
   * URL the customer is sent to after purchase. `{CHECKOUT_SESSION_ID}`
   * is substituted with the completed session id.
   */
  url: string;
}

export interface PaymentLinkAfterCompletion {
  /**
   * `hosted_confirmation` shows Stripe's confirmation page;
   * `redirect` sends the customer to `redirect.url`.
   */
  type: PaymentLinkAfterCompletionType;
  /**
   * Configuration when `type` is `hosted_confirmation`.
   */
  hostedConfirmation?: PaymentLinkAfterCompletionHostedConfirmation;
  /**
   * Configuration when `type` is `redirect`.
   */
  redirect?: PaymentLinkAfterCompletionRedirect;
}

/** Calculates tax with Stripe Tax at checkout. */
export interface PaymentLinkAutomaticTax {
  enabled: boolean;
  /** Which account is liable for the tax: this account (`self`) or a connected `account`. */
  liability?: { type: "account" | "self"; account?: string };
}

/** Consents Checkout collects. */
export interface PaymentLinkConsentCollection {
  /** `auto` asks for consent to promotional emails where required. */
  promotions?: "auto" | "none";
  /** `required` makes the customer accept your terms of service. */
  termsOfService?: "none" | "required";
  /** Where the agreement to reuse a saved payment method is shown. */
  paymentMethodReuseAgreement?: { position: "auto" | "hidden" };
}

/** Length bounds and default for a text or numeric custom field. */
export interface PaymentLinkCustomFieldInput {
  minimumLength?: number;
  maximumLength?: number;
  defaultValue?: string;
}

/** An extra field the customer fills in at checkout (up to 3). */
export interface PaymentLinkCustomField {
  /** Key the answer is stored under on the Checkout Session (alphanumeric, up to 200 characters). */
  key: string;
  /** Label shown to the customer (up to 50 characters). */
  label: string;
  /** `text`, `numeric`, or `dropdown`. */
  type: "dropdown" | "numeric" | "text";
  /** Whether the customer may leave it empty. @default false */
  optional?: boolean;
  /** Choices for a `dropdown` field. */
  dropdown?: { options: { label: string; value: string }[]; defaultValue?: string };
  /** Bounds for a `numeric` field. */
  numeric?: PaymentLinkCustomFieldInput;
  /** Bounds for a `text` field. */
  text?: PaymentLinkCustomFieldInput;
}

/** Extra text shown on the Checkout page (up to 1200 characters each). */
export interface PaymentLinkCustomText {
  /** Shown after the payment confirmation button. */
  afterSubmit?: string;
  /** Shown next to the shipping address form. */
  shippingAddress?: string;
  /** Shown next to the payment confirmation button. */
  submit?: string;
  /** Replaces the default terms of service agreement text. */
  termsOfServiceAcceptance?: string;
}

/** Fields shown on an invoice. */
export interface PaymentLinkInvoiceFields {
  /** Tax ids (`txi_…`) shown on the invoice. */
  accountTaxIds?: string[];
  /** Up to 4 name/value fields shown on the invoice. */
  customFields?: { name: string; value: string }[];
  /** Invoice description. */
  description?: string;
  /** Invoice footer. */
  footer?: string;
  /** Which account issues the invoice: this account (`self`) or a connected `account`. */
  issuer?: { type: "account" | "self"; account?: string };
  /** Metadata copied onto the invoice. */
  metadata?: Record<string, string>;
  /** How the invoice PDF shows amounts relative to tax. */
  renderingOptions?: { amountTaxDisplay?: "exclude_tax" | "include_inclusive_tax" };
}

/** Sends a post-payment invoice for one-time payments. */
export interface PaymentLinkInvoiceCreation {
  enabled: boolean;
  invoiceData?: PaymentLinkInvoiceFields;
}

/** Collects the customer's business or individual name. */
export interface PaymentLinkNameCollection {
  business?: { enabled: boolean; optional?: boolean };
  individual?: { enabled: boolean; optional?: boolean };
}

/** Options passed to the PaymentIntent of a one-time payment. */
export interface PaymentLinkPaymentIntentData {
  /**
   * When funds are captured: `automatic`, `automatic_async`, or `manual`.
   * Create-only — changing it replaces the payment link.
   */
  captureMethod?: "automatic" | "automatic_async" | "manual";
  /** Description on the PaymentIntent. */
  description?: string;
  /** Metadata copied onto the PaymentIntent. */
  metadata?: Record<string, string>;
  /** Save the payment method for later `on_session` or `off_session` use. */
  setupFutureUsage?: "off_session" | "on_session";
  /** Full card statement descriptor for card payments (up to 22 characters). */
  statementDescriptor?: string;
  /** Suffix appended to the account's statement descriptor. */
  statementDescriptorSuffix?: string;
  /** Groups the payment with related transfers. */
  transferGroup?: string;
}

/** Options for subscriptions this link starts. */
export interface PaymentLinkSubscriptionData {
  /**
   * Subscription description shown in the customer portal. Create-only —
   * changing it replaces the payment link.
   */
  description?: string;
  /** Who issues the subscription's invoices. */
  invoiceSettings?: { issuer?: { type: "account" | "self"; account?: string } };
  /** Metadata copied onto the subscription. */
  metadata?: Record<string, string>;
  /** Free trial length in days. */
  trialPeriodDays?: number;
  /** What happens when the trial ends without a payment method. */
  trialSettings?: {
    endBehavior: { missingPaymentMethod: "cancel" | "create_invoice" | "pause" };
  };
}

export interface PaymentLinkProps {
  /**
   * Line items sold by this payment link. At least one is required.
   * Changing the set of prices replaces the link; quantity and
   * `adjustableQuantity` of existing items update in place.
   */
  lineItems: PaymentLinkLineItem[];
  /**
   * Whether the payment link URL is active. When `false`, visitors see
   * a deactivated page (and `inactiveMessage` if set).
   * @default true
   */
  active?: boolean;
  /**
   * Whether customers can enter promotion codes at checkout.
   * @default false
   */
  allowPromotionCodes?: boolean;
  /**
   * How Checkout collects a billing address. `auto` collects one when
   * needed (tax, shipping); `required` always collects it.
   * @default "auto"
   */
  billingAddressCollection?: PaymentLinkBillingAddressCollection;
  /**
   * Behavior after the purchase completes.
   */
  afterCompletion?: PaymentLinkAfterCompletion;
  /**
   * Custom message shown when the payment link is inactive.
   */
  inactiveMessage?: string;
  /**
   * Submit-button copy and `buy.stripe.com` / `donate.stripe.com`
   * hostname. `auto` infers from the line items.
   * @default "auto"
   */
  submitType?: PaymentLinkSubmitType;
  /**
   * Whether Checkout Sessions created by this link also create a
   * Customer. `if_required` only creates one when needed.
   * @default "if_required"
   */
  customerCreation?: PaymentLinkCustomerCreation;
  /**
   * Whether Checkout collects a payment method. `if_required` skips
   * collection when the total due is 0 (subscription mode only).
   * @default "always"
   */
  paymentMethodCollection?: PaymentLinkPaymentMethodCollection;
  /**
   * When true, Checkout collects a phone number.
   * @default false
   */
  phoneNumberCollection?: boolean;
  /**
   * Three-letter currency code, when the prices offer several currencies.
   * Create-only — changing it replaces the payment link.
   */
  currency?: string;
  /**
   * Calculate tax with Stripe Tax. Requires Stripe Tax to be set up.
   */
  automaticTax?: PaymentLinkAutomaticTax;
  /**
   * Consents Checkout collects (promotional emails, terms of service).
   */
  consentCollection?: PaymentLinkConsentCollection;
  /**
   * Up to 3 extra fields the customer fills in at checkout.
   */
  customFields?: PaymentLinkCustomField[];
  /**
   * Extra text shown on the Checkout page.
   */
  customText?: PaymentLinkCustomText;
  /**
   * Send a post-payment invoice for one-time payments.
   */
  invoiceCreation?: PaymentLinkInvoiceCreation;
  /**
   * Collect the customer's business or individual name.
   */
  nameCollection?: PaymentLinkNameCollection;
  /**
   * Items the customer may add at checkout (up to 10).
   */
  optionalItems?: PaymentLinkLineItem[];
  /**
   * Options for the PaymentIntent of a one-time payment.
   */
  paymentIntentData?: PaymentLinkPaymentIntentData;
  /**
   * Card brands to refuse, e.g. `{ card: { restrictions: { brandsBlocked: ["american_express"] } } }`.
   */
  paymentMethodOptions?: { card?: { restrictions?: { brandsBlocked?: string[] } } };
  /**
   * Payment method types Checkout offers (e.g. `["card"]`). If omitted,
   * Stripe picks from your payment method settings.
   */
  paymentMethodTypes?: string[];
  /**
   * Deactivate the link after this many completed checkouts.
   */
  restrictions?: { completedSessions: { limit: number } };
  /**
   * Collect a shipping address in these countries (ISO 3166-1 alpha-2).
   */
  shippingAddressCollection?: { allowedCountries: string[] };
  /**
   * Shipping rates (`shr_…`) the customer can choose from.
   */
  shippingOptions?: { shippingRate: string }[];
  /**
   * Options for subscriptions this link starts.
   */
  subscriptionData?: PaymentLinkSubscriptionData;
  /**
   * Collect the customer's tax id. `required: "if_supported"` makes it
   * mandatory where Stripe supports it.
   */
  taxIdCollection?: { enabled: boolean; required?: "if_supported" | "never" };
  /**
   * Connect: the account the payments are made on behalf of.
   */
  onBehalfOf?: string;
  /**
   * Connect: transfer funds to a connected account after each payment.
   */
  transferData?: { destination: string; amount?: number };
  /**
   * Connect: fee in minor units taken from each one-time payment.
   */
  applicationFeeAmount?: number;
  /**
   * Connect: percentage fee taken from each subscription payment.
   */
  applicationFeePercent?: number;
  /**
   * Use Stripe Managed Payments, Stripe's merchant of record. Create-only —
   * changing it replaces the payment link.
   */
  managedPayments?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Copied onto Checkout Sessions created by this link.
   */
  metadata?: Record<string, string>;
}

export type PaymentLink = Resource<
  "Stripe.PaymentLink",
  PaymentLinkProps,
  {
    /** Stripe payment link id (`plink_…`). */
    id: string;
    /** Public URL customers open to pay. */
    url: string;
    /** Whether the payment link URL is active. */
    active: boolean;
    /** Line items sold by this payment link. */
    lineItems: PaymentLinkLineItem[];
    /** Whether customers can enter promotion codes at checkout. */
    allowPromotionCodes: boolean;
    /** How Checkout collects a billing address. */
    billingAddressCollection: PaymentLinkBillingAddressCollection;
    /** Behavior after the purchase completes. */
    afterCompletion: PaymentLinkAfterCompletion;
    /** Custom message shown when the payment link is inactive. */
    inactiveMessage: string | undefined;
    /** Submit-button copy / hostname hint. */
    submitType: PaymentLinkSubmitType;
    /** Whether Checkout Sessions create a Customer. */
    customerCreation: PaymentLinkCustomerCreation;
    /** Whether Checkout collects a payment method. */
    paymentMethodCollection: PaymentLinkPaymentMethodCollection;
    /** Whether Checkout collects a phone number. */
    phoneNumberCollection: boolean;
    /** Three-letter ISO currency code. */
    currency: string;
    /** Stripe Tax settings. */
    automaticTax: PaymentLinkAutomaticTax | undefined;
    /** Consents Checkout collects, if any. */
    consentCollection: PaymentLinkConsentCollection | undefined;
    /** Extra fields the customer fills in at checkout. */
    customFields: PaymentLinkCustomField[];
    /** Extra text shown on the Checkout page. */
    customText: PaymentLinkCustomText;
    /** Post-payment invoice settings, if set. */
    invoiceCreation: PaymentLinkInvoiceCreation | undefined;
    /** Name collection settings, if set. */
    nameCollection: PaymentLinkNameCollection | undefined;
    /** Items the customer may add at checkout. */
    optionalItems: PaymentLinkLineItem[];
    /** PaymentIntent options, if set. */
    paymentIntentData: PaymentLinkPaymentIntentData | undefined;
    /** Payment method options, if set. */
    paymentMethodOptions: PaymentLinkProps["paymentMethodOptions"];
    /** Payment method types Checkout offers, if restricted. */
    paymentMethodTypes: string[] | undefined;
    /** Completed-checkout limit and how many checkouts have completed, if set. */
    restrictions: { completedSessions: { limit: number; count: number } } | undefined;
    /** Countries a shipping address is collected in, if set. */
    shippingAddressCollection: PaymentLinkProps["shippingAddressCollection"];
    /** Shipping rates the customer can choose from. */
    shippingOptions: { shippingRate: string }[];
    /** Subscription options, if set. */
    subscriptionData: PaymentLinkSubscriptionData | undefined;
    /** Tax id collection settings. */
    taxIdCollection: PaymentLinkProps["taxIdCollection"];
    /** Connect: the account payments are made on behalf of, if set. */
    onBehalfOf: string | undefined;
    /** Connect: transfer settings, if set. */
    transferData: PaymentLinkProps["transferData"];
    /** Connect: fee per one-time payment, if set. */
    applicationFeeAmount: number | undefined;
    /** Connect: fee percentage per subscription payment, if set. */
    applicationFeePercent: number | undefined;
    /** Whether Stripe Managed Payments is enabled. */
    managedPayments: boolean;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Whether the payment link exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  PaymentLinkLookup
>;

/**
 * Props for {@link PaymentLink.lookup}: find a payment link this stack
 * doesn't manage by its id.
 */
export interface PaymentLinkLookup {
  /** Stripe payment link id, e.g. `"plink_1A2b3C4d5E6f7G8h"`. */
  id: string;
}

/**
 * A Stripe Payment Link — a shareable URL that opens a hosted Checkout
 * page. Requires at least one `lineItems` price. Quantity, metadata,
 * `active`, and most Checkout options update in place; changing the set
 * of prices, `currency`, `managedPayments`, `subscriptionData.description`,
 * or `paymentIntentData.captureMethod` replaces the link, which gives it a
 * new URL. Options left out keep their current value. Payment links cannot be deleted; destroy
 * deactivates them (`active=false`).
 *
 * @see https://docs.stripe.com/api/payment_links
 *
 * ### Creating a Payment Link
 * **Example:** One-time price
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const price = yield* Stripe.Price("pro-once", {
 *   product: product.id,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 * });
 * ```
 *
 * **Example:** Promotion codes and a confirmation message
 * ```typescript
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 *   allowPromotionCodes: true,
 *   afterCompletion: {
 *     type: "hosted_confirmation",
 *     hostedConfirmation: { customMessage: "Thanks for your order." },
 *   },
 *   metadata: { campaign: "launch" },
 * });
 * ```
 *
 * ### Checkout options
 * **Example:** Shipping, custom fields, and a session limit
 * ```typescript
 * const ground = yield* Stripe.ShippingRate("ground", {
 *   displayName: "Ground",
 *   amount: 500,
 *   currency: "usd",
 * });
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 *   shippingAddressCollection: { allowedCountries: ["US", "CA"] },
 *   shippingOptions: [{ shippingRate: ground.id }],
 *   customFields: [{ key: "company", label: "Company", type: "text", optional: true }],
 *   customText: { submit: "We ship within two days." },
 *   taxIdCollection: { enabled: true },
 *   restrictions: { completedSessions: { limit: 100 } },
 * });
 * ```
 *
 * **Example:** Subscription with a free trial
 * ```typescript
 * const link = yield* Stripe.PaymentLink("subscribe", {
 *   lineItems: [{ price: monthly.id, quantity: 1 }],
 *   subscriptionData: {
 *     trialPeriodDays: 14,
 *     trialSettings: { endBehavior: { missingPaymentMethod: "cancel" } },
 *     metadata: { plan: "pro" },
 *   },
 * });
 * ```
 *
 * **Example:** Post-payment invoice and an optional add-on
 * ```typescript
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 *   optionalItems: [{ price: addOn.id, quantity: 1 }],
 *   invoiceCreation: { enabled: true, invoiceData: { footer: "Thanks!" } },
 * });
 * ```
 *
 * ### Updating a Payment Link
 * **Example:** Quantity, metadata, and deactivate
 * ```typescript
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 2 }],
 *   active: false,
 *   inactiveMessage: "This link is no longer available.",
 *   metadata: { campaign: "paused" },
 * });
 * ```
 *
 * ### Looking up an existing payment link
 * `PaymentLink.lookup` references a payment link Alchemy doesn't manage (created in
 * the Stripe Dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing payment link
 * ```typescript
 * const ref = Stripe.PaymentLink.lookup({ id: "plink_1A2b3C4d5E6f7G8h" });
 * ```
 *
 * @resource
 * @product Checkout
 */
export const PaymentLink = Resource<PaymentLink>("Stripe.PaymentLink");

export class PaymentLinkNotResolved extends Data.TaggedError("Stripe.PaymentLinkNotResolved")<{
  lineItems: PaymentLinkLineItem[];
}> {}

type PaymentLinkAttributes = PaymentLink["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const priceIdOf = (
  price: StripeLineItem["price"] | string | null | undefined,
): string | undefined => {
  if (price == null) return undefined;
  if (typeof price === "string") return price;
  return price.id;
};

const fromObservedAdjustableQuantity = (
  value: StripeLineItem["adjustable_quantity"],
): PaymentLinkLineItemAdjustableQuantity | undefined => {
  if (value == null) return undefined;
  return {
    enabled: value.enabled,
    ...(value.minimum != null ? { minimum: value.minimum } : {}),
    ...(value.maximum != null ? { maximum: value.maximum } : {}),
  };
};

const fromObservedLineItems = (
  items: ReadonlyArray<StripeLineItem> | undefined,
): PaymentLinkLineItem[] => {
  if (items === undefined) return [];
  const out: PaymentLinkLineItem[] = [];
  for (const item of items) {
    const price = priceIdOf(item.price);
    if (price === undefined) continue;
    const adjustableQuantity = fromObservedAdjustableQuantity(item.adjustable_quantity);
    out.push({
      price,
      quantity: item.quantity ?? 1,
      ...(adjustableQuantity !== undefined ? { adjustableQuantity } : {}),
    });
  }
  return out;
};

const fromObservedAfterCompletion = (
  value: StripePaymentLink["after_completion"],
): PaymentLinkAfterCompletion => ({
  type: value.type,
  ...(value.hosted_confirmation !== undefined
    ? {
        hostedConfirmation:
          value.hosted_confirmation.custom_message != null
            ? { customMessage: value.hosted_confirmation.custom_message }
            : {},
      }
    : {}),
  ...(value.redirect !== undefined ? { redirect: { url: value.redirect.url } } : {}),
});

const toWireAfterCompletion = (
  value: PaymentLinkAfterCompletion,
): CreatePaymentLinkRequestAfterCompletion => ({
  type: value.type,
  ...(value.type === "hosted_confirmation"
    ? {
        hosted_confirmation:
          value.hostedConfirmation?.customMessage !== undefined
            ? { custom_message: value.hostedConfirmation.customMessage }
            : {},
      }
    : {}),
  ...(value.type === "redirect" && value.redirect !== undefined
    ? { redirect: { url: value.redirect.url } }
    : {}),
});

const toWireCreateLineItems = (
  items: PaymentLinkLineItem[],
): CreatePaymentLinkRequestLineItemsItem[] =>
  items.map((item) => ({
    price: item.price,
    quantity: item.quantity,
    ...(item.adjustableQuantity !== undefined
      ? {
          adjustable_quantity: {
            enabled: item.adjustableQuantity.enabled,
            ...(item.adjustableQuantity.minimum !== undefined
              ? { minimum: item.adjustableQuantity.minimum }
              : {}),
            ...(item.adjustableQuantity.maximum !== undefined
              ? { maximum: item.adjustableQuantity.maximum }
              : {}),
          },
        }
      : {}),
  }));

const idOf = (value: string | { readonly id: string } | null | undefined) =>
  value == null ? undefined : typeof value === "string" ? value : value.id;

const fromWireCustomFields = (
  fields: StripePaymentLink["custom_fields"],
): PaymentLinkCustomField[] =>
  fields.map((field) => ({
    key: field.key,
    label: field.label.custom ?? "",
    type: field.type as PaymentLinkCustomField["type"],
    optional: field.optional,
    ...(field.dropdown != null
      ? { dropdown: fromWire<PaymentLinkCustomField["dropdown"]>(field.dropdown) }
      : {}),
    ...(field.numeric != null
      ? { numeric: fromWire<PaymentLinkCustomFieldInput>(field.numeric) }
      : {}),
    ...(field.text != null ? { text: fromWire<PaymentLinkCustomFieldInput>(field.text) } : {}),
  }));

const toWireCustomFields = (fields: PaymentLinkCustomField[]) =>
  fields.map((field) => ({
    key: field.key,
    label: { type: "custom", custom: field.label },
    type: field.type,
    ...(field.optional !== undefined ? { optional: field.optional } : {}),
    ...(field.dropdown !== undefined ? { dropdown: toWire(field.dropdown) } : {}),
    ...(field.numeric !== undefined ? { numeric: toWire(field.numeric) } : {}),
    ...(field.text !== undefined ? { text: toWire(field.text) } : {}),
  }));

const customTextKeys = [
  "afterSubmit",
  "shippingAddress",
  "submit",
  "termsOfServiceAcceptance",
] as const;

const fromWireCustomText = (text: StripePaymentLink["custom_text"]): PaymentLinkCustomText => {
  const camel =
    fromWire<Partial<Record<(typeof customTextKeys)[number], { message?: string }>>>(text);
  return Object.fromEntries(
    customTextKeys.flatMap((key) => {
      const message = camel[key]?.message;
      return message !== undefined ? [[key, message]] : [];
    }),
  );
};

const toWireCustomText = (text: PaymentLinkCustomText) =>
  toWire(
    Object.fromEntries(
      customTextKeys.flatMap((key) => {
        const message = text[key];
        return message !== undefined ? [[key, { message }]] : [];
      }),
    ),
  );

/** The Checkout options the props manage, as observed on the link. */
const observedOptions = (link: StripePaymentLink) => ({
  automaticTax: fromWire<PaymentLinkAutomaticTax | undefined>(link.automatic_tax),
  consentCollection: fromWire<PaymentLinkConsentCollection | undefined>(link.consent_collection),
  customFields: fromWireCustomFields(link.custom_fields),
  customText: fromWireCustomText(link.custom_text),
  invoiceCreation: fromWire<PaymentLinkInvoiceCreation | undefined>(link.invoice_creation),
  nameCollection: fromWire<PaymentLinkNameCollection | undefined>(link.name_collection),
  optionalItems: fromWire<PaymentLinkLineItem[] | undefined>(link.optional_items) ?? [],
  paymentIntentData: fromWire<PaymentLinkPaymentIntentData | undefined>(link.payment_intent_data),
  paymentMethodOptions: fromWire<PaymentLinkProps["paymentMethodOptions"]>(
    link.payment_method_options,
  ),
  paymentMethodTypes: link.payment_method_types ?? undefined,
  restrictions: fromWire<PaymentLinkAttributes["restrictions"]>(link.restrictions),
  shippingAddressCollection: fromWire<PaymentLinkProps["shippingAddressCollection"]>(
    link.shipping_address_collection,
  ),
  shippingOptions: link.shipping_options.flatMap((option) => {
    const shippingRate = idOf(option.shipping_rate);
    return shippingRate !== undefined ? [{ shippingRate }] : [];
  }),
  subscriptionData: fromWire<PaymentLinkSubscriptionData | undefined>(link.subscription_data),
  taxIdCollection: fromWire<PaymentLinkProps["taxIdCollection"]>(link.tax_id_collection),
  onBehalfOf: idOf(link.on_behalf_of),
  transferData:
    link.transfer_data == null
      ? undefined
      : {
          destination: idOf(link.transfer_data.destination) ?? "",
          ...(link.transfer_data.amount != null ? { amount: link.transfer_data.amount } : {}),
        },
  applicationFeeAmount: link.application_fee_amount ?? undefined,
  applicationFeePercent: link.application_fee_percent ?? undefined,
});

type CheckoutOptions = ReturnType<typeof observedOptions>;

/** Options Stripe can update in place, with their wire encodings. */
const updatableOptions = {
  automaticTax: (value: PaymentLinkAutomaticTax) => toWire(value),
  consentCollection: (value: PaymentLinkConsentCollection) => toWire(value),
  customFields: toWireCustomFields,
  customText: toWireCustomText,
  invoiceCreation: (value: PaymentLinkInvoiceCreation) => toWire(value),
  nameCollection: (value: PaymentLinkNameCollection) => toWire(value),
  optionalItems: (value: PaymentLinkLineItem[]) => toWire(value),
  paymentIntentData: ({ captureMethod: _, ...value }: PaymentLinkPaymentIntentData) =>
    toWire(value),
  paymentMethodOptions: (value: NonNullable<PaymentLinkProps["paymentMethodOptions"]>) =>
    toWire(value),
  paymentMethodTypes: (value: string[]) => value,
  restrictions: (value: NonNullable<PaymentLinkProps["restrictions"]>) => toWire(value),
  shippingAddressCollection: (value: NonNullable<PaymentLinkProps["shippingAddressCollection"]>) =>
    toWire(value),
  shippingOptions: (value: { shippingRate: string }[]) => toWire(value),
  subscriptionData: ({ description: _, ...value }: PaymentLinkSubscriptionData) => toWire(value),
  taxIdCollection: (value: NonNullable<PaymentLinkProps["taxIdCollection"]>) => toWire(value),
  onBehalfOf: (value: string) => value,
  transferData: (value: NonNullable<PaymentLinkProps["transferData"]>) => toWire(value),
  applicationFeeAmount: (value: number) => value,
  applicationFeePercent: (value: number) => value,
} satisfies { [K in keyof CheckoutOptions]: (value: never) => unknown };

const snakeOf = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Wire fields for every option set in the props, or only those that changed. */
const optionsToWire = (news: PaymentLinkProps, observed?: CheckoutOptions) =>
  Object.fromEntries(
    (Object.keys(updatableOptions) as (keyof typeof updatableOptions)[]).flatMap((key) => {
      const desired = news[key];
      if (desired === undefined) return [];
      if (observed !== undefined && !subsetDiffers(desired, observed[key])) return [];
      const encode = updatableOptions[key] as (value: typeof desired) => unknown;
      return [[snakeOf(key), encode(desired)]];
    }),
  );

const toAttrs = (link: StripePaymentLink): PaymentLinkAttributes => ({
  ...observedOptions(link),
  managedPayments: link.managed_payments?.enabled ?? false,
  id: link.id,
  url: link.url,
  active: link.active,
  lineItems: fromObservedLineItems(link.line_items?.data),
  allowPromotionCodes: link.allow_promotion_codes,
  billingAddressCollection: link.billing_address_collection,
  afterCompletion: fromObservedAfterCompletion(link.after_completion),
  inactiveMessage: link.inactive_message ?? undefined,
  submitType: link.submit_type,
  customerCreation: link.customer_creation,
  paymentMethodCollection: link.payment_method_collection,
  phoneNumberCollection: link.phone_number_collection.enabled,
  currency: link.currency,
  metadata: userMetadata(link.metadata),
  livemode: link.livemode,
});

const isMissingPaymentLink = isMissingStripeResource;

// `optional_items` is only returned when expanded.
const PAYMENT_LINK_EXPAND = ["optional_items"];

const hydrateLineItems = (link: StripePaymentLink) =>
  Effect.gen(function* () {
    const data: StripeLineItem[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const response = yield* GetPaymentLinkLineItems({
        payment_link: link.id,
        limit: LIST_PAGE_SIZE,
        ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
      });
      data.push(...response.data);
      if (!response.has_more || response.data.length === 0) {
        break;
      }
      startingAfter = response.data[response.data.length - 1]?.id;
      if (startingAfter === undefined) {
        break;
      }
    }
    return {
      ...link,
      line_items: {
        data,
        has_more: false,
        object: "list" as const,
        url: link.line_items?.url ?? `/v1/payment_links/${link.id}/line_items`,
      },
    };
  });

const getById = (payment_link: string) =>
  GetPaymentLink({ payment_link, expand: PAYMENT_LINK_EXPAND }).pipe(
    Effect.catchIf(isMissingPaymentLink, () => Effect.undefined),
    Effect.flatMap((link) => (link === undefined ? Effect.undefined : hydrateLineItems(link))),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const links: StripePaymentLink[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPaymentLinks({
      active,
      limit: LIST_PAGE_SIZE,
      expand: PAYMENT_LINK_EXPAND.map((field) => `data.${field}`),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    links.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return links;
});

const listAllPaymentLinks = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all([listByActive(true), listByActive(false)], {
    concurrency: 2,
  });
  const seen = new Set<string>();
  const links: StripePaymentLink[] = [];
  for (const link of [...active, ...inactive]) {
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    links.push(link);
  }
  return links;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const links = yield* listAllPaymentLinks();
  const matches: StripePaymentLink[] = [];
  for (const link of links) {
    if (yield* hasAlchemyMetadata(id, tagRecord(link.metadata))) {
      matches.push(link);
    }
  }
  matches.sort((a, b) => Number(b.active) - Number(a.active));
  return matches[0];
});

const observe = Effect.fn(function* (input: { id?: string; logicalId: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  const found = yield* findByAlchemyId(input.logicalId);
  if (found === undefined) return undefined;
  return yield* getById(found.id);
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

const shouldReplace = (
  news: PaymentLinkProps,
  output: PaymentLinkAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.currency !== undefined && news.currency !== output.currency) return true;
  if ((news.managedPayments ?? false) !== output.managedPayments) return true;
  if (
    news.subscriptionData?.description !== undefined &&
    news.subscriptionData.description !== output.subscriptionData?.description
  ) {
    return true;
  }
  if (
    news.paymentIntentData?.captureMethod !== undefined &&
    news.paymentIntentData.captureMethod !== output.paymentIntentData?.captureMethod
  ) {
    return true;
  }
  if (output.lineItems.length === 0) return false;
  if (news.lineItems.length !== output.lineItems.length) return true;
  return news.lineItems.some((item, index) => item.price !== output.lineItems[index]?.price);
};

const adjustableQuantityEqual = (
  desired: PaymentLinkLineItemAdjustableQuantity | undefined,
  observed: PaymentLinkLineItemAdjustableQuantity | undefined,
): boolean => {
  if (desired === undefined) return true;
  return deepEqual(desired, observed, { stripNullish: true });
};

const lineItemsNeedUpdate = (
  desired: PaymentLinkLineItem[],
  observedItems: ReadonlyArray<StripeLineItem>,
): boolean => {
  if (desired.length !== observedItems.length) return false;
  return desired.some((item, index) => {
    const observed = observedItems[index];
    if (observed === undefined) return false;
    if ((observed.quantity ?? 1) !== item.quantity) return true;
    return !adjustableQuantityEqual(
      item.adjustableQuantity,
      fromObservedAdjustableQuantity(observed.adjustable_quantity),
    );
  });
};

const toWireUpdateLineItems = (
  desired: PaymentLinkLineItem[],
  observedItems: ReadonlyArray<StripeLineItem>,
): UpdatePaymentLinkRequestLineItemsItem[] | undefined => {
  if (desired.length !== observedItems.length) return undefined;
  const items: UpdatePaymentLinkRequestLineItemsItem[] = [];
  for (let index = 0; index < desired.length; index++) {
    const item = desired[index];
    const observed = observedItems[index];
    if (item === undefined || observed === undefined) return undefined;
    items.push({
      id: observed.id,
      quantity: item.quantity,
      ...(item.adjustableQuantity !== undefined
        ? {
            adjustable_quantity: {
              enabled: item.adjustableQuantity.enabled,
              ...(item.adjustableQuantity.minimum !== undefined
                ? { minimum: item.adjustableQuantity.minimum }
                : {}),
              ...(item.adjustableQuantity.maximum !== undefined
                ? { maximum: item.adjustableQuantity.maximum }
                : {}),
            },
          }
        : {}),
    });
  }
  return items;
};

export const PaymentLinkProvider = () =>
  Provider.succeed(PaymentLink, {
    stables: ["id", "currency", "livemode"],

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
      // Default list API is active payment links; deactivated rows stay
      // in Stripe but must not re-enter nuke. Filter to alchemy_stack so
      // account-wide teardown only touches our rows.
      const links = yield* listByActive(true);
      return links
        .filter((link) => {
          const metadata = tagRecord(link.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const afterCompletion = news.afterCompletion;

      let current: StripePaymentLink | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePaymentLink({
          line_items: toWireCreateLineItems(news.lineItems),
          metadata,
          expand: PAYMENT_LINK_EXPAND,
          ...(news.allowPromotionCodes !== undefined
            ? { allow_promotion_codes: news.allowPromotionCodes }
            : {}),
          ...(news.billingAddressCollection !== undefined
            ? { billing_address_collection: news.billingAddressCollection }
            : {}),
          ...(news.submitType !== undefined ? { submit_type: news.submitType } : {}),
          ...(news.customerCreation !== undefined
            ? { customer_creation: news.customerCreation }
            : {}),
          ...(news.paymentMethodCollection !== undefined
            ? { payment_method_collection: news.paymentMethodCollection }
            : {}),
          ...(news.phoneNumberCollection !== undefined
            ? {
                phone_number_collection: {
                  enabled: news.phoneNumberCollection,
                },
              }
            : {}),
          ...(news.inactiveMessage !== undefined ? { inactive_message: news.inactiveMessage } : {}),
          ...(afterCompletion !== undefined
            ? { after_completion: toWireAfterCompletion(afterCompletion) }
            : {}),
          ...(news.currency !== undefined ? { currency: news.currency } : {}),
          ...(news.managedPayments !== undefined
            ? { managed_payments: { enabled: news.managedPayments } }
            : {}),
          ...(optionsToWire(news) as Partial<CreatePaymentLinkRequest>),
          ...(news.subscriptionData?.description !== undefined
            ? {
                subscription_data: {
                  ...(optionsToWire(news).subscription_data as object),
                  description: news.subscriptionData.description,
                },
              }
            : {}),
          ...(news.paymentIntentData?.captureMethod !== undefined
            ? {
                payment_intent_data: {
                  ...(optionsToWire(news).payment_intent_data as object),
                  capture_method: news.paymentIntentData.captureMethod,
                },
              }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-payment-link-${instanceId}`,
          }),
        );
        current = yield* hydrateLineItems(current);
      }

      if (current === undefined) {
        return yield* new PaymentLinkNotResolved({
          lineItems: news.lineItems,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const allowPromotionCodesChanged =
        news.allowPromotionCodes !== undefined &&
        current.allow_promotion_codes !== news.allowPromotionCodes;
      const billingChanged =
        news.billingAddressCollection !== undefined &&
        current.billing_address_collection !== news.billingAddressCollection;
      const submitTypeChanged =
        news.submitType !== undefined && current.submit_type !== news.submitType;
      const customerCreationChanged =
        news.customerCreation !== undefined && current.customer_creation !== news.customerCreation;
      const paymentMethodCollectionChanged =
        news.paymentMethodCollection !== undefined &&
        current.payment_method_collection !== news.paymentMethodCollection;
      const phoneChanged =
        news.phoneNumberCollection !== undefined &&
        current.phone_number_collection.enabled !== news.phoneNumberCollection;
      const inactiveMessageChanged =
        news.inactiveMessage !== undefined &&
        (current.inactive_message ?? "") !== news.inactiveMessage;
      const afterCompletionChanged =
        afterCompletion !== undefined &&
        !deepEqual(afterCompletion, fromObservedAfterCompletion(current.after_completion), {
          stripNullish: true,
        });
      const observedLineItems = current.line_items?.data ?? [];
      const lineItemsChanged = lineItemsNeedUpdate(news.lineItems, observedLineItems);
      const updateLineItems = lineItemsChanged
        ? toWireUpdateLineItems(news.lineItems, observedLineItems)
        : undefined;
      const changedOptions = optionsToWire(news, observedOptions(current));
      const optionsChanged = Object.keys(changedOptions).length > 0;

      if (
        !activeChanged &&
        !allowPromotionCodesChanged &&
        !billingChanged &&
        !submitTypeChanged &&
        !customerCreationChanged &&
        !paymentMethodCollectionChanged &&
        !phoneChanged &&
        !inactiveMessageChanged &&
        !afterCompletionChanged &&
        !lineItemsChanged &&
        !optionsChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePaymentLink({
        payment_link: current.id,
        expand: PAYMENT_LINK_EXPAND,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(allowPromotionCodesChanged ? { allow_promotion_codes: news.allowPromotionCodes } : {}),
        ...(billingChanged ? { billing_address_collection: news.billingAddressCollection } : {}),
        ...(submitTypeChanged ? { submit_type: news.submitType } : {}),
        ...(customerCreationChanged ? { customer_creation: news.customerCreation } : {}),
        ...(paymentMethodCollectionChanged
          ? { payment_method_collection: news.paymentMethodCollection }
          : {}),
        ...(phoneChanged
          ? {
              phone_number_collection: {
                enabled: news.phoneNumberCollection === true,
              },
            }
          : {}),
        ...(inactiveMessageChanged ? { inactive_message: news.inactiveMessage } : {}),
        ...(afterCompletionChanged && afterCompletion !== undefined
          ? {
              after_completion: toWireAfterCompletion(
                afterCompletion,
              ) as UpdatePaymentLinkRequestAfterCompletion,
            }
          : {}),
        ...(updateLineItems !== undefined ? { line_items: updateLineItems } : {}),
        ...(changedOptions as Partial<UpdatePaymentLinkRequest>),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(yield* hydrateLineItems(updated));
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdatePaymentLink({
        payment_link: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingPaymentLink, () => Effect.void));
    }),
  });
