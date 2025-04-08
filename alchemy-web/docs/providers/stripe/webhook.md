# Stripe Webhook Endpoint

The Webhook Endpoint resource lets you create and manage [Stripe webhook endpoints](https://stripe.com/docs/webhooks) to receive notifications about events in your Stripe account.

# Minimal Example

Create a basic webhook endpoint to receive payment-related events.

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("payment-webhook", {
  url: "https://api.example.com/stripe/payments",
  enabledEvents: [
    "payment_intent.succeeded",
    "payment_intent.payment_failed"
  ],
  description: "Webhook for payment notifications"
});
```

# Create a Subscription Management Webhook

Create a webhook endpoint to handle subscription lifecycle events.

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const subscriptionWebhook = await WebhookEndpoint("subscription-webhook", {
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

Create a webhook endpoint for handling Stripe Connect platform events.

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const connectWebhook = await WebhookEndpoint("connect-webhook", {
  url: "https://api.example.com/stripe/connect",
  enabledEvents: [
    "account.updated",
    "account.application.deauthorized", 
    "payout.created",
    "payout.failed"
  ],
  connect: true,
  metadata: {
    platform: "connect",
    environment: "production"
  }
});
```