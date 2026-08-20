import {
  GetPaymentLinks,
  GetPaymentLinksPaymentLink,
  type PaymentLink as StripePaymentLinkObject,
  PostPaymentLinks,
  type PostPaymentLinksRequest,
  PostPaymentLinksPaymentLink,
  type PostPaymentLinksPaymentLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
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

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------

/** How the checkout page behaves once the purchase completes. */
export type PaymentLinkAfterCompletion = {
  /**
   * Either `hosted_confirmation` (show a Stripe-hosted confirmation page) or
   * `redirect` (send the customer to your own URL).
   */
  type: "hosted_confirmation" | "redirect";
  /** Configuration used when `type` is `hosted_confirmation`. */
  hostedConfirmation?: {
    /** Custom message shown to the customer on the confirmation page. */
    customMessage?: string;
  };
  /** Configuration used when `type` is `redirect`. */
  redirect?: {
    /**
     * The URL the customer is redirected to after the purchase completes.
     * May contain the `{CHECKOUT_SESSION_ID}` template variable.
     */
    url: string;
  };
};

/** Configuration for Stripe Tax automatic tax calculation. */
export type PaymentLinkAutomaticTax = {
  /** Whether tax is calculated automatically from the customer's location. */
  enabled: boolean;
  /** The connected account that is liable for the tax. */
  liability?: {
    /** `self` (your account) or `account` (a connected account). */
    type: "account" | "self";
    /** The connected account id — required when `type` is `account`. */
    account?: string;
  };
};

/** Extra copy rendered on the hosted checkout page. */
export type PaymentLinkCustomText = {
  /** Text displayed after the payment confirmation button. */
  afterSubmit?: string;
  /** Text displayed alongside shipping address collection. */
  shippingAddress?: string;
  /** Text displayed alongside the payment confirmation button. */
  submit?: string;
  /** Text displayed in place of the default terms-of-service agreement text. */
  termsOfServiceAcceptance?: string;
};

/** Post-purchase invoice generation for one-time payments. */
export type PaymentLinkInvoiceCreation = {
  /** Whether an invoice is generated after a successful one-time payment. */
  enabled: boolean;
  /** Fields rendered on the generated invoice PDF. */
  invoiceData?: {
    /** Arbitrary description attached to the invoice. */
    description?: string;
    /** Footer displayed on the invoice. */
    footer?: string;
    /** Metadata set on the generated invoice. */
    metadata?: Record<string, string>;
  };
};

/** Subscription configuration used when a line item has a recurring price. */
export type PaymentLinkSubscriptionData = {
  /**
   * Description of the subscription shown to the customer.
   *
   * Stripe does not accept `subscription_data[description]` on update, so
   * changing this value replaces the payment link.
   */
  description?: string;
  /** Number of free trial days before the first charge. Minimum `1`. */
  trialPeriodDays?: number;
  /** Metadata declaratively set on subscriptions created by this link. */
  metadata?: Record<string, string>;
  /** How the subscription behaves when the trial ends. */
  trialSettings?: {
    /** Behaviour when the trial ends without a payment method on file. */
    endBehavior: {
      /** One of `cancel`, `create_invoice` or `pause`. */
      missingPaymentMethod: "cancel" | "create_invoice" | "pause";
    };
  };
};

/** An inline `price_data` definition for a line item. */
export type PaymentLinkPriceData = {
  /** Three-letter lowercase ISO currency code, e.g. `"usd"`. */
  currency: string;
  /** Id of an existing Stripe Product. One of `productId` or `productData`. */
  productId?: string;
  /** Inline product definition. One of `productId` or `productData`. */
  productData?: {
    /** Name of the product shown to the customer. */
    name: string;
    /** Description of the product. */
    description?: string;
    /** Up to 8 image URLs displayable to the customer. */
    images?: string[];
    /** Metadata attached to the generated product. */
    metadata?: Record<string, string>;
    /** Stripe Tax product tax code. */
    taxCode?: string;
    /** Label describing a single unit, e.g. `"seat"`. */
    unitLabel?: string;
  };
  /** Recurring billing configuration — omit for a one-time price. */
  recurring?: {
    /** Billing frequency: `day`, `week`, `month` or `year`. */
    interval: "day" | "week" | "month" | "year";
    /** Number of intervals between billings. */
    intervalCount?: number;
  };
  /** Whether the price is `inclusive`, `exclusive` or `unspecified` of tax. */
  taxBehavior?: "exclusive" | "inclusive" | "unspecified";
  /** Amount in the smallest currency unit (e.g. cents). */
  unitAmount?: number;
  /** Amount in the smallest currency unit, as a decimal string. */
  unitAmountDecimal?: string;
};

/** One item being sold through the payment link. */
export type PaymentLinkLineItem = {
  /**
   * Id of an existing Stripe Price — e.g. `price.priceId`. One of `priceId`
   * or `priceData` is required.
   */
  priceId?: string;
  /**
   * Inline price definition, creating the Price (and optionally the Product)
   * as a side effect. One of `priceId` or `priceData` is required.
   */
  priceData?: PaymentLinkPriceData;
  /** Quantity of this item being purchased. */
  quantity: number;
  /** Let the customer change the quantity at checkout. */
  adjustableQuantity?: {
    /** Whether the customer can adjust the quantity. */
    enabled: boolean;
    /** Maximum selectable quantity (Stripe caps this at 999). */
    maximum?: number;
    /** Minimum selectable quantity. */
    minimum?: number;
  };
};

export type PaymentLinkProps = {
  /**
   * The items being sold. At least one is required and up to 20 are
   * supported.
   *
   * Stripe's update API can only adjust the `quantity` /
   * `adjustable_quantity` of line items that already exist on the link (it
   * addresses them by their server-assigned line item id, which is never
   * surfaced here) — prices cannot be added, removed or swapped. Alchemy
   * therefore treats **any** change to `lineItems` as a replacement: a new
   * payment link is created with a new `url` and the old one is archived.
   */
  lineItems: PaymentLinkLineItem[];
  /**
   * Behaviour after the purchase completes.
   *
   * @default { type: "hosted_confirmation" }
   */
  afterCompletion?: PaymentLinkAfterCompletion;
  /**
   * Whether customers can redeem promotion codes at checkout.
   *
   * @default false
   */
  allowPromotionCodes?: boolean;
  /**
   * Automatic tax calculation via Stripe Tax.
   *
   * @default { enabled: false }
   */
  automaticTax?: PaymentLinkAutomaticTax;
  /**
   * Whether to collect the customer's billing address.
   *
   * @default "auto"
   */
  billingAddressCollection?: "auto" | "required";
  /** Additional copy displayed on the hosted checkout page. */
  customText?: PaymentLinkCustomText;
  /**
   * Whether checkout sessions created from this link create a Customer.
   *
   * @default "if_required"
   */
  customerCreation?: "always" | "if_required";
  /**
   * Message shown to customers who open the link while it is inactive.
   */
  inactiveMessage?: string;
  /**
   * Generate a post-purchase invoice for one-time payments.
   *
   * @default { enabled: false }
   */
  invoiceCreation?: PaymentLinkInvoiceCreation;
  /**
   * The payment method types customers may use. Omit to let Stripe show the
   * methods enabled in your dashboard payment method settings.
   */
  paymentMethodTypes?: string[];
  /**
   * Whether to collect the customer's phone number.
   *
   * @default { enabled: false }
   */
  phoneNumberCollection?: { enabled: boolean };
  /** Collect a shipping address, restricted to these ISO country codes. */
  shippingAddressCollection?: {
    /** Two-letter ISO country codes offered as shipping destinations. */
    allowedCountries: string[];
  };
  /**
   * Customises the submit button copy — and the `url` hostname (`pay.`,
   * `donate.`, `book.`).
   *
   * @default "auto"
   */
  submitType?: "auto" | "book" | "donate" | "pay" | "subscribe";
  /** Subscription configuration, when a line item uses a recurring price. */
  subscriptionData?: PaymentLinkSubscriptionData;
  /**
   * Collect a tax ID at checkout.
   *
   * @default { enabled: false }
   */
  taxIdCollection?: {
    /** Whether tax ID collection is offered. */
    enabled: boolean;
    /**
     * Whether a tax ID is required: `if_supported` or `never`.
     *
     * @default "never"
     */
    required?: "if_supported" | "never";
  };
  /**
   * Route funds to a connected account. Stripe does not accept
   * `transfer_data` on update, so changing this replaces the payment link.
   */
  transferData?: {
    /** The connected account receiving the transfer. */
    destination: string;
    /** Amount transferred, in the smallest currency unit. */
    amount?: number;
  };
  /**
   * Application fee collected on each payment, in the smallest currency
   * unit. Only valid when no line item uses a recurring price. Stripe does
   * not accept it on update, so changing this replaces the payment link.
   */
  applicationFeeAmount?: number;
  /**
   * Whether the link's `url` is live. Deactivating shows visitors a
   * "link is no longer active" page rather than deleting the link.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Arbitrary key/value pairs stored on the payment link. Alchemy adds its
   * own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys for ownership
   * tracking; those are stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type PaymentLink = Resource<
  "Stripe.PaymentLink",
  PaymentLinkProps,
  {
    /** The payment link's Stripe id, e.g. `plink_1A2b3C...`. */
    paymentLinkId: string;
    /** The public URL that can be shared with customers. */
    url: string;
    /** Whether the link's URL currently accepts payments. */
    active: boolean;
    /** `true` when the object lives in live mode, `false` in test mode. */
    livemode: boolean;
    /** Three-letter lowercase ISO currency code resolved by Stripe. */
    currency: string;
    /** Whether customers may redeem promotion codes. */
    allowPromotionCodes: boolean;
    /** Resolved billing address collection mode. */
    billingAddressCollection: "auto" | "required";
    /** Resolved customer creation mode. */
    customerCreation: "always" | "if_required";
    /** Resolved submit button / URL hostname type. */
    submitType: "auto" | "book" | "donate" | "pay" | "subscribe";
    /** Message shown while the link is inactive, if configured. */
    inactiveMessage: string | undefined;
    /** Explicitly allowed payment method types, if configured. */
    paymentMethodTypes: string[] | undefined;
    /** Application fee collected per payment, if configured. */
    applicationFeeAmount: number | undefined;
    /** User metadata, with Alchemy's internal `alchemy_*` keys removed. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

type PaymentLinkAttributes = PaymentLink["Attributes"];

/**
 * A Stripe Payment Link — a shareable, Stripe-hosted checkout URL for a fixed
 * set of line items. No server-side code or Checkout Session is required: send
 * the `url` to a customer and Stripe handles the payment page end to end.
 *
 * :::caution
 * Stripe does not support deleting a payment link. Destroying this resource
 * **archives** it by setting `active: false`; the link keeps existing, stays
 * visible in the Stripe dashboard and in `GET /v1/payment_links`, and anyone
 * who opens its URL sees a "this link is no longer active" page.
 * :::
 *
 * :::caution
 * `lineItems`, `transferData`, `applicationFeeAmount` and
 * `subscriptionData.description` cannot be changed after creation. Changing
 * any of them **replaces** the payment link — the new link gets a brand new
 * `url`, so any already-shared URL must be re-shared.
 * :::
 *
 * ### Creating a Payment Link
 * **Example:** One-time purchase of an existing Price
 * ```typescript
 * const product = yield* Stripe.Product("t-shirt", { name: "T-Shirt" });
 * const price = yield* Stripe.Price("t-shirt-price", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 *
 * const link = yield* Stripe.PaymentLink("t-shirt-link", {
 *   lineItems: [{ priceId: price.priceId, quantity: 1 }],
 * });
 * // link.url -> https://buy.stripe.com/test_...
 * ```
 *
 * **Example:** Inline price — no Product/Price resources required
 * ```typescript
 * const link = yield* Stripe.PaymentLink("donation", {
 *   lineItems: [
 *     {
 *       quantity: 1,
 *       priceData: {
 *         currency: "usd",
 *         unitAmount: 500,
 *         productData: { name: "Donation" },
 *       },
 *     },
 *   ],
 *   submitType: "donate",
 * });
 * ```
 *
 * ### Configuring the checkout page
 * **Example:** Adjustable quantity, promotion codes and custom copy
 * ```typescript
 * const link = yield* Stripe.PaymentLink("bulk-order", {
 *   lineItems: [
 *     {
 *       priceId: price.priceId,
 *       quantity: 1,
 *       adjustableQuantity: { enabled: true, minimum: 1, maximum: 20 },
 *     },
 *   ],
 *   allowPromotionCodes: true,
 *   billingAddressCollection: "required",
 *   phoneNumberCollection: { enabled: true },
 *   shippingAddressCollection: { allowedCountries: ["US", "CA"] },
 *   customText: { submit: "We ship within two business days." },
 *   metadata: { channel: "email" },
 * });
 * ```
 *
 * **Example:** Redirect to your own thank-you page
 * ```typescript
 * const link = yield* Stripe.PaymentLink("checkout", {
 *   lineItems: [{ priceId: price.priceId, quantity: 1 }],
 *   afterCompletion: {
 *     type: "redirect",
 *     redirect: { url: "https://example.com/thanks?s={CHECKOUT_SESSION_ID}" },
 *   },
 * });
 * ```
 *
 * ### Subscriptions
 * **Example:** Recurring price with a free trial
 * ```typescript
 * const plan = yield* Stripe.Price("pro-monthly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 4900,
 *   recurring: { interval: "month" },
 * });
 *
 * const link = yield* Stripe.PaymentLink("pro-signup", {
 *   lineItems: [{ priceId: plan.priceId, quantity: 1 }],
 *   submitType: "subscribe",
 *   subscriptionData: {
 *     trialPeriodDays: 14,
 *     trialSettings: {
 *       endBehavior: { missingPaymentMethod: "cancel" },
 *     },
 *   },
 *   taxIdCollection: { enabled: true, required: "if_supported" },
 * });
 * ```
 *
 * ### Deactivating a link
 * **Example:** Take a link offline without destroying the resource
 * ```typescript
 * const link = yield* Stripe.PaymentLink("seasonal-offer", {
 *   lineItems: [{ priceId: price.priceId, quantity: 1 }],
 *   active: false,
 *   inactiveMessage: "This offer has ended — see our current pricing.",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/payment_links/payment_links
 *
 * @resource
 */
export const PaymentLink = Resource<PaymentLink>("Stripe.PaymentLink");

export const PaymentLinkProvider = () =>
  Provider.succeed(PaymentLink, {
    stables: ["paymentLinkId", "livemode"],

    /**
     * Payment links are account-scoped and enumerable, so `list` walks the
     * whole collection (both active and archived) with the `starting_after`
     * cursor and hydrates each row into the `read` Attributes shape.
     */
    list: Effect.fn(function* () {
      const links = yield* listAllPaymentLinks;
      return links.map(toAttributes);
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      // `diff` runs during plan, where props may still hold unresolved
      // Outputs (e.g. `price.priceId`). Bail out and let the engine's
      // default comparison run once everything is resolved.
      if (!isResolved(news)) return undefined;
      // Adoption: the engine hands `reconcile`/`diff` no prior props, so
      // nothing can be proven immutable-changed. Fall through to the default
      // update path and let the reconciler converge what it can.
      const prior: PaymentLinkProps | undefined = olds;
      if (prior === undefined) return undefined;

      // Immutable after creation — Stripe's update endpoint accepts none of
      // these (its `line_items` parameter can only re-quantity line items
      // that already exist, addressed by ids Alchemy never surfaces):
      //   line_items, transfer_data, application_fee_amount,
      //   subscription_data.description
      if (
        !sameJson(prior.lineItems, news.lineItems) ||
        !sameJson(prior.transferData, news.transferData) ||
        prior.applicationFeeAmount !== news.applicationFeeAmount ||
        prior.subscriptionData?.description !==
          news.subscriptionData?.description
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      if (output?.paymentLinkId) {
        const link = yield* getPaymentLink(output.paymentLinkId);
        return link ? toAttributes(link) : undefined;
      }
      // State loss: payment links have no user-chosen natural key, so the
      // only way back to "our" link is the `alchemy_*` metadata branding.
      const links = yield* listAllPaymentLinks;
      for (const link of links) {
        if (yield* isOwned(id, asMetadata(link.metadata))) {
          return toAttributes(link);
        }
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` is only a cache of the id; the link may be gone.
      const observed = output?.paymentLinkId
        ? yield* getPaymentLink(output.paymentLinkId)
        : undefined;

      // 2. Ensure — create when missing. `active` is not a create parameter,
      //    so a link requested inactive is born active and deactivated by the
      //    sync step below.
      const ensured =
        observed ??
        (yield* PostPaymentLinks(buildCreateRequest(news, desiredMetadata)));

      // 3. Sync — diff the *observed* link against the desired state and
      //    issue at most one update carrying only the fields that differ.
      const update = buildUpdateRequest(news, desiredMetadata, ensured);
      const link =
        update === undefined
          ? ensured
          : yield* PostPaymentLinksPaymentLink({
              payment_link: ensured.id,
              ...update,
            });

      // 4. Return the fresh attributes.
      return toAttributes(link);
    }),

    /**
     * Stripe has no `DELETE /v1/payment_links/{id}` — destroying a payment
     * link archives it. Idempotent: an already-archived or already-missing
     * link is success.
     */
    delete: Effect.fn(function* ({ output }) {
      const link = yield* getPaymentLink(output.paymentLinkId);
      if (link === undefined || link.active === false) return;
      yield* PostPaymentLinksPaymentLink({
        payment_link: output.paymentLinkId,
        active: false,
      }).pipe(
        Effect.asVoid,
        // The link can vanish between the observe and the archive — either
        // tag means "already gone", which is success for an idempotent
        // delete.
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a payment link, mapping "missing" to `undefined`.
 *
 * Stripe reports a missing object as `invalid_request_error` with HTTP 404
 * and `code: "resource_missing"`, and distilled dispatches on `error.type`
 * before the status map — so the tag can be either `NotFound` or
 * `InvalidRequestError` depending on the envelope Stripe returns.
 */
const getPaymentLink = (paymentLinkId: string) =>
  GetPaymentLinksPaymentLink({ payment_link: paymentLinkId }).pipe(
    Effect.map((link): StripePaymentLinkObject | undefined => link),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/** Hard ceiling on pagination so a bad cursor can never spin forever. */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

/** Exhaustively enumerate every payment link (active and archived). */
const listAllPaymentLinks = Effect.gen(function* () {
  const links: StripePaymentLinkObject[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetPaymentLinks({
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    links.push(...response.data);
    const last = response.data.at(-1);
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return links;
});

// ---------------------------------------------------------------------------
// Wire mapping — Alchemy camelCase props <-> Stripe snake_case wire names
// ---------------------------------------------------------------------------

const toAttributes = (
  link: StripePaymentLinkObject,
): PaymentLinkAttributes => ({
  paymentLinkId: link.id,
  url: link.url,
  active: link.active,
  livemode: link.livemode,
  currency: link.currency,
  allowPromotionCodes: link.allow_promotion_codes,
  billingAddressCollection: link.billing_address_collection,
  customerCreation: link.customer_creation,
  submitType: link.submit_type,
  inactiveMessage: link.inactive_message ?? undefined,
  paymentMethodTypes: link.payment_method_types
    ? [...link.payment_method_types]
    : undefined,
  applicationFeeAmount: link.application_fee_amount ?? undefined,
  metadata: stripInternalMetadata(asMetadata(link.metadata)),
});

/** Stripe types metadata values as `string | undefined`; drop the holes. */
const asMetadata = (
  map: { [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const toWireLineItem = (item: PaymentLinkLineItem) => ({
  price: item.priceId,
  price_data: item.priceData
    ? {
        currency: item.priceData.currency,
        product: item.priceData.productId,
        product_data: item.priceData.productData
          ? {
              name: item.priceData.productData.name,
              description: item.priceData.productData.description,
              images: item.priceData.productData.images,
              metadata: item.priceData.productData.metadata,
              tax_code: item.priceData.productData.taxCode,
              unit_label: item.priceData.productData.unitLabel,
            }
          : undefined,
        recurring: item.priceData.recurring
          ? {
              interval: item.priceData.recurring.interval,
              interval_count: item.priceData.recurring.intervalCount,
            }
          : undefined,
        tax_behavior: item.priceData.taxBehavior,
        unit_amount: item.priceData.unitAmount,
        unit_amount_decimal: item.priceData.unitAmountDecimal,
      }
    : undefined,
  quantity: item.quantity,
  adjustable_quantity: item.adjustableQuantity,
});

const toWireAfterCompletion = (value: PaymentLinkAfterCompletion) => ({
  type: value.type,
  hosted_confirmation: value.hostedConfirmation
    ? { custom_message: value.hostedConfirmation.customMessage }
    : undefined,
  redirect: value.redirect ? { url: value.redirect.url } : undefined,
});

const toWireAutomaticTax = (value: PaymentLinkAutomaticTax) => ({
  enabled: value.enabled,
  liability: value.liability
    ? { type: value.liability.type, account: value.liability.account }
    : undefined,
});

const toWireInvoiceCreation = (value: PaymentLinkInvoiceCreation) => ({
  enabled: value.enabled,
  invoice_data: value.invoiceData
    ? {
        description: value.invoiceData.description,
        footer: value.invoiceData.footer,
        metadata: value.invoiceData.metadata,
      }
    : undefined,
});

/**
 * The subset of `subscription_data` Stripe accepts on **update** —
 * `description` is create-only and is handled as a replacement in `diff`.
 */
const toWireSubscriptionDataUpdate = (value: PaymentLinkSubscriptionData) => ({
  trial_period_days: value.trialPeriodDays,
  metadata: value.metadata,
  trial_settings: value.trialSettings
    ? {
        end_behavior: {
          missing_payment_method:
            value.trialSettings.endBehavior.missingPaymentMethod,
        },
      }
    : undefined,
});

const buildCreateRequest = (
  news: PaymentLinkProps,
  metadata: Metadata,
): PostPaymentLinksRequest => ({
  line_items: news.lineItems.map(toWireLineItem),
  metadata,
  after_completion: news.afterCompletion
    ? toWireAfterCompletion(news.afterCompletion)
    : undefined,
  allow_promotion_codes: news.allowPromotionCodes,
  application_fee_amount: news.applicationFeeAmount,
  automatic_tax: news.automaticTax
    ? toWireAutomaticTax(news.automaticTax)
    : undefined,
  billing_address_collection: news.billingAddressCollection,
  custom_text: news.customText ? toWireCustomText(news.customText) : undefined,
  customer_creation: news.customerCreation,
  inactive_message: news.inactiveMessage,
  invoice_creation: news.invoiceCreation
    ? toWireInvoiceCreation(news.invoiceCreation)
    : undefined,
  payment_method_types: news.paymentMethodTypes,
  phone_number_collection: news.phoneNumberCollection,
  shipping_address_collection: news.shippingAddressCollection
    ? { allowed_countries: news.shippingAddressCollection.allowedCountries }
    : undefined,
  submit_type: news.submitType,
  subscription_data: news.subscriptionData
    ? {
        description: news.subscriptionData.description,
        ...toWireSubscriptionDataUpdate(news.subscriptionData),
      }
    : undefined,
  tax_id_collection: news.taxIdCollection,
  transfer_data: news.transferData
    ? {
        destination: news.transferData.destination,
        amount: news.transferData.amount,
      }
    : undefined,
});

/** Stripe clears an optional string/array/object field by posting `""`. */
const UNSET = "" as const;

const toWireCustomText = (value: PaymentLinkCustomText) => ({
  after_submit: value.afterSubmit ? { message: value.afterSubmit } : undefined,
  shipping_address: value.shippingAddress
    ? { message: value.shippingAddress }
    : undefined,
  submit: value.submit ? { message: value.submit } : undefined,
  terms_of_service_acceptance: value.termsOfServiceAcceptance
    ? { message: value.termsOfServiceAcceptance }
    : undefined,
});

/**
 * Compute the delta between the **observed** payment link and the desired
 * state. Returns `undefined` when nothing changed so the reconciler can skip
 * the API call entirely.
 *
 * Every comparison folds Stripe's own default in on the desired side, so a
 * re-deploy of unchanged props is a genuine no-op rather than a re-post of
 * every field.
 */
const buildUpdateRequest = (
  news: PaymentLinkProps,
  desiredMetadata: Metadata,
  observed: StripePaymentLinkObject,
): Omit<PostPaymentLinksPaymentLinkRequest, "payment_link"> | undefined => {
  // Accumulated as a loose record: several of Stripe's update parameters are
  // "the struct, or an empty string to unset" unions, which are far more
  // readable to build untyped and narrow once at the return boundary.
  const update: Record<string, unknown> = {};
  let changed = false;
  const set = (key: string, value: unknown) => {
    update[key] = value;
    changed = true;
  };

  // --- scalars -------------------------------------------------------------
  if ((news.active ?? true) !== observed.active) {
    set("active", news.active ?? true);
  }
  if ((news.allowPromotionCodes ?? false) !== observed.allow_promotion_codes) {
    set("allow_promotion_codes", news.allowPromotionCodes ?? false);
  }
  if (
    (news.billingAddressCollection ?? "auto") !==
    observed.billing_address_collection
  ) {
    set("billing_address_collection", news.billingAddressCollection ?? "auto");
  }
  if ((news.customerCreation ?? "if_required") !== observed.customer_creation) {
    set("customer_creation", news.customerCreation ?? "if_required");
  }
  if ((news.submitType ?? "auto") !== observed.submit_type) {
    set("submit_type", news.submitType ?? "auto");
  }
  if (
    (news.inactiveMessage ?? undefined) !==
    (observed.inactive_message ?? undefined)
  ) {
    set("inactive_message", news.inactiveMessage ?? UNSET);
  }

  // --- nested config -------------------------------------------------------
  // Compared as a flattened projection so Stripe's own shape for "unset"
  // (`hosted_confirmation: { custom_message: null }`) can't read as drift
  // against a caller who simply omitted `afterCompletion`.
  const desiredAfterCompletion = {
    type: news.afterCompletion?.type ?? "hosted_confirmation",
    customMessage: news.afterCompletion?.hostedConfirmation?.customMessage,
    redirectUrl: news.afterCompletion?.redirect?.url,
  };
  const observedAfterCompletion = {
    type: observed.after_completion.type,
    customMessage:
      observed.after_completion.hosted_confirmation?.custom_message ??
      undefined,
    redirectUrl: observed.after_completion.redirect?.url,
  };
  if (!sameJson(desiredAfterCompletion, observedAfterCompletion)) {
    set(
      "after_completion",
      news.afterCompletion
        ? toWireAfterCompletion(news.afterCompletion)
        : { type: "hosted_confirmation" },
    );
  }

  const desiredAutomaticTax = news.automaticTax
    ? toWireAutomaticTax(news.automaticTax)
    : { enabled: false, liability: undefined };
  const observedAutomaticTax = {
    enabled: observed.automatic_tax.enabled,
    liability: observed.automatic_tax.liability
      ? {
          type: observed.automatic_tax.liability.type,
          account:
            typeof observed.automatic_tax.liability.account === "string"
              ? observed.automatic_tax.liability.account
              : undefined,
        }
      : undefined,
  };
  if (!sameJson(desiredAutomaticTax, observedAutomaticTax)) {
    set("automatic_tax", desiredAutomaticTax);
  }

  const desiredCustomText = {
    after_submit: news.customText?.afterSubmit,
    shipping_address: news.customText?.shippingAddress,
    submit: news.customText?.submit,
    terms_of_service_acceptance: news.customText?.termsOfServiceAcceptance,
  };
  const observedCustomText = {
    after_submit: observed.custom_text.after_submit?.message,
    shipping_address: observed.custom_text.shipping_address?.message,
    submit: observed.custom_text.submit?.message,
    terms_of_service_acceptance:
      observed.custom_text.terms_of_service_acceptance?.message,
  };
  if (!sameJson(desiredCustomText, observedCustomText)) {
    set("custom_text", {
      after_submit: desiredCustomText.after_submit
        ? { message: desiredCustomText.after_submit }
        : UNSET,
      shipping_address: desiredCustomText.shipping_address
        ? { message: desiredCustomText.shipping_address }
        : UNSET,
      submit: desiredCustomText.submit
        ? { message: desiredCustomText.submit }
        : UNSET,
      terms_of_service_acceptance: desiredCustomText.terms_of_service_acceptance
        ? { message: desiredCustomText.terms_of_service_acceptance }
        : UNSET,
    });
  }

  const desiredInvoiceCreation = news.invoiceCreation
    ? {
        enabled: news.invoiceCreation.enabled,
        description: news.invoiceCreation.invoiceData?.description,
        footer: news.invoiceCreation.invoiceData?.footer,
        metadata: news.invoiceCreation.invoiceData?.metadata,
      }
    : {
        enabled: false,
        description: undefined,
        footer: undefined,
        metadata: undefined,
      };
  const observedInvoiceCreation = {
    enabled: observed.invoice_creation?.enabled ?? false,
    description:
      observed.invoice_creation?.invoice_data?.description ?? undefined,
    footer: observed.invoice_creation?.invoice_data?.footer ?? undefined,
    metadata: observed.invoice_creation?.invoice_data?.metadata
      ? asMetadata(observed.invoice_creation.invoice_data.metadata)
      : undefined,
  };
  if (!sameJson(desiredInvoiceCreation, observedInvoiceCreation)) {
    set(
      "invoice_creation",
      news.invoiceCreation
        ? toWireInvoiceCreation(news.invoiceCreation)
        : { enabled: false },
    );
  }

  const desiredPaymentMethodTypes = news.paymentMethodTypes;
  const observedPaymentMethodTypes = observed.payment_method_types
    ? [...observed.payment_method_types]
    : undefined;
  if (!sameJson(desiredPaymentMethodTypes, observedPaymentMethodTypes)) {
    set("payment_method_types", desiredPaymentMethodTypes ?? UNSET);
  }

  if (
    (news.phoneNumberCollection?.enabled ?? false) !==
    observed.phone_number_collection.enabled
  ) {
    set("phone_number_collection", {
      enabled: news.phoneNumberCollection?.enabled ?? false,
    });
  }

  const desiredCountries = news.shippingAddressCollection?.allowedCountries;
  const observedCountries = observed.shipping_address_collection
    ? [...observed.shipping_address_collection.allowed_countries]
    : undefined;
  if (!sameJson(desiredCountries, observedCountries)) {
    set(
      "shipping_address_collection",
      desiredCountries ? { allowed_countries: desiredCountries } : UNSET,
    );
  }

  // Flattened, with Stripe's implicit `trial_settings` default folded in:
  // a link that only sets `trialPeriodDays` comes back carrying
  // `end_behavior.missing_payment_method: "create_invoice"`, which would
  // otherwise look like drift on every redeploy.
  const desiredSubscriptionData = news.subscriptionData
    ? {
        trial_period_days: news.subscriptionData.trialPeriodDays,
        metadata: news.subscriptionData.metadata,
        missing_payment_method:
          news.subscriptionData.trialSettings?.endBehavior
            .missingPaymentMethod ??
          (news.subscriptionData.trialPeriodDays !== undefined
            ? "create_invoice"
            : undefined),
      }
    : undefined;
  const observedSubscriptionData = observed.subscription_data
    ? {
        trial_period_days:
          observed.subscription_data.trial_period_days ?? undefined,
        metadata: Object.keys(observed.subscription_data.metadata ?? {}).length
          ? asMetadata(observed.subscription_data.metadata)
          : undefined,
        missing_payment_method:
          observed.subscription_data.trial_settings?.end_behavior
            .missing_payment_method,
      }
    : undefined;
  // A link with no recurring line item carries no `subscription_data` at all,
  // and Stripe rejects the parameter on such a link — nothing to converge.
  if (
    news.subscriptionData !== undefined &&
    observedSubscriptionData !== undefined &&
    !sameJson(desiredSubscriptionData, observedSubscriptionData)
  ) {
    set(
      "subscription_data",
      toWireSubscriptionDataUpdate(news.subscriptionData),
    );
  }

  const desiredTaxIdCollection = {
    enabled: news.taxIdCollection?.enabled ?? false,
    required: news.taxIdCollection?.required ?? "never",
  };
  const observedTaxIdCollection = {
    enabled: observed.tax_id_collection.enabled,
    required: observed.tax_id_collection.required,
  };
  if (!sameJson(desiredTaxIdCollection, observedTaxIdCollection)) {
    set("tax_id_collection", desiredTaxIdCollection);
  }

  // --- metadata ------------------------------------------------------------
  // Diffed against the metadata observed on the live object (never `olds`),
  // so an adopted link with foreign keys converges. Removed keys are blanked
  // because Stripe unsets a key by posting an empty value.
  const observedMetadata = asMetadata(observed.metadata);
  if (!metadataEqual(observedMetadata, desiredMetadata)) {
    set("metadata", metadataUpdate(observedMetadata, desiredMetadata));
  }

  return changed
    ? (update as Omit<PostPaymentLinksPaymentLinkRequest, "payment_link">)
    : undefined;
};

// ---------------------------------------------------------------------------
// Structural comparison
// ---------------------------------------------------------------------------

/**
 * Key-order-insensitive structural equality. `undefined` fields are dropped
 * so `{ a: 1 }` and `{ a: 1, b: undefined }` compare equal — which is what
 * "the user didn't set it" means on the Stripe wire.
 */
const sameJson = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};
