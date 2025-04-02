# Webhook Endpoint

The Webhook Endpoint component allows you to create and manage [Stripe Webhook Endpoints](https://stripe.com/docs/webhooks) for handling events from Stripe.

# Minimal Example

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const webhook = await WebhookEndpoint("basic-webhook", {
  url: "https://api.example.com/stripe/webhook",
  enabledEvents: ["payment_intent.succeeded", "payment_intent.payment_failed"],
});
```

# Create the Webhook Endpoint

```ts
import { WebhookEndpoint } from "alchemy/stripe";

const subscriptionWebhook = await WebhookEndpoint("subscription-webhook", {
  url: "https://api.example.com/stripe/subscriptions",
  enabledEvents: [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
  ],
  description: "Webhook for subscription lifecycle events",
});
```