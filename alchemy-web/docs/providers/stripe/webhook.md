# WebhookEndpoint

The WebhookEndpoint resource lets you create and manage [Stripe webhook endpoints](https://stripe.com/docs/api/webhook_endpoints) to receive notifications about events in your Stripe account.

# Minimal Example

Create a basic webhook endpoint to receive payment notifications:

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("payments", {
  url: "https://api.example.com/webhooks/stripe",
  enabledEvents: [
    "payment_intent.succeeded",
    "payment_intent.payment_failed"
  ]
});
```

# Subscription Webhook

Create a webhook endpoint to handle subscription lifecycle events:

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("subscriptions", {
  url: "https://api.example.com/webhooks/subscriptions", 
  enabledEvents: [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_succeeded"
  ],
  description: "Subscription management webhook",
  metadata: {
    type: "subscription",
    environment: "production"
  }
});
```

# Connect Platform Webhook 

Create a webhook endpoint for Stripe Connect platform events:

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("connect", {
  url: "https://api.example.com/webhooks/connect",
  enabledEvents: [
    "account.updated",
    "account.application.deauthorized", 
    "payout.created",
    "payout.failed"
  ],
  connect: true,
  description: "Connect platform webhook"
});
```