# Price

The Price component allows you to create and manage [Stripe Prices](https://stripe.com/docs/api/prices) for products, enabling you to define pricing details for one-time or recurring billing.

# Minimal Example

```ts twoslash
import { Price } from "alchemy/stripe";

const oneTimePrice = await Price("basic-license", {
  currency: "usd",
  unitAmount: 2999, // $29.99
  product: "prod_xyz"
});
```

# Create the Price

```ts twoslash
import { Price } from "alchemy/stripe";

// Create a recurring subscription price with fixed monthly billing
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

```ts twoslash
import { Price } from "alchemy/stripe";

// Create a metered price for usage-based billing
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

```ts twoslash
import { Price } from "alchemy/stripe";

// Create a tiered price with tax behavior
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