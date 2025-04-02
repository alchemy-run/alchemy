# Kv Namespace

The Kv Namespace component allows you to manage [Cloudflare Workers KV](https://developers.cloudflare.com/workers/runtime-apis/kv) namespaces, which are key-value stores for your application.

# Minimal Example

```ts
import { KVNamespace } from "alchemy/cloudflare";

const myNamespace = await KVNamespace("my-namespace", {
  title: "example-namespace"
});
```

# Create the Kv Namespace

```ts
import { KVNamespace } from "alchemy/cloudflare";

const myNamespace = await KVNamespace("my-namespace", {
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
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myNamespace = await KVNamespace("my-namespace", {
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