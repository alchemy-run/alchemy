/**
 * Stripe webhook event classes. Each class is both the subscribe key
 * (`events: [CustomerCreated]`) and the value the handler receives.
 */

export interface StripeEventClass<
  Type extends string = string,
  Object = unknown,
> {
  readonly type: Type;
  new (object: Object): StripeEventInstance<Type, Object>;
}

export interface StripeEventInstance<
  Type extends string = string,
  Object = unknown,
> {
  readonly type: Type;
  readonly object: Object;
}

export class CustomerCreated {
  static readonly type = "customer.created" as const;
  readonly type = "customer.created" as const;
  constructor(readonly object: unknown) {}
}
export class CustomerUpdated {
  static readonly type = "customer.updated" as const;
  readonly type = "customer.updated" as const;
  constructor(readonly object: unknown) {}
}
export class CustomerDeleted {
  static readonly type = "customer.deleted" as const;
  readonly type = "customer.deleted" as const;
  constructor(readonly object: unknown) {}
}
export class InvoicePaid {
  static readonly type = "invoice.paid" as const;
  readonly type = "invoice.paid" as const;
  constructor(readonly object: unknown) {}
}
export class InvoicePaymentFailed {
  static readonly type = "invoice.payment_failed" as const;
  readonly type = "invoice.payment_failed" as const;
  constructor(readonly object: unknown) {}
}
export class CheckoutSessionCompleted {
  static readonly type = "checkout.session.completed" as const;
  readonly type = "checkout.session.completed" as const;
  constructor(readonly object: unknown) {}
}
export class PaymentIntentSucceeded {
  static readonly type = "payment_intent.succeeded" as const;
  readonly type = "payment_intent.succeeded" as const;
  constructor(readonly object: unknown) {}
}
export class PaymentIntentFailed {
  static readonly type = "payment_intent.payment_failed" as const;
  readonly type = "payment_intent.payment_failed" as const;
  constructor(readonly object: unknown) {}
}
