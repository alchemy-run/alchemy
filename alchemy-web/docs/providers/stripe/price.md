# Price

The Price resource lets you create and manage [Stripe Prices](https://stripe.com/docs/api/prices) for your products.

# Minimal Example

Create a simple one-time fixed price for a product.

```ts
import { Price } from "alchemy/stripe";

const price = await Price("basic-license", {
  currency: "usd", 
  unitAmount: 2999, // $29.99
  product: "prod_xyz"
});
```

# Create a Subscription Price

```ts
import { Price } from "alchemy/stripe";

const subscriptionPrice = await Price("pro-monthly", {
  currency: "usd",
  unitAmount: 1499, // $14.99/month
  product: "prod_xyz",
  recurring: {
    interval: "month",
    usageType: "licensed"
  }
});
```

# Create a Metered Price

```ts
import { Price } from "alchemy/stripe";

const meteredPrice = await Price("storage", {
  currency: "usd", 
  unitAmount: 25, // $0.25 per GB
  product: "prod_xyz",
  recurring: {
    interval: "month",
    usageType: "metered",
    aggregateUsage: "sum"
  }
});
```

# Create a Tiered Price

```ts
import { Price } from "alchemy/stripe";

const tieredPrice = await Price("enterprise", {
  currency: "usd",
  unitAmount: 10000, // $100.00
  product: "prod_xyz", 
  billingScheme: "tiered",
  taxBehavior: "exclusive",
  metadata: {
    tier: "enterprise",
    features: "all"
  }
});
```