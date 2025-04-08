# Product

The Product resource lets you create and manage [Stripe Products](https://stripe.com/docs/api/products) which represent goods and services that you sell.

# Minimal Example

Create a basic digital product with name and description.

```ts
import { Product } from "alchemy/stripe";

const product = await Product("basic-software", {
  name: "Basic Software License", 
  description: "Single-user license for basic software package"
});
```

# Create a Physical Product

Create a physical product with shipping details and images.

```ts
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

# Create a Service Product

Create a service product with tax code and metadata.

```ts
import { Product } from "alchemy/stripe";

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