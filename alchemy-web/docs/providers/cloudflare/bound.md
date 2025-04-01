# Bound

The `Bound` type in Alchemy is used to define the type of a binding in a Cloudflare Worker. It maps specific Cloudflare resources to their corresponding types, such as Durable Object Namespaces, KV Namespaces, Workers, R2 Buckets, and Secrets. This type helps ensure that the correct resource type is used when binding resources to a Cloudflare Worker.

# Minimal Example

```ts
import { Bound } from "alchemy/cloudflare";

// Example usage of Bound type
type MyBinding = Bound<SomeCloudflareResource>;
```

# Create the Bound

```ts
import { Bound } from "alchemy/cloudflare";

// Define a binding for a Cloudflare Worker
type MyWorkerBinding = Bound<SomeCloudflareResource>;
```

# Bind to a Worker

```ts
import { Worker, Bound } from "alchemy/cloudflare";

// Define a resource to bind
const myResource = await Bound("my-resource", {
  // Resource-specific properties
});

// Create a Cloudflare Worker and bind the resource
await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myResource,
  },
});
```

This documentation provides a concise overview of the `Bound` type and its usage in binding resources to Cloudflare Workers. The examples demonstrate how to define and use the `Bound` type in a Cloudflare Worker context.