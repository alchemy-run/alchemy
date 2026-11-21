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

export interface StripeEventClass<Type extends string = string, Object = unknown> {
  readonly type: Type;
  new (object: any): StripeEventInstance<Type, Object>;
}

export interface StripeEventInstance<Type extends string = string, Object = unknown> {
  readonly type: Type;
  readonly object: Object;
}

export class CustomerCreated {
  static readonly type = "customer.created" as const;
  readonly type = "customer.created" as const;
  constructor(readonly object: Customer) {}
}
export class CustomerUpdated {
  static readonly type = "customer.updated" as const;
  readonly type = "customer.updated" as const;
  constructor(readonly object: Customer) {}
}
export class CustomerDeleted {
  static readonly type = "customer.deleted" as const;
  readonly type = "customer.deleted" as const;
  constructor(readonly object: Customer) {}
}
export class InvoicePaid {
  static readonly type = "invoice.paid" as const;
  readonly type = "invoice.paid" as const;
  constructor(readonly object: Invoice) {}
}
export class InvoicePaymentFailed {
  static readonly type = "invoice.payment_failed" as const;
  readonly type = "invoice.payment_failed" as const;
  constructor(readonly object: Invoice) {}
}
export class CheckoutSessionCompleted {
  static readonly type = "checkout.session.completed" as const;
  readonly type = "checkout.session.completed" as const;
  constructor(readonly object: CheckoutSession) {}
}
export class PaymentIntentSucceeded {
  static readonly type = "payment_intent.succeeded" as const;
  readonly type = "payment_intent.succeeded" as const;
  constructor(readonly object: PaymentIntent) {}
}
export class PaymentIntentFailed {
  static readonly type = "payment_intent.payment_failed" as const;
  readonly type = "payment_intent.payment_failed" as const;
  constructor(readonly object: PaymentIntent) {}
}
export class CustomerSubscriptionCreated {
  static readonly type = "customer.subscription.created" as const;
  readonly type = "customer.subscription.created" as const;
  constructor(readonly object: Subscription) {}
}
export class CustomerSubscriptionUpdated {
  static readonly type = "customer.subscription.updated" as const;
  readonly type = "customer.subscription.updated" as const;
  constructor(readonly object: Subscription) {}
}
export class CustomerSubscriptionDeleted {
  static readonly type = "customer.subscription.deleted" as const;
  readonly type = "customer.subscription.deleted" as const;
  constructor(readonly object: Subscription) {}
}
/**
 * Fires whenever a Connect account changes — most usefully when a merchant
 * finishes hosted onboarding and `charges_enabled` / `payouts_enabled`
 * flip to `true`.
 */
export class AccountUpdated {
  static readonly type = "account.updated" as const;
  readonly type = "account.updated" as const;
  constructor(readonly object: Account) {}
}

/** The object a thin event is about, e.g. the meter or event destination. */
export interface ThinEventRelatedObject {
  readonly id: string;
  /** Object type, e.g. `"billing.meter"` or `"v2.core.event_destination"`. */
  readonly type: string;
  /** API path to fetch the object, e.g. `/v2/core/event_destinations/ed_…`. */
  readonly url: string;
}

/** A thin event, fetched from `GET /v2/core/events/:id` after its delivery. */
export interface ThinEventObject {
  /** Event id (`evt_…`). */
  readonly id: string;
  /** When the event happened (ISO 8601). */
  readonly created: string;
  /** Whether the event happened in live mode. */
  readonly livemode: boolean;
  /** The object the event is about, if any. */
  readonly relatedObject: ThinEventRelatedObject | undefined;
  /** Event-specific details; their shape depends on the event type. */
  readonly data: unknown;
  /** Stripe-Context to fetch the event or related object with, for events from other accounts. */
  readonly context: string | undefined;
}

/** A thin-event class: Stripe delivers a notification, and the handler receives the fetched event. */
export interface StripeThinEventClass<Type extends string = string> extends StripeEventClass<
  Type,
  ThinEventObject
> {
  readonly payload: "thin";
}

/**
 * Declares a thin event type, for events Stripe only sends as thin events
 * (every `v1.*` and `v2.*` type in the event destination catalog).
 *
 * @example
 * ```typescript
 * class MeterErrorReportTriggered extends Stripe.ThinEvent(
 *   "v1.billing.meter.error_report_triggered",
 * ) {}
 * ```
 */
export const ThinEvent = <const Type extends string>(type: Type) =>
  class {
    static readonly type: Type = type;
    static readonly payload = "thin" as const;
    readonly type: Type = type;
    constructor(readonly object: ThinEventObject) {}
  };

/**
 * A meter's usage reports had errors (an unknown customer, a bad
 * payload). `object.data` summarizes them.
 */
export class MeterErrorReportTriggered extends ThinEvent(
  "v1.billing.meter.error_report_triggered",
) {}
/** Usage was reported for an event name that no meter matches. */
export class MeterNoMeterFound extends ThinEvent("v1.billing.meter.no_meter_found") {}
/**
 * Sent when an event destination is pinged, e.g. from the Dashboard's
 * "Send test event", to check delivery end to end.
 */
export class EventDestinationPing extends ThinEvent("v2.core.event_destination.ping") {}

export const isThinEventClass = (event: StripeEventClass): event is StripeThinEventClass =>
  "payload" in event && event.payload === "thin";
