# Bound

The Bound component in Alchemy allows you to define and manage bindings for Cloudflare Workers, such as Durable Object namespaces, KV namespaces, R2 buckets, and more. For more information on Cloudflare Workers, visit the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/).

# Minimal Example

```ts
import { Bound } from "alchemy/cloudflare";

const myBinding: Bound<any> = {
  // Define your binding here
};
```

# Create the Bound

```ts
import { Bound } from "alchemy/cloudflare";

const myBinding: Bound<any> = {
  // Define your binding here
};
```

# Bind to a Worker

```ts
import { Worker, Bound } from "alchemy/cloudflare";

const myResource = await Bound("my-resource", {
  // Define your resource properties here
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myResource,
  },
});
```