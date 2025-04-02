# Kv Namespace

The Kv Namespace component allows you to create and manage [Cloudflare KV Namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/), which are key-value stores for your application.

# Minimal Example

```ts
import { KvNamespace } from "alchemy/cloudflare";

const myNamespace = await KvNamespace("my-namespace", {
  title: "example-namespace"
});
```

# Create the Kv Namespace

```ts
import { KvNamespace } from "alchemy/cloudflare";

const myNamespace = await KvNamespace("my-namespace", {
  title: "example-namespace",
  values: [
    {
      key: "exampleKey",
      value: "exampleValue",
      expirationTtl: 3600 // Expires in 1 hour
    }
  ]
});
```

# Bind to a Worker

```ts
import { Worker, KvNamespace } from "alchemy/cloudflare";

const myNamespace = await KvNamespace("my-namespace", {
  title: "example-namespace"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myNamespace,
  },
});
```