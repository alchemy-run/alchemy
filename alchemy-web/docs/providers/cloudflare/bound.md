# Bound

The Bound component in Alchemy is used to define the type of a binding in Cloudflare Workers. It helps in determining the specific type of a binding, such as Durable Object Namespace, KV Namespace, Worker, R2 Bucket, or Secret. For more information on Cloudflare Workers, visit the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/).

# Minimal Example

```ts
import { Bound } from "alchemy/cloudflare";

// Example usage of Bound
type MyBinding = Bound<SomeBindingType>;
```

# Create the Bound

```ts
import { Bound } from "alchemy/cloudflare";

// Define a specific binding type
type MyDurableObjectNamespace = Bound<DurableObjectNamespace>;
```

# Bind to a Worker

```ts
import { Worker, Bound } from "alchemy/cloudflare";

const myResource = await Bound("my-resource", {
  // Define properties specific to the binding type
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myResource,
  },
});
```