# Stripe Webhook Endpoint

The Webhook Endpoint resource lets you create and manage [Stripe webhook endpoints](https://stripe.com/docs/webhooks) to receive notifications about events in your Stripe account.

# Minimal Example

Create a basic webhook endpoint to receive payment events.

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("payment-webhook", {
  url: "https://api.example.com/stripe/payments",
  enabledEvents: [
    "payment_intent.succeeded",
    "payment_intent.payment_failed"
  ]
});
```

# Create a Subscription Management Webhook

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("subscription-webhook", {
  url: "https://api.example.com/stripe/subscriptions", 
  enabledEvents: [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_succeeded",
    "invoice.payment_failed"
  ],
  description: "Webhook for subscription lifecycle events",
  metadata: {
    type: "subscription",
    environment: "production"
  }
});
```

# Create a Connect Platform Webhook

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("connect-webhook", {
  url: "https://api.example.com/stripe/connect",
  enabledEvents: [
    "account.updated",
    "account.application.deauthorized", 
    "payout.created",
    "payout.failed"
  ],
  connect: true,
  description: "Webhook for Connect platform events"
});
```