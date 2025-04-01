# Product

The Product component allows you to create and manage [Stripe Products](https://stripe.com/docs/api/products) for your application.

# Minimal Example

```ts
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

```ts
import { Product } from "alchemy/stripe";

// Create a physical product with shipping details
const physicalProduct = await Product("premium-hardware", {
  name: "Premium Hardware Kit",
  description: "Complete hardware kit with premium components",
  shippable: true,
  images: ["https://example.com/hardware-kit.jpg"],
  unitLabel: "kit",
  statementDescriptor: "PREMIUM HW KIT"
});

// Create a service product with tax code
const serviceProduct = await Product("consulting", {
  name: "Professional Consulting",
  description: "Expert consulting services",
  type: "service",
  taxCode: "txcd_10000000",
  metadata: {
    industry: "technology",
    expertise: "cloud"
  }
});
```