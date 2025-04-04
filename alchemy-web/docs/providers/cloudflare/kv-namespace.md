# KV Namespace

The KV Namespace resource lets you create and manage [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) key-value storage namespaces.

## Minimal Example

Create a basic KV namespace for storing data:

```ts
import { KVNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("my-namespace", {
  title: "my-namespace"
});
```

## Create with Initial Values

```ts
import { KVNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("sessions", {
  title: "user-sessions",
  values: [{
    key: "session_123",
    value: { userId: "user_456", role: "admin" },
    expirationTtl: 3600 // Expires in 1 hour
  }]
});
```

## Bind to a Worker

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("cache", {
  title: "cache-store"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    CACHE: kv
  }
});
```