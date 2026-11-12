/**
 * Stripe webhook event classes. Each class is both the subscribe key
 * (`events: [CustomerCreated]`) and the value the handler receives.
 */
import type {
  Account,
  CheckoutSession,
  Customer,
  Invoice,
  PaymentIntent,
  Subscription,
} from "@distilled.cloud/stripe/stripe";

/**
 * The envelope of a delivered Stripe event: what the event says about
 * itself beside its object. `id` names the event (`evt_…`) for logs and
 * deduplication, since Stripe may deliver one event more than once.
 */
export interface StripeEventMeta {
  readonly id: string;
  /** Seconds since the epoch at which Stripe created the event. */
  readonly created: number;
  readonly livemode: boolean;
  /** The API version Stripe rendered the object with, if it says one. */
  readonly apiVersion?: string;
}

export interface StripeEventClass<Type extends string = string, Object = unknown> {
  readonly type: Type;
  new (object: any, meta?: StripeEventMeta): StripeEventInstance<Type, Object>;
}

export interface StripeEventInstance<Type extends string = string, Object = unknown> {
  readonly type: Type;
  readonly object: Object;
  /** Set on every event {@link consumeEvents} delivers. */
  readonly meta?: StripeEventMeta;
}

export class CustomerCreated {
  static readonly type = "customer.created" as const;
  readonly type = "customer.created" as const;
  constructor(
    readonly object: Customer,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CustomerUpdated {
  static readonly type = "customer.updated" as const;
  readonly type = "customer.updated" as const;
  constructor(
    readonly object: Customer,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CustomerDeleted {
  static readonly type = "customer.deleted" as const;
  readonly type = "customer.deleted" as const;
  constructor(
    readonly object: Customer,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class InvoicePaid {
  static readonly type = "invoice.paid" as const;
  readonly type = "invoice.paid" as const;
  constructor(
    readonly object: Invoice,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class InvoicePaymentFailed {
  static readonly type = "invoice.payment_failed" as const;
  readonly type = "invoice.payment_failed" as const;
  constructor(
    readonly object: Invoice,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CheckoutSessionCompleted {
  static readonly type = "checkout.session.completed" as const;
  readonly type = "checkout.session.completed" as const;
  constructor(
    readonly object: CheckoutSession,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class PaymentIntentSucceeded {
  static readonly type = "payment_intent.succeeded" as const;
  readonly type = "payment_intent.succeeded" as const;
  constructor(
    readonly object: PaymentIntent,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class PaymentIntentFailed {
  static readonly type = "payment_intent.payment_failed" as const;
  readonly type = "payment_intent.payment_failed" as const;
  constructor(
    readonly object: PaymentIntent,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CustomerSubscriptionCreated {
  static readonly type = "customer.subscription.created" as const;
  readonly type = "customer.subscription.created" as const;
  constructor(
    readonly object: Subscription,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CustomerSubscriptionUpdated {
  static readonly type = "customer.subscription.updated" as const;
  readonly type = "customer.subscription.updated" as const;
  constructor(
    readonly object: Subscription,
    readonly meta?: StripeEventMeta,
  ) {}
}
export class CustomerSubscriptionDeleted {
  static readonly type = "customer.subscription.deleted" as const;
  readonly type = "customer.subscription.deleted" as const;
  constructor(
    readonly object: Subscription,
    readonly meta?: StripeEventMeta,
  ) {}
}
/**
 * Fires whenever a Connect account changes — most usefully when a merchant
 * finishes hosted onboarding and `charges_enabled` / `payouts_enabled`
 * flip to `true`.
 */
export class AccountUpdated {
  static readonly type = "account.updated" as const;
  readonly type = "account.updated" as const;
  constructor(
    readonly object: Account,
    readonly meta?: StripeEventMeta,
  ) {}
}
