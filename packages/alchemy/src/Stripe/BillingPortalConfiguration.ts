import {
  GetBillingPortalConfigurations,
  GetBillingPortalConfigurationsConfiguration,
  PostBillingPortalConfigurations,
  PostBillingPortalConfigurationsConfiguration,
  type BillingPortalConfiguration as StripePortalConfiguration,
  type PortalFeatures,
  type PostBillingPortalConfigurationsConfigurationRequest,
  type PostBillingPortalConfigurationsRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ALCHEMY_ID_KEY,
  ALCHEMY_STACK_KEY,
  ALCHEMY_STAGE_KEY,
  brandMetadata,
  internalMetadata,
  isOwned,
  metadataUpdate,
  stripInternalMetadata,
  type Metadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** A customer detail the portal is allowed to edit. */
export type BillingPortalCustomerUpdateField =
  | "address"
  | "email"
  | "name"
  | "phone"
  | "shipping"
  | "tax_id";

/** A cancellation reason offered to the customer when they cancel. */
export type BillingPortalCancellationReason =
  | "customer_service"
  | "low_quality"
  | "missing_features"
  | "other"
  | "switched_service"
  | "too_complex"
  | "too_expensive"
  | "unused";

/** How Stripe handles prorations resulting from a portal-driven change. */
export type BillingPortalProrationBehavior =
  | "always_invoice"
  | "create_prorations"
  | "none";

/** Whether a cancellation takes effect immediately or at the period end. */
export type BillingPortalSubscriptionCancelMode =
  | "at_period_end"
  | "immediately";

/** A subscription attribute the portal is allowed to change. */
export type BillingPortalSubscriptionUpdateField =
  | "price"
  | "promotion_code"
  | "quantity";

/** What happens to the billing cycle anchor on a portal-driven update. */
export type BillingPortalBillingCycleAnchor = "now" | "unchanged";

/** How a portal-driven update behaves while the subscription is trialing. */
export type BillingPortalTrialUpdateBehavior = "continue_trial" | "end_trial";

/** A condition that defers an update to the end of the current period. */
export type BillingPortalScheduleCondition =
  | "decreasing_item_amount"
  | "shortening_interval";

// ---------------------------------------------------------------------------
// Props — nested camelCase mirrors of Stripe's `features` object
// ---------------------------------------------------------------------------

/** The business information shown to customers inside the portal. */
export type BillingPortalBusinessProfile = {
  /** The messaging shown at the top of the portal. */
  headline?: string;
  /** A link to your publicly available privacy policy. */
  privacyPolicyUrl?: string;
  /** A link to your publicly available terms of service. */
  termsOfServiceUrl?: string;
};

/** Controls whether customers may edit their own details in the portal. */
export type BillingPortalCustomerUpdate = {
  /** Whether customers may update their own details. */
  enabled: boolean;
  /**
   * Which customer details may be edited. When omitted (or empty) no detail
   * is editable, even when `enabled` is `true`.
   */
  allowedUpdates?: BillingPortalCustomerUpdateField[];
};

/** Controls whether the portal shows the customer's billing history. */
export type BillingPortalInvoiceHistory = {
  /** Whether invoice history is shown. */
  enabled: boolean;
};

/** Controls whether customers may manage their payment methods. */
export type BillingPortalPaymentMethodUpdate = {
  /** Whether payment methods may be added/removed. */
  enabled: boolean;
  /**
   * ID of the `PaymentMethodConfiguration` that decides which payment method
   * types are offered. Defaults to the account's default configuration.
   */
  paymentMethodConfiguration?: string;
};

/** Whether cancellation reasons are collected, and which are offered. */
export type BillingPortalCancellationReasonOptions = {
  /** Whether the customer is asked why they are cancelling. */
  enabled: boolean;
  /**
   * The reasons offered to the customer. Required by Stripe when `enabled`
   * is `true`.
   */
  options?: BillingPortalCancellationReason[];
};

/** Controls whether customers may cancel their subscription. */
export type BillingPortalSubscriptionCancel = {
  /** Whether cancellation is offered. */
  enabled: boolean;
  /**
   * Whether the cancellation applies immediately or at the end of the
   * current billing period.
   *
   * @default "at_period_end"
   */
  mode?: BillingPortalSubscriptionCancelMode;
  /**
   * Proration handling on cancellation. `create_prorations` is only valid
   * with `mode: "immediately"`; `always_invoice` is rejected by Stripe.
   *
   * @default "none"
   */
  prorationBehavior?: BillingPortalProrationBehavior;
  /** Whether cancellation reasons are collected, and which are offered. */
  cancellationReason?: BillingPortalCancellationReasonOptions;
};

/** Whether (and within what bounds) a product's quantity may be adjusted. */
export type BillingPortalAdjustableQuantity = {
  /** Whether the quantity may be adjusted at all. */
  enabled: boolean;
  /** The largest quantity the customer may select. */
  maximum?: number;
  /**
   * The smallest quantity the customer may select.
   *
   * @default 0
   */
  minimum?: number;
};

/** A product (and its selectable prices) the portal may switch between. */
export type BillingPortalSubscriptionUpdateProduct = {
  /** The `Product` ID, e.g. `product.productId`. */
  product: string;
  /** The `Price` IDs of that product the subscription may move to. */
  prices: string[];
  /** Whether the quantity of this product may be adjusted. */
  adjustableQuantity?: BillingPortalAdjustableQuantity;
};

/** Defers a portal-driven update to the end of the current period. */
export type BillingPortalScheduleAtPeriodEnd = {
  /**
   * When any listed condition holds, the update is scheduled for the end of
   * the current period instead of being applied immediately.
   */
  conditions?: BillingPortalScheduleCondition[];
};

/** Controls whether customers may change their subscription. */
export type BillingPortalSubscriptionUpdate = {
  /** Whether subscription updates are offered. */
  enabled: boolean;
  /**
   * Which subscription attributes may be changed. When omitted (or empty)
   * subscriptions are not updateable.
   */
  defaultAllowedUpdates?: BillingPortalSubscriptionUpdateField[];
  /**
   * Up to 10 products (with their selectable prices) the subscription may be
   * switched between. Required by Stripe when `enabled` is `true`.
   */
  products?: BillingPortalSubscriptionUpdateProduct[];
  /**
   * Proration handling on a subscription change.
   *
   * @default "none"
   */
  prorationBehavior?: BillingPortalProrationBehavior;
  /**
   * Whether a change resets the billing cycle anchor to now.
   *
   * @default "unchanged"
   */
  billingCycleAnchor?: BillingPortalBillingCycleAnchor;
  /** Conditions that defer the update to the end of the current period. */
  scheduleAtPeriodEnd?: BillingPortalScheduleAtPeriodEnd;
  /**
   * How a change behaves while the subscription is trialing.
   *
   * @default "end_trial"
   */
  trialUpdateBehavior?: BillingPortalTrialUpdateBehavior;
};

/** The set of features exposed by the portal. */
export type BillingPortalFeatures = {
  /** Editing the customer's own details. */
  customerUpdate?: BillingPortalCustomerUpdate;
  /** Showing the customer's billing history. */
  invoiceHistory?: BillingPortalInvoiceHistory;
  /** Managing the customer's payment methods. */
  paymentMethodUpdate?: BillingPortalPaymentMethodUpdate;
  /** Cancelling the customer's subscription. */
  subscriptionCancel?: BillingPortalSubscriptionCancel;
  /** Changing the customer's subscription. */
  subscriptionUpdate?: BillingPortalSubscriptionUpdate;
};

/** The hosted, shareable login page for this configuration. */
export type BillingPortalLoginPage = {
  /**
   * When `true` Stripe mints a shareable `loginPage.url` that takes
   * customers to a hosted portal login page. Setting it back to `false`
   * deactivates the previously generated URL.
   */
  enabled: boolean;
};

export type BillingPortalConfigurationProps = {
  /**
   * The features available in the portal. Required by Stripe — a portal
   * configuration with no feature block cannot be created.
   */
  features: BillingPortalFeatures;
  /**
   * Human-readable name shown in the Stripe Dashboard. Unset when omitted.
   */
  name?: string;
  /**
   * Whether the configuration may be used to create portal sessions.
   * Stripe always creates configurations active; setting this to `false`
   * archives it immediately after creation.
   *
   * @default true
   */
  active?: boolean;
  /** The business information shown to customers inside the portal. */
  businessProfile?: BillingPortalBusinessProfile;
  /**
   * Where customers land when they click the portal's "return to site"
   * link. Can be overridden per portal session.
   */
  defaultReturnUrl?: string;
  /** The hosted, shareable login page for this configuration. */
  loginPage?: BillingPortalLoginPage;
  /**
   * Arbitrary key/value pairs attached to the configuration. Alchemy also
   * writes its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys
   * here to brand the object as owned by this stack; those are stripped
   * from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Attributes — the resolved (defaults filled in) view of the same shape
// ---------------------------------------------------------------------------

/** Resolved business profile, with unset fields reported as `undefined`. */
export type BillingPortalBusinessProfileAttrs = {
  /** The messaging shown at the top of the portal. */
  headline: string | undefined;
  /** A link to your publicly available privacy policy. */
  privacyPolicyUrl: string | undefined;
  /** A link to your publicly available terms of service. */
  termsOfServiceUrl: string | undefined;
};

/** Resolved adjustable-quantity bounds for a portal-updateable product. */
export type BillingPortalAdjustableQuantityAttrs = {
  /** Whether the quantity may be adjusted. */
  enabled: boolean;
  /** The largest selectable quantity, or `undefined` when unbounded. */
  maximum: number | undefined;
  /** The smallest selectable quantity. */
  minimum: number;
};

/** Resolved product entry of `features.subscriptionUpdate.products`. */
export type BillingPortalSubscriptionUpdateProductAttrs = {
  /** The `Product` ID. */
  product: string;
  /** The `Price` IDs the subscription may move to. */
  prices: string[];
  /** Whether the quantity of this product may be adjusted. */
  adjustableQuantity: BillingPortalAdjustableQuantityAttrs;
};

/** Resolved feature set, with every Stripe default filled in. */
export type BillingPortalFeaturesAttrs = {
  /** Editing the customer's own details. */
  customerUpdate: {
    /** Whether customers may update their own details. */
    enabled: boolean;
    /** Which customer details may be edited (sorted). */
    allowedUpdates: BillingPortalCustomerUpdateField[];
  };
  /** Showing the customer's billing history. */
  invoiceHistory: {
    /** Whether invoice history is shown. */
    enabled: boolean;
  };
  /** Managing the customer's payment methods. */
  paymentMethodUpdate: {
    /** Whether payment methods may be added/removed. */
    enabled: boolean;
    /** The `PaymentMethodConfiguration` in use, if any. */
    paymentMethodConfiguration: string | undefined;
  };
  /** Cancelling the customer's subscription. */
  subscriptionCancel: {
    /** Whether cancellation is offered. */
    enabled: boolean;
    /** Whether cancellation is immediate or deferred to the period end. */
    mode: BillingPortalSubscriptionCancelMode;
    /** Proration handling on cancellation. */
    prorationBehavior: BillingPortalProrationBehavior;
    /** Whether cancellation reasons are collected, and which are offered. */
    cancellationReason: {
      /** Whether the customer is asked why they are cancelling. */
      enabled: boolean;
      /** The reasons offered to the customer (sorted). */
      options: BillingPortalCancellationReason[];
    };
  };
  /** Changing the customer's subscription. */
  subscriptionUpdate: {
    /** Whether subscription updates are offered. */
    enabled: boolean;
    /** Which subscription attributes may be changed (sorted). */
    defaultAllowedUpdates: BillingPortalSubscriptionUpdateField[];
    /** The switchable products, or `undefined` when none are configured. */
    products: BillingPortalSubscriptionUpdateProductAttrs[] | undefined;
    /** Proration handling on a subscription change. */
    prorationBehavior: BillingPortalProrationBehavior;
    /** Whether a change resets the billing cycle anchor to now. */
    billingCycleAnchor: BillingPortalBillingCycleAnchor;
    /** Conditions that defer the update to the end of the period. */
    scheduleAtPeriodEnd: {
      /** The deferral conditions (sorted). */
      conditions: BillingPortalScheduleCondition[];
    };
    /** How a change behaves while the subscription is trialing. */
    trialUpdateBehavior: BillingPortalTrialUpdateBehavior;
  };
};

export type BillingPortalConfiguration = Resource<
  "Stripe.BillingPortalConfiguration",
  BillingPortalConfigurationProps,
  {
    /** Stripe's ID for the configuration, e.g. `bpc_1A2b3C...`. */
    billingPortalConfigurationId: string;
    /** Whether the configuration may be used to create portal sessions. */
    active: boolean;
    /**
     * Whether this is the account's default configuration. Stripe refuses to
     * deactivate the default configuration, so a default configuration
     * survives `destroy`.
     */
    isDefault: boolean;
    /** `false` for configurations created with a test-mode API key. */
    livemode: boolean;
    /** Human-readable name, or `undefined` when unset. */
    name: string | undefined;
    /** Where customers land on "return to site", or `undefined`. */
    defaultReturnUrl: string | undefined;
    /** The business information shown to customers inside the portal. */
    businessProfile: BillingPortalBusinessProfileAttrs;
    /** The resolved feature set, with every Stripe default filled in. */
    features: BillingPortalFeaturesAttrs;
    /** The hosted login page and its shareable URL, when enabled. */
    loginPage: {
      /** Whether the hosted login page is active. */
      enabled: boolean;
      /** The shareable login page URL, or `undefined` when disabled. */
      url: string | undefined;
    };
    /** User metadata, with alchemy's internal `alchemy_*` keys stripped. */
    metadata: Record<string, string>;
    /** Unix timestamp (seconds) at which the configuration was created. */
    created: number;
    /** Unix timestamp (seconds) at which the configuration last changed. */
    updated: number;
  },
  never,
  Providers
>;

type BillingPortalConfigurationAttributes =
  BillingPortalConfiguration["Attributes"];

/**
 * A Stripe billing portal configuration — the functionality and branding
 * customers see inside the hosted customer portal.
 *
 * A configuration describes which features the portal exposes (updating
 * customer details, viewing invoices, managing payment methods, cancelling
 * or changing a subscription), the business profile shown at the top of the
 * portal, and where the "return to site" link points. Portal sessions
 * reference a configuration; the account's *default* configuration is used
 * when a session names none.
 *
 * :::caution
 * Stripe does not support deleting a billing portal configuration. Destroying
 * this resource **archives** it by setting `active: false`; the object remains
 * visible in the Dashboard and in list calls. Stripe additionally refuses to
 * deactivate the account's **default** configuration — destroying a resource
 * that is `isDefault` leaves the configuration fully active and logs a
 * warning rather than failing the destroy.
 * :::
 *
 * ### Creating a configuration
 * **Example:** Minimal configuration
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("portal", {
 *   features: {
 *     invoiceHistory: { enabled: true },
 *   },
 * });
 * ```
 *
 * **Example:** Branding and a return URL
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("portal", {
 *   businessProfile: {
 *     headline: "Acme Inc. — manage your subscription",
 *     privacyPolicyUrl: "https://acme.example.com/privacy",
 *     termsOfServiceUrl: "https://acme.example.com/terms",
 *   },
 *   defaultReturnUrl: "https://acme.example.com/account",
 *   features: {
 *     invoiceHistory: { enabled: true },
 *     customerUpdate: {
 *       enabled: true,
 *       allowedUpdates: ["address", "email", "tax_id"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Cancellation and payment methods
 * **Example:** Let customers cancel and tell you why
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("portal", {
 *   features: {
 *     invoiceHistory: { enabled: true },
 *     paymentMethodUpdate: { enabled: true },
 *     subscriptionCancel: {
 *       enabled: true,
 *       mode: "at_period_end",
 *       prorationBehavior: "none",
 *       cancellationReason: {
 *         enabled: true,
 *         options: ["too_expensive", "missing_features", "other"],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Plan switching
 * **Example:** Offer an upgrade path between two prices
 * ```typescript
 * const product = yield* Stripe.Product("saas", { name: "Acme SaaS" });
 * const monthly = yield* Stripe.Price("monthly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 1000,
 *   recurring: { interval: "month" },
 * });
 * const yearly = yield* Stripe.Price("yearly", {
 *   productId: product.productId,
 *   currency: "usd",
 *   unitAmount: 10000,
 *   recurring: { interval: "year" },
 * });
 *
 * const portal = yield* Stripe.BillingPortalConfiguration("portal", {
 *   features: {
 *     invoiceHistory: { enabled: true },
 *     subscriptionUpdate: {
 *       enabled: true,
 *       defaultAllowedUpdates: ["price", "promotion_code"],
 *       prorationBehavior: "create_prorations",
 *       products: [
 *         {
 *           product: product.productId,
 *           prices: [monthly.priceId, yearly.priceId],
 *           adjustableQuantity: { enabled: true, minimum: 1, maximum: 10 },
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Sharing a hosted login page
 * **Example:** Mint a shareable portal login URL
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("portal", {
 *   loginPage: { enabled: true },
 *   features: { invoiceHistory: { enabled: true } },
 * });
 *
 * // portal.loginPage.url — share this with customers
 * ```
 *
 * @see https://docs.stripe.com/api/customer_portal/configuration
 *
 * @resource
 */
export const BillingPortalConfiguration = Resource<BillingPortalConfiguration>(
  "Stripe.BillingPortalConfiguration",
);

export const BillingPortalConfigurationProvider = () =>
  Provider.succeed(BillingPortalConfiguration, {
    stables: ["billingPortalConfigurationId", "livemode", "created"],

    // No `diff`: every modelled field of a portal configuration is mutable
    // through `POST /v1/billing_portal/configurations/{configuration}`, so
    // there is no immutable field and therefore no provider-driven
    // replacement path. The engine's default update logic is exactly right,
    // and `reconcile` skips the API outright when nothing actually changed.

    list: Effect.fn(function* () {
      const configurations = yield* listAllConfigurations;
      // Only surface configurations alchemy branded. The account's default
      // configuration (and any hand-made one) is deliberately excluded so a
      // nuke can never archive infrastructure alchemy does not own.
      return configurations
        .filter(
          (configuration) =>
            !configuration.is_default &&
            configuration.metadata?.[ALCHEMY_STACK_KEY] !== undefined,
        )
        .map(toAttrs);
    }),

    read: Effect.fn(function* ({ id, output }) {
      const configurationId = output?.billingPortalConfigurationId;
      const observed = configurationId
        ? yield* getConfiguration(configurationId)
        : // State loss: re-discover by the `alchemy_*` branding written into
          // the configuration's metadata, so we adopt rather than duplicate.
          yield* findByBranding(id);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed);
      return (yield* isOwned(id, toMetadata(observed.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const metadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the live object is authoritative; `output` is only a
      //    cache for the id, never proof the configuration still exists.
      let observed = output?.billingPortalConfigurationId
        ? yield* getConfiguration(output.billingPortalConfigurationId)
        : yield* findByBranding(id);

      // 2. Ensure — create when missing. `active` is not accepted by the
      //    create API, so an `active: false` configuration is created active
      //    and archived by the sync step below.
      if (observed === undefined) {
        observed = yield* PostBillingPortalConfigurations(
          createRequest(news, metadata),
        );
      }

      // 3. Sync — converge observed → desired. Skip the API entirely when the
      //    live configuration already matches, so a no-op deploy is silent.
      const desired = desiredProjection(news, metadata);
      if (!sameShape(observedProjection(observed), desired)) {
        observed = yield* PostBillingPortalConfigurationsConfiguration(
          updateRequest(observed, news, metadata),
        );
      }

      // 4. Return the fresh attributes.
      return toAttrs(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const configurationId = output.billingPortalConfigurationId;
      const observed = yield* getConfiguration(configurationId);
      // Already gone, or already archived — deleting is idempotent.
      if (observed === undefined || observed.active === false) return;
      if (observed.is_default) {
        yield* Effect.logWarning(
          `Stripe refuses to deactivate the default billing portal configuration '${configurationId}'; leaving it active.`,
        );
        return;
      }
      yield* PostBillingPortalConfigurationsConfiguration({
        configuration: configurationId,
        active: false,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("InvalidRequestError", (error) =>
          isMissing(error) || isDefaultConfigurationRefusal(error)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
        // Stripe answers a deactivate of the default configuration with a
        // plain 400 in some API versions; that is a refusal to archive, not
        // a failure of the destroy.
        Effect.catchTag("BadRequest", (error) =>
          isDefaultConfigurationRefusal(error)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    }),
  });

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

/**
 * Stripe reports a missing object as `invalid_request_error` with
 * `code: "resource_missing"`. Distilled dispatches on `error.type` before
 * HTTP status, so this surfaces as `InvalidRequestError` rather than
 * `NotFound` — both are treated as "absent".
 */
const isMissing = (error: { readonly code?: string | undefined }): boolean =>
  error.code === "resource_missing";

const isDefaultConfigurationRefusal = (error: {
  readonly message?: string | undefined;
}): boolean => (error.message ?? "").toLowerCase().includes("default");

const getConfiguration = (configurationId: string) =>
  GetBillingPortalConfigurationsConfiguration({
    configuration: configurationId,
  }).pipe(
    Effect.map(
      (configuration): StripePortalConfiguration | undefined => configuration,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      isMissing(error) ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );

/** Stripe caps `limit` at 100; 100 pages is 10k configurations. */
const MAX_PAGES = 100;

const listAllConfigurations = Effect.gen(function* () {
  const all: StripePortalConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetBillingPortalConfigurations({
      limit: 100,
      starting_after: startingAfter,
    });
    all.push(...response.data);
    const last = response.data.at(-1);
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return all;
});

const findByBranding = Effect.fn(function* (id: string) {
  const expected = yield* internalMetadata(id);
  const all = yield* listAllConfigurations;
  return all.find(
    (configuration) =>
      configuration.metadata?.[ALCHEMY_STACK_KEY] ===
        expected[ALCHEMY_STACK_KEY] &&
      configuration.metadata?.[ALCHEMY_STAGE_KEY] ===
        expected[ALCHEMY_STAGE_KEY] &&
      configuration.metadata?.[ALCHEMY_ID_KEY] === expected[ALCHEMY_ID_KEY],
  );
});

// ---------------------------------------------------------------------------
// Normalization — desired props and observed API state are projected onto one
// shape so "does the cloud already match?" is a single structural comparison.
// ---------------------------------------------------------------------------

const sorted = <T extends string>(values: readonly T[] | undefined): T[] =>
  [...(values ?? [])].sort();

/**
 * Stripe types every metadata map as `string | undefined`-valued, while
 * alchemy's ownership helpers work on a plain `Record<string, string>`.
 */
const toMetadata = (
  metadata: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const orUndefined = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value === "" ? undefined : value;

const desiredFeatures = (
  features: BillingPortalFeatures,
): BillingPortalFeaturesAttrs => {
  const cancel = features.subscriptionCancel;
  const update = features.subscriptionUpdate;
  return {
    customerUpdate: {
      enabled: features.customerUpdate?.enabled ?? false,
      allowedUpdates: sorted(features.customerUpdate?.allowedUpdates),
    },
    invoiceHistory: { enabled: features.invoiceHistory?.enabled ?? false },
    paymentMethodUpdate: {
      enabled: features.paymentMethodUpdate?.enabled ?? false,
      paymentMethodConfiguration: orUndefined(
        features.paymentMethodUpdate?.paymentMethodConfiguration,
      ),
    },
    subscriptionCancel: {
      enabled: cancel?.enabled ?? false,
      mode: cancel?.mode ?? "at_period_end",
      prorationBehavior: cancel?.prorationBehavior ?? "none",
      cancellationReason: {
        enabled: cancel?.cancellationReason?.enabled ?? false,
        options: sorted(cancel?.cancellationReason?.options),
      },
    },
    subscriptionUpdate: {
      enabled: update?.enabled ?? false,
      defaultAllowedUpdates: sorted(update?.defaultAllowedUpdates),
      products:
        update?.products === undefined || update.products.length === 0
          ? undefined
          : update.products.map((product) => ({
              product: product.product,
              prices: [...product.prices],
              adjustableQuantity: {
                enabled: product.adjustableQuantity?.enabled ?? false,
                maximum: product.adjustableQuantity?.maximum,
                minimum: product.adjustableQuantity?.minimum ?? 0,
              },
            })),
      prorationBehavior: update?.prorationBehavior ?? "none",
      billingCycleAnchor: update?.billingCycleAnchor ?? "unchanged",
      scheduleAtPeriodEnd: {
        conditions: sorted(update?.scheduleAtPeriodEnd?.conditions),
      },
      trialUpdateBehavior: update?.trialUpdateBehavior ?? "end_trial",
    },
  };
};

const observedFeatures = (
  features: PortalFeatures,
): BillingPortalFeaturesAttrs => ({
  customerUpdate: {
    enabled: features.customer_update.enabled,
    allowedUpdates: sorted(features.customer_update.allowed_updates),
  },
  invoiceHistory: { enabled: features.invoice_history.enabled },
  paymentMethodUpdate: {
    enabled: features.payment_method_update.enabled,
    paymentMethodConfiguration: orUndefined(
      features.payment_method_update.payment_method_configuration,
    ),
  },
  subscriptionCancel: {
    enabled: features.subscription_cancel.enabled,
    mode: features.subscription_cancel.mode,
    prorationBehavior: features.subscription_cancel.proration_behavior,
    cancellationReason: {
      enabled: features.subscription_cancel.cancellation_reason.enabled,
      options: sorted(features.subscription_cancel.cancellation_reason.options),
    },
  },
  subscriptionUpdate: {
    enabled: features.subscription_update.enabled,
    defaultAllowedUpdates: sorted(
      features.subscription_update.default_allowed_updates,
    ),
    products:
      features.subscription_update.products === undefined ||
      features.subscription_update.products === null ||
      features.subscription_update.products.length === 0
        ? undefined
        : features.subscription_update.products.map((product) => ({
            product: product.product,
            prices: [...product.prices],
            adjustableQuantity: {
              enabled: product.adjustable_quantity.enabled,
              maximum: product.adjustable_quantity.maximum ?? undefined,
              minimum: product.adjustable_quantity.minimum,
            },
          })),
    prorationBehavior: features.subscription_update.proration_behavior,
    // Stripe reports "unchanged" as `null` on the object but only accepts
    // `now` / `unchanged` on the wire — normalize so the two sides compare.
    billingCycleAnchor:
      features.subscription_update.billing_cycle_anchor ?? "unchanged",
    scheduleAtPeriodEnd: {
      conditions: sorted(
        features.subscription_update.schedule_at_period_end.conditions.map(
          (condition) => condition.type,
        ),
      ),
    },
    trialUpdateBehavior: features.subscription_update.trial_update_behavior,
  },
});

type Projection = {
  name: string | undefined;
  active: boolean;
  defaultReturnUrl: string | undefined;
  businessProfile: BillingPortalBusinessProfileAttrs;
  features: BillingPortalFeaturesAttrs;
  loginPageEnabled: boolean;
  metadata: Metadata;
};

const desiredProjection = (
  news: BillingPortalConfigurationProps,
  metadata: Metadata,
): Projection => ({
  name: orUndefined(news.name),
  active: news.active ?? true,
  defaultReturnUrl: orUndefined(news.defaultReturnUrl),
  businessProfile: {
    headline: orUndefined(news.businessProfile?.headline),
    privacyPolicyUrl: orUndefined(news.businessProfile?.privacyPolicyUrl),
    termsOfServiceUrl: orUndefined(news.businessProfile?.termsOfServiceUrl),
  },
  features: desiredFeatures(news.features),
  loginPageEnabled: news.loginPage?.enabled ?? false,
  metadata,
});

const observedProjection = (
  configuration: StripePortalConfiguration,
): Projection => ({
  name: orUndefined(configuration.name),
  active: configuration.active,
  defaultReturnUrl: orUndefined(configuration.default_return_url),
  businessProfile: {
    headline: orUndefined(configuration.business_profile.headline),
    privacyPolicyUrl: orUndefined(
      configuration.business_profile.privacy_policy_url,
    ),
    termsOfServiceUrl: orUndefined(
      configuration.business_profile.terms_of_service_url,
    ),
  },
  features: observedFeatures(configuration.features),
  loginPageEnabled: configuration.login_page.enabled,
  metadata: toMetadata(configuration.metadata),
});

/** Key-sorted, `undefined`-stripped JSON so field order never matters. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};

const sameShape = (left: Projection, right: Projection): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// ---------------------------------------------------------------------------
// Wire translation — camelCase props → Stripe's snake_case form encoding
// ---------------------------------------------------------------------------

/**
 * The create payload omits everything the user did not specify: on a
 * greenfield create "omitted" already means "Stripe's default", and the
 * create API rejects the empty-string unset sentinel for URL fields.
 */
const createRequest = (
  news: BillingPortalConfigurationProps,
  metadata: Metadata,
): PostBillingPortalConfigurationsRequest => {
  const features = news.features;
  const cancel = features.subscriptionCancel;
  const update = features.subscriptionUpdate;
  return {
    name: news.name,
    default_return_url: news.defaultReturnUrl,
    business_profile: news.businessProfile && {
      headline: news.businessProfile.headline,
      privacy_policy_url: news.businessProfile.privacyPolicyUrl,
      terms_of_service_url: news.businessProfile.termsOfServiceUrl,
    },
    features: {
      customer_update: features.customerUpdate && {
        enabled: features.customerUpdate.enabled,
        allowed_updates: features.customerUpdate.allowedUpdates,
      },
      invoice_history: features.invoiceHistory && {
        enabled: features.invoiceHistory.enabled,
      },
      payment_method_update: features.paymentMethodUpdate && {
        enabled: features.paymentMethodUpdate.enabled,
        payment_method_configuration:
          features.paymentMethodUpdate.paymentMethodConfiguration,
      },
      subscription_cancel: cancel && {
        enabled: cancel.enabled,
        mode: cancel.mode,
        proration_behavior: cancel.prorationBehavior,
        cancellation_reason: cancel.cancellationReason && {
          enabled: cancel.cancellationReason.enabled,
          options: cancel.cancellationReason.options ?? [],
        },
      },
      subscription_update: update && {
        enabled: update.enabled,
        default_allowed_updates: update.defaultAllowedUpdates,
        products: update.products?.map(toWireProduct),
        proration_behavior: update.prorationBehavior,
        billing_cycle_anchor: update.billingCycleAnchor,
        schedule_at_period_end: update.scheduleAtPeriodEnd && {
          conditions: update.scheduleAtPeriodEnd.conditions?.map((type) => ({
            type,
          })),
        },
        trial_update_behavior: update.trialUpdateBehavior,
      },
    },
    login_page: news.loginPage && { enabled: news.loginPage.enabled },
    metadata,
  };
};

/**
 * The update payload is fully explicit: every field the resource models is
 * sent, using Stripe's empty-string sentinel (`""`) to unset the fields the
 * user removed. Without that, dropping a prop would silently leave the old
 * value deployed forever.
 */
const updateRequest = (
  observed: StripePortalConfiguration,
  news: BillingPortalConfigurationProps,
  metadata: Metadata,
): PostBillingPortalConfigurationsConfigurationRequest => {
  const features = news.features;
  const cancel = features.subscriptionCancel;
  const update = features.subscriptionUpdate;
  return {
    configuration: observed.id,
    active: news.active ?? true,
    name: news.name ?? "",
    default_return_url: news.defaultReturnUrl ?? "",
    business_profile: {
      headline: news.businessProfile?.headline ?? "",
      privacy_policy_url: news.businessProfile?.privacyPolicyUrl ?? "",
      terms_of_service_url: news.businessProfile?.termsOfServiceUrl ?? "",
    },
    features: {
      customer_update: {
        enabled: features.customerUpdate?.enabled ?? false,
        allowed_updates: features.customerUpdate?.allowedUpdates ?? "",
      },
      invoice_history: { enabled: features.invoiceHistory?.enabled ?? false },
      payment_method_update: {
        enabled: features.paymentMethodUpdate?.enabled ?? false,
        payment_method_configuration:
          features.paymentMethodUpdate?.paymentMethodConfiguration ?? "",
      },
      subscription_cancel: {
        enabled: cancel?.enabled ?? false,
        mode: cancel?.mode ?? "at_period_end",
        proration_behavior: cancel?.prorationBehavior ?? "none",
        cancellation_reason: {
          enabled: cancel?.cancellationReason?.enabled ?? false,
          options: cancel?.cancellationReason?.options ?? "",
        },
      },
      subscription_update: {
        enabled: update?.enabled ?? false,
        default_allowed_updates: update?.defaultAllowedUpdates ?? "",
        products: update?.products?.map(toWireProduct) ?? "",
        proration_behavior: update?.prorationBehavior ?? "none",
        billing_cycle_anchor: update?.billingCycleAnchor ?? "unchanged",
        schedule_at_period_end: {
          conditions:
            update?.scheduleAtPeriodEnd?.conditions?.map((type) => ({
              type,
            })) ?? "",
        },
        trial_update_behavior: update?.trialUpdateBehavior ?? "end_trial",
      },
    },
    login_page: { enabled: news.loginPage?.enabled ?? false },
    // Diff metadata against what Stripe currently holds (never against
    // `olds`) so an adopted object with foreign keys converges, and blank
    // the keys the user removed — Stripe unsets on an empty value.
    metadata: metadataUpdate(toMetadata(observed.metadata), metadata),
  };
};

const toWireProduct = (product: BillingPortalSubscriptionUpdateProduct) => ({
  product: product.product,
  prices: product.prices,
  adjustable_quantity: product.adjustableQuantity && {
    enabled: product.adjustableQuantity.enabled,
    maximum: product.adjustableQuantity.maximum,
    minimum: product.adjustableQuantity.minimum,
  },
});

const toAttrs = (
  configuration: StripePortalConfiguration,
): BillingPortalConfigurationAttributes => ({
  billingPortalConfigurationId: configuration.id,
  active: configuration.active,
  isDefault: configuration.is_default,
  livemode: configuration.livemode,
  name: orUndefined(configuration.name),
  defaultReturnUrl: orUndefined(configuration.default_return_url),
  businessProfile: {
    headline: orUndefined(configuration.business_profile.headline),
    privacyPolicyUrl: orUndefined(
      configuration.business_profile.privacy_policy_url,
    ),
    termsOfServiceUrl: orUndefined(
      configuration.business_profile.terms_of_service_url,
    ),
  },
  features: observedFeatures(configuration.features),
  loginPage: {
    enabled: configuration.login_page.enabled,
    url: orUndefined(configuration.login_page.url),
  },
  metadata: stripInternalMetadata(toMetadata(configuration.metadata)),
  created: configuration.created,
  updated: configuration.updated,
});
