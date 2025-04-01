# Product

The Product component allows you to create and manage [Stripe Products](https://stripe.com/docs/api/products) within your application.

# Minimal Example

```ts twoslash
import { Product } from "alchemy/stripe";

const digitalProduct = await Product("basic-software", {
  name: "Basic Software License",
  description: "Single-user license for basic software package",
  metadata: {
    type: "digital",
    features: "basic"
  }
});
```

# Create the Product

```ts twoslash
import { Product } from "alchemy/stripe";

const physicalProduct = await Product("premium-hardware", {
  name: "Premium Hardware Kit",
  description: "Complete hardware kit with premium components",
  shippable: true,
  images: ["https://example.com/hardware-kit.jpg"],
  unitLabel: "kit",
  statementDescriptor: "PREMIUM HW KIT"
});
```